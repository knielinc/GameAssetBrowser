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
/// v3: JPEGs decode from their embedded EXIF thumbnail or a scaled IDCT rather
/// than at full resolution (see jpeg.rs) — same picture, different pixels.
const CACHE_VERSION: u32 = 3;
/// Decode threads. Higher than metadata.rs's 2 because this is CPU-bound
/// decode rather than disk probes. Scales with the machine so a screenful of
/// audio waveforms (each a full symphonia decode) actually renders in parallel
/// instead of trickling four at a time, floored at 4 and capped at 12.
///
/// 12, not 8: measured on the real library (390 PNGs, 16-core machine), 8→12
/// threads is +27% throughput (300→381 thumbs/s) and 12→16 only +8% more while
/// taking every core from the UI and the scheme-handler threads — 12 is the
/// knee. Memory: each in-flight 4K RGBA decode is ~67 MB resident, so 12
/// workers is a ~800 MB transient ceiling; tolerable on the 12+-core machines
/// that actually reach the cap, and JPEG no longer materializes full
/// resolution at all (jpeg.rs decodes scaled). Audio decodes are memory-light,
/// so the ceiling only bites on texture-heavy grids.
fn decode_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(4, 12)
}
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

/// Decode an EXR into a memory-bounded RGBA float image. `image::open` fully
/// materializes the source (a 4096×16384 light bake is ~1 GB as RGBA f32, ~2 GB
/// peak with the decoder's own buffers — enough to OOM or hang).
///
/// The actual decode + downsample lives in the `exrthumb` crate so its 67M-pixel
/// setter is optimized in dev (inlined here at opt-level 0 it took ~17 s/file).
/// The result stays float, so `to_ldr` tone-maps it like any other HDR source.
/// `max_edge` None is the full-res "Copy image" path; bound it at the preview
/// size so a 67 MP copy can't OOM.
fn decode_exr(p: &Path, max_edge: Option<u32>) -> Result<DynamicImage, String> {
    let cap = max_edge.unwrap_or(PREVIEW_EDGE) as usize;
    let (w, h, px) = exrthumb::decode_downsampled(&p.to_string_lossy(), cap)?;
    image::Rgba32FImage::from_raw(w, h, px)
        .map(DynamicImage::ImageRgba32F)
        .ok_or_else(|| "exr: pixel buffer size mismatch".to_string())
}

/// Retries WebP through libwebp. The pure-Rust `image` WebP decoder rejects some
/// extended/animated WebP ("Invalid Chunk header") that libwebp decodes fine;
/// layered art (kra/aseprite) has its own decoders; camera RAW goes through the
/// `raw` module; other formats go straight through `image`.
fn decode_image_inner(p: &Path, max_edge: Option<u32>) -> Result<DynamicImage, String> {
    match p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("kra") => return decode_kra(p),
        Some("aseprite") | Some("ase") => return decode_aseprite(p),
        Some("psd") | Some("psb") => return decode_psd(p),
        Some("afphoto") | Some("afdesign") | Some("afpub") => return decode_affinity(p),
        // EXR gets a bounded, downsampling decode — a huge light bake would OOM
        // through image::open's full-resolution float path (see decode_exr).
        Some("exr") => return decode_exr(p, max_edge),
        // JPEG likewise decodes no larger than the caller will show: an embedded
        // EXIF thumbnail, or a scaled IDCT. The phone photos that land in asset
        // folders are 12–50 MP and dominated grid decode time (see jpeg.rs).
        Some("jpg") | Some("jpeg") => return crate::jpeg::decode_jpeg(p, max_edge),
        Some(ext) if crate::types::RAW_EXTENSIONS.contains(&ext) => {
            return crate::raw::decode_raw(p, max_edge)
        }
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
    // Audio has no image to decode: its thumbnail is embedded cover art or a
    // rendered waveform. Routed here (by extension) so request_thumbs stays one
    // uniform command for every kind.
    if is_audio_path(p) {
        return build_audio(path, p, cache);
    }
    let (size, mtime) = file_stamp(p);
    let h = hash_key("t", path, size, mtime);
    let key = hex_key(h);

    // Cache hit: the stats were computed once at decode time and stored with the
    // pixels, so just hand them back — no RGBA reconstruct, no per-pixel rescan.
    if let Some(px) = cache.get(h) {
        return Ok((key, px.info));
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
    // What we decoded is NOT necessarily the source's size: JPEG lifts an EXIF
    // thumbnail or scales the IDCT (jpeg.rs) and EXR downsamples, so the decoded
    // dimensions would understate the file — and the grid badge and status bar
    // report this as the real resolution. Ask the header prober, the app's
    // authority on dimensions, so the badge agrees with the Textures filter.
    // It returns None for camera RAW by design (see its doc): there the embedded
    // preview's size IS the meaningful one, which is exactly the fallback.
    let (sw, sh) = crate::texmeta::probe_dims(p).unwrap_or((w, ih));
    info.source_width = sw;
    info.source_height = sh;
    let rgba = thumb.to_rgba8();
    cache.put(
        h,
        Pixels {
            width: rgba.width(),
            height: rgba.height(),
            rgba: rgba.into_raw(),
            info,
        },
    );
    Ok((key, info))
}

/// True for the audio formats whose thumbnail comes from cover art / a
/// waveform rather than an image decode. Mirrors `AUDIO_EXTENSIONS`.
fn is_audio_path(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| crate::types::AUDIO_EXTENSIONS.contains(&e.as_str()))
}

