//! Size-aware JPEG decoding for thumbnails.
//!
//! A JPEG is the one texture format in the library that is routinely FAR bigger
//! than any cell that shows it: game art is 1–4K, but a phone photo dropped into
//! an asset folder is 12–50 MP. Decoding all of it to fill a 256px cell measured
//! as the single worst case in the grid — a mean of 148 ms per JPEG against
//! 19 ms per PNG across a real 483-file folder, entirely because of those photos
//! (a 6144×8160 shot took 478 ms, and materialized ~200 MB of RGBA while it did;
//! at eight decode threads that is a ~1.6 GB spike).
//!
//! Both fixes here read the size we need BEFORE decoding pixels, mirroring what
//! `raw.rs` already does for camera RAW:
//!
//! 1. **Embedded EXIF thumbnail.** Every camera writes one (the Pixel shots
//!    above carry 384×510) and it is exactly what Explorer shows. Lifting it
//!    turns a 478 ms decode into ~2 ms. Used only when it is big enough to fill
//!    the requested box at full quality and its aspect matches the full image —
//!    so a stale or cropped thumbnail from an editor can't quietly replace the
//!    real picture.
//! 2. **DCT-scaled decode.** The IDCT can emit 1/8, 1/4 or 1/2 size directly, so
//!    a 256px thumbnail never has to reconstruct 50 MP. Measured 2.1x faster
//!    overall on the same folder (2.5–2.8x on the 12 MP shots) and ~86x smaller
//!    peak allocation, with a mean per-channel difference of ~1/255 against the
//!    full-resolution path.
//!
//! Neither path applies EXIF orientation, exactly like `image::open` — the IFD1
//! thumbnail is stored in the same orientation as the main image, so the two
//! stay consistent with each other and with today's output.
//!
//! Everything else falls through to `image::open` (zune-jpeg), which is the
//! faster decoder when no scaling applies.

use std::path::Path;

use image::DynamicImage;

use crate::raw::{parse_sof, rd_u16, rd_u32};

/// How much of the file to read when looking for the SOF and the EXIF block.
/// APP1 alone can be ~64 KB (its length is a u16) and several APPn segments can
/// precede the frame header, so allow room for all of them — the same 256 KB
/// window `raw::jpeg_dims` uses.
const HEADER_WINDOW: usize = 256 * 1024;

/// Only hand a JPEG to the scaled decoder when the SMALLEST IDCT (1/8) still
/// fills the box — i.e. the source is at least 8x the target.
///
/// jpeg-decoder is the slower implementation per pixel, so the scaling has to
/// buy back more than it costs. Measured at a 256px box: 1/8 scale is 1.8–2.7x
/// faster, but 1/4 and 1/2 are both a few percent SLOWER than letting zune-jpeg
/// decode the whole thing. Those are small images anyway (a 1200px JPEG decodes
/// in ~5 ms); the win that matters is the 12–50 MP one.
const SCALE_FACTOR: u32 = 8;

/// Decode a JPEG no larger than it needs to be. `max_edge` is the longest edge
/// the caller will display (256 for a grid thumb, 4096 for the preview panel);
/// `None` means full resolution ("Copy image") and goes straight to `image::open`.
///
/// Returns `Err` only when the JPEG is genuinely undecodable — every "this
/// shortcut doesn't apply" case falls back to the ordinary full decode.
pub(crate) fn decode_jpeg(p: &Path, max_edge: Option<u32>) -> Result<DynamicImage, String> {
    let Some(edge) = max_edge else {
        return image::open(p).map_err(|e| e.to_string());
    };

    let head = read_head(p);
    // No readable SOF means we can't reason about size at all — let the real
    // decoder produce the error (or succeed, if it copes with what we can't).
    let Some((w, h)) = head.as_deref().and_then(parse_sof) else {
        return image::open(p).map_err(|e| e.to_string());
    };
    let long = w.max(h);
    if long <= edge {
        return image::open(p).map_err(|e| e.to_string()); // already small enough
    }

    if let Some(bytes) = head.as_deref().and_then(|b| exif_thumb(b, w, h, edge)) {
        if let Ok(img) = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg) {
            return Ok(img);
        }
        // A corrupt embedded thumbnail says nothing about the main image.
    }

    if long >= edge.saturating_mul(SCALE_FACTOR) {
        if let Some(img) = scaled_decode(p, edge) {
            return Ok(img);
        }
    }

    image::open(p).map_err(|e| e.to_string())
}

