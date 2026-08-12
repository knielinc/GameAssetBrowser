//! AVIF decoding, in pure Rust.
//!
//! An AVIF is a HEIF container holding one AV1 still frame (plus, optionally, a
//! second monochrome frame carrying alpha). `avif-parse` walks the container to
//! those two payloads, `rav1d` — the Rust port of dav1d — decodes them, and the
//! `yuv` crate converts the planes to RGBA.
//!
//! `image`'s own `avif-native` feature was not an option: it binds the C `dav1d`
//! library, which every build machine would then have to provide (meson +
//! pkg-config, neither of which is a given on Windows). rav1d builds with cargo
//! alone.
//!
//! rav1d exposes dav1d's C API rather than a Rust one, hence the `unsafe` — but
//! nothing crosses an FFI boundary, and every allocation is freed on all paths.

use std::mem::MaybeUninit;
use std::path::Path;
use std::ptr::NonNull;

use image::{DynamicImage, RgbaImage};
use rav1d::include::dav1d::data::Dav1dData;
use rav1d::include::dav1d::dav1d::{Dav1dContext, Dav1dSettings};
use rav1d::include::dav1d::headers::{
    Dav1dPixelLayout, DAV1D_PIXEL_LAYOUT_I400, DAV1D_PIXEL_LAYOUT_I420, DAV1D_PIXEL_LAYOUT_I422,
    DAV1D_PIXEL_LAYOUT_I444,
};
use rav1d::include::dav1d::picture::Dav1dPicture;
use rav1d::src::lib::{
    dav1d_close, dav1d_data_create, dav1d_data_unref, dav1d_default_settings, dav1d_get_picture,
    dav1d_open, dav1d_picture_unref, dav1d_send_data,
};
use yuv::{
    yuv400_to_rgba, yuv420_to_rgba, yuv422_to_rgba, yuv444_to_rgba, YuvGrayImage, YuvPlanarImage,
    YuvRange, YuvStandardMatrix,
};

/// Pixel dimensions from the AV1 sequence header alone — no frame is decoded.
/// `texmeta::probe_dims` uses this the way it uses the DDS and PSD header
/// readers: `image::image_dimensions` has no AVIF reader at all.
pub(crate) fn dims(path: &Path) -> Option<(u32, u32)> {
    let mut f = std::fs::File::open(path).ok()?;
    let avif = avif_parse::read_avif(&mut f).ok()?;
    let meta = avif.primary_item_metadata().ok()?;
    Some((meta.max_frame_width.get(), meta.max_frame_height.get()))
}

/// Decode an AVIF file to RGBA.
pub(crate) fn decode(path: &Path) -> Result<DynamicImage, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let avif = avif_parse::read_avif(&mut bytes.as_slice()).map_err(|e| format!("avif: {e}"))?;

    let mut decoder = Decoder::new()?;
    let color = decoder.decode(&avif.primary_item)?;
    let mut img = to_rgba(&color)?;

    // The alpha aux item is a separate monochrome AV1 frame. A failure here is
    // not fatal: an opaque image beats no image at all.
    if let Some(alpha_obu) = &avif.alpha_item {
        match decoder.decode(alpha_obu) {
            Ok(alpha) => apply_alpha(&mut img, &alpha, avif.premultiplied_alpha),
            Err(e) => eprintln!("[avif] {}: alpha channel: {e}", path.display()),
        }
    }
    Ok(DynamicImage::ImageRgba8(img))
}

/// One decoded AV1 still frame, planes copied out tightly packed and narrowed to
/// 8 bits per sample. 10- and 12-bit AVIFs lose their extra bits here: the whole
/// thumbnail/preview pipeline downstream is 8-bit LDR, so keeping them would buy
/// nothing but memory.
struct Frame {
    width: u32,
    height: u32,
    layout: Dav1dPixelLayout,
    range: YuvRange,
    matrix: YuvStandardMatrix,
    /// Y, U, V — Y only for monochrome (I400).
    planes: Vec<Vec<u8>>,
    /// Per-plane `(width, height)`; the plane's stride equals its width.
    dims: Vec<(u32, u32)>,
}

