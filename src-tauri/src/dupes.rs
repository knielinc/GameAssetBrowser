//! Duplicate file detection. Three-stage funnel so almost no bytes are read:
//! bucket by exact size (free — the scanner already knows sizes), xxh3 the
//! first 128 KiB of each size-collision, and only full-file-hash the prefix
//! collisions to confirm. Runs off the invoke thread, streams progress, and
//! is cancelled by generation bump — the waveform decoder's idiom: stale runs
//! bail between files and never emit.
//!
//! The frontend passes `(path, size)` pairs because the scanner deliberately
//! retains no file list backend-side (ScanState holds only gen/roots); the
//! webview's copy is the authoritative "last completed scan" anyway.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Emitter, Manager};
use xxhash_rust::xxh3::{xxh3_64, Xxh3};

use crate::types::{events, DupeGroup, DupeProgress, DupesDone};

/// First-stage hash length. 128 KiB separates "same size by coincidence"
/// (WAV headers, DDS mip chains) from real copies without reading whole packs.
const PREFIX_LEN: u64 = 128 * 1024;
/// Streaming read chunk for the confirm pass — bounded memory on GB files.
const FULL_CHUNK: usize = 1024 * 1024;
/// Emit `dupes:progress` roughly this often (in files prefix-hashed).
const PROGRESS_EVERY: u32 = 200;

/// Managed state: the live run generation. A new `find_duplicates` call or a
/// `cancel_duplicates` bumps it, and the superseded run goes quiet.
#[derive(Default)]
pub struct DupeState {
    generation: AtomicU32,
}

#[tauri::command]
pub async fn find_duplicates(app: AppHandle, files: Vec<(String, u64)>) {
    let gen = app
        .state::<DupeState>()
        .generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let _ = tauri::async_runtime::spawn_blocking(move || run(app, files, gen));
}

/// Abort any in-flight run. Nothing further is emitted — the caller (the
/// duplicates modal on unmount) is not listening anymore.
#[tauri::command]
pub fn cancel_duplicates(app: AppHandle) {
    app.state::<DupeState>()
        .generation
        .fetch_add(1, Ordering::SeqCst);
}

fn run(app: AppHandle, files: Vec<(String, u64)>, gen: u32) {
    let state = app.state::<DupeState>();
    let is_stale = || state.generation.load(Ordering::SeqCst) != gen;

    // Stage 1: size buckets. Size 0 is skipped outright — empty files are
    // trivially "identical" but reclaim nothing and would flood the list.
    let mut by_size: HashMap<u64, Vec<String>> = HashMap::new();
    for (path, size) in files {
        if size == 0 {
            continue;
        }
        by_size.entry(size).or_default().push(path);
    }
    by_size.retain(|_, paths| paths.len() > 1);

    let mut total: u32 = by_size.values().map(|p| p.len() as u32).sum();
    let mut done: u32 = 0;
    emit_progress(&app, done, total);

    let mut groups: Vec<DupeGroup> = Vec::new();
    for (size, paths) in by_size {
        // Stage 2: prefix hash. Unreadable files (deleted since the scan,
        // locked) just drop out of their bucket — a browser must not error a
        // whole report over one file.
        let mut by_prefix: HashMap<u64, Vec<String>> = HashMap::new();
        for path in paths {
            if is_stale() {
                return;
            }
            done += 1;
            if done % PROGRESS_EVERY == 0 {
                emit_progress(&app, done, total);
            }
            match hash_prefix(&path) {
                Some(h) => by_prefix.entry(h).or_default().push(path),
                None => {}
            }
        }

        for (_, candidates) in by_prefix {
            if candidates.len() < 2 {
                continue;
            }
            // Stage 3: full-content confirm — skippable when the prefix
            // already covered the whole file.
            if size <= PREFIX_LEN {
                push_group(&mut groups, size, candidates);
                continue;
            }
            // The confirm pass streams entire (multi-GB) files, one at a time —
            // minutes of work with no prefix-stage `done` bumps behind it. Count
            // each confirmed file toward progress so the bar keeps moving; these
            // are re-reads of candidates already tallied in `total`, so grow
            // `total` to match and keep `done <= total`. A full-file read is far
            // costlier than an emit, so emit per file for smooth motion.
            total += candidates.len() as u32;
            let mut by_full: HashMap<u64, Vec<String>> = HashMap::new();
            for path in candidates {
                match hash_full(&path, &is_stale) {
                    Ok(Some(h)) => by_full.entry(h).or_default().push(path),
                    Ok(None) => {} // read failed — drop the file, keep the run
                    Err(()) => return, // superseded mid-file
                }
                done += 1;
                emit_progress(&app, done, total);
            }
            for (_, confirmed) in by_full {
                if confirmed.len() > 1 {
                    push_group(&mut groups, size, confirmed);
                }
            }
        }
    }

    if is_stale() {
        return;
    }
    // Wasted bytes descending: the group worth acting on first sorts first.
    groups.sort_by(|a, b| {
        let wa = a.size * (a.paths.len() as u64 - 1);
        let wb = b.size * (b.paths.len() as u64 - 1);
        wb.cmp(&wa).then_with(|| a.paths[0].cmp(&b.paths[0]))
    });
    emit_progress(&app, total, total);
    if let Err(e) = app.emit(events::DUPES_DONE, DupesDone { groups }) {
        eprintln!("[dupes] failed to emit dupes:done: {e}");
    }
}

/// Paths sorted so a group renders stably run-to-run.
fn push_group(groups: &mut Vec<DupeGroup>, size: u64, mut paths: Vec<String>) {
    paths.sort_unstable();
    groups.push(DupeGroup { size, paths });
}

/// xxh3 of the first [`PREFIX_LEN`] bytes; `None` on any read error.
fn hash_prefix(path: &str) -> Option<u64> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[dupes] {path}: open failed: {e}");
            return None;
        }
    };
    let mut buf = Vec::with_capacity(PREFIX_LEN as usize);
    if let Err(e) = file.take(PREFIX_LEN).read_to_end(&mut buf) {
        eprintln!("[dupes] {path}: prefix read failed: {e}");
        return None;
    }
    Some(xxh3_64(&buf))
}

/// Streaming xxh3 of the whole file. `Ok(None)` on read errors (skip the
/// file), `Err(())` when superseded — checked between chunks so a cancel
/// lands promptly even mid-multi-GB file.
fn hash_full(path: &str, is_stale: &impl Fn() -> bool) -> Result<Option<u64>, ()> {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[dupes] {path}: open failed: {e}");
            return Ok(None);
        }
    };
    let mut hasher = Xxh3::new();
    let mut buf = vec![0u8; FULL_CHUNK];
    loop {
        if is_stale() {
            return Err(());
        }
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                eprintln!("[dupes] {path}: read failed: {e}");
                return Ok(None);
            }
        }
    }
    Ok(Some(hasher.digest()))
}

fn emit_progress(app: &AppHandle, done: u32, total: u32) {
    if let Err(e) = app.emit(events::DUPES_PROGRESS, DupeProgress { done, total }) {
        eprintln!("[dupes] failed to emit dupes:progress: {e}");
    }
}
