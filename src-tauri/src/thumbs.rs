//! Texture thumbnails: decode in Rust, cache in ONE file, serve over a custom
//! URI scheme.
//!
//! Rust decodes because Chromium cannot read DDS/TGA/EXR/HDR at all, and even
//! for PNG a 4K image in a 128px cell would decode at full resolution â€” 200
//! visible cells of that is an OOM, not a slow frame.
//!
//! Storage is a single append-only blob (see `thumbcache.rs`), not thousands
//! of loose PNGs â€” one tidy file in the data folder instead of clutter.
//!
//! Two channels, mirroring `waveform.rs`'s split of "cheap request, fat
//! result":
//!
//! ```text
//! invoke request_thumbs(ids, gen)   <- cheap, cancellable, batched
//!   -> worker pool decodes + writes the PNG into thumbs.cache
//!   -> event thumb:ready            <- cheap notification: "key K exists"
//!   -> frontend sets <img src="http://thumb.localhost/K">
//!   -> WebView2 GETs it             <- the fat payload, off the JS main thread
//! ```
//!
//! The protocol handler NEVER decodes. Memory LRU -> blob -> 404. Decoding
//! inside it would block on a 4K PNG with no cancellation and no batching â€”
//! exactly what this design exists to avoid.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView};
use lru::LruCache;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::thumbcache::{Pixels, ThumbCache};
use crate::types::{events, ThumbBatch, ThumbInfo};

/// Thumbnail edge in px. 256 covers the largest grid cell (220) plus a little
/// headroom for hi-dpi without storing a second size.
const THUMB_EDGE: u32 = 256;
/// Preview edge in px. The grid keeps its 256px thumbnail, but the preview
/// panel (and the 3D surface / HDRI env sphere) wants the real pixels â€” a 5K
/// HDR through the 256px thumb is a blurry mess on a fullscreen panorama. 4096
/// is source-quality for all but the largest maps, 16x the grid thumb, and
/// stays under the WebGL2 max-texture-size on essentially all hardware.
const PREVIEW_EDGE: u32 = 4096;
/// Bump to invalidate every cached thumbnail after a pipeline change.
/// v2: default tone-mapper for HDR/EXR thumbnails changed Reinhard -> ACES and
/// gamma 2.2 -> accurate sRGB (see tonemap.rs).
const CACHE_VERSION: u32 = 2;
/// Decode threads. Higher than metadata.rs's 2 because this is CPU-bound
/// decode rather than disk probes, but capped: each in-flight 4K RGBA decode
/// is ~64 MB resident, so 4 workers is a ~256 MB ceiling.
const DECODE_THREADS: usize = 4;
const FLUSH_MS: u64 = 100;

pub struct ThumbState {
    /// path -> cache key. Read on the way in so a re-scrolled cell skips both
    /// the disk probe and the PNG re-decode that `build` would otherwise do
    /// just to recompute stats.
    cache: Mutex<LruCache<String, (String, ThumbInfo)>>,
    queue: Mutex<Vec<Job>>,
    running: Mutex<bool>,
}

/// Cache of full-resolution preview PNGs, keyed by `path|size|mtime`. Small â€”
/// the preview shows one asset (a handful of channels) at a time, and each
/// entry is a multi-MB decoded PNG, so a big LRU would just hoard RAM.
pub struct PreviewState {
    cache: Mutex<LruCache<String, Arc<Vec<u8>>>>,
}

impl Default for PreviewState {
    fn default() -> Self {
        Self {
            cache: Mutex::new(LruCache::new(std::num::NonZeroUsize::new(16).unwrap())),
        }
    }
}

/// Decode a texture to a full-resolution, browser-loadable PNG for the preview
/// panel. Served over the `preview://` scheme for formats the browser cannot
/// decode itself (HDR/EXR/DDS/TGA/TIFF); browser-decodable originals go straight
/// over `model://` at native resolution instead, skipping this re-encode.
///
/// HDR/EXR are tone-mapped by [`to_ldr`] exactly like the thumbnail, so an HDRI
/// looks identical to its grid cell â€” just sharp. Decode + resize + PNG encode
/// is expensive, so results are cached by path+stamp.
///
/// Same consent gate as `model://`: only files inside a scanned root are read,
/// so a crafted path cannot exfiltrate an arbitrary file.
pub fn preview_png(
    app: &AppHandle,
    decoded_path: &str,
    tm: crate::tonemap::Tonemap,
    exposure_ev: f32,
) -> Option<Vec<u8>> {
    if decoded_path.is_empty() {
        return None;
    }
    // Same "/"-separated, leading-slash-stripped shape as model://: on Windows
    // rebuild "C:/Pack/x" -> "C:\Pack\x"; on Unix re-add the root the scheme
    // handler's trim_start_matches('/') removed.
    #[cfg(windows)]
    let path = std::path::PathBuf::from(decoded_path.replace('/', "\\"));
    #[cfg(not(windows))]
    let path = std::path::PathBuf::from(format!("/{decoded_path}"));
    if !crate::scanner::is_within_roots(app, &path) {
        eprintln!("[preview] refused out-of-scope read: {}", path.display());
        return None;
    }

    let (size, mtime) = file_stamp(&path);
    // Operator + exposure are in the key: the same HDRI at ACES/+1EV and
    // AgX/0EV are different pixels and must cache separately.
    let ckey = format!("{}|{size}|{mtime}|{}|{exposure_ev}", path.display(), tm.id());
    let state = app.state::<PreviewState>();
    if let Some(bytes) = state.cache.lock().get(&ckey) {
        return Some(bytes.as_ref().clone());
    }

    let img = match decode_image(&path, Some(PREVIEW_EDGE)) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("[preview] decode {}: {e}", path.display());
            return None;
        }
    };
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    // Lanczos3 (not the thumbnail's Triangle): at near-1:1 the extra sharpness
    // is exactly what the preview is for, and there is only one image to resize.
    let img = if w.max(h) > PREVIEW_EDGE {
        img.resize(PREVIEW_EDGE, PREVIEW_EDGE, FilterType::Lanczos3)
    } else {
        img
    };
    let img = crate::tonemap::apply(img, tm, exposure_ev);

    let mut bytes: Vec<u8> = Vec::new();
    if let Err(e) = img.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png) {
        eprintln!("[preview] encode {}: {e}", path.display());
        return None;
    }
    let arc = Arc::new(bytes);
    state.cache.lock().put(ckey, arc.clone());
    Some(arc.as_ref().clone())
}

/// No `gen` field: cancellation happens by CLEARING the queue in
/// request_thumbs, not by tagging jobs. Results are never dropped for
/// staleness (see the note in `drain`), so a job carries nothing a later
/// generation would need to check.
struct Job {
    id: u32,
    path: String,
}

