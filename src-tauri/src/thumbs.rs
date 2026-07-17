//! Texture thumbnails: decode in Rust, cache on disk, serve over a custom URI
//! scheme.
//!
//! Rust decodes because Chromium cannot read DDS/TGA/EXR/HDR at all, and even
//! for PNG a 4K image in a 128px cell would decode at full resolution — 200
//! visible cells of that is an OOM, not a slow frame.
//!
//! Two channels, mirroring `waveform.rs`'s split of "cheap request, fat
//! result":
//!
//! ```text
//! invoke request_thumbs(ids, gen)   <- cheap, cancellable, batched
//!   -> worker pool decodes + writes <hash>.png
//!   -> event thumb:ready            <- cheap notification: "key K exists"
//!   -> frontend sets <img src="http://thumb.localhost/K">
//!   -> WebView2 GETs it             <- the fat payload, off the JS main thread
//! ```
//!
//! The protocol handler NEVER decodes. Memory LRU -> disk -> 404. Decoding
//! inside it would block on a 4K PNG with no cancellation and no batching —
//! exactly what this design exists to avoid.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView};
use lru::LruCache;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::portable::DataHome;
use crate::types::{events, ThumbBatch, ThumbInfo};

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
    /// Bumped on every viewport change; stale jobs go quiet.
    pub generation: AtomicU32,
    /// path -> cache key, so a re-scrolled cell skips the disk probe.
    cache: Mutex<LruCache<String, String>>,
    queue: Mutex<Vec<Job>>,
    running: Mutex<bool>,
}

struct Job {
    id: u32,
    path: String,
    gen: u32,
}

impl Default for ThumbState {
    fn default() -> Self {
        Self {
            generation: AtomicU32::new(0),
            cache: Mutex::new(LruCache::new(std::num::NonZeroUsize::new(2048).unwrap())),
            queue: Mutex::new(Vec::new()),
            running: Mutex::new(false),
        }
    }
}

/// FNV-1a over `version:edge:size:mtime:path`.
///
/// size+mtime means a texture overwritten by a DCC re-decodes, same reasoning
/// as waveform.rs's key. FNV inline rather than a hashing crate: collisions
/// across 100k thumbs are ~1e-10 and self-heal on the next mtime change.
fn cache_key(path: &str, size: u64, mtime: i64) -> String {
    let raw = format!("{CACHE_VERSION}:{THUMB_EDGE}:{size}:{mtime}:{path}");
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in raw.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
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
        normal_like,
        grayscale,
        bimodal,
        has_alpha,
        mean_r: mean[0] as f32,
        mean_g: mean[1] as f32,
        mean_b: mean[2] as f32,
    }
}

/// Decode -> downscale -> PNG -> disk. Returns the cache key and stats.
fn build(path: &str, dir: &Path) -> Result<(String, ThumbInfo), String> {
    let p = Path::new(path);
    let (size, mtime) = file_stamp(p);
    let key = cache_key(path, size, mtime);
    let out = dir.join(format!("{key}.png"));

    // Cache hit: still need the dims/stats, so read back the thumb (small and
    // already decoded once) rather than touching the 4K original again.
    if out.exists() {
        if let Ok(img) = image::open(&out) {
            return Ok((key, analyze(&img)));
        }
        let _ = fs::remove_file(&out); // corrupt entry — rebuild it
    }

    let img = image::open(p).map_err(|e| format!("decode {path}: {e}"))?;
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return Err(format!("{path}: zero-sized image"));
    }
    // Triangle over Lanczos: at a 16:1 downscale the ringing Lanczos adds is
    // visible on the hard-edged art these packs ship, and it is ~3x slower.
    let thumb = if w.max(h) > THUMB_EDGE {
        img.resize(THUMB_EDGE, THUMB_EDGE, FilterType::Triangle)
    } else {
        img
    };

    let info = analyze(&thumb);
    let mut buf = Cursor::new(Vec::new());
    thumb
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("encode {path}: {e}"))?;
    fs::write(&out, buf.into_inner()).map_err(|e| format!("write {}: {e}", out.display()))?;
    Ok((key, info))
}

/// Queue thumbnails for the given (id, path) pairs.
///
/// LIFO drain: during a fast scroll the newest visible cells win, and the gen
/// check drops everything the user has already scrolled past. Ported straight
/// from waveform.rs's cancellation shape.
#[tauri::command]
pub async fn request_thumbs(
    app: AppHandle,
    state: State<'_, ThumbState>,
    items: Vec<(u32, String)>,
) -> Result<u32, String> {
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let n = items.len();
    // Take BOTH locks before touching either, and hold `running` across the
    // spawn. Otherwise a drain that is mid-exit can set running=false after we
    // observed it true, and the jobs we just queued sit there with nobody to
    // drain them — the cells stay blank forever with no error anywhere.
    let mut running = state.running.lock();
    {
        let mut q = state.queue.lock();
        q.clear(); // drop unstarted stale jobs
        for (id, path) in items {
            q.push(Job { id, path, gen });
        }
    }
    #[cfg(debug_assertions)]
    eprintln!("[thumbs] queued {n} gen={gen} running={}", *running);
    let _ = n;
    if !*running {
        *running = true;
        let handle = app.clone();
        std::thread::Builder::new()
            .name("thumbs".into())
            .spawn(move || drain(handle))
            .map_err(|e| format!("spawn thumb thread: {e}"))?;
    }
    Ok(gen)
}

fn drain(app: AppHandle) {
    let dir = app.state::<DataHome>().thumbs_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("[thumbs] cannot create {}: {e}", dir.display());
        *app.state::<ThumbState>().running.lock() = false;
        return;
    }

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

        let dir_ref = &dir;
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
                // The generation still governs what gets QUEUED (clear + LIFO),
                // which is where cancellation actually pays.
                match build(&job.path, dir_ref) {
                    Ok((key, info)) => {
                        app.state::<ThumbState>()
                            .cache
                            .lock()
                            .put(job.path.clone(), key.clone());
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

/// Resolve a cache key to its file, for the URI-scheme handler.
pub fn thumb_file(app: &AppHandle, key: &str) -> Option<PathBuf> {
    // Keys are our own 16 hex chars; refuse anything else rather than letting
    // a crafted URL walk out of the cache dir.
    if key.len() != 16 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let p = app.state::<DataHome>().thumbs_dir().join(format!("{key}.png"));
    p.exists().then_some(p)
}

/// Prune the cache to a size cap, oldest-first. Dumb and sufficient.
pub fn gc(dir: PathBuf, cap_bytes: u64) {
    let Ok(rd) = fs::read_dir(&dir) else { return };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let md = e.metadata().ok()?;
            Some((e.path(), md.len(), md.modified().ok()?))
        })
        .collect();
    let total: u64 = files.iter().map(|f| f.1).sum();
    if total <= cap_bytes {
        return;
    }
    files.sort_by_key(|f| f.2);
    let mut freed = 0u64;
    for (p, len, _) in files {
        if total - freed <= cap_bytes {
            break;
        }
        if fs::remove_file(&p).is_ok() {
            freed += len;
        }
    }
}
