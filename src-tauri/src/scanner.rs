//! Recursive library scanning. Each `start_scan` bumps a global generation
//! counter and spawns a walker thread that streams `scan:batch` events of at
//! most [`BATCH_SIZE`] entries — never one huge invoke payload. Threads from
//! superseded scans notice the generation change and stop emitting.

use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Instant, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, State};
use walkdir::WalkDir;

use crate::metadata;
use crate::types::{
    events, AssetKind, FileEntry, ScanBatch, ScanDone, AUDIO_EXTENSIONS, MODEL_EXTENSIONS,
    SKIP_DIRS, TEXTURE_EXTENSIONS,
};

const BATCH_SIZE: usize = 1000;

/// Managed state: the current scan generation. Bumping it invalidates every
/// in-flight scan walker and duration-probe worker.
#[derive(Default)]
pub struct ScanState {
    pub generation: AtomicU32,
    /// The roots the user has consented to, as of the last scan. The `model://`
    /// scheme checks reads against these — a crafted glTF referencing
    /// `../../../../Windows/System32/...` must not resolve. `start_scan` is the
    /// single choke point every root passes through, including hydration from
    /// persisted settings, so this is the one place worth setting it.
    pub roots: parking_lot::Mutex<Vec<String>>,
}

/// True if `path` sits inside a root the user picked. Case-insensitive because
/// Windows paths are, and separator-normalized because the URL carries `/`.
pub fn is_within_roots(app: &AppHandle, path: &Path) -> bool {
    let Ok(canon) = path.canonicalize() else {
        return false;
    };
    let target = canon.to_string_lossy().to_lowercase().replace('/', "\\");
    // Bind the State guard: `app.state::<T>()` is a temporary, and locking
    // through it inline would drop it while the lock still borrows it.
    let state = app.state::<ScanState>();
    let roots = state.roots.lock();
    roots.iter().any(|r| {
        let Ok(rc) = Path::new(r).canonicalize() else {
            return false;
        };
        let root = rc.to_string_lossy().to_lowercase().replace('/', "\\");
        // Trailing-separator trim so the boundary test lands on the right char
        // (a drive root is "C:\"), then require a separator so `C:\AB` never
        // matches root `C:\A`.
        let root = root.trim_end_matches('\\');
        target.starts_with(root)
            && (target.len() == root.len() || target.as_bytes().get(root.len()) == Some(&b'\\'))
    })
}

/// The scan generation currently considered live.
pub fn current_generation(app: &AppHandle) -> u32 {
    app.state::<ScanState>().generation.load(Ordering::SeqCst)
}

#[tauri::command]
pub async fn start_scan(
    app: AppHandle,
    state: State<'_, ScanState>,
    roots: Vec<String>,
) -> Result<u32, String> {
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    // Record consent before the walk: the model:// scheme reads this, and a
    // preview can be requested the moment the first batch lands.
    *state.roots.lock() = roots.clone();
    std::thread::Builder::new()
        .name(format!("scanner-{gen}"))
        .spawn(move || scan_worker(app, roots, gen))
        .map_err(|e| format!("failed to spawn scan thread: {e}"))?;
    Ok(gen)
}

