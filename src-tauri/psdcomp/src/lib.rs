//! Reads ONLY a Photoshop file's flattened composite, at a requested size.
//!
//! Opening a 90 MB .psd used to mean handing all 90 MB to the webview and
//! decoding it there — about two seconds before anything appeared. Almost none
//! of that work is needed to show the picture, because of two properties of the
//! format:
//!
//!  * A PSD is a chain of length-prefixed sections, and the layer section —
//!    which is nearly the whole file — can be **skipped by seeking**. Its length
//!    field sits at a known offset; the flattened image follows it.
//!  * The flattened image is RLE-compressed **row by row**, preceded by a table
//!    of per-row byte counts. That table turns the image into a random-access
//!    structure: the byte range of any single row is known without decoding a
//!    single one before it.
//!
//! So a preview at 1/4 size reads and decodes about 1/4 of the rows and touches
//! a few megabytes of a 90 MB file. Cost scales with the SIZE ASKED FOR, not
//! with the size of the document, which is what makes an instant first paint
//! possible for arbitrarily large files.
//!
//! Handles 8- and 16-bit RGB and grayscale, raw or RLE. Anything else returns
//! None and the caller falls back to a full parse in the webview.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub struct Composite {
    /// Straight (non-premultiplied) RGBA8.
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

fn be16(b: &[u8], o: usize) -> u32 {
    u32::from(b[o]) << 8 | u32::from(b[o + 1])
}
fn be32(b: &[u8], o: usize) -> u64 {
    (u64::from(b[o]) << 24) | (u64::from(b[o + 1]) << 16) | (u64::from(b[o + 2]) << 8) | u64::from(b[o + 3])
}

struct Header {
    channels: usize,
    width: u32,
    height: u32,
    /// Bytes per sample: 1, 2 or 4.
    sample: usize,
    /// 1 = grayscale, 3 = RGB.
    color_mode: u32,
    large: bool,
}

/// One big-endian sample, narrowed to 8 bits.
///
/// 8- and 16-bit are integer and the high byte IS the answer, so the stride
/// does the work. 32-bit is scene-linear float and has to be gamma-encoded, the
/// same 1/2.2 ag-psd applies — without it a float document renders washed out.
#[inline]
fn sample8(b: &[u8], sample: usize) -> u8 {
    match sample {
        4 => {
            let v = f32::from_be_bytes([b[0], b[1], b[2], b[3]]);
            let v = if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 };
            (v.powf(1.0 / 2.2) * 255.0 + 0.5) as u8
        }
        _ => b[0],
    }
}

fn read_header(f: &mut File) -> Option<Header> {
    let mut h = [0u8; 26];
    f.read_exact(&mut h).ok()?;
    if &h[0..4] != b"8BPS" {
        return None;
    }
    let version = be16(&h, 4);
    if version != 1 && version != 2 {
        return None;
    }
    let channels = be16(&h, 12) as usize;
    let height = be32(&h, 14) as u32;
    let width = be32(&h, 18) as u32;
    let depth = be16(&h, 22);
    let color_mode = be16(&h, 24);
    if width == 0 || height == 0 || channels == 0 || channels > 16 {
        return None;
    }
    if depth != 8 && depth != 16 && depth != 32 {
        return None;
    }
    if color_mode != 1 && color_mode != 3 {
        return None;
    }
    Some(Header {
        channels,
        width,
        height,
        sample: (depth / 8) as usize,
        color_mode,
        large: version == 2,
    })
}

/// Seek past colour-mode data, image resources and the layer section, landing
/// on the composite's compression word. Returns (compression, byte offset just
/// past it).
fn seek_to_composite(f: &mut File, large: bool) -> Option<(u16, u64)> {
    let mut pos = 26u64;
    for section in 0..3 {
        // The layer-and-mask section's length field is 8 bytes wide in PSB.
        let wide = large && section == 2;
        let n = if wide { 8 } else { 4 };
        let mut lb = [0u8; 8];
        f.read_exact(&mut lb[..n]).ok()?;
        let len = if wide {
            u64::from_be_bytes(lb)
        } else {
            be32(&lb, 0)
        };
        pos = pos.checked_add(n as u64)?.checked_add(len)?;
        f.seek(SeekFrom::Start(pos)).ok()?;
    }
    let mut cb = [0u8; 2];
    f.read_exact(&mut cb).ok()?;
    Some((u16::from_be_bytes(cb), pos + 2))
}

