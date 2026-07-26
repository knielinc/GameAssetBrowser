//! The eframe shell: folder scan, grid, material viewport, and the measurement
//! overlay that is the actual point of the exercise.

use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender};
use std::time::Instant;

use eframe::egui_wgpu;

use crate::decode::{self, Rgba};
use crate::grid::ThumbGrid;
use crate::material::{MaterialParams, MaterialRenderer, Shape};

/// Full-resolution cap for the material preview texture. Matches the order of
/// magnitude the shipping preview uses; the grid uses THUMB_EDGE.
const PREVIEW_EDGE: u32 = 2048;

/// Frames the scroll benchmark runs for, and how far it advances each frame.
/// 900 frames at 60 Hz is ~15 s — long enough to cross a large library and to
/// let the decode pool fall behind, which is exactly the condition that makes a
/// grid feel bad.
const BENCH_FRAMES: u32 = 900;
const BENCH_PIXELS_PER_FRAME: f32 = 36.0;

struct Bench {
    frames_left: u32,
    offset: f32,
}

pub fn run() -> eframe::Result<()> {
    let started = Instant::now();

    // `--bench <folder>` self-drives the scroll and prints statistics on exit.
    // Hand-scrolling is not reproducible, and comparing it against the WebView2
    // grid by feel is exactly the kind of evidence this spike exists to replace.
    let args: Vec<String> = std::env::args().skip(1).collect();
    let bench = args.iter().any(|a| a == "--bench");
    let initial = args.into_iter().find(|a| !a.starts_with("--"));

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1400.0, 900.0])
            .with_title("GAB native spike — egui + wgpu"),
        ..Default::default()
    };

    eframe::run_native(
        "gab-native-spike",
        options,
        Box::new(move |cc| Ok(Box::new(SpikeApp::new(cc, started, initial, bench)))),
    )
}

struct Timing {
    /// Ring of recent frame times in milliseconds.
    frames: std::collections::VecDeque<f32>,
    /// Frames over 16.67 ms since launch — the "dropped frames" number to
    /// compare against the WebView2 grid.
    dropped: u64,
    total: u64,
    process_start: Instant,
    /// Time to reach App::new — i.e. everything eframe does before our code
    /// runs: window creation, wgpu instance/adapter/device, surface config.
    /// Broken out because "cold start" is otherwise a single opaque number, and
    /// the interesting question is whether it is *our* cost or the toolkit's.
    init_done: f32,
    first_frame: Option<f32>,
    first_thumb: Option<f32>,
}

impl Timing {
    fn push(&mut self, dt: f32) {
        let ms = dt * 1000.0;
        self.frames.push_back(ms);
        if self.frames.len() > 240 {
            self.frames.pop_front();
        }
        self.total += 1;
        if ms > 16.67 {
            self.dropped += 1;
        }
    }

    /// Mean and 95th percentile over the ring.
    fn stats(&self) -> (f32, f32, f32) {
        if self.frames.is_empty() {
            return (0.0, 0.0, 0.0);
        }
        let mut sorted: Vec<f32> = self.frames.iter().copied().collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mean = sorted.iter().sum::<f32>() / sorted.len() as f32;
        let p95 = sorted[(sorted.len() as f32 * 0.95) as usize % sorted.len()];
        let max = *sorted.last().unwrap();
        (mean, p95, max)
    }
}

struct SpikeApp {
    folder: String,
    files: Vec<PathBuf>,
    grid: ThumbGrid,
    selected: Option<usize>,
    params: MaterialParams,
    timing: Timing,
    font_report: String,
    scan_report: String,
    /// egui repaints reactively: when nothing is happening it simply does not
    /// draw, and `unstable_dt` becomes the gap between input events — seconds,
    /// not milliseconds. Accumulating that would report a wildly inflated
    /// dropped-frame count. Forcing a repaint every frame is what makes the
    /// numbers comparable to a browser's rAF loop, so measurement runs with it
    /// on; a shipped app would leave it off and use less power for it.
    continuous: bool,
    bench: Option<Bench>,
    preview_tx: Sender<(usize, Result<Rgba, String>)>,
    preview_rx: Receiver<(usize, Result<Rgba, String>)>,
    preview_pending: Option<usize>,
}