fn scan_worker(app: AppHandle, roots: Vec<String>, gen: u32) {
    let started = Instant::now();
    let mut next_id: u32 = 0;
    let mut total: u64 = 0;
    let mut batch: Vec<FileEntry> = Vec::with_capacity(BATCH_SIZE);
    // (id, path) list handed to the duration-probe worker after the walk.
    let mut meta_queue: Vec<(u32, String)> = Vec::new();

    for root in &roots {
        // filter_entry prunes whole subtrees (build dirs, VCS metadata) before
        // walkdir descends — a straight speed win, and the only thing keeping
        // a C++ build's COFF `.obj` files out of the Models tab.
        let walker = WalkDir::new(root)
            .into_iter()
            .filter_entry(|e| !is_skipped_dir(e));
        for entry in walker {
            if current_generation(&app) != gen {
                return; // superseded by a newer scan — go quiet
            }
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("[scan] walk error: {e}");
                    continue;
                }
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let Some((ext, kind)) = classify(entry.path()) else {
                continue;
            };
            // walkdir already has this metadata on Windows — no extra stat.
            let (size, modified) = match entry.metadata() {
                Ok(md) => (md.len(), unix_seconds(&md)),
                Err(e) => {
                    eprintln!("[scan] metadata error for {}: {e}", entry.path().display());
                    (0, 0)
                }
            };

            let id = next_id;
            next_id += 1;
            total += 1;
            let path = entry.path().to_string_lossy().into_owned();
            // AUDIO ONLY. probe_durations hands every queued path to symphonia;
            // queueing textures/models would make it try to decode `.png` and
            // `.fbx` — thousands of them in a Synty pack — burning CPU and
            // flooding stderr for results that can never exist.
            if matches!(kind, AssetKind::Audio) {
                meta_queue.push((id, path.clone()));
            }
            batch.push(FileEntry {
                id,
                path,
                name: entry.file_name().to_string_lossy().into_owned(),
                ext,
                kind,
                size,
                modified,
            });

            if batch.len() >= BATCH_SIZE {
                emit_batch(&app, gen, &mut batch);
            }
        }
    }

    if current_generation(&app) != gen {
        return;
    }
    if !batch.is_empty() {
        emit_batch(&app, gen, &mut batch);
    }
    let done = ScanDone {
        gen,
        total,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    if let Err(e) = app.emit(events::SCAN_DONE, done) {
        eprintln!("[scan] failed to emit scan:done: {e}");
    }

    // Lazy duration probing runs on this (already background) thread until
    // done or superseded.
    metadata::probe_durations(app, meta_queue, gen);
}

fn emit_batch(app: &AppHandle, gen: u32, batch: &mut Vec<FileEntry>) {
    let files = std::mem::take(batch);
    if let Err(e) = app.emit(events::SCAN_BATCH, ScanBatch { gen, files }) {
        eprintln!("[scan] failed to emit scan:batch: {e}");
    }
}

/// Lower-cased extension + which tab it belongs to, or `None` if the file is
/// not an asset we handle. One classification for one walk — the scanner never
/// walks the tree per kind.
fn classify(path: &Path) -> Option<(String, AssetKind)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let e = ext.as_str();
    let kind = if AUDIO_EXTENSIONS.contains(&e) {
        AssetKind::Audio
    } else if TEXTURE_EXTENSIONS.contains(&e) {
        // Documentation images that ship inside asset packs (a vendor's
        // "- Thank You.png", a readme screenshot) are the one common way the
        // Textures tab fills with non-assets. They only masquerade as textures;
        // skip them. Audio/models never carry these names, so the check is
        // texture-only.
        if is_doc_image(path) {
            return None;
        }
        AssetKind::Texture
    } else if MODEL_EXTENSIONS.contains(&e) {
        AssetKind::Model
    } else {
        return None;
    };
    Some((ext, kind))
}

/// True if an image's name marks it as documentation rather than a game asset.
///
/// Deliberately narrow — these words essentially never name a real texture, so
/// the false-positive risk is nil, while "- Thank You.png" is exactly what
/// OVNI/audio packs ship and what clutters the Textures tab.
fn is_doc_image(path: &Path) -> bool {
    const DOC_MARKERS: [&str; 7] = [
        "thank you",
        "thankyou",
        "readme",
        "read me",
        "license",
        "licence",
        "changelog",
    ];
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
        return false;
    };
    let low = stem.to_ascii_lowercase();
    DOC_MARKERS.iter().any(|m| low.contains(m))
}

/// True for directories we never descend into: dot-prefixed tooling metadata
/// (`.git`, `.svn`, `.mayaSwatches`, `.vs`) plus the [`SKIP_DIRS`] list.
///
/// Files are never skipped here — only directories — and depth 0 is exempt so
/// a root the user explicitly picked always scans, whatever it's called.
fn is_skipped_dir(entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return false;
    }
    let Some(name) = entry.file_name().to_str() else {
        return false;
    };
    name.starts_with('.') || SKIP_DIRS.iter().any(|s| name.eq_ignore_ascii_case(s))
}

fn unix_seconds(md: &std::fs::Metadata) -> i64 {
    match md.modified() {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs() as i64,
            Err(e) => -(e.duration().as_secs() as i64),
        },
        Err(_) => 0,
    }
}