/// Unpack one PackBits row into `out` (cleared first), padded to `want` bytes.
fn unpack_rle(src: &[u8], want: usize, out: &mut Vec<u8>) {
    out.clear();
    let mut i = 0usize;
    while i < src.len() && out.len() < want {
        let n = src[i] as i8;
        i += 1;
        if n >= 0 {
            let len = n as usize + 1;
            let end = (i + len).min(src.len());
            out.extend_from_slice(&src[i..end]);
            i = end;
        } else if n != -128 {
            // Parenthesised deliberately: `1 - n as isize as usize` would parse
            // as `1 - ((n as isize) as usize)` and underflow for every negative
            // n — a debug-build panic that only "works" in release by wrapping.
            let len = (1 - n as isize) as usize;
            if i >= src.len() {
                break;
            }
            let b = src[i];
            i += 1;
            out.resize((out.len() + len).min(want), b);
        }
    }
    out.resize(want, 0);
}

/// Byte length of the file prefix that contains the whole LAYER TREE.
///
/// A layer's record — bounds, blend, opacity, clipping, mask, name, and every
/// additional-info block (effects, adjustments, text, vector masks) — is stored
/// before any channel pixels: all the records come first, then all the pixel
/// data. So a reader that only wants the tree needs a prefix, not the file, and
/// this returns where that prefix ends.
///
/// Walking the records needs no interpretation, only arithmetic: each one is a
/// fixed header plus a length-prefixed blob. Returns None if the file has no
/// layer section (a flattened document).
pub fn records_end(path: &Path) -> Option<u64> {
    let mut f = File::open(path).ok()?;
    let head = read_header(&mut f)?;
    let large = head.large;

    // Skip colour-mode data and image resources.
    let mut pos = 26u64;
    for _ in 0..2 {
        let mut lb = [0u8; 4];
        f.read_exact(&mut lb).ok()?;
        pos = pos.checked_add(4)?.checked_add(be32(&lb, 0))?;
        f.seek(SeekFrom::Start(pos)).ok()?;
    }

    // Layer-and-mask section, then the layer-info block inside it.
    let n = if large { 8 } else { 4 };
    let mut lb = [0u8; 8];
    f.read_exact(&mut lb[..n]).ok()?;
    let mask_len = if large { u64::from_be_bytes(lb) } else { be32(&lb, 0) };
    if mask_len == 0 {
        return None;
    }
    pos += n as u64;
    let mask_end = pos + mask_len;

    f.read_exact(&mut lb[..n]).ok()?;
    let info_len = if large { u64::from_be_bytes(lb) } else { be32(&lb, 0) };
    pos += n as u64;
    if info_len == 0 {
        return None;
    }

    let mut cb = [0u8; 2];
    f.read_exact(&mut cb).ok()?;
    pos += 2;
    // Negative count means the first alpha channel is the document's
    // transparency; the magnitude is still the layer count.
    let count = (i16::from_be_bytes(cb)).unsigned_abs() as u64;

    for _ in 0..count {
        // rect(16) + channel count(2)
        let mut fixed = [0u8; 18];
        f.read_exact(&mut fixed).ok()?;
        pos += 18;
        let channels = be16(&fixed, 16) as u64;
        // Per channel: id(2) + data length(4, or 8 in PSB).
        let per = 2 + if large { 8 } else { 4 };
        let skip = channels.checked_mul(per)?;
        // signature(4) + key(4) + opacity/clipping/flags/filler(4)
        let skip = skip.checked_add(12)?;
        pos = pos.checked_add(skip)?;
        f.seek(SeekFrom::Start(pos)).ok()?;

        let mut eb = [0u8; 4];
        f.read_exact(&mut eb).ok()?;
        pos = pos.checked_add(4)?.checked_add(be32(&eb, 0))?;
        if pos > mask_end {
            return None; // malformed — don't hand back a bogus prefix
        }
        f.seek(SeekFrom::Start(pos)).ok()?;
    }
    Some(pos)
}

