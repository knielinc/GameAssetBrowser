//! Recursive library scanning. Each `start_scan` bumps a global generation
//! counter and spawns a walker thread that streams `scan:batch` events of at
//! most [`BATCH_SIZE`] entries — never one huge invoke payload. Threads from
//! superseded scans notice the generation change and stop emitting.

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Instant, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::index;
use crate::metadata;
use crate::texmeta;
use crate::watcher;
use crate::types::{
    events, AssetKind, FileEntry, ScanBatch, ScanDone, AUDIO_EXTENSIONS, DOCUMENT_EXTENSIONS,
    MODEL_EXTENSIONS, SKIP_DIRS, TEXTURE_EXTENSIONS,
};

const BATCH_SIZE: usize = 1000;

/// Managed state: the current scan generation. Bumping it invalidates every
/// in-flight scan walker and duration-probe worker.
#[derive(Default)]
pub struct ScanState {
    pub generation: AtomicU32,
    /// True from generation bump until that generation's worker finished its
    /// disk walk (including the index-verify pass). The watcher reads this to
    /// coalesce mid-scan filesystem bursts into one trailing rescan.
    pub scanning: AtomicBool,
    /// Set by the watcher when relevant events land while `scanning`; drained
    /// into exactly one rescan when the running scan finishes.
    pub rescan_pending: AtomicBool,
    /// The roots the user has consented to, as of the last scan. The `model://`
    /// scheme checks reads against these — a crafted glTF referencing
    /// `../../../../Windows/System32/...` must not resolve. `start_scan` is the
    /// single choke point every root passes through, including hydration from
    /// persisted settings, so this is the one place worth setting it.
    pub roots: parking_lot::Mutex<Vec<String>>,
    /// `roots` canonicalized + normalized for the prefix test in
    /// `is_within_roots`, rebuilt once per scan. Keeps that hot scheme-request
    /// path from `canonicalize()`-ing every root on every model/preview/doc
    /// fetch (a glTF pulls many sibling textures, each hitting this).
    pub roots_norm: parking_lot::Mutex<Vec<String>>,
    /// Individual files the user explicitly chose in the Browse dialog for a
    /// model's atlas. They picked it themselves, so it is allowed even outside
    /// the scanned roots — but ONLY these exact files, canonicalized.
    pub approved: parking_lot::Mutex<std::collections::HashSet<String>>,
}

fn norm(path: &Path) -> Option<String> {
    // Separators normalized to `\` so the boundary check in is_within_roots is
    // uniform (the URL carries `/`). Case-folded only on Windows: canonicalize()
    // already resolves to the real on-disk casing everywhere, so case-sensitive
    // filesystems (Linux) match correctly without folding — and folding there
    // would wrongly collapse two distinct files onto one path.
    let s = path.canonicalize().ok()?.to_string_lossy().replace('/', "\\");
    #[cfg(windows)]
    let s = s.to_lowercase();
    Some(s)
}

/// A root canonicalized + normalized for the prefix test, with its trailing
/// separator trimmed (so a drive root "C:\" compares correctly). Same folding
/// as `norm`; computed once per scan and cached in `ScanState::roots_norm`.
fn norm_root(r: &str) -> Option<String> {
    let root = Path::new(r).canonicalize().ok()?.to_string_lossy().replace('/', "\\");
    #[cfg(windows)]
    let root = root.to_lowercase();
    Some(root.trim_end_matches('\\').to_string())
}

/// Allow a file the user explicitly browsed to as a model's atlas, so the
/// `model://` scheme will serve it even if it lives outside the scanned roots.
#[tauri::command]
pub fn approve_texture(app: AppHandle, path: String) {
    if let Some(n) = norm(Path::new(&path)) {
        app.state::<ScanState>().approved.lock().insert(n);
    }
}