impl SpikeApp {
    fn new(
        cc: &eframe::CreationContext<'_>,
        started: Instant,
        initial: Option<String>,
        bench: bool,
    ) -> Self {
        // Sampled first thing: by the time eframe calls us, the window and the
        // whole wgpu stack already exist.
        let init_done = started.elapsed().as_secs_f32() * 1000.0;
        let font_report = install_cjk_fallback(&cc.egui_ctx);

        // The custom-GPU-content setup. RenderState is where egui hands over the
        // device, queue and — critically — the target format it is compositing
        // into, which the pipeline has to match.
        let render_state = cc
            .wgpu_render_state
            .as_ref()
            .expect("spike requires the wgpu backend");
        let renderer = MaterialRenderer::new(
            &render_state.device,
            &render_state.queue,
            render_state.target_format,
        );
        render_state
            .renderer
            .write()
            .callback_resources
            .insert(renderer);

        let (preview_tx, preview_rx) = std::sync::mpsc::channel();
        let mut app = Self {
            folder: initial.clone().unwrap_or_default(),
            files: Vec::new(),
            grid: ThumbGrid::new(),
            selected: None,
            params: MaterialParams::default(),
            timing: Timing {
                frames: std::collections::VecDeque::new(),
                dropped: 0,
                total: 0,
                process_start: started,
                init_done,
                first_frame: None,
                first_thumb: None,
            },
            font_report,
            scan_report: String::new(),
            continuous: true,
            bench: bench.then_some(Bench {
                frames_left: BENCH_FRAMES,
                offset: 0.0,
            }),
            preview_tx,
            preview_rx,
            preview_pending: None,
        };
        if initial.is_some() {
            app.scan();
        }
        app
    }

    fn scan(&mut self) {
        let root = PathBuf::from(self.folder.trim().trim_matches('"'));
        if !root.is_dir() {
            self.scan_report = format!("not a directory: {}", root.display());
            return;
        }
        let t = Instant::now();
        let mut files: Vec<PathBuf> = walkdir::WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .map(|e| e.into_path())
            .filter(|p| decode::is_supported(p))
            .collect();
        files.sort();
        self.scan_report = format!(
            "{} files in {:.0} ms",
            files.len(),
            t.elapsed().as_secs_f32() * 1000.0
        );
        self.files = files;
        self.selected = None;
        self.grid.clear();
        self.timing.first_thumb = None;
    }

    fn select(&mut self, index: usize) {
        self.selected = Some(index);
        self.preview_pending = Some(index);
        let path = self.files[index].clone();
        let tx = self.preview_tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send((index, decode::decode(&path, PREVIEW_EDGE)));
        });
    }

    fn apply_preview(&mut self, frame: &eframe::Frame) {
        while let Ok((index, result)) = self.preview_rx.try_recv() {
            // A newer selection may have landed while this decode was running.
            if self.preview_pending != Some(index) {
                continue;
            }
            let Ok(rgba) = result else { continue };
            let Some(render_state) = frame.wgpu_render_state() else {
                return;
            };
            if let Some(renderer) = render_state
                .renderer
                .write()
                .callback_resources
                .get_mut::<MaterialRenderer>()
            {
                renderer.set_texture(&render_state.device, &render_state.queue, &rgba);
            }
        }
    }

    fn advance_bench(&mut self, ctx: &egui::Context, grid_width: f32) {
        // Wrap rather than run off the end: a library shorter than the run
        // would otherwise spend most of the benchmark parked at the bottom
        // measuring nothing but an idle repaint.
        let span = (self.grid.content_height(&self.files, grid_width) - 600.0).max(1.0);
        let Some(b) = self.bench.as_mut() else { return };
        b.offset = (b.offset + BENCH_PIXELS_PER_FRAME) % span;
        b.frames_left = b.frames_left.saturating_sub(1);
        if b.frames_left > 0 {
            return;
        }

        // ViewportCommand::Close does not take effect until the next frame, and
        // that frame still runs this. Disarm before reporting so the numbers are
        // printed exactly once.
        self.bench = None;

        let (mean, p95, max) = self.timing.stats();
        println!("files            {}", self.files.len());
        println!("scan             {}", self.scan_report);
        println!("frames           {}", self.timing.total);
        println!("frame mean       {mean:.2} ms");
        println!("frame p95        {p95:.2} ms");
        println!("frame max        {max:.2} ms");
        println!(
            "over 16.67 ms    {}/{} ({:.1}%)",
            self.timing.dropped,
            self.timing.total,
            100.0 * self.timing.dropped as f32 / self.timing.total.max(1) as f32
        );
        println!("--- cold start, from process launch ---");
        println!("eframe+wgpu init {:.0} ms", self.timing.init_done);
        if let Some(ms) = self.timing.first_frame {
            println!("first frame      {ms:.0} ms");
        }
        if let Some(ms) = self.timing.first_thumb {
            println!("first thumbnail  {ms:.0} ms");
        }
        println!(
            "decoded          {} ({} errors, {} resident at exit)",
            self.grid.decoded,
            self.grid.errors,
            self.grid.resident()
        );
        println!("{}", self.font_report);
        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
    }

    fn viewport(&mut self, ui: &mut egui::Ui) {
        let size = ui.available_size();
        let (rect, response) =
            ui.allocate_exact_size(size, egui::Sense::click_and_drag());

        if response.dragged() {
            let d = response.drag_delta();
            self.params.yaw -= d.x * 0.01;
            self.params.pitch = (self.params.pitch + d.y * 0.01).clamp(-1.4, 1.4);
        }
        if response.hovered() {
            let scroll = ui.ctx().input(|i| i.smooth_scroll_delta.y);
            if scroll != 0.0 {
                self.params.distance = (self.params.distance - scroll * 0.01).clamp(1.5, 12.0);
            }
        }
        self.params.aspect = (rect.width() / rect.height().max(1.0)).max(0.01);

        // This is the line the whole spike is about: our own wgpu pass, recorded
        // into the same encoder egui is using, clipped to this rect.
        ui.painter().add(egui_wgpu::Callback::new_paint_callback(
            rect,
            MaterialCallback {
                params: self.params,
            },
        ));
    }
}