impl Default for ThumbState {
    fn default() -> Self {
        Self {
            cache: Mutex::new(LruCache::new(std::num::NonZeroUsize::new(2048).unwrap())),
            queue: Mutex::new(Vec::new()),
            running: Mutex::new(false),
        }
    }
}

/// FNV-1a over `version:edge:size:mtime:path`, as a u64.
///
/// size+mtime means a texture overwritten by a DCC re-decodes, same reasoning
/// as waveform.rs's key. FNV inline rather than a hashing crate: collisions
/// across 100k thumbs are ~1e-10 and self-heal on the next mtime change.
///
/// `kind` namespaces the key so a model and a texture at the same path can
/// never collide, and so bumping one pipeline's version cannot invalidate the
/// other's cache. The u64 is the store's key; `hex_key` formats it for the
/// `thumb://<key>` URL.
///
/// MIRRORED in `src/thumbKey.ts` (the "t" case) so the frontend can compute a
/// warm-cache thumb URL with no IPC. If CACHE_VERSION, THUMB_EDGE, the format
/// string, or the hash changes here, change it there too.
fn hash_key(kind: &str, path: &str, size: u64, mtime: i64) -> u64 {
    let raw = format!("{kind}:{CACHE_VERSION}:{THUMB_EDGE}:{size}:{mtime}:{path}");
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in raw.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// The 16-hex-char form used in `thumb://<key>` URLs and by thumbKey.ts.
fn hex_key(h: u64) -> String {
    format!("{h:016x}")
}

fn file_stamp(path: &Path) -> (u64, i64) {
    match fs::metadata(path) {
        Ok(md) => {
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            (md.len(), mtime)
        }
        Err(_) => (0, 0),
    }
}

/// Cheap per-image statistics, computed on the already-downscaled thumbnail so
/// they cost nothing extra.
///
/// These SUPPLEMENT the name-based channel classifier; they never override it.
/// A name is an author's intent, a histogram is a guess.
fn analyze(img: &DynamicImage) -> ThumbInfo {
    let rgba = img.to_rgba8();
    let n = (rgba.width() * rgba.height()) as f64;
    let (mut sr, mut sg, mut sb) = (0f64, 0f64, 0f64);
    let mut chroma = 0f64;
    let mut has_alpha = false;
    // 16-bucket luma histogram, enough to spot a bimodal (mask) distribution.
    let mut hist = [0u32; 16];

    for p in rgba.pixels() {
        let (r, g, b, a) = (p[0] as f64, p[1] as f64, p[2] as f64, p[3]);
        sr += r;
        sg += g;
        sb += b;
        let mx = r.max(g).max(b);
        let mn = r.min(g).min(b);
        chroma += mx - mn;
        if a < 250 {
            has_alpha = true;
        }
        let luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) as usize;
        hist[(luma * 16 / 256).min(15)] += 1;
    }

    let mean = [sr / n / 255.0, sg / n / 255.0, sb / n / 255.0];
    let mean_chroma = chroma / n / 255.0;

    // Tangent-space normal maps cluster hard around (0.5, 0.5, 1.0): mostly
    // flat surface, so most texels point straight out. Blue-dominant plus
    // r/g near the midpoint is a strong, cheap signal.
    let normal_like = mean[2] > 0.75
        && (mean[0] - 0.5).abs() < 0.14
        && (mean[1] - 0.5).abs() < 0.14
        && mean[2] > mean[0]
        && mean[2] > mean[1];

    // Roughness/height/AO/metallic are single-channel in practice.
    let grayscale = mean_chroma < 0.02;

    // Opacity masks pile up at both ends and are empty in the middle.
    let ends = (hist[0] + hist[1] + hist[14] + hist[15]) as f64 / n;
    let middle = hist[6..10].iter().sum::<u32>() as f64 / n;
    let bimodal = ends > 0.80 && middle < 0.04;

    ThumbInfo {
        width: img.width(),
        height: img.height(),
        // Overwritten by build() with the pre-downscale source dimensions.
        source_width: img.width(),
        source_height: img.height(),
        normal_like,
        grayscale,
        bimodal,
        has_alpha,
        mean_r: mean[0] as f32,
        mean_g: mean[1] as f32,
        mean_b: mean[2] as f32,
    }
}

/// Tone-map a floating-point image down to 8-bit with the DEFAULT operator.
/// The grid thumbnail and workflow.rs's "Copy image" share this — only the
/// preview panel picks an operator/exposure (see [`crate::tonemap`]).
/// (`pub(crate)`: workflow.rs's "Copy image" shares this decode pipeline.)
///
/// `.hdr` decodes to Rgb32F and `.exr` to Rgba32F, and the PNG encoder cannot
/// write either â€” it returns Unsupported, the thumbnail is never written, and
/// the cell stays blank forever with only a line on stderr. That silently cost
/// 38 of 303 real files here. The tone-mapper also folds HDR's past-1.0 range
/// into [0,1] so bright pixels don't just clamp to flat white.
pub(crate) fn to_ldr(img: DynamicImage) -> DynamicImage {
    crate::tonemap::apply(img, crate::tonemap::Tonemap::DEFAULT, 0.0)
}

/// Krita (.kra) is a ZIP; it stores a full-resolution flattened `mergedimage.png`
/// (and a smaller `preview.png`). Pull the merged one and decode it as PNG.
fn decode_kra(p: &Path) -> Result<DynamicImage, String> {
    use std::io::Read;
    let file = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("kra zip: {e}"))?;
    for name in ["mergedimage.png", "preview.png"] {
        if let Ok(mut entry) = zip.by_name(name) {
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            return image::load_from_memory(&buf).map_err(|e| e.to_string());
        }
    }
    Err("kra: no mergedimage.png".into())
}

/// Aseprite (.aseprite/.ase) â€” composite the first frame to RGBA. Rebuilt
/// through our own `image` crate via raw bytes so asefile's image version can't
/// clash with ours.
fn decode_aseprite(p: &Path) -> Result<DynamicImage, String> {
    let ase = ah_asefile::AsepriteFile::read_file(p).map_err(|e| e.to_string())?;
    let frame = ase.frame(0).image();
    let (w, h) = (frame.width(), frame.height());
    let buf = image::RgbaImage::from_raw(w, h, frame.into_raw())
        .ok_or_else(|| "aseprite: bad frame buffer".to_string())?;
    Ok(DynamicImage::ImageRgba8(buf))
}

