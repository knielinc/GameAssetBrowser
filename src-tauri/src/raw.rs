//! Camera-RAW thumbnail decoding: lift the embedded JPEG preview rather than
//! debayering the sensor. Split out of `thumbs.rs` because it's the largest and
//! most self-contained decoder — a TIFF/IFD walker (CR2/NEF/ARW/DNG/…), a Fuji
//! RAF header reader, a Canon CR3 ISO-BMFF box parser, and a whole-file JPEG
//! byte-scan fallback — with its own container-parsing risk surface. The only
//! entry point is [`decode_raw`]; everything else is private to this module.

use std::path::Path;

use image::DynamicImage;

/// Camera RAW (.cr2/.nef/.arw/.dng/.raf/…): decode the camera's EMBEDDED JPEG
/// preview rather than debayering the sensor. Every consumer camera writes one,
/// it is already white-balanced and display-ready, and lifting a JPEG out of
/// the file is a fraction of a full demosaic. Same embedded-preview philosophy
/// as `decode_affinity`; no new dependency (the bytes are just a JPEG).
///
/// Two speed levers, both driven by `max_edge` (256 for a grid thumb, 4096 for
/// the preview, None for full-res "Copy image"):
/// * RAW files embed SEVERAL previews (~160px thumb, ~1600px medium, sometimes
///   full-res), so we decode the SMALLEST that still covers `max_edge` — a 256px
///   cell turns a 24MP JPEG decode into a ~1600px one.
/// * We parse the container by seeking (IFDs are tiny) and read ONLY the chosen
///   preview's bytes, instead of slurping the whole 20–60 MB file.
///
/// The slow, robust whole-file scan stays as a fallback for containers the
/// TIFF/RAF parser doesn't handle (CR3 is ISO-BMFF; some RW2 hide the preview).
pub(crate) fn decode_raw(p: &Path, max_edge: Option<u32>) -> Result<DynamicImage, String> {
    let mut file = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();

    // Fast path: container parse + a single targeted read (TIFF-based RAW & RAF).
    if let Some(img) = fast_raw_preview(&mut file, len, max_edge) {
        return Ok(img);
    }

    // CR3 (ISO-BMFF): lift the JPEG straight from the THMB/PRVW boxes. The
    // generic byte scan below is UNUSABLE for CR3 — the 20-30 MB CRAW sensor
    // payload in `mdat` is riddled with coincidental FFD8/FFD9 runs (a real file
    // yields ~270 false "JPEGs"), so choose_preview would pick sensor garbage.
    if is_cr3(&mut file) {
        if let Some(img) = cr3_preview(&mut file, len, max_edge) {
            return Ok(img);
        }
    }

    // Fallback: slurp and byte-scan for any embedded JPEG.
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(len as usize);
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let cands = byte_scan_all(&bytes);
    let idx =
        choose_preview(&cands, max_edge).ok_or_else(|| "raw: no embedded preview".to_string())?;
    let c = &cands[idx];
    let img =
        image::load_from_memory_with_format(&bytes[c.off..c.off + c.len], image::ImageFormat::Jpeg)
            .map_err(|e| format!("raw preview: {e}"))?;
    Ok(apply_orientation(img, 1))
}

/// True iff this is a Canon CR3 (`ftyp` brand `crx `). CR3 is the one RAW we
/// support that isn't TIFF/RAF, so it needs its own extractor.
fn is_cr3(file: &mut std::fs::File) -> bool {
    let mut h = [0u8; 12];
    read_exact_at(file, 0, &mut h).is_some() && &h[4..8] == b"ftyp" && &h[8..12] == b"crx "
}

