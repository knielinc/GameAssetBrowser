//! Path -> RGBA8 at a bounded edge.
//!
//! Deliberately mirrors the dispatch in `src-tauri/src/thumbs.rs`
//! (`decode_image_inner`) rather than inventing a new one, so the grid is
//! measuring the UI toolkit and not a different decode path. The two crates
//! that carry the hard-won work — `exrthumb` and `psdcomp` — are reused as-is.
//!
//! What is deliberately NOT ported here: camera RAW (`raw.rs`), Krita, Aseprite
//! and Affinity. They add decoder crates without telling us anything new about
//! whether egui can render a grid, and the spike is meant to stay small.

use std::path::Path;

use image::DynamicImage;

/// Decoded, already downscaled, ready to hand to the GPU.
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// Extensions the spike will attempt. Anything else is skipped at scan time so
/// the grid never shows a cell it cannot fill.
pub const EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "bmp", "tga", "dds", "tif", "tiff", "hdr", "exr", "gif", "webp", "psd",
    "psb",
];

pub fn is_supported(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(e) => EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// `catch_unwind` for the same reason the shipping code does it: third-party
/// decoders panic on files they do not handle, and one bad file must not take
/// down a decode worker and blank every later thumbnail.
pub fn decode(path: &Path, max_edge: u32) -> Result<Rgba, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| decode_inner(path, max_edge)))
        .unwrap_or_else(|_| Err(format!("{}: decoder panicked", path.display())))
}

fn decode_inner(path: &Path, max_edge: u32) -> Result<Rgba, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);

    let img = match ext.as_deref() {
        // Bounded, downsampling decode. image::open would fully materialize the
        // source (a 4096x16384 light bake is ~1 GB as RGBA f32) and OOM.
        Some("exr") => decode_exr(path, max_edge)?,
        // Seek past the layer section and read only the composite rows a
        // downscale samples. Returns None for exotic colour modes; the spike
        // reports that rather than pulling in the full `psd` crate as well.
        Some("psd") | Some("psb") => {
            let c = psdcomp::from_file(path, max_edge)
                .ok_or_else(|| "psd: unsupported colour mode or depth".to_string())?;
            return Ok(Rgba {
                width: c.width,
                height: c.height,
                pixels: c.rgba,
            });
        }
        _ => open_with_webp_fallback(path)?,
    };

    Ok(to_rgba8(img, max_edge))
}

fn decode_exr(path: &Path, max_edge: u32) -> Result<DynamicImage, String> {
    let (w, h, px) = exrthumb::decode_downsampled(&path.to_string_lossy(), max_edge as usize)?;
    image::Rgba32FImage::from_raw(w, h, px)
        .map(DynamicImage::ImageRgba32F)
        .ok_or_else(|| "exr: pixel buffer size mismatch".to_string())
}

/// The pure-Rust WebP decoder rejects some extended/animated WebP that libwebp
/// reads fine — the same fallback the shipping decoder has.
fn open_with_webp_fallback(path: &Path) -> Result<DynamicImage, String> {
    match image::open(path) {
        Ok(img) => Ok(img),
        Err(e) => {
            let is_webp = path
                .extension()
                .map(|x| x.eq_ignore_ascii_case("webp"))
                .unwrap_or(false);
            if is_webp {
                if let Ok(bytes) = std::fs::read(path) {
                    if let Some(w) = webp::Decoder::new(&bytes).decode() {
                        if let Some(buf) =
                            image::RgbaImage::from_raw(w.width(), w.height(), w.to_vec())
                        {
                            return Ok(DynamicImage::ImageRgba8(buf));
                        }
                    }
                }
            }
            Err(e.to_string())
        }
    }
}

/// Downscale first, then convert: tone-mapping a 67 MP float image and throwing
/// 99% of it away is the expensive way round.
fn to_rgba8(img: DynamicImage, max_edge: u32) -> Rgba {
    let (w, h) = (img.width().max(1), img.height().max(1));
    let img = if w.max(h) > max_edge {
        let scale = max_edge as f32 / w.max(h) as f32;
        let nw = ((w as f32 * scale).round() as u32).max(1);
        let nh = ((h as f32 * scale).round() as u32).max(1);
        // Box-average: correct for large downscales and much faster than a
        // windowed filter, which is what a thumbnail wants.
        img.thumbnail_exact(nw, nh)
    } else {
        img
    };

    let is_hdr = matches!(
        img,
        DynamicImage::ImageRgb32F(_) | DynamicImage::ImageRgba32F(_)
    );
    if is_hdr {
        let f = img.to_rgba32f();
        let (w, h) = (f.width(), f.height());
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for px in f.pixels() {
            out.push(encode_srgb(tonemap(px.0[0])));
            out.push(encode_srgb(tonemap(px.0[1])));
            out.push(encode_srgb(tonemap(px.0[2])));
            out.push((px.0[3].clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
        }
        Rgba {
            width: w,
            height: h,
            pixels: out,
        }
    } else {
        let buf = img.to_rgba8();
        Rgba {
            width: buf.width(),
            height: buf.height(),
            pixels: buf.into_raw(),
        }
    }
}

/// Narinder Singh's ACES fit. A simplification of `src-tauri/src/tonemap.rs`,
/// which is configurable (curve + exposure) and user-facing; here it only has to
/// stop EXR/HDR highlights clamping to flat white so the grid looks honest.
fn tonemap(x: f32) -> f32 {
    let x = x.max(0.0);
    ((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decodes the screenshots committed in the repo. Cheap, but it proves the
    /// whole reused path links and runs: `image` with the shipping feature set,
    /// the downscale, and the RGBA hand-off the GPU upload expects.
    #[test]
    fn decodes_repo_images() {
        let docs = std::path::Path::new("../docs");
        let mut seen = 0;
        for entry in std::fs::read_dir(docs).expect("../docs should exist") {
            let path = entry.unwrap().path();
            if !is_supported(&path) {
                continue;
            }
            let rgba = decode(&path, 256).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            assert!(rgba.width <= 256 && rgba.height <= 256, "not downscaled");
            assert_eq!(
                rgba.pixels.len(),
                (rgba.width * rgba.height * 4) as usize,
                "buffer does not match dimensions"
            );
            seen += 1;
        }
        assert!(seen > 0, "no supported images found in ../docs");
    }

    #[test]
    fn tonemap_is_monotonic_and_bounded() {
        assert_eq!(tonemap(0.0), 0.0);
        assert!(tonemap(1.0) < 1.0);
        // The whole point: a very bright HDR value must compress, not clamp flat.
        assert!(tonemap(100.0) <= 1.0);
        assert!(tonemap(4.0) > tonemap(1.0));
    }
}

fn encode_srgb(linear: f32) -> u8 {
    let c = if linear <= 0.003_130_8 {
        linear * 12.92
    } else {
        1.055 * linear.powf(1.0 / 2.4) - 0.055
    };
    (c.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}
