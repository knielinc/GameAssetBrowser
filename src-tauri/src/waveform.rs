//! Waveform peak extraction. A full symphonia decode is folded into
//! `bins` interleaved min/max pairs (~12 KB for 1600 bins — never raw PCM
//! over IPC), cached in an LRU keyed by request shape *and* file identity
//! (size + mtime, so overwritten files re-decode), and delivered via the
//! `waveform:ready` event. A request generation counter cancels stale
//! decodes when the selection changes quickly: they bail between packets
//! and never emit.

use std::fs::File;
use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use lru::LruCache;
use parking_lot::Mutex;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Emitter, Manager};

use crate::types::{events, WaveformReady};

const CACHE_CAPACITY: usize = 50;

/// Managed state: peak cache plus the live request generation.
pub struct WaveformState {
    cache: Mutex<LruCache<String, Arc<Vec<f32>>>>,
    generation: AtomicU32,
}

impl Default for WaveformState {
    fn default() -> Self {
        Self {
            cache: Mutex::new(LruCache::new(
                NonZeroUsize::new(CACHE_CAPACITY).expect("cache capacity is non-zero"),
            )),
            generation: AtomicU32::new(0),
        }
    }
}

/// Cache key: request shape (`bins`) plus file identity (size + mtime), so a
/// file overwritten on disk (e.g. re-exported from a DAW, then rescanned)
/// never serves stale peaks. On metadata errors fall back to the plain path —
/// worst case a single entry goes stale instead of the request failing.
fn cache_key(path: &str, bins: u32) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let size = meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            format!("{bins}:{size}:{mtime}:{path}")
        }
        Err(_) => format!("{bins}:{path}"),
    }
}

/// How a decode ended without producing peaks.
enum DecodeAbort {
    /// A newer request superseded this one — say nothing.
    Stale,
    Failed(String),
}

#[tauri::command]
pub async fn request_waveform(app: AppHandle, path: String, bins: u32) {
    let bins = bins.clamp(16, 8192);
    let key = cache_key(&path, bins);

    // Every request bumps the generation, cancelling any in-flight decode.
    let gen = {
        let state = app.state::<WaveformState>();
        let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(peaks) = state.cache.lock().get(&key).cloned() {
            emit_ready(&app, &path, bins, &peaks);
            return;
        }
        gen
    };

    let _ = tauri::async_runtime::spawn_blocking(move || {
        let peaks = match decode_peaks(&app, &path, bins, gen) {
            Ok(p) => p,
            Err(DecodeAbort::Stale) => return,
            Err(DecodeAbort::Failed(msg)) => {
                eprintln!("[waveform] {path}: {msg}");
                return;
            }
        };
        let peaks = Arc::new(peaks);
        let state = app.state::<WaveformState>();
        // Completed work is worth caching even if it just went stale...
        state.cache.lock().put(key, Arc::clone(&peaks));
        // ...but stale results are never emitted.
        if state.generation.load(Ordering::SeqCst) == gen {
            emit_ready(&app, &path, bins, &peaks);
        }
    });
}

/// Full decode → mono mix → fine min/max chunks → refold to exactly `bins`
/// interleaved (min, max) pairs.
fn decode_peaks(
    app: &AppHandle,
    path: &str,
    bins: u32,
    gen: u32,
) -> Result<Vec<f32>, DecodeAbort> {
    let state = app.state::<WaveformState>();
    let is_stale = || state.generation.load(Ordering::SeqCst) != gen;

    let file =
        File::open(path).map_err(|e| DecodeAbort::Failed(format!("could not open file: {e}")))?;
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
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
        .map_err(|e| DecodeAbort::Failed(format!("unrecognized format: {e}")))?;
    let mut format = probed.format;

    let (track_id, codec_params) = {
        let track = format
            .default_track()
            .ok_or_else(|| DecodeAbort::Failed("no default audio track".into()))?;
        (track.id, track.codec_params.clone())
    };
    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| DecodeAbort::Failed(format!("no decoder for codec: {e}")))?;

    let bins = bins as usize;
    // Frames per fine accumulation chunk. With a known total length, aim ~4x
    // finer than the requested bins (the refold sharpens edges); otherwise a
    // fixed chunk keeps memory bounded for arbitrarily long files.
    let chunk: u64 = match codec_params.n_frames {
        Some(n) if n > 0 => (n / (bins as u64 * 4)).max(1),
        _ => 1024,
    };

    let mut fine: Vec<(f32, f32)> = Vec::new();
    let mut cur_min = f32::MAX;
    let mut cur_max = f32::MIN;
    let mut frames_in_chunk: u64 = 0;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        // Cancellation point between packets.
        if is_stale() {
            return Err(DecodeAbort::Stale);
        }
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break; // normal end of stream
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => {
                // Corrupt tail — keep whatever decoded so far.
                eprintln!("[waveform] {path}: packet read stopped early: {e}");
                break;
            }
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymphoniaError::DecodeError(e)) => {
                eprintln!("[waveform] {path}: skipping undecodable packet: {e}");
                continue;
            }
            Err(e) => return Err(DecodeAbort::Failed(format!("decode failed: {e}"))),
        };

        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        let needed_samples = decoded.capacity() * channels;
        if sample_buf
            .as_ref()
            .map_or(true, |b| b.capacity() < needed_samples)
        {
            sample_buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        }
        let buf = sample_buf.as_mut().expect("sample buffer just initialized");
        buf.copy_interleaved_ref(decoded);

        for frame in buf.samples().chunks_exact(channels) {
            let mono = frame.iter().copied().sum::<f32>() / channels as f32;
            cur_min = cur_min.min(mono);
            cur_max = cur_max.max(mono);
            frames_in_chunk += 1;
            if frames_in_chunk >= chunk {
                fine.push((cur_min, cur_max));
                cur_min = f32::MAX;
                cur_max = f32::MIN;
                frames_in_chunk = 0;
            }
        }
    }
    if frames_in_chunk > 0 {
        fine.push((cur_min, cur_max));
    }
    if fine.is_empty() {
        return Err(DecodeAbort::Failed("no audio frames decoded".into()));
    }

    Ok(refold(&fine, bins))
}

/// Fold `fine` (min, max) chunks into exactly `bins` interleaved pairs.
fn refold(fine: &[(f32, f32)], bins: usize) -> Vec<f32> {
    let n = fine.len();
    let mut peaks = Vec::with_capacity(bins * 2);
    for i in 0..bins {
        // n >= 1 guarantees start < n and start < end <= n.
        let start = i * n / bins;
        let end = ((i + 1) * n / bins).clamp(start + 1, n);
        let mut min = f32::MAX;
        let mut max = f32::MIN;
        for &(lo, hi) in &fine[start..end] {
            min = min.min(lo);
            max = max.max(hi);
        }
        peaks.push(min.clamp(-1.0, 1.0));
        peaks.push(max.clamp(-1.0, 1.0));
    }
    peaks
}

fn emit_ready(app: &AppHandle, path: &str, bins: u32, peaks: &Arc<Vec<f32>>) {
    let payload = WaveformReady {
        path: path.to_string(),
        bins,
        peaks: peaks.as_ref().clone(),
    };
    if let Err(e) = app.emit(events::WAVEFORM_READY, payload) {
        eprintln!("[waveform] failed to emit waveform:ready: {e}");
    }
}