/// Decode the composite, box-downscaled so its longest edge is at most
/// `max_edge`. Reads only the rows the downscale samples.
pub fn from_file(path: &Path, max_edge: u32) -> Option<Composite> {
    let mut f = File::open(path).ok()?;
    let head = read_header(&mut f)?;
    let (compression, data_start) = seek_to_composite(&mut f, head.large)?;

    let Header { width, height, sample, color_mode, .. } = head;
    let color_channels = if color_mode == 3 { 3 } else { 1 };
    // Colour channels plus alpha if present; extras (spot channels) are ignored.
    let used = head.channels.min(color_channels + 1);
    let row_bytes = (width as usize).checked_mul(sample)?;

    let scale = (width.max(height) as f32 / max_edge.max(1) as f32).max(1.0);
    let ow = (((width as f32) / scale).round() as u32).max(1);
    let oh = (((height as f32) / scale).round() as u32).max(1);

    // Source column spans for each output column, precomputed once.
    let xs: Vec<(usize, usize)> = (0..ow)
        .map(|x| {
            let a = ((x as f32 * scale) as usize).min(width as usize - 1);
            let b = (((x + 1) as f32 * scale) as usize).clamp(a + 1, width as usize);
            (a, b)
        })
        .collect();
    // Source row for each output row (centre sample; the box average is
    // horizontal only — vertical averaging would mean reading every row, which
    // is exactly the cost this reader exists to avoid).
    let ys: Vec<u32> = (0..oh)
        .map(|y| (((y as f32 + 0.5) * scale) as u32).min(height - 1))
        .collect();

    let mut out = vec![0u8; (ow as usize).checked_mul(oh as usize)?.checked_mul(4)?];

    // Row byte ranges. Raw rows are a fixed stride; RLE rows come from the
    // per-row count table that precedes the data.
    let nrows = height as usize * head.channels;
    let mut offsets: Vec<u64> = Vec::new();
    let mut lengths: Vec<u32> = Vec::new();
    if compression == 1 {
        let count_size = if head.large { 4 } else { 2 };
        let mut table = vec![0u8; nrows * count_size];
        f.seek(SeekFrom::Start(data_start)).ok()?;
        f.read_exact(&mut table).ok()?;
        offsets.reserve(nrows);
        lengths.reserve(nrows);
        let mut acc = data_start + (nrows * count_size) as u64;
        for i in 0..nrows {
            let o = i * count_size;
            let len = if head.large { be32(&table, o) as u32 } else { be16(&table, o) as u32 };
            offsets.push(acc);
            lengths.push(len);
            acc = acc.checked_add(u64::from(len))?;
        }
    } else if compression != 0 {
        return None; // zip-compressed composites are vanishingly rare
    }

    let mut raw = Vec::new();
    let mut row = vec![0u8; row_bytes];
    for ch in 0..used {
        for (oy, &sy) in ys.iter().enumerate() {
            if compression == 0 {
                let at = data_start
                    + ((ch * height as usize + sy as usize) as u64) * row_bytes as u64;
                f.seek(SeekFrom::Start(at)).ok()?;
                f.read_exact(&mut row).ok()?;
            } else {
                let idx = ch * height as usize + sy as usize;
                let len = *lengths.get(idx)? as usize;
                raw.resize(len, 0);
                f.seek(SeekFrom::Start(*offsets.get(idx)?)).ok()?;
                f.read_exact(&mut raw).ok()?;
                let mut unpacked = Vec::with_capacity(row_bytes);
                unpack_rle(&raw, row_bytes, &mut unpacked);
                row.copy_from_slice(&unpacked);
            }
            for (ox, &(a, b)) in xs.iter().enumerate() {
                let mut sum = 0u32;
                for sx in a..b {
                    sum += u32::from(sample8(&row[sx * sample..], sample));
                }
                let v = (sum / (b - a) as u32) as u8;
                let o = (oy * ow as usize + ox) * 4;
                match (color_mode, ch) {
                    (1, 0) => {
                        out[o] = v;
                        out[o + 1] = v;
                        out[o + 2] = v;
                    }
                    (1, 1) | (3, 3) => out[o + 3] = v,
                    (3, c) if c < 3 => out[o + c] = v,
                    _ => {}
                }
            }
        }
    }

    // A document with no alpha channel is fully opaque.
    if head.channels <= color_channels {
        for px in out.chunks_exact_mut(4) {
            px[3] = 255;
        }
    }
    Some(Composite { rgba: out, width: ow, height: oh })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Minimal PSD: header, three empty sections, composite image data.
    fn tiny_psd(w: u32, h: u32, compression: u16, planes: &[Vec<u8>]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(b"8BPS");
        b.extend_from_slice(&1u16.to_be_bytes());
        b.extend_from_slice(&[0u8; 6]);
        b.extend_from_slice(&(planes.len() as u16).to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&8u16.to_be_bytes());
        b.extend_from_slice(&3u16.to_be_bytes());
        for _ in 0..3 {
            b.extend_from_slice(&0u32.to_be_bytes());
        }
        b.extend_from_slice(&compression.to_be_bytes());
        if compression == 0 {
            for p in planes {
                b.extend_from_slice(p);
            }
        } else {
            let mut rows: Vec<Vec<u8>> = Vec::new();
            for p in planes {
                for r in p.chunks(w as usize) {
                    let mut enc = Vec::new();
                    enc.push((r.len() - 1) as u8);
                    enc.extend_from_slice(r);
                    rows.push(enc);
                }
            }
            for r in &rows {
                b.extend_from_slice(&(r.len() as u16).to_be_bytes());
            }
            for r in &rows {
                b.extend_from_slice(r);
            }
        }
        b
    }

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(name);
        let mut f = File::create(&p).unwrap();
        f.write_all(bytes).unwrap();
        p
    }

    #[test]
    fn reads_raw_and_rle_identically() {
        let r = vec![10u8, 20, 30, 40];
        let g = vec![50u8, 60, 70, 80];
        let bl = vec![90u8, 100, 110, 120];
        for comp in [0u16, 1u16] {
            let p = write_temp(
                &format!("psdcomp-{comp}.psd"),
                &tiny_psd(2, 2, comp, &[r.clone(), g.clone(), bl.clone()]),
            );
            let c = from_file(&p, 4096).expect("decodes");
            assert_eq!((c.width, c.height), (2, 2));
            assert_eq!(&c.rgba[0..4], &[10, 50, 90, 255], "compression {comp}");
            assert_eq!(&c.rgba[12..16], &[40, 80, 120, 255]);
            let _ = std::fs::remove_file(&p);
        }
    }

    #[test]
    fn downscales_by_averaging_columns() {
        let r = vec![0u8, 100, 200, 250];
        let p = write_temp(
            "psdcomp-scale.psd",
            &tiny_psd(4, 1, 0, &[r, vec![0; 4], vec![0; 4]]),
        );
        let c = from_file(&p, 2).unwrap();
        assert_eq!((c.width, c.height), (2, 1));
        assert_eq!(c.rgba[0], 50); // avg(0, 100)
        assert_eq!(c.rgba[4], 225); // avg(200, 250)
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn skips_the_layer_section_by_its_length() {
        // Same image, but with a fat layer section in between: the reader must
        // land on the composite regardless of what it contains.
        let planes = [vec![7u8], vec![8u8], vec![9u8]];
        let mut b = Vec::new();
        b.extend_from_slice(b"8BPS");
        b.extend_from_slice(&1u16.to_be_bytes());
        b.extend_from_slice(&[0u8; 6]);
        b.extend_from_slice(&3u16.to_be_bytes());
        b.extend_from_slice(&1u32.to_be_bytes());
        b.extend_from_slice(&1u32.to_be_bytes());
        b.extend_from_slice(&8u16.to_be_bytes());
        b.extend_from_slice(&3u16.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes()); // colour mode data
        b.extend_from_slice(&4u32.to_be_bytes()); // image resources
        b.extend_from_slice(&[0xAB; 4]);
        b.extend_from_slice(&64u32.to_be_bytes()); // layer section
        b.extend_from_slice(&[0xCD; 64]);
        b.extend_from_slice(&0u16.to_be_bytes()); // raw
        for p in &planes {
            b.extend_from_slice(p);
        }
        let p = write_temp("psdcomp-skip.psd", &b);
        let c = from_file(&p, 4096).unwrap();
        assert_eq!(&c.rgba[0..4], &[7, 8, 9, 255]);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn gamma_encodes_32_bit_float_samples() {
        // 1x1 float RGB: mid-grey in linear light is ~0.73 after 1/2.2.
        let mut b = Vec::new();
        b.extend_from_slice(b"8BPS");
        b.extend_from_slice(&1u16.to_be_bytes());
        b.extend_from_slice(&[0u8; 6]);
        b.extend_from_slice(&3u16.to_be_bytes());
        b.extend_from_slice(&1u32.to_be_bytes());
        b.extend_from_slice(&1u32.to_be_bytes());
        b.extend_from_slice(&32u16.to_be_bytes());
        b.extend_from_slice(&3u16.to_be_bytes());
        for _ in 0..3 {
            b.extend_from_slice(&0u32.to_be_bytes());
        }
        b.extend_from_slice(&0u16.to_be_bytes()); // raw
        for v in [0.5f32, 1.0, 0.0] {
            b.extend_from_slice(&v.to_be_bytes());
        }
        let p = write_temp("psdcomp-f32.psd", &b);
        let c = from_file(&p, 512).unwrap();
        assert!((c.rgba[0] as i32 - 186).abs() <= 2, "got {}", c.rgba[0]);
        assert_eq!(c.rgba[1], 255);
        assert_eq!(c.rgba[2], 0);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn records_end_lands_before_the_channel_data() {
        // One layer whose record is 18 + 1 channel(2+4) + 12 + 4 + 5 extra
        // bytes, followed by pixel data that must NOT be included.
        let mut layer = Vec::new();
        layer.extend_from_slice(&[0u8; 16]); // rect
        layer.extend_from_slice(&1u16.to_be_bytes()); // channel count
        layer.extend_from_slice(&0i16.to_be_bytes()); // channel id
        layer.extend_from_slice(&99u32.to_be_bytes()); // channel data length
        layer.extend_from_slice(b"8BIMnorm");
        layer.extend_from_slice(&[255, 0, 0, 0]); // opacity/clip/flags/filler
        layer.extend_from_slice(&5u32.to_be_bytes()); // extra length
        layer.extend_from_slice(&[1, 2, 3, 4, 5]);
        let records_len = layer.len();

        let mut info = Vec::new();
        info.extend_from_slice(&1i16.to_be_bytes()); // layer count
        info.extend_from_slice(&layer);
        info.extend_from_slice(&[0xEE; 99]); // channel data

        let mut mask = Vec::new();
        mask.extend_from_slice(&(info.len() as u32).to_be_bytes());
        mask.extend_from_slice(&info);

        let mut b = Vec::new();
        b.extend_from_slice(b"8BPS");
        b.extend_from_slice(&1u16.to_be_bytes());
        b.extend_from_slice(&[0u8; 6]);
        b.extend_from_slice(&3u16.to_be_bytes());
        b.extend_from_slice(&1u32.to_be_bytes());
        b.extend_from_slice(&1u32.to_be_bytes());
        b.extend_from_slice(&8u16.to_be_bytes());
        b.extend_from_slice(&3u16.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes()); // colour mode data
        b.extend_from_slice(&0u32.to_be_bytes()); // image resources
        b.extend_from_slice(&(mask.len() as u32).to_be_bytes());
        b.extend_from_slice(&mask);

        let p = write_temp("psdcomp-records.psd", &b);
        let end = records_end(&p).expect("finds the boundary");
        // 26 header + 4 + 4 colour/resources + 4 mask len + 4 info len + 2 count
        let expected = 26 + 4 + 4 + 4 + 4 + 2 + records_len as u64;
        assert_eq!(end, expected);
        assert!(end < b.len() as u64, "prefix must exclude the channel data");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn records_end_declines_a_flattened_document() {
        let p = write_temp("psdcomp-flat.psd", &tiny_psd(2, 2, 0, &[vec![1; 4], vec![2; 4], vec![3; 4]]));
        assert!(records_end(&p).is_none());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn rejects_what_it_cannot_read() {
        let p = write_temp("psdcomp-bad.psd", b"NOT A PSD FILE AT ALL");
        assert!(from_file(&p, 512).is_none());
        let _ = std::fs::remove_file(&p);
    }
}