// egui 0.35 unified SidePanel/TopBottomPanel into `Panel`, and eframe's App
// trait now hands the root `Ui` to `ui()` rather than a `Context` to `update()`.
impl eframe::App for SpikeApp {
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        if self.timing.first_frame.is_none() {
            self.timing.first_frame =
                Some(self.timing.process_start.elapsed().as_secs_f32() * 1000.0);
        }
        if self.continuous {
            // Only meaningful under a continuous repaint — see the field's note.
            self.timing.push(ctx.input(|i| i.unstable_dt));
        }
        self.apply_preview(frame);

        egui::Panel::top("top").show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label("Library:");
                let edit = ui.add(
                    egui::TextEdit::singleline(&mut self.folder)
                        .desired_width(520.0)
                        .hint_text(r"paste a folder path, e.g. D:\Packs\Textures"),
                );
                let go = ui.button("Scan").clicked()
                    || (edit.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)));
                if go {
                    self.scan();
                }
                if !self.scan_report.is_empty() {
                    ui.label(egui::RichText::new(&self.scan_report).weak());
                }
            });
        });

        egui::Panel::bottom("stats").show(ui, |ui| {
            let (mean, p95, max) = self.timing.stats();
            ui.horizontal_wrapped(|ui| {
                ui.monospace(format!(
                    "frame mean {mean:5.2} ms · p95 {p95:5.2} ms · max {max:6.2} ms · \
                     dropped {}/{} ({:.1}%)",
                    self.timing.dropped,
                    self.timing.total,
                    100.0 * self.timing.dropped as f32 / self.timing.total.max(1) as f32,
                ));
                ui.separator();
                ui.monospace(format!(
                    "resident {} · in-flight {} · decoded {} · errors {}",
                    self.grid.resident(),
                    self.grid.in_flight(),
                    self.grid.decoded,
                    self.grid.errors,
                ));
                if let Some(ms) = self.timing.first_thumb {
                    ui.separator();
                    ui.monospace(format!("first thumbnail {ms:.0} ms after launch"));
                }
            });
            ui.horizontal(|ui| {
                ui.checkbox(&mut self.continuous, "continuous repaint")
                    .on_hover_text(
                        "Forces a repaint every frame so frame times are comparable to a \
                         browser rAF loop. Off = egui's normal reactive mode, which is what \
                         you would ship, but the timings become meaningless.",
                    );
                if ui.button("reset stats").clicked() {
                    self.timing.frames.clear();
                    self.timing.dropped = 0;
                    self.timing.total = 0;
                }
                ui.separator();
                ui.small(egui::RichText::new(&self.font_report).weak());
            });
        });

        egui::Panel::right("preview")
            .resizable(true)
            .default_size(460.0)
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.selectable_value(&mut self.params.shape, Shape::Sphere, "Sphere");
                    ui.selectable_value(&mut self.params.shape, Shape::Plane, "Plane");
                });
                ui.add(egui::Slider::new(&mut self.params.tiling, 1.0..=8.0).text("tiling"));
                ui.add(egui::Slider::new(&mut self.params.roughness, 0.05..=1.0).text("roughness"));
                ui.add(
                    egui::Slider::new(&mut self.params.light_yaw, -3.14..=3.14).text("light"),
                );
                if let Some(i) = self.selected {
                    ui.small(
                        egui::RichText::new(self.files[i].display().to_string())
                            .weak(),
                    );
                }
                ui.separator();
                self.viewport(ui);
            });

        let scroll_to = self.bench.as_ref().map(|b| b.offset);
        let mut grid_width = 0.0;
        egui::CentralPanel::default().show(ui, |ui| {
            grid_width = ui.available_width();
            if self.files.is_empty() {
                ui.centered_and_justified(|ui| {
                    ui.label("Paste a texture folder above and press Scan.");
                });
                return;
            }
            if let Some(index) = self.grid.ui(ui, &self.files, self.selected, scroll_to) {
                self.select(index);
            }
        });

        if self.bench.is_some() {
            self.advance_bench(&ctx, grid_width);
        }

        if self.timing.first_thumb.is_none() && self.grid.resident() > 0 {
            self.timing.first_thumb =
                Some(self.timing.process_start.elapsed().as_secs_f32() * 1000.0);
        }

        // Thumbnails arrive on background threads, so keep painting while any
        // decode is outstanding; otherwise the grid would stall until the next
        // input event.
        if self.continuous || self.grid.in_flight() > 0 {
            ctx.request_repaint();
        }
    }
}