/// Photoshop (.psd/.psb) â€” flatten to the composited RGBA image. The per-layer
/// tree is read separately in the frontend (ag-psd); here we only need the final
/// picture for the thumbnail and the base preview.
fn decode_psd(p: &Path) -> Result<DynamicImage, String> {
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let doc = psd::Psd::from_bytes(&bytes).map_err(|e| e.to_string())?;
    let (w, h) = (doc.width(), doc.height());
    image::RgbaImage::from_raw(w, h, doc.rgba())
        .map(DynamicImage::ImageRgba8)
        .ok_or_else(|| "psd: bad composite buffer".to_string())
}

/// Affinity Photo/Designer/Publisher (.afphoto/.afdesign/.afpub) is a closed,
/// undocumented binary format with no Rust decoder â€” but every file embeds a PNG
/// preview of the flattened composite (what the OS and XnView show as its
/// thumbnail). Carve out the embedded PNGs and decode the LARGEST one: a file
/// can hold several (a small app icon alongside the full preview), and we want
/// the preview. Unlike psd/kra/aseprite there are no layers to read â€” this is a
/// flat image, so it takes the ordinary texture preview, not a layer panel.
fn decode_affinity(p: &Path) -> Result<DynamicImage, String> {
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let mut blobs = find_png_blobs(&bytes);
    // Largest byte range first: the biggest embedded PNG is the full preview.
    blobs.sort_by_key(|&(s, e)| std::cmp::Reverse(e - s));
    for (s, e) in blobs {
        if let Ok(img) = image::load_from_memory_with_format(&bytes[s..e], image::ImageFormat::Png) {
            return Ok(img);
        }
    }
    Err("affinity: no embedded PNG preview found".into())
}

/// Byte ranges `[start, end)` of every complete PNG stream in `data`. Found by
/// the 8-byte signature, then walked chunk-by-chunk (`[u32 len][4 type][data][4
/// crc]`) to the end of the IEND chunk. Walking â€” rather than searching for the
/// literal bytes "IEND" â€” is exact: it can't be fooled by that sequence turning
/// up inside a chunk's compressed pixel data.
fn find_png_blobs(data: &[u8]) -> Vec<(usize, usize)> {
    const SIG: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + SIG.len() <= data.len() {
        if data[i..i + SIG.len()] != SIG {
            i += 1;
            continue;
        }
        let mut pos = i + SIG.len();
        let end = loop {
            if pos + 8 > data.len() {
                break None; // truncated chunk header â€” not a usable PNG
            }
            let len =
                u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
            let is_iend = &data[pos + 4..pos + 8] == b"IEND";
            let next = pos + 12 + len; // 4 len + 4 type + len data + 4 crc
            if next > data.len() {
                break None; // chunk runs past EOF â€” a false signature match
            }
            if is_iend {
                break Some(next);
            }
            pos = next;
        };
        match end {
            Some(e) => {
                out.push((i, e));
                i = e;
            }
            None => i += 1,
        }
    }
    out
}

/// A layer's metadata (aseprite gives us per-layer opacity/blend/visibility;
/// Krita only its name).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpriteLayer {
    pub name: String,
    pub opacity: f32,
    pub blend: String,
    /// This layer's OWN eye state (not inherited from parent groups).
    pub visible: bool,
    /// Nesting depth for the tree (0 = top level).
    pub depth: u32,
    /// A group/folder layer (holds children, no pixels of its own).
    pub is_group: bool,
    /// Index of the parent group in `layers`, or -1 for a top-level layer.
    pub parent: i32,
    /// Krita "inherit alpha" (clip to the layers below it in its group). The
    /// frontend clips the layer to the accumulated alpha beneath it instead of
    /// drawing it flat. Always false for aseprite.
    pub clip: bool,
    /// A pass-through group (composites as if its children were in the parent,
    /// no isolation). Only meaningful when `is_group`. False for aseprite.
    pub passthrough: bool,
}

/// One layer's pixels on one frame, positioned on the canvas. `layer` is the
/// layer index (>=0) it belongs to, or -1 for a standalone/merged image (Krita)
/// that is always drawn.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpriteCel {
    pub layer: i32,
    pub data_url: String,
    pub x: i32,
    pub y: i32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpriteFrame {
    pub duration_ms: u32,
    pub cels: Vec<SpriteCel>,
}

/// Everything the sprite-art preview needs to composite kra/aseprite itself:
/// the layer list (for the show/hide panel) and, per frame, each layer's cel so
/// the frontend can re-composite live as layers are toggled. `layered` is false
/// for Krita (only the flattened merged image is available â€” names are shown but
/// not toggleable).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpriteData {
    pub width: u32,
    pub height: u32,
    pub layered: bool,
    pub layers: Vec<SpriteLayer>,
    pub frames: Vec<SpriteFrame>,
    /// Krita's own flattened `mergedimage.png` (what Krita rendered at save
    /// time). Shown as the preview UNTIL the user toggles a layer â€” it is
    /// pixel-exact, whereas our live per-layer composite only approximates
    /// Krita's exotic clip/blend stack. None for aseprite (its own composite is
    /// exact) and when no merged image is embedded.
    pub merged_data_url: Option<String>,
}

fn png_data_url(img: &DynamicImage) -> Result<String, String> {
    use base64::Engine as _;
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png)))
}

/// Krita layer names, scanned out of the ZIP's `maindoc.xml` (top-first, as the
/// file lists them). Crude attribute scan â€” no XML crate needed.
fn kra_layer_names(p: &Path) -> Vec<String> {
    use std::io::Read;
    let Ok(file) = std::fs::File::open(p) else { return Vec::new() };
    let Ok(mut zip) = zip::ZipArchive::new(file) else { return Vec::new() };
    let mut xml = String::new();
    if zip.by_name("maindoc.xml").and_then(|mut e| Ok(e.read_to_string(&mut xml))).is_err() {
        return Vec::new();
    }
    let mut names = Vec::new();
    for chunk in xml.split("<layer").skip(1) {
        if let Some((_, after)) = chunk.split_once("name=\"") {
            if let Some((name, _)) = after.split_once('"') {
                names.push(name.to_string());
            }
        }
    }
    names
}

