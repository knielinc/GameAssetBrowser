//! Virtualized thumbnail grid with a background decode pool and LRU texture
//! residency.
//!
//! Residency is the part that is easy to get wrong and then misread as "native
//! is slow": a 20k-file library cannot hold every thumbnail on the GPU, so cells
//! that scroll far away have to give their textures back. An eviction bug here
//! looks exactly like a toolkit performance problem, which would invalidate the
//! comparison the spike exists to make.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender};

use crate::decode::{self, Rgba};

pub const THUMB_EDGE: u32 = 256;

/// How many decoded thumbnails may be resident on the GPU at once. ~600 cells is
/// several screenfuls at any realistic cell size, so scrolling back a page never
/// re-decodes, while a 20k library still costs a bounded ~150 MB.
const RESIDENT_BUDGET: usize = 600;

/// Texture uploads are synchronous work on the render thread. Uploading a whole
/// screenful in one frame causes a visible hitch, so drip-feed them; the queue
/// drains within a few frames and the grid fills in progressively.
const UPLOADS_PER_FRAME: usize = 16;

struct Done {
    index: usize,
    result: Result<Rgba, String>,
}

pub struct ThumbGrid {
    pool: rayon::ThreadPool,
    tx: Sender<Done>,
    rx: Receiver<Done>,
    inflight: HashSet<usize>,
    /// Decoded but not yet uploaded, so uploads can be rate-limited.
    pending: Vec<(usize, Rgba)>,
    textures: HashMap<usize, (egui::TextureHandle, u64)>,
    failed: HashSet<usize>,
    frame: u64,
    max_inflight: usize,
    pub decoded: usize,
    pub errors: usize,
}

