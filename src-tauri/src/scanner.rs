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
use crate::types::{events, FileEntry, ScanBatch, ScanDone, AUDIO_EXTENSIONS};

const BATCH_SIZE: usize = 1000;

/// Managed state: the current scan generation. Bumping it invalidates every
/// in-flight scan walker and duration-probe worker.
#[derive(Default)]
pub struct ScanState {
    pub generation: AtomicU32,
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
        for entry in WalkDir::new(root) {
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
            let Some(ext) = audio_ext(entry.path()) else {
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
            meta_queue.push((id, path.clone()));
            batch.push(FileEntry {
                id,
                path,
                name: entry.file_name().to_string_lossy().into_owned(),
                ext,
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

/// Lower-cased extension if the path is a whitelisted audio file.
fn audio_ext(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    AUDIO_EXTENSIONS.contains(&ext.as_str()).then_some(ext)
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