/// LibLZF decompression (the variant Krita uses for its layer tiles). A control
/// byte < 32 introduces a literal run of `ctrl + 1` bytes; otherwise it starts a
/// back-reference of `(ctrl >> 5) + 2` bytes (extended by one more byte when the
/// length nibble is 7) at offset `((ctrl & 0x1f) << 8 | next) + 1` behind the
/// output cursor. `expected` pre-sizes the buffer; a malformed stream returns
/// None rather than panicking. ~40 lines, so no crate (and no transitive deps).
fn lzf_decompress(input: &[u8], expected: usize) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(expected);
    let mut ip = 0usize;
    while ip < input.len() {
        let ctrl = input[ip] as usize;
        ip += 1;
        if ctrl < 32 {
            // Literal run.
            let len = ctrl + 1;
            if ip + len > input.len() {
                return None;
            }
            out.extend_from_slice(&input[ip..ip + len]);
            ip += len;
        } else {
            // Back-reference.
            let mut len = ctrl >> 5;
            if len == 7 {
                if ip >= input.len() {
                    return None;
                }
                len += input[ip] as usize;
                ip += 1;
            }
            if ip >= input.len() {
                return None;
            }
            let off = ((ctrl & 0x1f) << 8) | input[ip] as usize;
            ip += 1;
            let mut src = out.len().checked_sub(off + 1)?;
            for _ in 0..len + 2 {
                let b = *out.get(src)?;
                out.push(b);
                src += 1;
            }
        }
    }
    Some(out)
}

/// Decode one Krita paint-layer file to a full-canvas RGBA buffer.
///
/// The file is a tiny ASCII header (`VERSION`/`TILEWIDTH`/`TILEHEIGHT`/
/// `PIXELSIZE`/`DATA <count>`) followed by `count` tiles. Each tile has a
/// `left,top,LZF,bytes` header line, then `bytes` of data whose first byte is a
/// compression flag (1 = LZF). Krita de-interleaves the channels before
/// compressing â€” the decompressed tile is PLANAR: all blue bytes, then green,
/// then red, then alpha (RGBA8 is stored BGRA, Qt order). We reinterleave to
/// straight RGBA and place each tile at `tile_pos + (off_x, off_y)` (the layer's
/// device offset from maindoc), clamped to the canvas. Only 8-bit RGBA
/// (`PIXELSIZE 4`) is handled; anything else returns None â†’ merged image.
///
/// Returns the pixels CROPPED to the layer's opaque bounding box as
/// `(rgba, x, y, w, h)` â€” most layers cover a small region, so cropping shrinks
/// the PNG encode and the data-URL payload by orders of magnitude versus a
/// full-canvas buffer. A fully transparent layer returns None (nothing to draw).
fn kra_assemble_layer(
    data: &[u8],
    canvas_w: u32,
    canvas_h: u32,
    off_x: i64,
    off_y: i64,
) -> Option<(Vec<u8>, u32, u32, u32, u32)> {
    // Read one `\n`-terminated line, advancing `pos` past the newline.
    fn read_line(data: &[u8], pos: &mut usize) -> Option<String> {
        let start = *pos;
        while *pos < data.len() && data[*pos] != b'\n' {
            *pos += 1;
        }
        if *pos >= data.len() {
            return None;
        }
        let line = String::from_utf8_lossy(&data[start..*pos]).into_owned();
        *pos += 1;
        Some(line)
    }

    let mut pos = 0usize;
    let (mut tw, mut th, mut ps) = (0usize, 0usize, 0usize);
    let ntiles: usize = loop {
        let line = read_line(data, &mut pos)?;
        let line = line.trim();
        if let Some(v) = line.strip_prefix("TILEWIDTH ") {
            tw = v.trim().parse().ok()?;
        } else if let Some(v) = line.strip_prefix("TILEHEIGHT ") {
            th = v.trim().parse().ok()?;
        } else if let Some(v) = line.strip_prefix("PIXELSIZE ") {
            ps = v.trim().parse().ok()?;
        } else if let Some(v) = line.strip_prefix("DATA ") {
            break v.trim().parse().ok()?;
        }
        // VERSION and any unknown header lines are ignored.
    };
    // Only 8-bit RGBA (4 bytes/pixel). 16-bit and other colorspaces fall back.
    if ps != 4 || tw == 0 || th == 0 {
        return None;
    }
    let plane = tw.checked_mul(th)?;
    let tile_len = plane.checked_mul(ps)?;
    let (cw, ch) = (canvas_w as usize, canvas_h as usize);
    let mut out = vec![0u8; cw.checked_mul(ch)?.checked_mul(4)?];
    // Opaque bounding box, accumulated as pixels are written.
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (usize::MAX, usize::MAX, 0usize, 0usize);

    for _ in 0..ntiles {
        let header = read_line(data, &mut pos)?;
        let parts: Vec<&str> = header.trim().split(',').collect();
        if parts.len() < 4 {
            return None;
        }
        let left: i64 = parts[0].trim().parse().ok()?;
        let top: i64 = parts[1].trim().parse().ok()?;
        // parts[2] is the compression name ("LZF").
        let dsize: usize = parts[3].trim().parse().ok()?;
        if dsize == 0 || pos + dsize > data.len() {
            return None;
        }
        let blob = &data[pos..pos + dsize];
        pos += dsize;
        let compressed = blob[0] != 0;
        let payload = &blob[1..];
        let tile = if compressed {
            lzf_decompress(payload, tile_len)?
        } else {
            payload.to_vec()
        };
        if tile.len() < tile_len {
            continue;
        }
        for py in 0..th {
            let cy = top + off_y + py as i64;
            if cy < 0 || cy >= canvas_h as i64 {
                continue;
            }
            let row = cy as usize * cw;
            for px in 0..tw {
                let cx = left + off_x + px as i64;
                if cx < 0 || cx >= canvas_w as i64 {
                    continue;
                }
                let idx = py * tw + px;
                let o = (row + cx as usize) * 4;
                let a = tile[3 * plane + idx];
                out[o] = tile[2 * plane + idx]; // R
                out[o + 1] = tile[plane + idx]; // G
                out[o + 2] = tile[idx]; // B
                out[o + 3] = a; // A
                if a != 0 {
                    let (ux, uy) = (cx as usize, cy as usize);
                    min_x = min_x.min(ux);
                    min_y = min_y.min(uy);
                    max_x = max_x.max(ux);
                    max_y = max_y.max(uy);
                }
            }
        }
    }
    if min_x == usize::MAX {
        return None; // fully transparent â€” nothing to draw
    }
    let (rw, rh) = (max_x - min_x + 1, max_y - min_y + 1);
    let mut cropped = vec![0u8; rw * rh * 4];
    for ry in 0..rh {
        let src = ((min_y + ry) * cw + min_x) * 4;
        let dst = ry * rw * 4;
        cropped[dst..dst + rw * 4].copy_from_slice(&out[src..src + rw * 4]);
    }
    Some((cropped, min_x as u32, min_y as u32, rw as u32, rh as u32))
}

/// A Krita layer node parsed from maindoc.xml (tree order, top-first).
struct KraNode {
    name: String,
    filename: String,
    nodetype: String,
    opacity: f32,
    blend: String,
    visible: bool,
    depth: u32,
    parent: i32,
    /// Layer device offset from maindoc — Krita stores tiles in the layer's LOCAL
    /// coordinate space and translates the whole device by (x, y) when
    /// compositing, so a tile at grid (tx, ty) lands at canvas (tx+x, ty+y).
    x: i64,
    y: i64,
    /// "Inherit alpha" — channelflags with the alpha bit cleared ("1110").
    clip: bool,
    /// Pass-through group.
    passthrough: bool,
}