/// Extract a CR3 preview by walking its ISO-BMFF boxes rather than byte-scanning
/// the whole file. Both JPEG previews — `THMB` (small, inside moov/uuid) and
/// `PRVW` (large, in a top-level uuid) — sit BEFORE the `mdat` sensor payload,
/// so we read only `[0, mdat)` and locate each box by its FourCC, taking its
/// JPEG by the box's own byte bounds (immune to nested EXIF thumbnails and to
/// the FFD8/FFD9 noise in `mdat`).
fn cr3_preview(file: &mut std::fs::File, len: u64, max_edge: Option<u32>) -> Option<DynamicImage> {
    // No mdat found → hand back to the generic fallback rather than guess.
    let mdat = mdat_offset(file, len)?;
    // The preview region is small (a few hundred KB to a few MB); the cap is a
    // pure safety net against a malformed box chain, never hit in practice.
    let limit = mdat.min(len).min(32 * 1024 * 1024) as usize;
    if limit < 8 {
        return None;
    }
    let mut buf = vec![0u8; limit];
    read_exact_at(file, 0, &mut buf)?;

    let mut cands: Vec<Cand> = Vec::new();
    for tag in [&b"THMB"[..], &b"PRVW"[..]] {
        let mut from = 0usize;
        while let Some(rel) = find_bytes(&buf[from..], tag) {
            let q = from + rel; // start of the 4-char box type
            from = q + 4;
            if q < 4 {
                continue;
            }
            // The box's 32-bit big-endian size sits in the 4 bytes before the type.
            let box_start = q - 4;
            let size = match rd_u32(&buf, box_start, false) {
                Some(v) => v as usize,
                None => continue,
            };
            let box_end = match box_start.checked_add(size) {
                Some(e) if size >= 16 && e <= buf.len() => e,
                _ => continue,
            };
            // The JPEG is the first FFD8 in the box and runs to the box boundary.
            if let Some(soi) = find_bytes(&buf[q..box_end], &[0xFF, 0xD8]) {
                let off = q + soi;
                let (w, h) = parse_sof(&buf[off..box_end]).unwrap_or((0, 0));
                cands.push(Cand { off, len: box_end - off, w, h });
            }
        }
    }

    let idx = choose_preview(&cands, max_edge)?;
    let c = cands[idx];
    let img =
        image::load_from_memory_with_format(&buf[c.off..c.off + c.len], image::ImageFormat::Jpeg)
            .ok()?;
    Some(apply_orientation(img, cr3_orientation(&buf)))
}

/// Byte offset of the top-level `mdat` box — the compressed sensor payload.
/// Everything the previews need precedes it. Walks the box chain by size,
/// bounded so a malformed file can't loop or run past EOF.
fn mdat_offset(file: &mut std::fs::File, len: u64) -> Option<u64> {
    let mut pos: u64 = 0;
    let mut hops = 0;
    while pos + 8 <= len && hops < 256 {
        hops += 1;
        let mut hdr = [0u8; 8];
        read_exact_at(file, pos, &mut hdr)?;
        if &hdr[4..8] == b"mdat" {
            return Some(pos);
        }
        let mut size = rd_u32(&hdr, 0, false)? as u64;
        if size == 1 {
            // 64-bit size in the 8 bytes following the header.
            let mut ext = [0u8; 8];
            read_exact_at(file, pos + 8, &mut ext)?;
            size = u64::from_be_bytes(ext);
        }
        // size 0 ("to EOF") or a size smaller than its header is unusable here.
        if size < 8 {
            return None;
        }
        pos = pos.checked_add(size)?;
    }
    None
}

/// CR3 keeps EXIF in a `CMT1` box whose payload is a self-contained TIFF stream.
/// Pull just the Orientation tag (0x0112) from its IFD0 so portrait shots aren't
/// shown sideways; default to 1 (no rotation) on any miss.
fn cr3_orientation(buf: &[u8]) -> u16 {
    let rel = match find_bytes(buf, b"CMT1") {
        Some(r) => r,
        None => return 1,
    };
    let tiff = rel + 4; // the TIFF header follows the FourCC
    let le = match buf.get(tiff..tiff + 2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return 1,
    };
    // IFD0 offset is relative to the TIFF header start.
    let ifd0 = match rd_u32(buf, tiff + 4, le) {
        Some(v) => tiff + v as usize,
        None => return 1,
    };
    let count = match rd_u16(buf, ifd0, le) {
        Some(c) => c as usize,
        None => return 1,
    };
    for i in 0..count.min(4096) {
        let e = ifd0 + 2 + i * 12;
        if rd_u16(buf, e, le) == Some(0x0112) {
            // Orientation is a SHORT stored left-justified in the value field.
            return rd_u16(buf, e + 8, le).unwrap_or(1);
        }
    }
    1
}