struct MaterialCallback {
    params: MaterialParams,
}

impl egui_wgpu::CallbackTrait for MaterialCallback {
    fn prepare(
        &self,
        _device: &eframe::wgpu::Device,
        queue: &eframe::wgpu::Queue,
        _screen: &egui_wgpu::ScreenDescriptor,
        _encoder: &mut eframe::wgpu::CommandEncoder,
        resources: &mut egui_wgpu::CallbackResources,
    ) -> Vec<eframe::wgpu::CommandBuffer> {
        if let Some(renderer) = resources.get::<MaterialRenderer>() {
            renderer.update(queue, &self.params);
        }
        Vec::new()
    }

    fn paint(
        &self,
        info: egui::PaintCallbackInfo,
        render_pass: &mut eframe::wgpu::RenderPass<'static>,
        resources: &egui_wgpu::CallbackResources,
    ) {
        let Some(renderer) = resources.get::<MaterialRenderer>() else {
            return;
        };
        let vp = info.viewport_in_pixels();
        renderer.draw(
            render_pass,
            [
                vp.left_px as f32,
                vp.top_px as f32,
                vp.width_px as f32,
                vp.height_px as f32,
            ],
            self.params.shape,
        );
    }
}

/// egui ships its own fonts and does no system font fallback, so a CJK filename
/// renders as tofu out of the box. The webview gets this for free; a native port
/// has to solve it, and this is the cheap version of solving it — find one
/// system CJK face and append it to both families.
///
/// Returns a one-line report, shown in the UI, because "did the toolkit handle
/// non-ASCII filenames" is one of the spike's measurements.
fn install_cjk_fallback(ctx: &egui::Context) -> String {
    // (path, face index within a .ttc collection)
    const CANDIDATES: &[(&str, u32)] = &[
        // Windows
        (r"C:\Windows\Fonts\msgothic.ttc", 0),
        (r"C:\Windows\Fonts\meiryo.ttc", 0),
        (r"C:\Windows\Fonts\simsun.ttc", 0),
        (r"C:\Windows\Fonts\malgun.ttf", 0),
        // macOS
        ("/System/Library/Fonts/PingFang.ttc", 0),
        ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0),
        // Linux
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
        ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", 0),
        ("/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", 0),
    ];

    for (path, index) in CANDIDATES {
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        let mut data = egui::FontData::from_owned(bytes);
        data.index = *index;

        let mut fonts = egui::FontDefinitions::default();
        fonts.font_data.insert("cjk".to_owned(), std::sync::Arc::new(data));
        for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
            fonts.families.entry(family).or_default().push("cjk".to_owned());
        }
        ctx.set_fonts(fonts);
        return format!("CJK fallback: {path}");
    }

    "CJK fallback: none found — non-ASCII filenames will render as tofu".to_owned()
}
