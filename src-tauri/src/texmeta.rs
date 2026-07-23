//! Lazy texture dimension probing — `metadata.rs`'s sibling for the Textures
//! tab. Header-only reads (no pixels are decoded) run on a small dedicated
//! rayon pool; results are buffered and flushed to the frontend as one
//! `meta:dimensions` event every ~250 ms — never tens of thousands of
//! individual events.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use rayon::prelude::*;
use tauri::{AppHandle, Emitter};

use crate::scanner;
use crate::types::{events, DimensionBatch};

const FLUSH_INTERVAL: Duration = Duration::from_millis(250);
/// Cap the probe pool — don't starve the disk while thumbnails are decoding.
const PROBE_THREADS: usize = 2;

/// Probe pixel dimensions for `entries`, emitting batched results until done.
/// Blocks the calling (background `tex-meta`) thread; aborts early — and stops
/// emitting — as soon as the scan generation moves past `gen`.
pub fn probe_dimensions(app: AppHandle, entries: Vec<(u32, String)>, gen: u32) {
    if entries.is_empty() {
        return;
    }

    let pool = match rayon::ThreadPoolBuilder::new()
        .num_threads(PROBE_THREADS)
        .thread_name(|i| format!("tex-probe-{i}"))
        .build()
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[texmeta] failed to build probe pool: {e}");
            return;
        }
    };

    let buffer: Arc<Mutex<Vec<(u32, u32, u32)>>> = Arc::new(Mutex::new(Vec::new()));
    let done = Arc::new(AtomicBool::new(false));

    let flusher = {
        let app = app.clone();
        let buffer = Arc::clone(&buffer);
        let done = Arc::clone(&done);
        std::thread::Builder::new()
            .name("tex-flusher".into())
            .spawn(move || flusher_loop(app, buffer, done, gen))
    };
    let flusher = match flusher {
        Ok(handle) => handle,
        Err(e) => {
            eprintln!("[texmeta] failed to spawn flusher thread: {e}");
            return;
        }
    };

    pool.install(|| {
        entries.par_iter().for_each(|(id, path)| {
            if scanner::current_generation(&app) != gen {
                return; // stale — drain remaining items as no-ops
            }
            if let Some((w, h)) = probe_dims(Path::new(path)) {
                buffer.lock().push((*id, w, h));
            }
        });
    });

    done.store(true, Ordering::SeqCst);
    if flusher.join().is_err() {
        eprintln!("[texmeta] flusher thread panicked");
    }
}

fn flusher_loop(
    app: AppHandle,
    buffer: Arc<Mutex<Vec<(u32, u32, u32)>>>,
    done: Arc<AtomicBool>,
    gen: u32,
) {
    loop {
        std::thread::sleep(FLUSH_INTERVAL);
        if scanner::current_generation(&app) != gen {
            return; // superseded — these dimensions are for a dead file list
        }
        // Read `done` BEFORE draining: if it was already set, every probe
        // result is guaranteed to be in the buffer, so this drain is final.
        let finished = done.load(Ordering::SeqCst);
        let entries = std::mem::take(&mut *buffer.lock());
        if !entries.is_empty() {
            if let Err(e) = app.emit(events::META_DIMENSIONS, DimensionBatch { gen, entries }) {
                eprintln!("[texmeta] failed to emit meta:dimensions: {e}");
            }
        }
        if finished {
            return;
        }
    }
}

/// Header-only dimension probe. `image::image_dimensions` covers every format
/// in TEXTURE_EXTENSIONS except DDS, which gets a manual header read.
/// Unparseable files yield `None` — nothing is emitted, and the frontend keeps
/// them visible forever (a filter may only remove files it has positively
/// measured).
fn probe_dims(path: &Path) -> Option<(u32, u32)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    // Camera RAW: `image::image_dimensions` would read the TIFF CFA dims (or
    // fail); the meaningful size is the embedded preview's, which the thumbnail
    // decode fills in (build() sets source_width/height). Skip here.
    if crate::types::RAW_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    let (w, h) = if ext == "dds" {
        dds_dims(path)?
    } else {
        image::image_dimensions(path).ok()?
    };
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h))
}

/// DDS dimensions straight from the raw header. Manual because `image`'s DDS
/// decoder rejects pixel formats it can't decompress (BC7, DX10 header
/// extensions) — but height/width sit at fixed offsets in the DDS_HEADER
/// regardless of what follows.
fn dds_dims(path: &Path) -> Option<(u32, u32)> {
    let mut head = [0u8; 20];
    File::open(path).ok()?.read_exact(&mut head).ok()?;
    if &head[0..4] != b"DDS " {
        return None;
    }
    let h = u32::from_le_bytes([head[12], head[13], head[14], head[15]]);
    let w = u32::from_le_bytes([head[16], head[17], head[18], head[19]]);
    Some((w, h))
}
