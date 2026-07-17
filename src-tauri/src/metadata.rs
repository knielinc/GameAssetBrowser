//! Lazy duration probing. Header-only symphonia probes run on a small
//! dedicated rayon pool (capped so disk reads never starve auditioning);
//! results are buffered and flushed to the frontend as one `meta:durations`
//! event every ~250 ms — never tens of thousands of individual events.

use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use rayon::prelude::*;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Emitter};

use crate::scanner;
use crate::types::{events, DurationBatch};

const FLUSH_INTERVAL: Duration = Duration::from_millis(250);
/// Cap the probe pool — don't starve the disk while the user is auditioning.
const PROBE_THREADS: usize = 2;

/// Probe durations for `entries`, emitting batched results until done.
/// Blocks the calling (background scan) thread; aborts early — and stops
/// emitting — as soon as the scan generation moves past `gen`.
pub fn probe_durations(app: AppHandle, entries: Vec<(u32, String)>, gen: u32) {
    if entries.is_empty() {
        return;
    }

    let pool = match rayon::ThreadPoolBuilder::new()
        .num_threads(PROBE_THREADS)
        .thread_name(|i| format!("meta-probe-{i}"))
        .build()
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[meta] failed to build probe pool: {e}");
            return;
        }
    };

    let buffer: Arc<Mutex<Vec<(u32, f32)>>> = Arc::new(Mutex::new(Vec::new()));
    let done = Arc::new(AtomicBool::new(false));

    let flusher = {
        let app = app.clone();
        let buffer = Arc::clone(&buffer);
        let done = Arc::clone(&done);
        std::thread::Builder::new()
            .name("meta-flusher".into())
            .spawn(move || flusher_loop(app, buffer, done, gen))
    };
    let flusher = match flusher {
        Ok(handle) => handle,
        Err(e) => {
            eprintln!("[meta] failed to spawn flusher thread: {e}");
            return;
        }
    };

    pool.install(|| {
        entries.par_iter().for_each(|(id, path)| {
            if scanner::current_generation(&app) != gen {
                return; // stale — drain remaining items as no-ops
            }
            if let Some(seconds) = probe_duration(Path::new(path)) {
                buffer.lock().push((*id, seconds));
            }
        });
    });

    done.store(true, Ordering::SeqCst);
    if flusher.join().is_err() {
        eprintln!("[meta] flusher thread panicked");
    }
}

fn flusher_loop(
    app: AppHandle,
    buffer: Arc<Mutex<Vec<(u32, f32)>>>,
    done: Arc<AtomicBool>,
    gen: u32,
) {
    loop {
        std::thread::sleep(FLUSH_INTERVAL);
        if scanner::current_generation(&app) != gen {
            return; // superseded — these durations are for a dead file list
        }
        // Read `done` BEFORE draining: if it was already set, every probe
        // result is guaranteed to be in the buffer, so this drain is final.
        let finished = done.load(Ordering::SeqCst);
        let entries = std::mem::take(&mut *buffer.lock());
        if !entries.is_empty() {
            if let Err(e) = app.emit(events::META_DURATIONS, DurationBatch { entries }) {
                eprintln!("[meta] failed to emit meta:durations: {e}");
            }
        }
        if finished {
            return;
        }
    }
}

/// Header-only duration probe: no packets are decoded. Prefers the exact
/// `n_frames` from the header; for files without one (typically CBR mp3
/// lacking a Xing header) it measures the first packet's bitrate and
/// extrapolates over the file size.
fn probe_duration(path: &Path) -> Option<f32> {
    let file = File::open(path).ok()?;
    let byte_len = file.metadata().ok().map(|m| m.len());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(&ext.to_ascii_lowercase());
    }
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;
    let mut format = probed.format;

    let (sample_rate, n_frames, time_base) = {
        let track = format.default_track()?;
        let params = &track.codec_params;
        (params.sample_rate, params.n_frames, params.time_base)
    };

    if let Some(frames) = n_frames {
        if let Some(sr) = sample_rate {
            if sr > 0 {
                return Some((frames as f64 / sr as f64) as f32);
            }
        }
        if let Some(tb) = time_base {
            let t = tb.calc_time(frames);
            return Some((t.seconds as f64 + t.frac) as f32);
        }
    }

    // Fallback: bitrate of the first packet, extrapolated over the file size
    // (size * 8 / bitrate). Exact for CBR, approximate for VBR — good enough
    // for a preview list.
    let tb = time_base?;
    let byte_len = byte_len?;
    let packet = format.next_packet().ok()?;
    if packet.dur == 0 || packet.data.is_empty() {
        return None;
    }
    let t = tb.calc_time(packet.dur);
    let packet_secs = t.seconds as f64 + t.frac;
    if packet_secs <= 0.0 {
        return None;
    }
    let bytes_per_sec = packet.data.len() as f64 / packet_secs;
    Some((byte_len as f64 / bytes_per_sec) as f32)
}