/// True if `path` sits inside a root the user picked, or is a file they
/// explicitly browsed to. Case-insensitive (Windows) and separator-normalized
/// (the URL carries `/`).
pub fn is_within_roots(app: &AppHandle, path: &Path) -> bool {
    let Some(target) = norm(path) else {
        return false;
    };
    let state = app.state::<ScanState>();
    if state.approved.lock().contains(&target) {
        return true;
    }
    // Read the pre-normalized roots (rebuilt per scan) — no canonicalize here, so
    // a model load's many sibling fetches don't each syscall over every root.
    let roots = state.roots_norm.lock();
    roots.iter().any(|root| {
        // Require a separator after the root prefix so `C:\AB` never matches root
        // `C:\A` (roots_norm already trimmed the trailing separator).
        target.starts_with(root.as_str())
            && (target.len() == root.len() || target.as_bytes().get(root.len()) == Some(&b'\\'))
    })
}

/// The scan generation currently considered live.
pub fn current_generation(app: &AppHandle) -> u32 {
    app.state::<ScanState>().generation.load(Ordering::SeqCst)
}

#[tauri::command]
pub async fn start_scan(app: AppHandle, roots: Vec<String>) -> Result<u32, String> {
    spawn_scan(&app, roots)
}

/// Bump the generation and spawn a walker thread. The single internal entry
/// point for scans — the `start_scan` command and the filesystem watcher's
/// rescan both pass through here, so consent recording and the scanning flag
/// can never drift apart.
pub fn spawn_scan(app: &AppHandle, roots: Vec<String>) -> Result<u32, String> {
    let state = app.state::<ScanState>();
    // Bump the generation, record consent, and raise the scanning flag as one
    // step under the roots lock. Recording consent before the walk is required
    // (the model:// scheme reads it, and a preview can be requested the moment
    // the first batch lands); doing the bump+set atomically under the same lock
    // `finish_scan` takes is what lets its generation-check-then-clear never
    // interleave with this bump-and-set (see `finish_scan`).
    let gen = {
        let mut roots_guard = state.roots.lock();
        let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *roots_guard = roots.clone();
        state.scanning.store(true, Ordering::SeqCst);
        gen
    };
    // Rebuild the normalized-roots cache the scheme handlers read (is_within_roots).
    *state.roots_norm.lock() = roots.iter().filter_map(|r| norm_root(r)).collect();
    // Arm the watcher at scan START, not only at `finish_scan`. A file created
    // mid-walk fires no later event, so watching only after the walk leaves the
    // cold first scan (and any freshly added root) blind to changes during it —
    // and that gap bakes into the saved index, so index-served startups stay
    // stale until some unrelated event forces a rescan. Events during the walk
    // park in `rescan_pending` (scanning is true) and `finish_scan` drains them
    // into one trailing rescan. `arm` is a no-op once the root set matches, so
    // the trailing rescan and every watcher rescan don't churn OS handles.
    if !roots.is_empty() {
        watcher::arm(app, &roots);
    }
    let app = app.clone();
    if let Err(e) = std::thread::Builder::new()
        .name(format!("scanner-{gen}"))
        .spawn(move || scan_worker(app, roots, gen))
    {
        // Spawn failed: no worker will ever run `finish_scan` for this gen, so
        // the scanning flag would stick true forever and every future watcher
        // rescan would park in `rescan_pending` unserved. Roll it back — but
        // only while we're still the current gen, so we can't clobber a newer
        // scan that already claimed the flag (same guard `finish_scan` uses).
        let _guard = state.roots.lock();
        if state.generation.load(Ordering::SeqCst) == gen {
            state.scanning.store(false, Ordering::SeqCst);
        }
        return Err(format!("failed to spawn scan thread: {e}"));
    }
    Ok(gen)
}