fn kra_walk<'a, 'i>(layers_el: roxmltree::Node<'a, 'i>, depth: u32, parent: i32, out: &mut Vec<KraNode>) {
    for el in layers_el
        .children()
        .filter(|c| c.is_element() && c.tag_name().name() == "layer")
    {
        let nodetype = el.attribute("nodetype").unwrap_or("").to_string();
        let idx = out.len() as i32;
        out.push(KraNode {
            name: el.attribute("name").unwrap_or("").to_string(),
            filename: el.attribute("filename").unwrap_or("").to_string(),
            nodetype: nodetype.clone(),
            opacity: el.attribute("opacity").and_then(|s| s.parse::<f32>().ok()).unwrap_or(255.0) / 255.0,
            blend: el.attribute("compositeop").unwrap_or("normal").to_string(),
            visible: el.attribute("visible").map(|s| s != "0").unwrap_or(true),
            depth,
            parent,
            x: el.attribute("x").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0),
            y: el.attribute("y").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0),
            // channelflags is per-channel enable "RGBA"; alpha bit cleared ("1110")
            // is Krita's "inherit alpha" (clip to below). Empty = all channels on.
            clip: el.attribute("channelflags").unwrap_or("").as_bytes().get(3) == Some(&b'0'),
            passthrough: el.attribute("passthrough") == Some("1"),
        });
        if nodetype == "grouplayer" {
            if let Some(sub) = el
                .children()
                .find(|c| c.is_element() && c.tag_name().name() == "layers")
            {
                kra_walk(sub, depth + 1, idx, out);
            }
        }
    }
}

/// Parse a .kra's maindoc.xml into (width, height, image name, layer nodes). Cheap
/// — just an XML walk, no tile decoding.
fn kra_parse(p: &Path) -> Option<(u32, u32, String, Vec<KraNode>)> {
    use std::io::Read;
    let file = std::fs::File::open(p).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let mut xml = String::new();
    zip.by_name("maindoc.xml").ok()?.read_to_string(&mut xml).ok()?;
    let opts = roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() };
    let doc = match roxmltree::Document::parse_with_options(&xml, opts) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[kra] {}: maindoc parse ({e})", p.display());
            return None;
        }
    };
    let image = doc.descendants().find(|nd| nd.tag_name().name() == "IMAGE")?;
    let img_name = image.attribute("name").unwrap_or("").to_string();
    let w = image.attribute("width").and_then(|s| s.parse().ok())?;
    let h = image.attribute("height").and_then(|s| s.parse().ok())?;
    let top = image
        .children()
        .find(|c| c.is_element() && c.tag_name().name() == "layers")?;
    let mut nodes = Vec::new();
    kra_walk(top, 0, -1, &mut nodes);
    Some((w, h, img_name, nodes))
}

/// Krita's flattened image as a data URL, straight from the embedded PNG bytes —
/// NO decode/re-encode, so it is nearly free. This is the exact default preview.
fn kra_merged_url(p: &Path) -> Option<String> {
    use base64::Engine as _;
    use std::io::Read;
    let file = std::fs::File::open(p).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    for name in ["mergedimage.png", "preview.png"] {
        if let Ok(mut e) = zip.by_name(name) {
            let mut buf = Vec::with_capacity(e.size() as usize);
            if e.read_to_end(&mut buf).is_ok() {
                return Some(format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&buf)
                ));
            }
        }
    }
    None
}

fn kra_layer_metas(nodes: &[KraNode]) -> Vec<SpriteLayer> {
    nodes
        .iter()
        .map(|nd| SpriteLayer {
            name: nd.name.clone(),
            opacity: nd.opacity,
            blend: nd.blend.clone(),
            visible: nd.visible,
            depth: nd.depth,
            is_group: nd.nodetype == "grouplayer",
            parent: nd.parent,
            clip: nd.clip && nd.nodetype != "grouplayer",
            passthrough: nd.passthrough && nd.nodetype == "grouplayer",
        })
        .collect()
}

/// FAST Krita preview metadata: the layer tree (for the panel) plus Krita's exact
/// merged image (the default preview). The per-layer cels — the expensive part,
/// hundreds of tile decodes + PNG encodes — are loaded lazily via `sprite_cels`
/// only when the user toggles a layer, so opening a big .kra is instant.
/// Returns None (→ merged fallback) if there are no paint layers to toggle.
fn kra_meta(p: &Path) -> Option<SpriteData> {
    let (w, h, _img_name, nodes) = kra_parse(p)?;
    if !nodes.iter().any(|nd| nd.nodetype == "paintlayer") {
        eprintln!("[kra] {}: no paint layers — using merged image", p.display());
        return None;
    }
    Some(SpriteData {
        width: w,
        height: h,
        layered: true,
        layers: kra_layer_metas(&nodes),
        // Empty until sprite_cels fills them in; the merged image shows meanwhile.
        frames: vec![SpriteFrame { duration_ms: 0, cels: Vec::new() }],
        merged_data_url: kra_merged_url(p),
    })
}

/// The HEAVY half of a Krita decode: assemble every paint layer's tiles, crop to
/// its opaque box, and PNG-encode it — in parallel. Called lazily so it never
/// blocks the initial preview.
fn kra_cels(p: &Path) -> Vec<SpriteCel> {
    use rayon::prelude::*;
    use std::io::Read;
    let Some((w, h, img_name, nodes)) = kra_parse(p) else { return Vec::new() };
    let Ok(file) = std::fs::File::open(p) else { return Vec::new() };
    let Ok(mut zip) = zip::ZipArchive::new(file) else { return Vec::new() };
    // Read the raw tile blobs sequentially (zip access is single-threaded)...
    let blobs: Vec<(usize, Vec<u8>, i64, i64)> = nodes
        .iter()
        .enumerate()
        .filter(|(_, nd)| nd.nodetype == "paintlayer")
        .filter_map(|(idx, nd)| {
            let path = format!("{}/layers/{}", img_name, nd.filename);
            let mut bytes = Vec::new();
            let mut f = zip.by_name(&path).ok()?;
            f.read_to_end(&mut bytes).ok()?;
            Some((idx, bytes, nd.x, nd.y))
        })
        .collect();
    // ...then decode + crop + encode them in parallel.
    blobs
        .par_iter()
        .filter_map(|(idx, bytes, x, y)| {
            // None = empty/transparent (common) or non-RGBA8 → no cel.
            let (rgba, cx, cy, cw, ch) = kra_assemble_layer(bytes, w, h, *x, *y)?;
            let buf = image::RgbaImage::from_raw(cw, ch, rgba)?;
            let url = png_data_url(&DynamicImage::ImageRgba8(buf)).ok()?;
            Some(SpriteCel { layer: *idx as i32, data_url: url, x: cx as i32, y: cy as i32 })
        })
        .collect()
}



