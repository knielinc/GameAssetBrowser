//! Texture thumbnails: decode in Rust, cache in ONE file, serve over a custom
//! URI scheme.
//!
//! Rust decodes because Chromium cannot read DDS/TGA/EXR/HDR at all, and even
//! for PNG a 4K image in a 128px cell would decode at full resolution — 200
//! visible cells of that is an OOM, not a slow frame.
//!
//! Storage is a single append-only blob (see `thumbcache.rs`), not thousands
//! of loose PNGs — one tidy file in the data folder instead of clutter.
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
//! inside it would block on a 4K PNG with no cancellation and no batching —
//! exactly what this design exists to avoid.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView};
use lru::LruCache;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::portable::DataHome;
use crate::thumbcache::{Pixels, ThumbCache};
use crate::types::{events, ThumbBatch, ThumbInfo};

/// On-disk directory for rendered MODEL thumbnails, created lazily.
///
/// Models are the one thing worth persisting: a texture thumbnail is a
/// millisecond decode, but a model thumbnail is a full FBX/glTF parse + render
/// in the webview (100-400 ms each). RAM-only meant re-rendering every model on
/// every launch — the reason a big library felt slow. Textures stay RAM-only
/// (the user's explicit call); only models land here, as small PNGs.
fn model_cache_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.try_state::<DataHome>()?.dir().join("model-thumbs");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Thumbnail edge in px. 256 covers the largest grid cell (220) plus a little
/// headroom for hi-dpi without storing a second size.
const THUMB_EDGE: u32 = 256;
/// Bump to invalidate every cached thumbnail after a pipeline change.
const CACHE_VERSION: u32 = 1;
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

/// Tone-map a floating-point image down to 8-bit.
///
/// `.hdr` decodes to Rgb32F and `.exr` to Rgba32F, and the PNG encoder cannot
/// write either — it returns Unsupported, the thumbnail is never written, and
/// the cell stays blank forever with only a line on stderr. That silently cost
/// 38 of 303 real files here.
///
/// Straight truncation to 8-bit would "work" and look wrong: HDR values run
/// well past 1.0, so everything bright clamps to flat white. Reinhard maps the
/// whole range into [0,1] first, then gamma-encodes — the same shape of
/// tone-mapping the 3D viewport applies, so an HDRI's thumbnail resembles what
/// you get when you open it.
fn to_ldr(img: DynamicImage) -> DynamicImage {
    match img {
        DynamicImage::ImageRgb32F(_) | DynamicImage::ImageRgba32F(_) => {
            let src = img.to_rgba32f();
            let mut out = image::RgbaImage::new(src.width(), src.height());
            let map = |v: f32| -> u8 {
                let v = if v.is_finite() { v.max(0.0) } else { 0.0 };
                let tone = v / (1.0 + v); // Reinhard
                (tone.powf(1.0 / 2.2) * 255.0).clamp(0.0, 255.0) as u8
            };
            for (s, d) in src.pixels().zip(out.pixels_mut()) {
                *d = image::Rgba([
                    map(s[0]),
                    map(s[1]),
                    map(s[2]),
                    (s[3].clamp(0.0, 1.0) * 255.0) as u8,
                ]);
            }
            DynamicImage::ImageRgba8(out)
        }
        // 16-bit types encode to PNG fine; leave them alone.
        other => other,
    }
}