/// Audio grid thumbnail: embedded cover art if the file has any, else a
/// rendered waveform. Keyed `"a"` so it lives in the same cache/blob and is
/// served over the same `thumb://`/`tex://` path as textures, but can never
/// collide with a texture key for the same path.
fn build_audio(path: &str, p: &Path, cache: &ThumbCache) -> Result<(String, ThumbInfo), String> {
    let (size, mtime) = file_stamp(p);
    let h = hash_key("a", path, size, mtime);
    let key = hex_key(h);

    // Warm blob hit: return the stored stats — never re-decode cover art or
    // re-run the (expensive, full-file) waveform decode.
    if let Some(px) = cache.get(h) {
        return Ok((key, px.info));
    }

    // Cover art first (it IS a picture); the waveform is the fallback for the
    // many game-audio files that ship untagged.
    let img = audio_cover(p)
        .or_else(|| audio_waveform_image(path))
        .ok_or_else(|| format!("{path}: no cover art and no decodable waveform"))?;
    let (w, ih) = img.dimensions();
    if w == 0 || ih == 0 {
        return Err(format!("{path}: zero-sized audio thumb"));
    }
    let thumb = if w.max(ih) > THUMB_EDGE {
        img.resize(THUMB_EDGE, THUMB_EDGE, FilterType::Triangle)
    } else {
        img
    };
    let mut info = analyze(&thumb);
    info.source_width = w;
    info.source_height = ih;
    let rgba = thumb.to_rgba8();
    cache.put(
        h,
        Pixels {
            width: rgba.width(),
            height: rgba.height(),
            rgba: rgba.into_raw(),
            info,
        },
    );
    Ok((key, info))
}

/// Embedded cover art via lofty — ID3 APIC (mp3/wav/aiff), FLAC/OGG PICTURE,
/// MP4 `covr` — decoded through the same `image` path textures use. `None` when
/// the file carries no tag or no picture.
fn audio_cover(p: &Path) -> Option<DynamicImage> {
    use lofty::prelude::TaggedFileExt;
    let tagged = lofty::read_from_path(p).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pic = tag.pictures().first()?;
    image::load_from_memory(pic.data()).ok()
}