/// First index of `needle` in `hay` (small, allocation-free substring search).
fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// A candidate embedded JPEG: where it lives and its decoded size (0 when the
/// SOF couldn't be read — then byte length stands in as a size proxy).
#[derive(Clone, Copy)]
struct Cand {
    off: usize,
    len: usize,
    w: u32,
    h: u32,
}

impl Cand {
    /// Sort key: the shorter edge (what `max_edge` compares against), or the
    /// byte length as a proxy when dimensions are unknown (scaled down so it
    /// never outranks a real pixel edge when a sized candidate exists).
    fn edge(&self) -> u64 {
        if self.w > 0 && self.h > 0 {
            self.w.min(self.h) as u64
        } else {
            (self.len as u64) / 1000
        }
    }
}

/// Pick which preview to decode: the smallest candidate whose short edge still
/// covers `max_edge`; failing that (or when `max_edge` is None), the biggest.
fn choose_preview(cands: &[Cand], max_edge: Option<u32>) -> Option<usize> {
    if cands.is_empty() {
        return None;
    }
    if let Some(target) = max_edge {
        let t = target as u64;
        if let Some((i, _)) = cands
            .iter()
            .enumerate()
            .filter(|(_, c)| c.edge() >= t)
            .min_by_key(|(_, c)| c.edge())
        {
            return Some(i);
        }
    }
    cands
        .iter()
        .enumerate()
        .max_by_key(|(_, c)| c.edge())
        .map(|(i, _)| i)
}

/// Seek-based fast path: RAF header or TIFF IFD walk → candidates (with sizes)
/// → read only the chosen JPEG. Returns None (→ slurp fallback) for containers
/// it doesn't recognise or when nothing decodable is found.
fn fast_raw_preview(
    file: &mut std::fs::File,
    len: u64,
    max_edge: Option<u32>,
) -> Option<DynamicImage> {
    let mut head = [0u8; 16];
    read_exact_at(file, 0, &mut head)?;

    let mut cands: Vec<Cand> = Vec::new();
    let mut orientation: u16 = 1;

    if &head[0..8] == b"FUJIFILM" {
        // Fuji RAF: JPEG offset (BE u32) @ 0x54, length @ 0x58.
        let mut hdr = [0u8; 0x5C];
        read_exact_at(file, 0, &mut hdr)?;
        let off = rd_u32(&hdr, 0x54, false)? as usize;
        let l = rd_u32(&hdr, 0x58, false)? as usize;
        if let Some((w, h)) = jpeg_dims(file, off, l, len) {
            cands.push(Cand { off, len: l, w, h });
        }
    } else {
        // CR2 is "II*\0" too; ORF/RW2 keep the II/MM byte-order sig even when
        // their magic word isn't 42, so key off byte order alone.
        let le = match &head[0..2] {
            b"II" => true,
            b"MM" => false,
            _ => return None,
        };
        let ifd0 = rd_u32(&head, 4, le)?;
        walk_ifds(file, len, le, ifd0, &mut cands, &mut orientation);
        // Fill in sizes and drop anything that isn't really a JPEG.
        cands.retain_mut(|c| match jpeg_dims(file, c.off, c.len, len) {
            Some((w, h)) => {
                c.w = w;
                c.h = h;
                true
            }
            None => false,
        });
    }

    let idx = choose_preview(&cands, max_edge)?;
    let c = cands[idx];
    let mut buf = vec![0u8; c.len];
    read_exact_at(file, c.off as u64, &mut buf)?;
    let img = image::load_from_memory_with_format(&buf, image::ImageFormat::Jpeg).ok()?;
    Some(apply_orientation(img, orientation))
}