/// Owns a dav1d context so it is closed exactly once, on drop, however the
/// decode exits. Reused for the alpha item — opening a context is the expensive
/// part of a still-image decode.
struct Decoder {
    ctx: Option<Dav1dContext>,
}

impl Decoder {
    fn new() -> Result<Self, String> {
        // SAFETY: `dav1d_default_settings` fully initializes the struct it is
        // handed; `dav1d_open` reads it and writes the context slot.
        unsafe {
            let mut settings = MaybeUninit::<Dav1dSettings>::zeroed();
            dav1d_default_settings(NonNull::new(settings.as_mut_ptr()).unwrap());
            let mut settings = settings.assume_init();
            // One thread per decode: thumbs.rs already runs a decode per core,
            // and a still image is a single frame with nothing to pipeline.
            settings.n_threads = 1;
            settings.max_frame_delay = 1;
            let mut ctx: Option<Dav1dContext> = None;
            let r = dav1d_open(
                NonNull::new(&mut ctx as *mut _),
                NonNull::new(&mut settings as *mut _),
            );
            if r.0 < 0 {
                return Err(format!("dav1d_open failed ({})", r.0));
            }
            Ok(Self { ctx })
        }
    }

    fn decode(&mut self, obu: &[u8]) -> Result<Frame, String> {
        let ctx = self.ctx.ok_or("no decoder context")?;
        // SAFETY: every pointer below points at a live local. `data` is unref'd
        // on every path out, and `pic` is unref'd once its planes are copied.
        unsafe {
            let mut data = Dav1dData::default();
            let buf = dav1d_data_create(NonNull::new(&mut data as *mut _), obu.len());
            if buf.is_null() {
                return Err("dav1d_data_create failed".into());
            }
            std::ptr::copy_nonoverlapping(obu.as_ptr(), buf, obu.len());

            let r = dav1d_send_data(Some(ctx), NonNull::new(&mut data as *mut _));
            if r.0 < 0 {
                dav1d_data_unref(NonNull::new(&mut data as *mut _));
                return Err(format!("dav1d_send_data failed ({})", r.0));
            }
            let mut pic = Dav1dPicture::default();
            let r = dav1d_get_picture(Some(ctx), NonNull::new(&mut pic as *mut _));
            dav1d_data_unref(NonNull::new(&mut data as *mut _));
            if r.0 < 0 {
                return Err(format!("dav1d_get_picture failed ({})", r.0));
            }
            let frame = read_frame(&pic);
            dav1d_picture_unref(NonNull::new(&mut pic as *mut _));
            frame
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        // SAFETY: `ctx` came from `dav1d_open` and is closed exactly once.
        unsafe { dav1d_close(NonNull::new(&mut self.ctx as *mut _)) };
    }
}

/// Copy a decoded picture's planes out of dav1d's buffers.
///
/// # Safety
///
/// `pic` must be a picture filled in by `dav1d_get_picture` and not yet unref'd.
unsafe fn read_frame(pic: &Dav1dPicture) -> Result<Frame, String> {
    let width = pic.p.w.max(0) as u32;
    let height = pic.p.h.max(0) as u32;
    if width == 0 || height == 0 {
        return Err("zero-sized frame".into());
    }
    let bpc = pic.p.bpc;
    let layout = pic.p.layout;
    // Odd dimensions round UP: a 1203-wide 4:2:0 frame carries 602 chroma
    // samples per row, not 601.
    let (chroma_w, chroma_h) = match layout {
        DAV1D_PIXEL_LAYOUT_I400 => (0, 0),
        DAV1D_PIXEL_LAYOUT_I420 => (width.div_ceil(2), height.div_ceil(2)),
        DAV1D_PIXEL_LAYOUT_I422 => (width.div_ceil(2), height),
        DAV1D_PIXEL_LAYOUT_I444 => (width, height),
        other => return Err(format!("unsupported pixel layout {other}")),
    };

    let (range, matrix) = color_space(pic);

    let mut planes = Vec::with_capacity(3);
    let mut dims = Vec::with_capacity(3);
    for i in 0..3usize {
        let (pw, ph) = if i == 0 {
            (width, height)
        } else {
            (chroma_w, chroma_h)
        };
        if pw == 0 || ph == 0 {
            break; // monochrome: no U/V
        }
        let src = pic.data[i].ok_or("missing plane")?.as_ptr() as *const u8;
        // dav1d's rows are padded and 64-byte aligned; stride[0] is luma,
        // stride[1] covers both chroma planes.
        let stride = pic.stride[usize::from(i != 0)];
        let mut out = vec![0u8; (pw as usize) * (ph as usize)];
        for y in 0..ph as usize {
            // SAFETY: dav1d guarantees `ph` rows of `pw` samples at this stride.
            let row = unsafe { src.offset(y as isize * stride) };
            let dst = &mut out[y * pw as usize..][..pw as usize];
            if bpc == 8 {
                // SAFETY: as above; source and destination cannot overlap.
                unsafe { std::ptr::copy_nonoverlapping(row, dst.as_mut_ptr(), pw as usize) };
            } else {
                let shift = (bpc - 8) as u32;
                let row = row as *const u16;
                for (x, d) in dst.iter_mut().enumerate() {
                    // SAFETY: `x < pw`, and the row holds `pw` u16 samples.
                    // read_unaligned because only the 64-byte row start is
                    // guaranteed aligned.
                    *d = (unsafe { row.add(x).read_unaligned() } >> shift).min(255) as u8;
                }
            }
        }
        planes.push(out);
        dims.push((pw, ph));
    }
    Ok(Frame {
        width,
        height,
        layout,
        range,
        matrix,
        planes,
        dims,
    })
}

/// Range + matrix coefficients from the sequence header. AVIF encoders leave
/// both "unspecified" more often than not; BT.601 limited is what libavif falls
/// back to there, so match it rather than inventing a different default.
///
/// # Safety
///
/// `pic`'s `seq_hdr`, if present, must point at a live sequence header.
unsafe fn color_space(pic: &Dav1dPicture) -> (YuvRange, YuvStandardMatrix) {
    let Some(seq) = pic.seq_hdr else {
        return (YuvRange::Limited, YuvStandardMatrix::Bt601);
    };
    // SAFETY: the picture is still referenced, so its sequence header is live.
    let seq = unsafe { seq.as_ref() };
    let range = if seq.color_range != 0 {
        YuvRange::Full
    } else {
        YuvRange::Limited
    };
    // Values are ISO/IEC 23091-2 matrix coefficients.
    let matrix = match seq.mtrx {
        1 => YuvStandardMatrix::Bt709,
        4 => YuvStandardMatrix::Fcc,
        5 | 6 => YuvStandardMatrix::Bt601,
        7 => YuvStandardMatrix::Smpte240,
        9 | 10 => YuvStandardMatrix::Bt2020,
        _ => YuvStandardMatrix::Bt601,
    };
    (range, matrix)
}

/// YUV -> RGBA, alpha left opaque.
fn to_rgba(f: &Frame) -> Result<RgbaImage, String> {
    let mut rgba = vec![0u8; (f.width as usize) * (f.height as usize) * 4];
    let stride = f.width * 4;
    let result = if f.layout == DAV1D_PIXEL_LAYOUT_I400 {
        let gray = YuvGrayImage {
            y_plane: &f.planes[0],
            y_stride: f.dims[0].0,
            width: f.width,
            height: f.height,
        };
        yuv400_to_rgba(&gray, &mut rgba, stride, f.range, f.matrix)
    } else {
        let planar = YuvPlanarImage {
            y_plane: &f.planes[0],
            y_stride: f.dims[0].0,
            u_plane: &f.planes[1],
            u_stride: f.dims[1].0,
            v_plane: &f.planes[2],
            v_stride: f.dims[2].0,
            width: f.width,
            height: f.height,
        };
        match f.layout {
            DAV1D_PIXEL_LAYOUT_I420 => yuv420_to_rgba(&planar, &mut rgba, stride, f.range, f.matrix),
            DAV1D_PIXEL_LAYOUT_I422 => yuv422_to_rgba(&planar, &mut rgba, stride, f.range, f.matrix),
            _ => yuv444_to_rgba(&planar, &mut rgba, stride, f.range, f.matrix),
        }
    };
    result.map_err(|e| format!("yuv -> rgb: {e}"))?;
    RgbaImage::from_raw(f.width, f.height, rgba).ok_or_else(|| "rgba size mismatch".to_string())
}

/// Fold the alpha item's luma plane into the colour image's alpha channel.
/// Mismatched dimensions are ignored rather than stretched — that combination
/// is malformed, and an opaque image is the safer answer.
fn apply_alpha(img: &mut RgbaImage, alpha: &Frame, premultiplied: bool) {
    let (aw, ah) = alpha.dims[0];
    if aw < img.width() || ah < img.height() {
        return;
    }
    let full_range = matches!(alpha.range, YuvRange::Full);
    for y in 0..img.height() {
        for x in 0..img.width() {
            let v = alpha.planes[0][(y * aw + x) as usize];
            // Limited-range alpha is coded 16..=235, exactly like luma.
            let v = if full_range {
                v
            } else {
                (((v as i32 - 16) * 255) / 219).clamp(0, 255) as u8
            };
            img.get_pixel_mut(x, y).0[3] = v;
        }
    }
    if premultiplied {
        for p in img.pixels_mut() {
            let a = p.0[3] as u32;
            if a > 0 && a < 255 {
                for c in &mut p.0[..3] {
                    *c = (*c as u32 * 255 / a).min(255) as u8;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use image::GenericImageView;

    /// 8x4, encoded by `ravif` at quality 100: opaque red left half, fully
    /// transparent right half. Inline rather than a fixture file so the test
    /// exercises the container walk, the AV1 decode, the YUV conversion AND the
    /// separate alpha item without dragging a binary into the repo.
    const RED_WITH_ALPHA: &str = "AAAAGGZ0eXBhdmlmAAAAAG1pZjFtaWFmAAABaG1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAADnBpdG0AAAAAAAEAAAAsaWxvYwAAAABEAAACAAIAAAABAAABiAAAACcAAQAAAAEAAAGvAAAAPAAAADhpaW5mAAAAAAACAAAAFWluZmUCAAAAAAEAAGF2MDEAAAAAFWluZmUCAAAAAAIAAGF2MDEAAAAAGmlyZWYAAAAAAAAADmF1eGwAAgABAAEAAACvaXBycAAAAIppcGNvAAAAFGlzcGUAAAAAAAAACAAAAAQAAAAMYXYxQ4E/QAAAAAAQcGl4aQAAAAADCgoKAAAADGF2MUOBH1wAAAAADnBpeGkAAAAAAQoAAAA4YXV4QwAAAAB1cm46bXBlZzptcGVnQjpjaWNwOnN5c3RlbXM6YXV4aWxpYXJ5OmFscGhhAAAAAB1pcG1hAAAAAAAAAAIAAQMBggMAAgQBhAYFAAAAa21kYXQSAAoFH8h+RqAyHGQEwAAgABAAAAAAAAAAAAQHG6p2MEFgjw/m4LASAAoIP8h+RgIaDaAyLmQEGAAEAAIAAAAAAAAAAACAx3fsrFWLgO2z4V79p1wsEQ1KKtizUJ+/XJ15/Vg=";

    fn fixture() -> std::path::PathBuf {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(RED_WITH_ALPHA)
            .unwrap();
        let path = std::env::temp_dir().join("gab_test.avif");
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn probes_dimensions_without_decoding() {
        assert_eq!(dims(&fixture()), Some((8, 4)));
    }

    #[test]
    fn decodes_color_and_the_alpha_aux_item() {
        let img = decode(&fixture()).unwrap();
        assert_eq!(img.dimensions(), (8, 4));
        let px = img.get_pixel(1, 1).0;
        // AV1 is lossy even at quality 100, and the red survives a YUV round
        // trip — a wrong range or matrix would miss by far more than this.
        assert!(px[0] > 230, "red channel {px:?}");
        assert!(px[1] < 40 && px[2] < 40, "not red: {px:?}");
        assert_eq!(px[3], 255, "left half must be opaque");
        assert!(img.get_pixel(6, 1).0[3] < 16, "right half must be clear");
    }
}
