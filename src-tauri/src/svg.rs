//! SVG rasterization (resvg).
//!
//! SVG is the one texture format with no intrinsic pixels, so it is the one
//! format that rasterizes at the size the CALLER asked for rather than being
//! decoded and then downscaled: a 256px grid thumbnail and a 4096px preview are
//! two different renders of the same document, both sharp.
//!
//! The frontend still shows the ORIGINAL file in the 2D preview panel (`svg` is
//! in `BROWSER_DECODABLE`), where the webview's own renderer re-rasterizes on
//! every zoom step. This module is what the grid thumbnail, the dimension probe,
//! the "Copy image" action and any 3D material slot go through.

use std::path::Path;
use std::sync::Arc;
use std::sync::OnceLock;

use image::{DynamicImage, RgbaImage};
use resvg::tiny_skia;
use resvg::usvg;

/// Fallback edge when the caller wants "full resolution" (`max_edge: None`,
/// i.e. the clipboard copy) but the document has no useful intrinsic size to
/// honour. Matches the preview's cap so a copied vector is never absurdly big.
const DEFAULT_EDGE: u32 = 4096;

/// System fonts, loaded once. `load_system_fonts` walks every font on the
/// machine (hundreds of ms); doing that per thumbnail would dominate the decode
/// of a folder of icons.
fn fontdb() -> &'static Arc<usvg::fontdb::Database> {
    static DB: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = usvg::fontdb::Database::new();
        db.load_system_fonts();
        Arc::new(db)
    })
}

fn parse(path: &Path) -> Result<usvg::Tree, String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let options = usvg::Options {
        // `<image href="logo.png">` and `@font-face` URLs resolve relative to
        // the file, not to our working directory.
        resources_dir: path.parent().map(|d| d.to_path_buf()),
        fontdb: Arc::clone(fontdb()),
        ..Default::default()
    };
    // `from_data` transparently handles gzipped (.svgz) documents too.
    usvg::Tree::from_data(&data, &options).map_err(|e| format!("svg: {e}"))
}

/// The document's intrinsic size, rounded up. `image::image_dimensions` has no
/// SVG reader, so `texmeta::probe_dims` calls this the way it calls the DDS and
/// PSD header readers.
pub(crate) fn dims(path: &Path) -> Option<(u32, u32)> {
    let size = parse(path).ok()?.size();
    let (w, h) = (size.width().ceil() as u32, size.height().ceil() as u32);
    (w > 0 && h > 0).then_some((w, h))
}

/// Rasterize, scaled so the longest edge is `max_edge`.
///
/// A document smaller than the cap is still scaled UP to it: unlike a bitmap
/// there is no source resolution to preserve, and a 16x16 icon rendered at 16px
/// then upscaled into a 220px grid cell would be a blurry mess.
pub(crate) fn decode(path: &Path, max_edge: Option<u32>) -> Result<DynamicImage, String> {
    let tree = parse(path)?;
    let size = tree.size();
    let (sw, sh) = (size.width(), size.height());
    if !(sw > 0.0 && sh > 0.0) {
        return Err("svg: zero-sized document".into());
    }

    let cap = max_edge.unwrap_or(DEFAULT_EDGE) as f32;
    let scale = cap / sw.max(sh);
    let w = (sw * scale).round().max(1.0) as u32;
    let h = (sh * scale).round().max(1.0) as u32;

    let mut pixmap = tiny_skia::Pixmap::new(w, h)
        .ok_or_else(|| format!("svg: cannot allocate a {w}x{h} pixmap"))?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );

    // tiny-skia composites premultiplied; the rest of the pipeline (analyze,
    // the GPU atlas, PNG encode) is straight alpha.
    let mut rgba = Vec::with_capacity((w as usize) * (h as usize) * 4);
    for px in pixmap.pixels() {
        let c = px.demultiply();
        rgba.extend_from_slice(&[c.red(), c.green(), c.blue(), c.alpha()]);
    }
    RgbaImage::from_raw(w, h, rgba)
        .map(DynamicImage::ImageRgba8)
        .ok_or_else(|| "svg: rgba size mismatch".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    /// A 20x10 document: opaque red left half, transparent right half.
    const DOC: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10">
        <rect x="0" y="0" width="10" height="10" fill="#ff0000"/></svg>"##;

    fn fixture(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, DOC).unwrap();
        path
    }

    #[test]
    fn reports_intrinsic_size() {
        assert_eq!(dims(&fixture("gab_dims.svg")), Some((20, 10)));
    }

    #[test]
    fn rasterizes_to_the_requested_edge_keeping_aspect() {
        // Scaled UP from 20x10: a vector has no source resolution to preserve.
        let img = decode(&fixture("gab_scale.svg"), Some(200)).unwrap();
        assert_eq!(img.dimensions(), (200, 100));
    }

    #[test]
    fn preserves_straight_alpha() {
        let img = decode(&fixture("gab_alpha.svg"), Some(20)).unwrap();
        // tiny-skia composites premultiplied; a demultiply bug shows up as a
        // dimmed red rather than a pure one.
        assert_eq!(img.get_pixel(4, 5).0, [255, 0, 0, 255]);
        assert_eq!(img.get_pixel(15, 5).0[3], 0);
    }
}
