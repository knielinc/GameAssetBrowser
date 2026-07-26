//! Renders the material pass to an offscreen texture and reads it back.
//!
//! This exists to answer the one question that killed the GPUI attempt — can we
//! drive our own wgpu pass on macOS — without needing a Mac in hand. It runs the
//! identical `MaterialRenderer::draw` the egui callback runs, so a green result
//! on a `macos-latest` CI runner is real evidence, not a proxy.
//!
//! It deliberately does NOT open a window: GitHub's macOS runners have no
//! display, but Metal is available to a headless process.

use eframe::wgpu;

use crate::decode::Rgba;
use crate::material::{MaterialParams, MaterialRenderer, Shape};

fn checkerboard(size: u32, square: u32) -> Rgba {
    let mut pixels = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let on = ((x / square) + (y / square)) % 2 == 0;
            let (r, g, b) = if on { (225, 225, 230) } else { (40, 90, 150) };
            pixels.extend_from_slice(&[r, g, b, 255]);
        }
    }
    Rgba {
        width: size,
        height: size,
        pixels,
    }
}

const SIZE: u32 = 512;
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;

pub struct Report {
    pub backend: String,
    pub adapter: String,
    /// Pixels differing from the clear colour — how much of the frame the mesh
    /// actually covered.
    pub covered: u32,
    pub total: u32,
    /// Where the frame was written, if a path was requested. "Non-black pixels"
    /// is a weak assertion — a broken shader or a mangled normal still passes
    /// it. Being able to look at the frame is what makes this check trustworthy.
    pub written_to: Option<String>,
}

pub fn render_once(save_to: Option<&std::path::Path>) -> Result<Report, String> {
    // No window, so no display handle to hand over — that is the entire point:
    // this has to run on a CI runner with no desktop session.
    //
    // `_from_env` so WGPU_BACKEND=dx12|vulkan|metal actually applies. Without
    // it the variable is silently ignored, which makes any backend comparison
    // quietly measure the same backend twice.
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
    }))
    .map_err(|e| format!("no wgpu adapter: {e}"))?;

    let info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("spike.headless"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::downlevel_defaults(),
        ..Default::default()
    }))
    .map_err(|e| format!("no wgpu device: {e}"))?;

    let mut renderer = MaterialRenderer::new(&device, &queue, FORMAT);
    // A checkerboard rather than the grey fallback: it makes UV mapping, tiling
    // and sampler wrap-around verifiable by eye, so the saved frame proves more
    // than "something drew".
    renderer.set_texture(&device, &queue, &checkerboard(256, 32));
    renderer.update(
        &queue,
        &MaterialParams {
            shape: Shape::Sphere,
            aspect: 1.0,
            tiling: 2.0,
            ..Default::default()
        },
    );

    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("spike.headless.target"),
        size: wgpu::Extent3d {
            width: SIZE,
            height: SIZE,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&wgpu::TextureViewDescriptor::default());

    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("spike.headless.readback"),
        size: (SIZE * SIZE * 4) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("spike.headless.encoder"),
    });
    {
        let mut pass = encoder
            .begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("spike.headless.pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            })
            // The egui callback is handed a RenderPass<'static>; match it so the
            // exact same draw path is exercised here.
            .forget_lifetime();
        renderer.draw(&mut pass, [0.0, 0.0, SIZE as f32, SIZE as f32], Shape::Sphere);
    }
    // 512 * 4 = 2048, already a multiple of the 256-byte row alignment.
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &target,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(SIZE * 4),
                rows_per_image: Some(SIZE),
            },
        },
        wgpu::Extent3d {
            width: SIZE,
            height: SIZE,
            depth_or_array_layers: 1,
        },
    );
    queue.submit(Some(encoder.finish()));

    let slice = readback.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|e| format!("poll failed: {e}"))?;
    rx.recv()
        .map_err(|e| format!("map channel closed: {e}"))?
        .map_err(|e| format!("buffer map failed: {e}"))?;

    let data = slice.get_mapped_range();
    let covered = data
        .chunks_exact(4)
        .filter(|px| px[0] > 4 || px[1] > 4 || px[2] > 4)
        .count() as u32;

    let written_to = match save_to {
        Some(path) => {
            image::RgbaImage::from_raw(SIZE, SIZE, data.to_vec())
                .ok_or_else(|| "readback size mismatch".to_string())?
                .save(path)
                .map_err(|e| format!("could not write {}: {e}", path.display()))?;
            Some(path.display().to_string())
        }
        None => None,
    };

    drop(data);
    readback.unmap();

    Ok(Report {
        backend: format!("{:?}", info.backend),
        adapter: info.name,
        covered,
        total: SIZE * SIZE,
        written_to,
    })
}