/// A square waveform rendered from the audio peaks — the fallback thumbnail
/// when there's no embedded art. Transparent background so the cell's own
/// colour shows through; a single accent colour, centred on the midline. The
/// peaks come from the same decoder the player-bar waveform uses.
fn audio_waveform_image(path: &str) -> Option<DynamicImage> {
    const SIZE: u32 = 256;
    const BINS: u32 = 96;
    let peaks = crate::waveform::peaks_blocking(path, BINS)?;
    let bins = (peaks.len() / 2) as u32;
    if bins == 0 {
        return None;
    }
    let mut img = image::RgbaImage::new(SIZE, SIZE); // zero-filled = transparent
    let mid = SIZE as f32 / 2.0;
    let amp = mid * 0.9;
    // Matches the app's waveform tint; opaque bars over the transparent bg.
    let color = image::Rgba([96u8, 165, 250, 255]);
    for x in 0..SIZE {
        let bin = (x * bins / SIZE) as usize;
        let hi = peaks[bin * 2 + 1]; // max → above the midline
        let lo = peaks[bin * 2]; // min → below
        let mut top = (mid - hi * amp).round();
        let mut bot = (mid - lo * amp).round();
        if top > bot {
            std::mem::swap(&mut top, &mut bot);
        }
        let y0 = top.clamp(0.0, SIZE as f32 - 1.0) as u32;
        let y1 = bot.clamp(0.0, SIZE as f32 - 1.0) as u32;
        for y in y0..=y1 {
            img.put_pixel(x, y, color);
        }
    }
    Some(DynamicImage::ImageRgba8(img))
}