/// Decode -> downscale -> RGBA -> the in-memory cache. Returns the hex key and
/// stats. NO PNG is produced: the grid uploads this RGBA straight to the GPU.
fn build(path: &str, cache: &ThumbCache) -> Result<(String, ThumbInfo), String> {
    let p = Path::new(path);
    let (size, mtime) = file_stamp(p);
    let h = hash_key("t", path, size, mtime);
    let key = hex_key(h);

    // Cache hit: the RGBA and its dims are already here — recompute stats from
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

    let img = image::open(p).map_err(|e| format!("decode {path}: {e}"))?;
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
/// cancellation works — without it, scrolling a 2000-texture folder would
/// eventually decode all of it, which the concurrency cap exists to prevent.
/// But the frontend marks an id "asked" the moment the invoke resolves and
/// never asks twice, so a silently-dropped job stranded that cell FOREVER: no
/// thumbnail, no error, no retry. It bit on ordinary scrolling, not just fast
/// flicks — the drain releases the queue lock across its multi-hundred-ms
/// decode barrier, which is far longer than the frontend's 120 ms debounce.
///
/// Returning the dropped ids keeps both properties: the queue stays bounded,
/// and nothing is lost. Cheap — it is a Vec<u32> of at most a screenful.
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
    // drain them — the cells stay blank forever with no error anywhere.
    let mut running = state.running.lock();
    let dropped: Vec<u32> = {
        let mut q = state.queue.lock();
        // drain, not clear — we owe the caller the ids we are abandoning
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

        // Take a chunk LIFO so the cells under the cursor render first.
        let chunk: Vec<Job> = {
            let mut q = state.queue.lock();
            let take = q.len().min(DECODE_THREADS * 2);
            let at = q.len() - take;
            q.split_off(at)
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
                // arrived late. Dropping it would strand the cell forever —
                // the frontend never re-asks for an id it already asked for.
                //
                // Memory hit: skip the blob decode entirely. build() decodes
                // the stored 256px PNG purely to recompute stats that cannot
                // have changed — cheap per cell, but it recurs for every cell
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

/// Cached model-thumbnail keys for `items`, as `(id, key)` — only for entries
/// that actually exist on disk. Callers render the misses themselves.
///
/// Models are rendered in the WEBVIEW (Rust has no FBX story), so unlike
/// textures the Rust side only owns the cache: lookup and store. The decode,
/// framing, and rasterization all happen in three.js.
#[tauri::command]
pub fn model_thumb_lookup(app: AppHandle, items: Vec<(u32, String)>) -> Vec<(u32, String)> {
    let cache = app.state::<ThumbCache>();
    let dir = model_cache_dir(&app);
    items
        .into_iter()
        .filter_map(|(id, path)| {
            let (size, mtime) = file_stamp(Path::new(&path));
            let h = hash_key("m", &path, size, mtime);
            let key = hex_key(h);
            if cache.contains(h) {
                return Some((id, key));
            }
            // Disk hit: decode the cached PNG straight into the RAM cache so the
            // tex:// handler serves it exactly like a freshly rendered one, and
            // the (expensive) render is skipped entirely.
            let png = dir.as_ref()?.join(format!("{key}.png"));
            let img = image::open(&png).ok()?; // miss → None → the caller renders it
            let rgba = img.to_rgba8();
            let (w, ih) = (rgba.width(), rgba.height());
            cache.put(
                h,
                Pixels {
                    width: w,
                    height: ih,
                    src_w: w,
                    src_h: ih,
                    rgba: rgba.into_raw(),
                },
            );
            Some((id, key))
        })
        .collect()
}

/// Persist a webview-rendered model thumbnail as RGBA. Returns its cache key,
/// which the frontend turns into a `tex://` URL.
///
/// The frontend renders the model in three.js, reads the canvas back as RGBA
/// (getImageData), and sends the raw pixels — same no-PNG path as textures.
/// ~256 KB over IPC at a couple per second is noise.
#[tauri::command]
pub fn model_thumb_store(
    app: AppHandle,
    path: String,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
) -> Result<String, String> {
    if rgba.len() != (width as usize) * (height as usize) * 4 {
        return Err("rgba length does not match dimensions".into());
    }
    let (size, mtime) = file_stamp(Path::new(&path));
    let h = hash_key("m", &path, size, mtime);
    let key = hex_key(h);
    // Build the image once, persist it to disk (so a relaunch skips the render),
    // then hand the raw pixels to the RAM cache. A model thumbnail is rendered,
    // not decoded — its "source" size is just the render size; the status bar
    // shows resolution for textures only.
    let img = image::RgbaImage::from_raw(width, height, rgba).ok_or("bad rgba buffer")?;
    if let Some(dir) = model_cache_dir(&app) {
        // Best-effort: a failed write just means this model re-renders next time.
        let _ = img.save(dir.join(format!("{key}.png")));
    }
    app.state::<ThumbCache>().put(
        h,
        Pixels {
            width,
            height,
            src_w: width,
            src_h: height,
            rgba: img.into_raw(),
        },
    );
    Ok(key)
}

/// PNG bytes for a cache key, for the `thumb://` handler — the few surfaces
/// still on `<img>`/three.js. Keys are our own 16 hex chars; anything else is
/// refused rather than trusted.
pub fn thumb_bytes(app: &AppHandle, key: &str) -> Option<Vec<u8>> {
    let h = crate::thumbcache::parse_key(key)?;
    app.state::<ThumbCache>().get_png(h)
}

/// Raw RGBA for the `tex://` handler — the WebGL grid. Wire format:
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