/// Walk the TIFF IFD tree (SubIFDs via 0x014A, the Exif IFD via 0x8769, and the
/// IFD1 next-pointer chain), collecting JPEG byte ranges from both
/// `JPEGInterchangeFormat` pointers and single-strip JPEG-compressed IFDs.
/// Every read is a small seek — IFDs are a few hundred bytes each.
fn walk_ifds(
    file: &mut std::fs::File,
    len: u64,
    le: bool,
    ifd0: u32,
    out: &mut Vec<Cand>,
    orientation: &mut u16,
) {
    let mut queue: Vec<u32> = vec![ifd0];
    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut first = true;
    let mut budget = 64; // hard cap: a crafted file cannot spin us forever
    while let Some(off) = queue.pop() {
        if budget == 0 || off == 0 || !seen.insert(off) {
            continue;
        }
        budget -= 1;
        let base = off as u64;
        if base + 2 > len {
            continue;
        }
        let mut cb = [0u8; 2];
        if read_exact_at(file, base, &mut cb).is_none() {
            continue;
        }
        let count = rd_u16(&cb, 0, le).unwrap_or(0) as usize;
        if count == 0 || count > 4096 {
            continue;
        }
        // Read the whole entry block (+ the 4-byte next-IFD pointer) at once.
        let mut buf = vec![0u8; count * 12 + 4];
        if read_exact_at(file, base + 2, &mut buf).is_none() {
            // The final IFD can omit its next-pointer at EOF; retry shorter.
            buf = vec![0u8; count * 12];
            if read_exact_at(file, base + 2, &mut buf).is_none() {
                continue;
            }
        }
        let mut jpg_off: Option<usize> = None;
        let mut jpg_len: Option<usize> = None;
        let mut compression: u16 = 0;
        let mut strip_off: Option<usize> = None;
        let mut strip_len: Option<usize> = None;
        for i in 0..count {
            let e = i * 12;
            let tag = match rd_u16(&buf, e, le) {
                Some(t) => t,
                None => break,
            };
            let ftype = rd_u16(&buf, e + 2, le).unwrap_or(0);
            let cnt = rd_u32(&buf, e + 4, le).unwrap_or(0);
            // A SHORT value is stored left-justified in the 4-byte value field.
            let v16 = rd_u16(&buf, e + 8, le).unwrap_or(0);
            let v32 = rd_u32(&buf, e + 8, le).unwrap_or(0);
            match tag {
                0x0112 if first => *orientation = v16,       // Orientation
                0x0103 => compression = v16,                 // Compression
                0x0111 if cnt == 1 => strip_off = Some(v32 as usize), // StripOffsets
                0x0117 if cnt == 1 => strip_len = Some(v32 as usize), // StripByteCounts
                0x0201 => jpg_off = Some(v32 as usize),      // JPEGInterchangeFormat
                0x0202 => jpg_len = Some(v32 as usize),      // ...Length
                0x014A => read_subifds(file, le, ftype, cnt, v32, &mut queue), // SubIFDs
                0x8769 => queue.push(v32),                   // Exif IFD
                _ => {}
            }
        }
        // Next IFD in the chain (IFD1 holds the classic thumbnail on many cams).
        if buf.len() >= count * 12 + 4 {
            if let Some(next) = rd_u32(&buf, count * 12, le) {
                if next != 0 {
                    queue.push(next);
                }
            }
        }
        first = false;

        if let (Some(o), Some(l)) = (jpg_off, jpg_len) {
            if l >= 4 {
                out.push(Cand { off: o, len: l, w: 0, h: 0 });
            }
        }
        // A JPEG/YCbCr-compressed single strip is a preview too (DNG/ARW store
        // their big preview this way rather than via JPEGInterchangeFormat).
        if matches!(compression, 6 | 7) {
            if let (Some(o), Some(l)) = (strip_off, strip_len) {
                if l >= 4 {
                    out.push(Cand { off: o, len: l, w: 0, h: 0 });
                }
            }
        }
    }
}

/// SubIFDs (tag 0x014A): one inline offset when count==1, else a pointer to an
/// array of `count` LONG offsets (capped so a bogus count can't over-read).
fn read_subifds(
    file: &mut std::fs::File,
    le: bool,
    ftype: u16,
    cnt: u32,
    val: u32,
    queue: &mut Vec<u32>,
) {
    if cnt == 1 {
        queue.push(val); // offset stored inline
        return;
    }
    if ftype != 4 {
        return; // LONG offsets only
    }
    let n = cnt.min(16) as usize;
    let mut buf = vec![0u8; n * 4];
    if read_exact_at(file, val as u64, &mut buf).is_none() {
        return;
    }
    for i in 0..n {
        if let Some(o) = rd_u32(&buf, i * 4, le) {
            queue.push(o);
        }
    }
}