/// Queue thumbnails for the given (id, path) pairs, superseding the previous
/// request when `supersede` is set. **Returns the ids that were dropped
/// unstarted**, so the caller can forget it ever asked for them.
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
///
/// `supersede`/`background` distinguish the three kinds of caller. The grid
/// scroller owns the queue and supersedes (drops the previous window). A *pin*
/// â€” the audio inspector or a fullscreen preview asking for one selected file
/// â€” must NOT supersede: it shares the grid's queue but not its "asked"
/// bookkeeping, so draining the grid's jobs here would report them dropped to
/// the *pin's* promise, which discards them; the grid never re-asks and its
/// cells strand. A pin therefore jumps to the front of the queue and drops
/// nothing (returns empty), decoding its file next without disturbing the
/// grid's window.
///
/// `background` is the idle prefetcher (thumbPrefetch.ts): append BEHIND
/// everything and drop nothing, so warming future tabs can never delay a
/// visible cell or a pin â€” and the next interactive supersede is free to
/// discard the backfill wholesale. That costs the prefetcher nothing: it holds
/// no "asked" bookkeeping, re-deriving what is still undone from the store
/// each round, so a dropped backfill job is simply re-found later.
#[tauri::command]
pub async fn request_thumbs(
    app: AppHandle,
    state: State<'_, ThumbState>,
    items: Vec<(u32, String)>,
    supersede: bool,
    background: Option<bool>,
) -> Result<Vec<u32>, String> {
    let n = items.len();
    // Take BOTH locks before touching either, and hold `running` across the
    // spawn. Otherwise a drain that is mid-exit can set running=false after we
    // observed it true, and the jobs we just queued sit there with nobody to
    // drain them â€” the cells stay blank forever with no error anywhere.
    let mut running = state.running.lock();
    let dropped: Vec<u32> = {
        let mut q = state.queue.lock();
        if supersede {
            // drain, not clear â€” we owe the caller the ids we are abandoning
            let dropped = q.drain(..).map(|j| j.id).collect();
            for (id, path) in items {
                q.push(Job { id, path });
            }
            dropped
        } else if background == Some(true) {
            // Backfill: strictly behind whatever is queued.
            for (id, path) in items {
                q.push(Job { id, path });
            }
            Vec::new()
        } else {
            // Pin: prepend so the selected file decodes next, keep the grid's
            // window intact, and drop nothing. `.rev()` preserves caller order
            // once the inserts stack up at the front.
            for (id, path) in items.into_iter().rev() {
                q.insert(0, Job { id, path });
            }
            Vec::new()
        }
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
    let threads = decode_threads();
    let pool = match rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
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
    // Shared across workers so ANY of them can flush once the cadence elapses —
    // emissions stay batched (~FLUSH_MS apart) without a dedicated timer thread.
    let last_flush = Mutex::new(std::time::Instant::now());

    loop {
        let state = app.state::<ThumbState>();
        let blob = app.state::<ThumbCache>();
        let blob_ref: &ThumbCache = &blob;
        let pending_ref = &pending;
        let last_flush_ref = &last_flush;
        let app_ref = &app;

        // Every worker pulls ONE job at a time from the FRONT of the live
        // queue, so previews fill in top-left downward, the order the eye
        // scans — and there is NO chunk barrier. The old shape drained
        // `threads * 2` jobs and par_iter'd them, which parked every finished
        // worker until the chunk's slowest decode returned: one 380 ms PNG
        // held 15 idle threads (measured 30% slower on a mixed batch), and
        // its chunk-mates' finished results couldn't flush until it was done.
        // Per-job pulling also shrinks the committed window (jobs cancellation
        // can no longer reach) from threads*2 to threads.
        pool.install(|| {
            rayon::scope(|s| {
                for _ in 0..threads {
                    s.spawn(move |_| loop {
                        let job = {
                            let st = app_ref.state::<ThumbState>();
                            let mut q = st.queue.lock();
                            if q.is_empty() {
                                return;
                            }
                            q.remove(0)
                        };

                        // NOTE: deliberately no staleness gate on the RESULT,
                        // unlike waveform.rs. A waveform is single-slot state,
                        // so a stale one would clobber the current track's
                        // peaks; thumbnails are keyed by file id, so a late
                        // result is simply a correct result that arrived late.
                        // Dropping it would strand the cell forever â€” the
                        // frontend never re-asks for an id it already asked for.
                        //
                        // Memory hit: skip the decode entirely — but only trust
                        // the memo while the PIXELS are still there. The memo is
                        // bounded by ENTRY COUNT (2048) and ThumbCache by a BYTE
                        // budget, so the two evict independently: on a large
                        // library the blob drops a thumbnail whose memo entry is
                        // still live. Taking the shortcut then answers with a
                        // key that has nothing behind it — `thumb://` 404s and
                        // the cell strands showing badges and dimensions (both
                        // come from this `info`) but no image, with no way back.
                        // Verify, and on a miss fall through to a real re-decode.
                        let memo =
                            app_ref.state::<ThumbState>().cache.lock().get(&job.path).cloned();
                        let mut served = false;
                        if let Some((key, info)) = memo {
                            if crate::thumbcache::parse_key(&key)
                                .is_some_and(|h| blob_ref.contains(h))
                            {
                                pending_ref.lock().push((job.id, info, key));
                                served = true;
                            } else {
                                // Stale memo — drop it so build() replaces it.
                                app_ref.state::<ThumbState>().cache.lock().pop(&job.path);
                            }
                        }
                        if !served {
                            match build(&job.path, blob_ref) {
                                Ok((key, info)) => {
                                    app_ref
                                        .state::<ThumbState>()
                                        .cache
                                        .lock()
                                        .put(job.path.clone(), (key.clone(), info));
                                    pending_ref.lock().push((job.id, info, key));
                                }
                                Err(e) => eprintln!("[thumbs] {e}"),
                            }
                        }

                        // Cadence flush from whichever worker crosses the line
                        // first. Under the old chunk barrier a straggler delayed
                        // its chunk-mates' FINISHED results by its whole decode
                        // time; now they reach the screen within ~FLUSH_MS.
                        let due = {
                            let mut lf = last_flush_ref.lock();
                            if lf.elapsed().as_millis() as u64 >= FLUSH_MS {
                                *lf = std::time::Instant::now();
                                true
                            } else {
                                false
                            }
                        };
                        if due {
                            flush(app_ref, pending_ref);
                        }
                    });
                }
            });
        });

        // Workers only exit on an empty queue: emit what's left, then re-check
        // the queue while holding `running`, in the same lock order
        // request_thumbs uses. A request that landed between the workers
        // exiting and here would otherwise be orphaned.
        flush(&app, &pending);
        let mut running = state.running.lock();
        if state.queue.lock().is_empty() {
            *running = false;
            return;
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
            rgba: rgba.to_vec(),
            // Model thumbs are rendered, not decoded — no image stats to carry.
            info: crate::types::ThumbInfo::default(),
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