/// Watcher entry point: debounced filesystem changes land here. Coalesces to
/// one trailing rescan when a scan is already running.
pub fn rescan_from_watcher(app: &AppHandle) {
    let state = app.state::<ScanState>();
    // Set the flag FIRST, then check `scanning`: whichever side observes the
    // other's write drains the flag, so a burst landing exactly at scan-end
    // still gets its trailing rescan instead of being lost in the gap.
    state.rescan_pending.store(true, Ordering::SeqCst);
    if !state.scanning.load(Ordering::SeqCst) {
        run_pending_rescan(app);
    }
}

/// Drain the pending-rescan flag into an actual scan of the last roots.
fn run_pending_rescan(app: &AppHandle) {
    let state = app.state::<ScanState>();
    if !state.rescan_pending.swap(false, Ordering::SeqCst) {
        return;
    }
    let roots = state.roots.lock().clone();
    if roots.is_empty() {
        return;
    }
    if let Err(e) = spawn_scan(app, roots) {
        eprintln!("[scan] watcher rescan failed: {e}");
    }
}

/// End-of-scan bookkeeping for a worker whose generation is still current:
/// clear the scanning flag, (re-)arm the watcher over the scanned roots, and
/// run the trailing rescan the watcher may have parked while we walked.
fn finish_scan(app: &AppHandle, gen: u32, roots: &[String]) {
    let state = app.state::<ScanState>();
    // Check the generation and clear scanning under the roots lock, so a newer
    // `spawn_scan` bumping the generation and re-raising the flag can't slip
    // between the check and the clear — otherwise this finishing worker would
    // wipe the NEW scan's scanning flag (and arm the watcher with the OLD root
    // set below). Holding the lock across both makes bump-and-set vs
    // check-and-clear mutually exclusive.
    {
        let _guard = state.roots.lock();
        if state.generation.load(Ordering::SeqCst) != gen {
            return; // a newer scan owns the flags now
        }
        state.scanning.store(false, Ordering::SeqCst);
    }
    // Arm and drain outside the lock: `run_pending_rescan` may re-enter
    // `spawn_scan`, which takes the roots lock itself.
    watcher::arm(app, roots);
    run_pending_rescan(app);
}

fn scan_worker(app: AppHandle, roots: Vec<String>, gen: u32) {
    // Fast path: a persisted index for exactly these roots streams instantly;
    // the real walk then runs behind it and corrects only if the disk changed.
    if let Some(stored) = index::load_matching(&app, &roots) {
        serve_index_then_verify(&app, &roots, gen, stored);
        return;
    }

    // Cold path: walk the disk, streaming batches as they fill.
    let started = Instant::now();
    let Some(files) = walk_roots(&app, &roots, gen, true) else {
        return; // superseded mid-walk — go quiet
    };
    emit_done(&app, gen, files.len() as u64, started);
    spawn_probes(&app, gen, &files);
    index::save(&app, &roots, &files);
    finish_scan(&app, gen, &roots);
}

