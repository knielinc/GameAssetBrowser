//! Bounded, downsampling EXR decode.
//!
//! Lives in its own crate for ONE reason: the pixel setter below runs once per
//! source pixel — 67 million times for a 4096×16384 light bake — and it is
//! monomorphized into whatever crate instantiates `read_first_rgba_layer_from_file`.
//! In the parent `game-file-browser` crate (deliberately `opt-level = 0` in dev,
//! for fast incremental builds) that loop takes ~17 s; here, with this crate
//! pinned to `opt-level = 3` in the parent's dev profile, it takes ~0.85 s.
//!
//! Memory is bounded regardless of source size: files larger than `MAX_FULL`
//! are nearest-neighbour subsampled straight into the small target buffer, so
//! we never materialize the full-res RGBA float image (~1 GB for 67 MP).

// Import specifically (not a glob) so exr's `Result<T>` alias doesn't shadow
// std's two-parameter `Result` in this file's signatures.
use exr::prelude::{read_first_rgba_layer_from_file, RgbaChannels, Vec2};

/// Above this pixel count, subsample into the target during the read instead of
/// decoding at native resolution. ~16 MP full RGBA f32 ≈ 256 MB transient.
const MAX_FULL: usize = 16_000_000;

/// Decode the first RGBA layer of an EXR to a flat `[r,g,b,a, …]` f32 buffer,
/// downsampled so the longer edge is at most `cap` for oversized files.
/// Returns `(width, height, pixels)`. Files up to `MAX_FULL` decode at native
/// resolution (the caller resizes them with a good filter).
pub fn decode_downsampled(path: &str, cap: usize) -> Result<(u32, u32, Vec<f32>), String> {
    struct Target {
        w: usize,
        h: usize,
        sw: usize,
        sh: usize,
        px: Vec<f32>,
    }

    let cap = cap.max(1);
    let image = read_first_rgba_layer_from_file(
        path,
        move |res: Vec2<usize>, _: &RgbaChannels| {
            let sw = res.0.max(1);
            let sh = res.1.max(1);
            let (w, h) = if sw.saturating_mul(sh) <= MAX_FULL {
                (sw, sh)
            } else {
                let scale = cap as f64 / sw.max(sh) as f64; // < 1
                (
                    ((sw as f64 * scale).round() as usize).max(1),
                    ((sh as f64 * scale).round() as usize).max(1),
                )
            };
            Target { w, h, sw, sh, px: vec![0.0f32; w * h * 4] }
        },
        |t: &mut Target, pos: Vec2<usize>, (r, g, b, a): (f32, f32, f32, f32)| {
            // Nearest-neighbour into the target cell; identity when w == sw.
            let tx = (pos.0 * t.w / t.sw).min(t.w - 1);
            let ty = (pos.1 * t.h / t.sh).min(t.h - 1);
            let i = (ty * t.w + tx) * 4;
            t.px[i] = r;
            t.px[i + 1] = g;
            t.px[i + 2] = b;
            t.px[i + 3] = a;
        },
    )
    .map_err(|e| format!("exr: {e}"))?;

    let t = image.layer_data.channel_data.pixels;
    Ok((t.w as u32, t.h as u32, t.px))
}