fn sprite_data_inner(p: &Path) -> Result<SpriteData, String> {
    match p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("aseprite") | Some("ase") => {
            let ase = ah_asefile::AsepriteFile::read_file(p).map_err(|e| e.to_string())?;
            let (w, h) = (ase.width() as u32, ase.height() as u32);
            let n = ase.num_layers();
            // Present layers TOP-first (index 0 = topmost) to match Krita and the
            // panel; remap aseprite's bottom-first ids.
            let order: Vec<u32> = (0..n).rev().collect();
            let mut new_of = vec![-1i32; n as usize];
            for (ni, &old) in order.iter().enumerate() {
                new_of[old as usize] = ni as i32;
            }
            let layers = order
                .iter()
                .map(|&old| {
                    let l = ase.layer(old);
                    let mut depth = 0u32;
                    let mut pid = l.parent().map(|p| p.id());
                    while let Some(id) = pid {
                        depth += 1;
                        pid = ase.layer(id).parent().map(|p| p.id());
                    }
                    let is_group = matches!(l.layer_type(), ah_asefile::LayerType::Group);
                    // Aseprite group layers carry an opacity byte that is usually
                    // 0 ("unset") — asefile's own compositor ignores it. Applying
                    // it would multiply the whole group to nothing, so treat a
                    // group's zero opacity as fully opaque.
                    let opacity = if is_group && l.opacity() == 0 {
                        1.0
                    } else {
                        l.opacity() as f32 / 255.0
                    };
                    SpriteLayer {
                        name: l.name().to_string(),
                        opacity,
                        blend: format!("{:?}", l.blend_mode()).to_ascii_lowercase(),
                        visible: l.flags().contains(ah_asefile::LayerFlags::VISIBLE),
                        depth,
                        is_group,
                        parent: l.parent().map(|p| new_of[p.id() as usize]).unwrap_or(-1),
                        clip: false,
                        passthrough: false,
                    }
                })
                .collect();
            // Cels drawn bottom-first (old id order) for correct compositing;
            // `layer` carries the new top-first index.
            let mut frames = Vec::with_capacity(ase.num_frames() as usize);
            for f in 0..ase.num_frames() {
                let mut cels = Vec::new();
                for old in 0..n {
                    let cel = ase.cel(f, old);
                    if cel.is_empty() {
                        continue;
                    }
                    // `cel.image()` is already full-canvas with the layer placed
                    // in it â€” draw at the origin.
                    let img = cel.image();
                    let buf = image::RgbaImage::from_raw(img.width(), img.height(), img.into_raw())
                        .ok_or_else(|| "aseprite: bad cel".to_string())?;
                    cels.push(SpriteCel {
                        layer: new_of[old as usize],
                        data_url: png_data_url(&DynamicImage::ImageRgba8(buf))?,
                        x: 0,
                        y: 0,
                    });
                }
                frames.push(SpriteFrame { duration_ms: ase.frame(f).duration(), cels });
            }
            // Aseprite's own composite is exact â€” no separate merged image.
            Ok(SpriteData { width: w, height: h, layered: true, layers, frames, merged_data_url: None })
        }
        Some("kra") => {
            // FAST path: layer tree + Krita's exact merged image, no per-layer
            // tile decode (that happens lazily via `sprite_cels`). Instant even
            // for a 500-layer .kra.
            if let Some(sd) = kra_meta(p) {
                return Ok(sd);
            }
            // Fallback: the flattened merged image plus layer names.
            let img = decode_kra(p)?;
            let (w, h) = img.dimensions();
            let layers = kra_layer_names(p)
                .into_iter()
                .map(|name| SpriteLayer {
                    name,
                    opacity: 1.0,
                    blend: "normal".into(),
                    visible: true,
                    depth: 0,
                    is_group: false,
                    parent: -1,
                    clip: false,
                    passthrough: false,
                })
                .collect();
            let frames = vec![SpriteFrame {
                duration_ms: 0,
                cels: vec![SpriteCel { layer: -1, data_url: png_data_url(&img)?, x: 0, y: 0 }],
            }];
            // Non-toggleable fallback: the single merged cel already IS the
            // image, so no separate merged url is needed.
            Ok(SpriteData { width: w, height: h, layered: false, layers, frames, merged_data_url: None })
        }
        _ => Err("not a sprite/art file".into()),
    }
}

/// Frames + layers for a kra/aseprite file, for the sprite-art preview. Panic-
/// safe like decode_image (asefile can panic on odd inputs).
#[tauri::command]
pub fn sprite_data(app: tauri::AppHandle, path: String) -> Result<SpriteData, String> {
    let p = Path::new(&path);
    if !crate::scanner::is_within_roots(&app, p) {
        return Err("out of scope".into());
    }
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sprite_data_inner(p)))
        .unwrap_or_else(|_| Err("sprite: decoder panicked".into()))
}

/// The per-layer cels for a Krita file (the expensive tile decode), fetched
/// lazily by the frontend the first time the user toggles a layer — until then
/// the merged image from `sprite_data` is shown. Empty for non-Krita files.
#[tauri::command]
pub fn sprite_cels(app: tauri::AppHandle, path: String) -> Result<Vec<SpriteCel>, String> {
    let p = Path::new(&path);
    if !crate::scanner::is_within_roots(&app, p) {
        return Err("out of scope".into());
    }
    let is_kra = p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("kra")).unwrap_or(false);
    if !is_kra {
        return Ok(Vec::new());
    }
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| kra_cels(p)))
        .map_err(|_| "sprite cels: decoder panicked".to_string())
}