impl ThumbGrid {
    pub fn new() -> Self {
        // Leave a core for the UI thread. The shipping app schedules its own
        // parallelism for the same reason (see decode_threads in thumbs.rs).
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().saturating_sub(1).max(1))
            .unwrap_or(4);
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|i| format!("spike-decode-{i}"))
            .build()
            .expect("decode pool");
        let (tx, rx) = std::sync::mpsc::channel();
        Self {
            pool,
            tx,
            rx,
            inflight: HashSet::new(),
            pending: Vec::new(),
            textures: HashMap::new(),
            failed: HashSet::new(),
            frame: 0,
            max_inflight: threads * 4,
            decoded: 0,
            errors: 0,
        }
    }

    pub fn resident(&self) -> usize {
        self.textures.len()
    }

    pub fn in_flight(&self) -> usize {
        self.inflight.len()
    }

    /// Drop everything — called when a new folder is scanned, since indices no
    /// longer refer to the same files.
    pub fn clear(&mut self) {
        self.textures.clear();
        self.pending.clear();
        self.failed.clear();
        self.inflight.clear();
        self.decoded = 0;
        self.errors = 0;
    }

    fn collect(&mut self, ctx: &egui::Context) {
        while let Ok(done) = self.rx.try_recv() {
            self.inflight.remove(&done.index);
            match done.result {
                Ok(rgba) => {
                    self.decoded += 1;
                    self.pending.push((done.index, rgba));
                }
                Err(_) => {
                    self.errors += 1;
                    self.failed.insert(done.index);
                }
            }
        }

        // Drain a bounded prefix, NOT `drain(..).take(n)` — dropping a full-range
        // Drain removes everything it did not yield, which would throw away the
        // rest of the queue and make those cells decode all over again.
        let n = self.pending.len().min(UPLOADS_PER_FRAME);
        for (index, rgba) in self.pending.drain(..n).collect::<Vec<_>>() {
            let image = egui::ColorImage::from_rgba_unmultiplied(
                [rgba.width as usize, rgba.height as usize],
                &rgba.pixels,
            );
            let handle = ctx.load_texture(
                format!("thumb{index}"),
                image,
                egui::TextureOptions::LINEAR,
            );
            self.textures.insert(index, (handle, self.frame));
        }
    }

    fn request(&mut self, index: usize, path: &PathBuf) {
        if self.textures.contains_key(&index)
            || self.inflight.contains(&index)
            || self.failed.contains(&index)
            || self.inflight.len() >= self.max_inflight
        {
            return;
        }
        self.inflight.insert(index);
        let tx = self.tx.clone();
        let path = path.clone();
        self.pool.spawn(move || {
            let result = decode::decode(&path, THUMB_EDGE);
            // The receiver is gone only when the app is shutting down.
            let _ = tx.send(Done { index, result });
        });
    }

    fn evict(&mut self) {
        if self.textures.len() <= RESIDENT_BUDGET {
            return;
        }
        let mut by_age: Vec<(usize, u64)> =
            self.textures.iter().map(|(k, (_, t))| (*k, *t)).collect();
        by_age.sort_by_key(|&(_, t)| t);
        let excess = self.textures.len() - RESIDENT_BUDGET;
        for (index, _) in by_age.into_iter().take(excess) {
            self.textures.remove(&index);
        }
    }

    /// Total scrollable height, so a benchmark can drive the offset across the
    /// whole library rather than off the end of it.
    pub fn content_height(&self, files: &[PathBuf], width: f32) -> f32 {
        let (columns, row_height) = Self::layout(width);
        files.len().div_ceil(columns) as f32 * row_height
    }

    fn layout(width: f32) -> (usize, f32) {
        let cell = egui::vec2(THUMB_EDGE as f32 * 0.55, THUMB_EDGE as f32 * 0.55 + 18.0);
        let spacing = 8.0;
        let columns = (((width + spacing) / (cell.x + spacing)).floor() as usize).max(1);
        (columns, cell.y + spacing)
    }

    /// Draws the grid and returns the newly clicked index, if any.
    /// `scroll_to` forces the vertical offset — used by the benchmark; `None`
    /// leaves the scroll under user control.
    pub fn ui(
        &mut self,
        ui: &mut egui::Ui,
        files: &[PathBuf],
        selected: Option<usize>,
        scroll_to: Option<f32>,
    ) -> Option<usize> {
        self.frame += 1;
        self.collect(ui.ctx());

        let spacing = 8.0;
        let (columns, row_height) = Self::layout(ui.available_width());
        let rows = files.len().div_ceil(columns);

        let mut clicked = None;

        // egui's own virtualization: only the rows in view are ever built, which
        // is the equivalent of what @tanstack/react-virtual does in FileList.tsx
        // and AssetGrid.tsx today.
        let mut area = egui::ScrollArea::vertical().auto_shrink([false; 2]);
        if let Some(offset) = scroll_to {
            area = area.vertical_scroll_offset(offset);
        }
        area.show_rows(ui, row_height, rows, |ui, row_range| {
            for row in row_range {
                ui.horizontal(|ui| {
                    for col in 0..columns {
                        let index = row * columns + col;
                        if index >= files.len() {
                            break;
                        }
                        self.request(index, &files[index]);
                        if self.cell(ui, index, &files[index], selected == Some(index)) {
                            clicked = Some(index);
                        }
                    }
                });
                ui.add_space(spacing);
            }
        });

        self.evict();
        clicked
    }

    fn cell(
        &mut self,
        ui: &mut egui::Ui,
        index: usize,
        path: &PathBuf,
        selected: bool,
    ) -> bool {
        let size = egui::vec2(THUMB_EDGE as f32 * 0.55, THUMB_EDGE as f32 * 0.55 + 18.0);
        let (rect, response) = ui.allocate_exact_size(size, egui::Sense::click());
        if !ui.is_rect_visible(rect) {
            return false;
        }

        let painter = ui.painter();
        let image_rect = egui::Rect::from_min_size(rect.min, egui::vec2(size.x, size.x));
        painter.rect_filled(image_rect, 4.0, egui::Color32::from_gray(28));

        if let Some((handle, last_used)) = self.textures.get_mut(&index) {
            *last_used = self.frame;
            // Letterbox rather than stretch: a 2:1 texture stretched to a square
            // cell reads as a decode bug when scanning a grid quickly.
            let [w, h] = handle.size();
            let scale = (image_rect.width() / w as f32).min(image_rect.height() / h as f32);
            let drawn = egui::vec2(w as f32 * scale, h as f32 * scale);
            let fitted = egui::Rect::from_center_size(image_rect.center(), drawn);
            painter.image(
                handle.id(),
                fitted,
                egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)),
                egui::Color32::WHITE,
            );
        } else if self.failed.contains(&index) {
            painter.text(
                image_rect.center(),
                egui::Align2::CENTER_CENTER,
                "!",
                egui::FontId::proportional(20.0),
                egui::Color32::from_rgb(180, 90, 90),
            );
        }

        if selected {
            painter.rect_stroke(
                image_rect,
                4.0,
                egui::Stroke::new(2.0, egui::Color32::from_rgb(90, 150, 240)),
                egui::StrokeKind::Inside,
            );
        }

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        painter.text(
            egui::pos2(rect.center().x, image_rect.max.y + 2.0),
            egui::Align2::CENTER_TOP,
            elide(&name, 18),
            egui::FontId::proportional(11.0),
            egui::Color32::from_gray(190),
        );

        response.clicked()
    }
}

/// Character-count elision, not width-aware — good enough for a spike, and a
/// reminder of what CSS `text-overflow: ellipsis` was doing for free.
fn elide(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let head: String = s.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{head}…")
}