/// Serve the persisted index as a normal scan (batches + done + probes), then
/// silently re-walk the disk behind it. Identical result → emit nothing more;
/// any difference → stream the fresh list under a NEW generation (the frontend
/// replaces wholesale on a gen bump) and rewrite the index.
fn serve_index_then_verify(
    app: &AppHandle,
    roots: &[String],
    gen: u32,
    stored: Vec<(String, u64, i64)>,
) {
    let started = Instant::now();
    let served = entries_from_index(stored);
    if !stream_collected(app, gen, &served, started) {
        return; // superseded while streaming
    }
    // Probes re-probe from scratch for the index-served gen — accepted cost;
    // durations/dimensions are deliberately not persisted in the index.
    spawn_probes(app, gen, &served);

    let verify_started = Instant::now();
    let Some(fresh) = walk_roots(app, roots, gen, false) else {
        return;
    };
    if index::fingerprint(&fresh) == index::fingerprint(&served) {
        finish_scan(app, gen, roots);
        return; // disk matches what the frontend already has
    }

    // Disk changed since the index was written. Claim a fresh generation — but
    // only if ours is still the live one: losing the CAS means a newer scan
    // superseded us mid-verify, and ITS walk delivers the truth instead.
    let state = app.state::<ScanState>();
    let new_gen = gen + 1;
    if state
        .generation
        .compare_exchange(gen, new_gen, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    if !stream_collected(app, new_gen, &fresh, verify_started) {
        return;
    }
    spawn_probes(app, new_gen, &fresh);
    index::save(app, roots, &fresh);
    finish_scan(app, new_gen, roots);
}

/// Rebuild `FileEntry`s from stored `(path, size, mtime)` tuples. Kind and ext
/// are re-derived from the extension exactly as the walker does — `classify`
/// stays the single source of truth — so a file the current build would no
/// longer list (say a new doc-image marker) drops out here too, and the
/// fingerprint comparison then flags the difference. Ids restart at 0, as
/// every generation's do.
fn entries_from_index(stored: Vec<(String, u64, i64)>) -> Vec<FileEntry> {
    let mut files: Vec<FileEntry> = Vec::with_capacity(stored.len());
    for (path, size, modified) in stored {
        let p = Path::new(&path);
        let Some((ext, kind)) = classify(p) else {
            continue;
        };
        let name = match p.file_name() {
            Some(n) => n.to_string_lossy().into_owned(),
            None => continue,
        };
        files.push(FileEntry {
            id: files.len() as u32,
            path,
            name,
            ext,
            kind,
            size,
            modified,
        });
    }
    files
}

/// Walk `roots`, classifying and deduping into one collected list. `stream`
/// emits each full batch as it fills so a cold scan paints progressively; the
/// index-verify pass walks silently. Returns `None` when superseded mid-walk
/// (already-emitted batches are harmless — the newer gen replaces them).
fn walk_roots(
    app: &AppHandle,
    roots: &[String],
    gen: u32,
    stream: bool,
) -> Option<Vec<FileEntry>> {
    let mut files: Vec<FileEntry> = Vec::new();
    // How many of `files` have already been emitted when streaming.
    let mut streamed = 0usize;
    // Paths already listed, so a file reachable from two OVERLAPPING roots
    // (e.g. `Documents` and `Documents\git\3d-test`) is listed once. Without
    // this it appears twice, and since selection is keyed by path, clicking one
    // copy highlights both. Normalized (lowercase + backslashes) — the same
    // file is byte-identical across roots, so no canonicalize syscall needed.
    let mut seen: HashSet<String> = HashSet::new();

    for root in roots {
        // filter_entry prunes whole subtrees (build dirs, VCS metadata) before
        // walkdir descends — a straight speed win, and the only thing keeping
        // a C++ build's COFF `.obj` files out of the Models tab.
        let walker = WalkDir::new(root)
            .into_iter()
            .filter_entry(|e| !is_skipped_dir(e));
        for entry in walker {
            if current_generation(app) != gen {
                return None; // superseded by a newer scan — go quiet
            }
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    // Broad roots (a whole drive, C:\, a folder above
                    // C:\Windows) inevitably cross system directories like
                    // C:\Windows\WUModels that deny listing. That's expected —
                    // skip the unreadable subtree quietly. Only genuinely
                    // unexpected walk errors are worth logging.
                    if e.io_error().map(std::io::Error::kind)
                        != Some(std::io::ErrorKind::PermissionDenied)
                    {
                        eprintln!("[scan] walk error: {e}");
                    }
                    continue;
                }
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let Some((ext, kind)) = classify(entry.path()) else {
                continue;
            };
            let path = entry.path().to_string_lossy().into_owned();
            if !seen.insert(path.to_lowercase().replace('/', "\\")) {
                continue; // already emitted via an overlapping root
            }
            // walkdir already has this metadata on Windows — no extra stat.
            let (size, modified) = match entry.metadata() {
                Ok(md) => (md.len(), unix_seconds(&md)),
                Err(e) => {
                    eprintln!("[scan] metadata error for {}: {e}", entry.path().display());
                    (0, 0)
                }
            };

            files.push(FileEntry {
                id: files.len() as u32,
                path,
                name: entry.file_name().to_string_lossy().into_owned(),
                ext,
                kind,
                size,
                modified,
            });

            if stream && files.len() - streamed >= BATCH_SIZE {
                emit_range(app, gen, &files[streamed..]);
                streamed = files.len();
            }
        }
    }

    if current_generation(app) != gen {
        return None;
    }
    if stream && files.len() > streamed {
        emit_range(app, gen, &files[streamed..]);
    }
    Some(files)
}