/// The leading `HEADER_WINDOW` bytes (or the whole file, if shorter). `None` on
/// any I/O error — callers treat that as "no header information".
fn read_head(p: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(p).ok()?;
    let mut buf = Vec::with_capacity(HEADER_WINDOW.min(64 * 1024));
    file.take(HEADER_WINDOW as u64).read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Decode at the smallest IDCT scale that still fills an `edge`-sized box.
///
/// `scale(edge, edge)` matches how the thumbnail is resized: jpeg-decoder picks
/// the first scale where EITHER output dimension reaches the request, which for
/// a square request is exactly "the long edge still covers the box".
fn scaled_decode(p: &Path, edge: u32) -> Option<DynamicImage> {
    // Streamed, not slurped: the point of this path is to keep a 50 MP photo's
    // footprint small, and holding its 10 MB of compressed bytes as well would
    // work against that on every decode thread at once.
    let file = std::io::BufReader::new(std::fs::File::open(p).ok()?);
    let mut dec = jpeg_decoder::Decoder::new(file);
    // u16 is the JPEG frame-size type; every real `max_edge` (256/4096) fits.
    let req = u16::try_from(edge).ok()?;
    dec.scale(req, req).ok()?;
    let px = dec.decode().ok()?;
    let info = dec.info()?;
    let (w, h) = (u32::from(info.width), u32::from(info.height));
    match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => {
            image::RgbImage::from_raw(w, h, px).map(DynamicImage::ImageRgb8)
        }
        jpeg_decoder::PixelFormat::L8 => {
            image::GrayImage::from_raw(w, h, px).map(DynamicImage::ImageLuma8)
        }
        // L16 and CMYK32 need conversion `image` already does properly on the
        // full path; both are rare enough not to warrant a second copy of it.
        _ => None,
    }
}

/// The bytes of the embedded EXIF thumbnail, if there is one worth using.
///
/// `full_w`/`full_h` are the main image's dimensions; `edge` the box the caller
/// will fit the result into. Rejects a thumbnail that is too small to fill that
/// box, or whose aspect ratio disagrees with the main image — the cheap guard
/// against an editor leaving a stale or cropped thumbnail behind.
fn exif_thumb(head: &[u8], full_w: u32, full_h: u32, edge: u32) -> Option<&[u8]> {
    let tiff = find_exif_tiff(head)?;
    let (off, len) = ifd1_thumbnail(tiff)?;
    let bytes = tiff.get(off..off.checked_add(len)?)?;
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None; // not a JPEG stream
    }
    let (tw, th) = parse_sof(bytes)?;
    // Short edge, not long: the same conservative rule `raw::choose_preview`
    // applies, so a thumbnail is only ever used at or above native quality.
    if tw.min(th) < edge {
        return None;
    }
    let (a, b) = (f64::from(tw) / f64::from(th), f64::from(full_w) / f64::from(full_h));
    if (a / b - 1.0).abs() > 0.02 {
        return None;
    }
    Some(bytes)
}

