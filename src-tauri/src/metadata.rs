//! Lazy audio metadata probing (duration + sample rate/channels/bit depth).
//! Header-only symphonia probes run on a small dedicated rayon pool (capped so
//! disk reads never starve auditioning); results are buffered and flushed to
//! the frontend as one `meta:audio` event every ~250 ms — never tens of
//! thousands of individual events.

use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use rayon::prelude::*;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::TimeBase;
use tauri::{AppHandle, Emitter};

use crate::scanner;
use crate::types::{events, AudioMetaBatch};

/// One probed file: `(id, seconds, sample rate Hz, channels, bits per sample)`.
/// 0 means "unknown" for every field but the id — lossy codecs have no bit
/// depth, and the duration fallback can fail while the header facts survive.
type ProbedEntry = (u32, f32, u32, u16, u16);

const FLUSH_INTERVAL: Duration = Duration::from_millis(250);
/// Cap the probe pool — don't starve the disk while the user is auditioning.
const PROBE_THREADS: usize = 2;

/// Probe duration + format facts for `entries`, emitting batched results until
/// done. Blocks the calling (background scan) thread; aborts early — and stops
/// emitting — as soon as the scan generation moves past `gen`.
pub fn probe_audio_meta(app: AppHandle, entries: Vec<(u32, String)>, gen: u32) {
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

    let buffer: Arc<Mutex<Vec<ProbedEntry>>> = Arc::new(Mutex::new(Vec::new()));
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
            if let Some((seconds, rate, channels, bits)) = probe_file(Path::new(path)) {
                buffer.lock().push((*id, seconds, rate, channels, bits));
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
    buffer: Arc<Mutex<Vec<ProbedEntry>>>,
    done: Arc<AtomicBool>,
    gen: u32,
) {
    loop {
        std::thread::sleep(FLUSH_INTERVAL);
        if scanner::current_generation(&app) != gen {
            return; // superseded — this metadata is for a dead file list
        }
        // Read `done` BEFORE draining: if it was already set, every probe
        // result is guaranteed to be in the buffer, so this drain is final.
        let finished = done.load(Ordering::SeqCst);
        let entries = std::mem::take(&mut *buffer.lock());
        if !entries.is_empty() {
            if let Err(e) = app.emit(events::META_AUDIO, AudioMetaBatch { gen, entries }) {
                eprintln!("[meta] failed to emit meta:audio: {e}");
            }
        }
        if finished {
            return;
        }
    }
}

/// Header-only probe: `(seconds, sample rate, channels, bits per sample)`,
/// each 0 when the header doesn't say. `None` only when nothing at all could
/// be learned — emitting an all-zero entry would just churn the frontend maps.
fn probe_file(path: &Path) -> Option<(f32, u32, u16, u16)> {
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

    let (sample_rate, n_frames, time_base, channels, bits) = {
        let track = format.default_track()?;
        let params = &track.codec_params;
        (
            params.sample_rate,
            params.n_frames,
            params.time_base,
            // Fields the header may omit map to 0 = unknown. Lossy codecs
            // (mp3/ogg/m4a) legitimately have no bit depth — 0 is expected.
            params.channels.map_or(0u16, |c| c.count() as u16),
            params.bits_per_sample.map_or(0u16, |b| b as u16),
        )
    };
    let rate = sample_rate.unwrap_or(0);

    // Duration can fail (no header frame count AND no usable first packet)
    // while the format facts above survive — report 0 rather than dropping
    // the whole entry.
    let seconds =
        duration_seconds(format.as_mut(), sample_rate, n_frames, time_base, byte_len)
            .unwrap_or(0.0);
    if seconds <= 0.0 && rate == 0 && channels == 0 && bits == 0 {
        return None;
    }
    Some((seconds, rate, channels, bits))
}

/// Header-only duration: no packets are decoded on the happy path. Prefers the
/// exact `n_frames` from the header; for files without one (typically CBR mp3
/// lacking a Xing header) it measures the first packet's bitrate and
/// extrapolates over the file size.
fn duration_seconds(
    format: &mut dyn FormatReader,
    sample_rate: Option<u32>,
    n_frames: Option<u64>,
    time_base: Option<TimeBase>,
    byte_len: Option<u64>,
) -> Option<f32> {
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