/// Stream an already-collected list as normal `scan:batch`/`scan:done` events
/// under `gen` — exactly the surface a live walk produces, which is what lets
/// the index fast path and the verify re-stream reuse the whole frontend
/// pipeline untouched. Returns false when superseded partway (stops emitting).
fn stream_collected(app: &AppHandle, gen: u32, files: &[FileEntry], started: Instant) -> bool {
    for chunk in files.chunks(BATCH_SIZE) {
        if current_generation(app) != gen {
            return false;
        }
        emit_range(app, gen, chunk);
    }
    if current_generation(app) != gen {
        return false;
    }
    emit_done(app, gen, files.len() as u64, started);
    true
}

fn emit_range(app: &AppHandle, gen: u32, files: &[FileEntry]) {
    let batch = ScanBatch {
        gen,
        files: files.to_vec(),
    };
    if let Err(e) = app.emit(events::SCAN_BATCH, batch) {
        eprintln!("[scan] failed to emit scan:batch: {e}");
    }
}

fn emit_done(app: &AppHandle, gen: u32, total: u64, started: Instant) {
    let done = ScanDone {
        gen,
        total,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    if let Err(e) = app.emit(events::SCAN_DONE, done) {
        eprintln!("[scan] failed to emit scan:done: {e}");
    }
}

/// Hand the audio and texture path queues to the probe workers, each on its
/// own thread. AUDIO ONLY goes to symphonia: queueing textures/models would
/// make it try to decode `.png` and `.fbx` — thousands of them in a Synty
/// pack — burning CPU and flooding stderr for results that can never exist.
/// Dimension probing likewise gets its OWN thread so an audio-heavy library
/// can't hold texture dims — and the Resolution/Shape filters — hostage to
/// the duration probe; and the scanner thread itself must stay free for the
/// index-verify walk that may still be running behind an index-served gen.
fn spawn_probes(app: &AppHandle, gen: u32, files: &[FileEntry]) {
    let meta_queue: Vec<(u32, String)> = files
        .iter()
        .filter(|f| matches!(f.kind, AssetKind::Audio))
        .map(|f| (f.id, f.path.clone()))
        .collect();
    let tex_queue: Vec<(u32, String)> = files
        .iter()
        .filter(|f| matches!(f.kind, AssetKind::Texture))
        .map(|f| (f.id, f.path.clone()))
        .collect();
    {
        let app = app.clone();
        if let Err(e) = std::thread::Builder::new()
            .name("tex-meta".into())
            .spawn(move || texmeta::probe_dimensions(app, tex_queue, gen))
        {
            eprintln!("[scan] failed to spawn tex-meta thread: {e}");
        }
    }
    {
        let app = app.clone();
        if let Err(e) = std::thread::Builder::new()
            .name("audio-meta".into())
            .spawn(move || metadata::probe_audio_meta(app, meta_queue, gen))
        {
            eprintln!("[scan] failed to spawn audio-meta thread: {e}");
        }
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
    } else if DOCUMENT_EXTENSIONS.contains(&e) {
        // Design docs, references, notes. No is_doc_image gate here: a
        // "readme.md" IS the document we want to surface, unlike a readme
        // *image* masquerading as a texture.
        AssetKind::Document
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