/// The TIFF stream inside the `Exif\0\0` APP1 segment. All EXIF offsets are
/// relative to its start, so the returned slice is the base for both.
///
/// Walks the marker segments rather than searching for "Exif" — the literal can
/// occur inside a comment or another APPn payload.
fn find_exif_tiff(b: &[u8]) -> Option<&[u8]> {
    if b.len() < 4 || b[0] != 0xFF || b[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 4 <= b.len() {
        if b[i] != 0xFF {
            return None; // not at a marker boundary — give up rather than guess
        }
        let marker = b[i + 1];
        if marker == 0xFF {
            i += 1; // fill byte
            continue;
        }
        // SOI (D8), EOI (D9), SOS (DA): the first two carry no length word and
        // SOS begins entropy-coded data — either way there are no more APPn
        // segments to find.
        if matches!(marker, 0xD8..=0xDA) {
            return None;
        }
        let seglen = usize::from(u16::from_be_bytes([b[i + 2], b[i + 3]]));
        if seglen < 2 {
            return None;
        }
        let payload = b.get(i + 4..i + 2 + seglen)?;
        if marker == 0xE1 && payload.starts_with(b"Exif\0\0") {
            return payload.get(6..);
        }
        i += 2 + seglen;
    }
    None
}

/// `(offset, length)` of IFD1's `JPEGInterchangeFormat` thumbnail, relative to
/// the TIFF header. IFD1 is the second entry in the IFD chain — that is where
/// the classic EXIF thumbnail lives.
fn ifd1_thumbnail(tiff: &[u8]) -> Option<(usize, usize)> {
    let le = match tiff.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let ifd0 = rd_u32(tiff, 4, le)? as usize;
    let count0 = usize::from(rd_u16(tiff, ifd0, le)?);
    if count0 > 4096 {
        return None;
    }
    // The next-IFD pointer sits immediately after IFD0's entries.
    let ifd1 = rd_u32(tiff, ifd0.checked_add(2 + count0 * 12)?, le)? as usize;
    if ifd1 == 0 {
        return None;
    }
    let count1 = usize::from(rd_u16(tiff, ifd1, le)?);
    if count1 == 0 || count1 > 4096 {
        return None;
    }
    let (mut off, mut len) = (None, None);
    for i in 0..count1 {
        let e = ifd1.checked_add(2 + i * 12)?;
        match rd_u16(tiff, e, le)? {
            0x0201 => off = Some(rd_u32(tiff, e + 8, le)? as usize), // JPEGInterchangeFormat
            0x0202 => len = Some(rd_u32(tiff, e + 8, le)? as usize), // ...Length
            _ => {}
        }
    }
    Some((off?, len?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, GenericImageView, RgbImage};

    fn jpeg_bytes(w: u32, h: u32, tint: u8) -> Vec<u8> {
        let img = DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([tint, (x % 256) as u8, (y % 256) as u8])
        }));
        let mut out = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
            .unwrap();
        out
    }

    /// A JPEG carrying `thumb` as its IFD1 EXIF thumbnail. Hand-assembled
    /// because no encoder we depend on writes EXIF.
    fn with_exif_thumb(main: &[u8], thumb: &[u8]) -> Vec<u8> {
        const THUMB_OFF: u32 = 56; // see the IFD layout below
        let mut tiff: Vec<u8> = Vec::new();
        tiff.extend(b"II");
        tiff.extend(42u16.to_le_bytes());
        tiff.extend(8u32.to_le_bytes()); // -> IFD0
        // IFD0 @8: one entry (Orientation), then the pointer to IFD1.
        tiff.extend(1u16.to_le_bytes());
        tiff.extend(0x0112u16.to_le_bytes());
        tiff.extend(3u16.to_le_bytes());
        tiff.extend(1u32.to_le_bytes());
        tiff.extend(1u16.to_le_bytes());
        tiff.extend([0, 0]);
        tiff.extend(26u32.to_le_bytes()); // -> IFD1
        // IFD1 @26: JPEGInterchangeFormat + Length.
        tiff.extend(2u16.to_le_bytes());
        for (tag, val) in [(0x0201u16, THUMB_OFF), (0x0202, thumb.len() as u32)] {
            tiff.extend(tag.to_le_bytes());
            tiff.extend(4u16.to_le_bytes());
            tiff.extend(1u32.to_le_bytes());
            tiff.extend(val.to_le_bytes());
        }
        tiff.extend(0u32.to_le_bytes()); // no IFD2
        assert_eq!(tiff.len(), THUMB_OFF as usize);
        tiff.extend_from_slice(thumb);

        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        let mut out = vec![0xFF, 0xD8];
        out.extend([0xFF, 0xE1]);
        out.extend(((payload.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(&payload);
        out.extend_from_slice(&main[2..]); // past the main image's own SOI
        out
    }

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("gab_jpeg_test_{name}.jpg"));
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn lifts_a_big_enough_exif_thumbnail() {
        let file = with_exif_thumb(&jpeg_bytes(2048, 2048, 10), &jpeg_bytes(320, 320, 200));
        let p = write_temp("good", &file);
        let img = decode_jpeg(&p, Some(256)).unwrap();
        assert_eq!(img.dimensions(), (320, 320));
    }

    #[test]
    fn ignores_a_thumbnail_too_small_for_the_box() {
        // 320px fills a 256 box but not a 1024 one — the full image must win.
        let file = with_exif_thumb(&jpeg_bytes(2048, 2048, 10), &jpeg_bytes(320, 320, 200));
        let p = write_temp("small", &file);
        assert_eq!(decode_jpeg(&p, Some(1024)).unwrap().dimensions(), (2048, 2048));
    }

    #[test]
    fn ignores_a_thumbnail_whose_aspect_disagrees() {
        // A stale or cropped thumbnail is a different picture — never show it.
        // 1000px is under 8x the box, so rejecting it falls through to a plain
        // full decode and the size alone tells the two apart.
        let file = with_exif_thumb(&jpeg_bytes(1000, 1000, 10), &jpeg_bytes(320, 160, 200));
        let p = write_temp("aspect", &file);
        assert_eq!(decode_jpeg(&p, Some(256)).unwrap().dimensions(), (1000, 1000));
    }

    #[test]
    fn scales_the_idct_when_there_is_no_thumbnail() {
        // 2048 is 8x a 256 box, so the 1/8 IDCT still covers it.
        let p = write_temp("noexif", &jpeg_bytes(2048, 2048, 10));
        assert_eq!(decode_jpeg(&p, Some(256)).unwrap().dimensions(), (256, 256));
        // ...but the preview box and full-res must get every pixel.
        assert_eq!(decode_jpeg(&p, Some(4096)).unwrap().dimensions(), (2048, 2048));
        assert_eq!(decode_jpeg(&p, None).unwrap().dimensions(), (2048, 2048));
    }

    #[test]
    fn leaves_images_smaller_than_the_box_alone() {
        let p = write_temp("tiny", &jpeg_bytes(200, 120, 10));
        assert_eq!(decode_jpeg(&p, Some(256)).unwrap().dimensions(), (200, 120));
    }

    #[test]
    fn refuses_garbage_instead_of_hanging() {
        // A truncated APP1 header must not send the marker walk off the end.
        let p = write_temp("garbage", &[0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x08, b'E', b'x', b'i', b'f']);
        assert!(decode_jpeg(&p, Some(256)).is_err());
        assert!(find_exif_tiff(&[0xFF, 0xD8, 0xFF]).is_none());
        assert!(find_exif_tiff(b"not a jpeg").is_none());
    }
}