/// Decode an image. `catch_unwind` because third-party decoders (asefile in
/// particular) PANIC on files/features they don't handle â€” without this, one bad
/// file takes down the whole rayon decode worker and every later thumbnail goes
/// blank. A panic here just means "no thumbnail for this one".
/// `max_edge` hints the largest edge the caller will actually display (256 for
/// a grid thumb, 4096 for the preview, None for full-res); only the camera-RAW
/// path uses it, to pick a right-sized embedded preview instead of always
/// decoding the biggest one.
pub(crate) fn decode_image(p: &Path, max_edge: Option<u32>) -> Result<DynamicImage, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| decode_image_inner(p, max_edge)))
        .unwrap_or_else(|_| Err(format!("{}: decoder panicked", p.display())))
}

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
fn decode_raw(p: &Path, max_edge: Option<u32>) -> Result<DynamicImage, String> {
    let mut file = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();

    // Fast path: container parse + a single targeted read.
    if let Some(img) = fast_raw_preview(&mut file, len, max_edge) {
        return Ok(img);
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

/// Retries WebP through libwebp. The pure-Rust `image` WebP decoder rejects some
/// extended/animated WebP ("Invalid Chunk header") that libwebp decodes fine;
/// layered art (kra/aseprite) has its own decoders; other formats go straight
/// through `image`.
fn decode_image_inner(p: &Path, max_edge: Option<u32>) -> Result<DynamicImage, String> {
    match p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("kra") => return decode_kra(p),
        Some("aseprite") | Some("ase") => return decode_aseprite(p),
        Some("psd") | Some("psb") => return decode_psd(p),
        Some("afphoto") | Some("afdesign") | Some("afpub") => return decode_affinity(p),
        Some(ext) if crate::types::RAW_EXTENSIONS.contains(&ext) => return decode_raw(p, max_edge),
        _ => {}
    }
    match image::open(p) {
        Ok(img) => Ok(img),
        Err(e) => {
            let is_webp = p
                .extension()
                .map(|x| x.eq_ignore_ascii_case("webp"))
                .unwrap_or(false);
            if is_webp {
                if let Ok(bytes) = std::fs::read(p) {
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

/// Decode -> downscale -> RGBA -> the in-memory cache. Returns the hex key and
/// stats. NO PNG is produced: the grid uploads this RGBA straight to the GPU.
fn build(path: &str, cache: &ThumbCache) -> Result<(String, ThumbInfo), String> {
    let p = Path::new(path);
    let (size, mtime) = file_stamp(p);
    let h = hash_key("t", path, size, mtime);
    let key = hex_key(h);

    // Cache hit: the RGBA and its dims are already here â€” recompute stats from
    // it (cheap) rather than touching the 4K original again.
    if let Some(px) = cache.get(h) {
        let (sw, sh) = (px.src_w, px.src_h);
        if let Some(buf) = image::RgbaImage::from_raw(px.width, px.height, px.rgba) {
            let mut info = analyze(&DynamicImage::ImageRgba8(buf));
            info.source_width = sw;
            info.source_height = sh;
            return Ok((key, info));
        }
    }

    let img = decode_image(p, Some(THUMB_EDGE)).map_err(|e| format!("decode {path}: {e}"))?;
    let (w, ih) = img.dimensions();
    if w == 0 || ih == 0 {
        return Err(format!("{path}: zero-sized image"));
    }
    // Triangle over Lanczos: at a 16:1 downscale the ringing Lanczos adds is
    // visible on the hard-edged art these packs ship, and it is ~3x slower.
    let thumb = if w.max(ih) > THUMB_EDGE {
        img.resize(THUMB_EDGE, THUMB_EDGE, FilterType::Triangle)
    } else {
        img
    };
    // After the resize (cheaper) and before analyze(), so the stats see the
    // same pixels the thumbnail shows.
    let thumb = to_ldr(thumb);

    let mut info = analyze(&thumb);
    info.source_width = w;
    info.source_height = ih;
    let rgba = thumb.to_rgba8();
    cache.put(
        h,
        Pixels {
            width: rgba.width(),
            height: rgba.height(),
            src_w: w,
            src_h: ih,
            rgba: rgba.into_raw(),
        },
    );
    Ok((key, info))
}

/// Queue thumbnails for the given (id, path) pairs, superseding the previous
/// request. **Returns the ids that were dropped unstarted**, so the caller can
/// forget it ever asked for them.
///
/// That return value is the whole contract. Clearing the queue is how
/// cancellation works â€” without it, scrolling a 2000-texture folder would
/// eventually decode all of it, which the concurrency cap exists to prevent.
/// But the frontend marks an id "asked" the moment the invoke resolves and
/// never asks twice, so a silently-dropped job stranded that cell FOREVER: no
/// thumbnail, no error, no retry. It bit on ordinary scrolling, not just fast
/// flicks â€” the drain releases the queue lock across its multi-hundred-ms
/// decode barrier, which is far longer than the frontend's 120 ms debounce.
///
/// Returning the dropped ids keeps both properties: the queue stays bounded,
/// and nothing is lost. Cheap â€” it is a Vec<u32> of at most a screenful.
#[tauri::command]
pub async fn request_thumbs(
    app: AppHandle,
    state: State<'_, ThumbState>,
    items: Vec<(u32, String)>,
) -> Result<Vec<u32>, String> {
    let n = items.len();
    // Take BOTH locks before touching either, and hold `running` across the
    // spawn. Otherwise a drain that is mid-exit can set running=false after we
    // observed it true, and the jobs we just queued sit there with nobody to
    // drain them â€” the cells stay blank forever with no error anywhere.
    let mut running = state.running.lock();
    let dropped: Vec<u32> = {
        let mut q = state.queue.lock();
        // drain, not clear â€” we owe the caller the ids we are abandoning
        let dropped = q.drain(..).map(|j| j.id).collect();
        for (id, path) in items {
            q.push(Job { id, path });
        }
        dropped
    };
    #[cfg(debug_assertions)]
    eprintln!(
        "[thumbs] queued {n} dropped {} running={}",
        dropped.len(),
        *running
    );
    let _ = n;
    if !*running {
        *running = true;
        let handle = app.clone();
        std::thread::Builder::new()
            .name("thumbs".into())
            .spawn(move || drain(handle))
            .map_err(|e| format!("spawn thumb thread: {e}"))?;
    }
    Ok(dropped)
}

fn drain(app: AppHandle) {
    let pool = match rayon::ThreadPoolBuilder::new()
        .num_threads(DECODE_THREADS)
        .thread_name(|i| format!("thumb-{i}"))
        .build()
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[thumbs] pool: {e}");
            *app.state::<ThumbState>().running.lock() = false;
            return;
        }
    };

    let pending: Arc<Mutex<Vec<(u32, ThumbInfo, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let mut last_flush = std::time::Instant::now();

    loop {
        let state = app.state::<ThumbState>();

        // Take a chunk from the FRONT so previews fill in top-left downward, the
        // order the eye scans. The queue only ever holds the current visible
        // window (request_thumbs clears it on each range change), so the front
        // is the topmost on-screen row, not a stale fly-over.
        let chunk: Vec<Job> = {
            let mut q = state.queue.lock();
            let take = q.len().min(DECODE_THREADS * 2);
            q.drain(0..take).collect()
        };
        if chunk.is_empty() {
            flush(&app, &pending);
            // Re-check the queue while holding `running`, in the same lock
            // order request_thumbs uses. A request that landed between our
            // split_off and here would otherwise be orphaned.
            let mut running = state.running.lock();
            if state.queue.lock().is_empty() {
                *running = false;
                return;
            }
            continue;
        }

        let blob = app.state::<ThumbCache>();
        let blob_ref: &ThumbCache = &blob;
        let pending_ref = &pending;
        pool.install(|| {
            use rayon::prelude::*;
            chunk.into_par_iter().for_each(|job| {
                // NOTE: deliberately no staleness gate on the RESULT, unlike
                // waveform.rs. A waveform is single-slot state, so a stale one
                // would clobber the current track's peaks; thumbnails are keyed
                // by file id, so a late result is simply a correct result that
                // arrived late. Dropping it would strand the cell forever â€”
                // the frontend never re-asks for an id it already asked for.
                //
                // Memory hit: skip the blob decode entirely. build() decodes
                // the stored 256px PNG purely to recompute stats that cannot
                // have changed â€” cheap per cell, but it recurs for every cell
                // on every warm launch, and this in-RAM LRU exists to skip it.
                if let Some(hit) = app.state::<ThumbState>().cache.lock().get(&job.path) {
                    pending_ref.lock().push((job.id, hit.1, hit.0.clone()));
                    return;
                }
                match build(&job.path, blob_ref) {
                    Ok((key, info)) => {
                        app.state::<ThumbState>()
                            .cache
                            .lock()
                            .put(job.path.clone(), (key.clone(), info));
                        pending_ref.lock().push((job.id, info, key));
                    }
                    Err(e) => eprintln!("[thumbs] {e}"),
                }
            });
        });

        if last_flush.elapsed().as_millis() as u64 >= FLUSH_MS {
            flush(&app, &pending);
            last_flush = std::time::Instant::now();
        }
    }
}

fn flush(app: &AppHandle, pending: &Arc<Mutex<Vec<(u32, ThumbInfo, String)>>>) {
    let batch: Vec<(u32, ThumbInfo, String)> = std::mem::take(&mut *pending.lock());
    if batch.is_empty() {
        return;
    }
    #[cfg(debug_assertions)]
    let n = batch.len();
    match app.emit(events::THUMB_READY, ThumbBatch { entries: batch }) {
        Ok(()) => {
            #[cfg(debug_assertions)]
            eprintln!("[thumbs] emitted {n}");
        }
        Err(e) => eprintln!("[thumbs] emit failed: {e}"),
    }
}

/// Cached model-thumbnail keys for `items`, as `(id, key)` â€” only for entries
/// that actually exist on disk. Callers render the misses themselves.
///
/// Models are rendered in the WEBVIEW (Rust has no FBX story), so unlike
/// textures the Rust side only owns the cache: lookup and store. The decode,
/// framing, and rasterization all happen in three.js.
#[tauri::command]
pub fn model_thumb_lookup(app: AppHandle, items: Vec<(u32, String)>) -> Vec<(u32, String)> {
    let cache = app.state::<ThumbCache>();
    items
        .into_iter()
        .filter_map(|(id, path)| {
            let (size, mtime) = file_stamp(Path::new(&path));
            let h = hash_key("m", &path, size, mtime);
            // RAM only â€” a model thumbnail is a rendered artifact we keep for the
            // session and never write to the user's disk. A miss (cold cache, or
            // one evicted under memory pressure) means the caller re-renders it.
            if cache.contains(h) {
                Some((id, hex_key(h)))
            } else {
                None
            }
        })
        .collect()
}

/// Persist a webview-rendered model thumbnail as RGBA. Returns its cache key,
/// which the frontend turns into a `tex://` URL.
///
/// The frontend renders the model in three.js, reads the canvas back as RGBA,
/// and sends it as ONE raw octet-stream body â€” NOT a JSON object with an `rgba`
/// number array. Tauri JSON-encodes a nested `Uint8Array` into a ~262k-element
/// array (~1 MB of text) per thumbnail on the webview's main thread; packing
/// everything into the raw body skips that entirely. Wire format (little-endian):
/// `[u32 width][u32 height][u32 path_len][path utf8][width*height*4 RGBA]`.
#[tauri::command]
pub fn model_thumb_store(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("model_thumb_store expects a raw body".into())
        }
    };
    if body.len() < 12 {
        return Err("model_thumb_store: truncated header".into());
    }
    let width = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
    let height = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
    let path_len = u32::from_le_bytes([body[8], body[9], body[10], body[11]]) as usize;
    let rest = &body[12..];
    if rest.len() < path_len {
        return Err("model_thumb_store: truncated path".into());
    }
    let (path_bytes, rgba) = rest.split_at(path_len);
    let path = std::str::from_utf8(path_bytes).map_err(|_| "model_thumb_store: bad path utf8")?;
    if rgba.len() != (width as usize) * (height as usize) * 4 {
        return Err("rgba length does not match dimensions".into());
    }
    let (size, mtime) = file_stamp(Path::new(path));
    let h = hash_key("m", path, size, mtime);
    let key = hex_key(h);
    // RAM only â€” copy the raw pixels straight into the in-memory cache and write
    // NOTHING to disk. A model thumbnail is rendered, not decoded; its "source"
    // size is just the render size (the status bar shows resolution for textures
    // only). Keeping thumbnails off disk is deliberate: the user's drive stays
    // untouched, at the cost of re-rendering across launches.
    app.state::<ThumbCache>().put(
        h,
        Pixels {
            width,
            height,
            src_w: width,
            src_h: height,
            rgba: rgba.to_vec(),
        },
    );
    Ok(key)
}

/// PNG bytes for a cache key, for the `thumb://` handler â€” the few surfaces
/// still on `<img>`/three.js. Keys are our own 16 hex chars; anything else is
/// refused rather than trusted.
pub fn thumb_bytes(app: &AppHandle, key: &str) -> Option<Vec<u8>> {
    let h = crate::thumbcache::parse_key(key)?;
    app.state::<ThumbCache>().get_png(h)
}

/// Raw RGBA for the `tex://` handler â€” the WebGL grid. Wire format:
/// `[u32 width LE][u32 height LE][width*height*4 bytes RGBA]`.
pub fn tex_bytes(app: &AppHandle, key: &str) -> Option<Vec<u8>> {
    let h = crate::thumbcache::parse_key(key)?;
    let px = app.state::<ThumbCache>().get(h)?;
    let mut out = Vec::with_capacity(8 + px.rgba.len());
    out.extend_from_slice(&px.width.to_le_bytes());
    out.extend_from_slice(&px.height.to_le_bytes());
    out.extend_from_slice(&px.rgba);
    Some(out)
}