/// Read a JPEG's decoded dimensions from its SOF, reading only a bounded header
/// window (APP1/EXIF can be tens of KB, so allow up to 256 KB) — not the whole
/// preview. Also doubles as the "is this actually a JPEG" check via the SOI.
fn jpeg_dims(file: &mut std::fs::File, off: usize, claimed_len: usize, file_len: u64) -> Option<(u32, u32)> {
    let off = off as u64;
    if off >= file_len {
        return None;
    }
    let avail = file_len - off;
    let want = (claimed_len as u64).min(avail).min(256 * 1024) as usize;
    if want < 4 {
        return None;
    }
    let mut buf = vec![0u8; want];
    read_exact_at(file, off, &mut buf)?;
    if buf[0] != 0xFF || buf[1] != 0xD8 {
        return None; // not a JPEG (no SOI)
    }
    parse_sof(&buf)
}

/// Scan JPEG marker segments for the Start-Of-Frame and return (width, height).
/// SOF always precedes the scan data, so we return before hitting entropy bytes.
fn parse_sof(b: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2usize; // past the SOI
    while i + 9 < b.len() {
        if b[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = b[i + 1];
        // Padding and standalone markers (no length word).
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        let seglen = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        // SOF0..SOF15 carry the frame size; skip DHT(C4)/JPG(C8)/DAC(CC).
        if matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
            let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
            return if w > 0 && h > 0 { Some((w, h)) } else { None };
        }
        if seglen < 2 {
            return None;
        }
        i += 2 + seglen;
    }
    None
}

/// Whole-file scan for every `FFD8 … FFD9` JPEG run (with SOF sizes). Fallback
/// for containers the TIFF/RAF parser can't walk — CR3 (ISO-BMFF) and the odd
/// RW2 — as long as a JPEG is embedded somewhere.
fn byte_scan_all(bytes: &[u8]) -> Vec<Cand> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 1 < bytes.len() {
        if bytes[i] == 0xFF && bytes[i + 1] == 0xD8 {
            let mut j = i + 2;
            let mut found = false;
            while j + 1 < bytes.len() {
                if bytes[j] == 0xFF && bytes[j + 1] == 0xD9 {
                    let l = j + 2 - i;
                    let (w, h) = parse_sof(&bytes[i..i + l]).unwrap_or((0, 0));
                    out.push(Cand { off: i, len: l, w, h });
                    i = j + 2;
                    found = true;
                    break;
                }
                j += 1;
            }
            if !found {
                break;
            }
        } else {
            i += 1;
        }
    }
    out
}

/// `seek + read_exact` into `buf`; None on any I/O error or short read.
fn read_exact_at(file: &mut std::fs::File, off: u64, buf: &mut [u8]) -> Option<()> {
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(off)).ok()?;
    file.read_exact(buf).ok()?;
    Some(())
}

fn rd_u16(b: &[u8], o: usize, le: bool) -> Option<u16> {
    let s = b.get(o..o + 2)?;
    Some(if le {
        u16::from_le_bytes([s[0], s[1]])
    } else {
        u16::from_be_bytes([s[0], s[1]])
    })
}

fn rd_u32(b: &[u8], o: usize, le: bool) -> Option<u32> {
    let s = b.get(o..o + 4)?;
    Some(if le {
        u32::from_le_bytes([s[0], s[1], s[2], s[3]])
    } else {
        u32::from_be_bytes([s[0], s[1], s[2], s[3]])
    })
}

/// Rotate/flip a decoded preview per its EXIF orientation (1..=8). Portrait
/// shots (6/8) are the common ones; the mirror cases (2/4/5/7) are rare and
/// handled best-effort.
fn apply_orientation(img: DynamicImage, orient: u16) -> DynamicImage {
    match orient {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}
