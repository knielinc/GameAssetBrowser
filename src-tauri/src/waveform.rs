//! Waveform peak extraction. A full symphonia decode is folded into
//! `bins` interleaved min/max pairs (~12 KB for 1600 bins — never raw PCM
//! over IPC), cached in an LRU keyed by request shape *and* file identity
//! (size + mtime, so overwritten files re-decode), and delivered via the
//! `waveform:ready` event. A request generation counter cancels stale
//! decodes when the selection changes quickly: they bail between packets
//! and never emit.

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use lru::LruCache;
use parking_lot::Mutex;
use symphonia::core::audio::{AudioBuffer, AudioBufferRef, Signal};
use symphonia::core::conv::IntoSample;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::sample::Sample;
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
        // A newer request wins: bail between packets. Borrows `app` immutably,
        // as does the cache/emit below — all reads, so they coexist fine.
        let is_stale = || app.state::<WaveformState>().generation.load(Ordering::SeqCst) != gen;
        let peaks = match decode_peaks(&path, bins, &is_stale, None) {
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

/// Grid-thumbnail waveforms stop after this many frames (~3 min at 44.1 kHz).
/// The thumbnail path can't be cancelled mid-decode (the thumb pool has no
/// bail contract), so this bounds how long one pathologically long file can
/// pin a decode thread. Normal-length game audio is far under it and decodes in
/// full; the player-bar waveform (request_waveform) is never capped.
const THUMB_MAX_FRAMES: u64 = 8_000_000;

/// One-shot peak decode for the audio grid thumbnail — no cancellation and no
/// cache (the thumbnail blob already caches the rendered result), and bounded
/// by [`THUMB_MAX_FRAMES`]. `None` on any failure so the caller can fall back to
/// cover art or nothing. Shares the exact decoder the player bar uses.
pub(crate) fn peaks_blocking(path: &str, bins: u32) -> Option<Vec<f32>> {
    let bins = bins.clamp(16, 8192);
    decode_peaks(path, bins, &|| false, Some(THUMB_MAX_FRAMES)).ok()
}

/// Streaming min/max fold: every `chunk` mono frames collapse to one (min, max)
/// pair in `fine`. State is carried across packets, so a chunk that straddles a
/// packet boundary yields exactly the bins one continuous sample stream would —
/// the fold is oblivious to how the decoder happened to packetize the file.
struct FineFold {
    chunk: u64,
    fine: Vec<(f32, f32)>,
    cur_min: f32,
    cur_max: f32,
    frames_in_chunk: u64,
}

impl FineFold {
    fn new(chunk: u64) -> Self {
        Self {
            chunk,
            fine: Vec::new(),
            cur_min: f32::MAX,
            cur_max: f32::MIN,
            frames_in_chunk: 0,
        }
    }

    #[inline]
    fn push(&mut self, mono: f32) {
        self.cur_min = self.cur_min.min(mono);
        self.cur_max = self.cur_max.max(mono);
        self.frames_in_chunk += 1;
        if self.frames_in_chunk >= self.chunk {
            self.fine.push((self.cur_min, self.cur_max));
            self.cur_min = f32::MAX;
            self.cur_max = f32::MIN;
            self.frames_in_chunk = 0;
        }
    }

    /// Flush the trailing partial chunk (if any) and hand back the fine pairs.
    fn finish(mut self) -> Vec<(f32, f32)> {
        if self.frames_in_chunk > 0 {
            self.fine.push((self.cur_min, self.cur_max));
        }
        self.fine
    }
}

/// Fold one decoded packet straight from symphonia's *planar* buffer, mixing to
/// mono and converting each sample to f32 with symphonia's own `IntoSample` —
/// the very conversion the old `copy_interleaved_ref` used, so the numbers are
/// bit-for-bit identical. The win is what it skips: no intermediate interleaved
/// f32 `SampleBuffer`, so one pass over the samples instead of two and no
/// per-packet allocation. Returns the frame count folded (for the length cap).
fn fold_planar<S>(buf: &AudioBuffer<S>, fold: &mut FineFold) -> u64
where
    S: Sample + IntoSample<f32>,
{
    let channels = buf.spec().channels.count().max(1);
    let frames = buf.frames();
    match channels {
        // Contiguous single channel: the min/max reduction can vectorize.
        1 => {
            for &s in buf.chan(0) {
                let v: f32 = s.into_sample();
                fold.push(v);
            }
        }
        // The common stereo case, avoiding the general per-frame sum loop.
        // `* 0.5` is bit-identical to the old `/ 2.0` (0.5 is exact).
        2 => {
            let (l, r) = (buf.chan(0), buf.chan(1));
            for i in 0..frames {
                let a: f32 = l[i].into_sample();
                let b: f32 = r[i].into_sample();
                fold.push((a + b) * 0.5);
            }
        }
        // Surround et al.: sum the channels in index order and divide, exactly
        // as the interleaved path did (same order → same f32 rounding).
        c => {
            for i in 0..frames {
                let mut sum = 0.0f32;
                for ch in 0..c {
                    let v: f32 = buf.chan(ch)[i].into_sample();
                    sum += v;
                }
                fold.push(sum / c as f32);
            }
        }
    }
    frames as u64
}

/// Full decode → mono mix → fine min/max chunks → refold to exactly `bins`
/// interleaved (min, max) pairs. `is_stale` is polled between packets so a
/// caller can cancel a superseded decode (the player bar does; the one-shot
/// thumbnail path passes a closure that is always false). `max_frames` caps the
/// decode length (thumbnail path); `None` decodes the whole track (player bar).
fn decode_peaks(
    path: &str,
    bins: u32,
    is_stale: &dyn Fn() -> bool,
    max_frames: Option<u64>,
) -> Result<Vec<f32>, DecodeAbort> {
    let (mut format, track_id, mut decoder) =
        crate::audio_probe::open_default_track(path).map_err(DecodeAbort::Failed)?;

    let bins = bins as usize;
    // Frames per fine accumulation chunk. Aim ~4x finer than the requested bins
    // (the refold sharpens edges) over the effective length — clamped to
    // `max_frames` so a capped decode still fills all `bins`. Unknown length
    // falls back to a fixed chunk that keeps memory bounded.
    let effective_frames = match (decoder.codec_params().n_frames, max_frames) {
        (Some(n), Some(m)) => Some(n.min(m)),
        (Some(n), None) => Some(n),
        _ => None,
    };
    let chunk: u64 = match effective_frames {
        Some(n) if n > 0 => (n / (bins as u64 * 4)).max(1),
        _ => 1024,
    };

    let mut fold = FineFold::new(chunk);
    let mut total_frames: u64 = 0;

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

        // Fold straight from the native buffer — no interleaved f32 copy. Every
        // symphonia sample format so the match stays exhaustive.
        total_frames += match &decoded {
            AudioBufferRef::U8(b) => fold_planar(b, &mut fold),
            AudioBufferRef::U16(b) => fold_planar(b, &mut fold),
            AudioBufferRef::U24(b) => fold_planar(b, &mut fold),
            AudioBufferRef::U32(b) => fold_planar(b, &mut fold),
            AudioBufferRef::S8(b) => fold_planar(b, &mut fold),
            AudioBufferRef::S16(b) => fold_planar(b, &mut fold),
            AudioBufferRef::S24(b) => fold_planar(b, &mut fold),
            AudioBufferRef::S32(b) => fold_planar(b, &mut fold),
            AudioBufferRef::F32(b) => fold_planar(b, &mut fold),
            AudioBufferRef::F64(b) => fold_planar(b, &mut fold),
        };
        if max_frames.is_some_and(|m| total_frames >= m) {
            break; // thumbnail cap reached — see THUMB_MAX_FRAMES
        }
    }

    let fine = fold.finish();
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The pre-refactor inline fold, verbatim — the reference `FineFold` must
    /// reproduce exactly, so the native-buffer path can't drift from what the
    /// interleaved-copy path produced.
    fn reference_fine(mono: &[f32], chunk: u64) -> Vec<(f32, f32)> {
        let mut fine = Vec::new();
        let (mut cur_min, mut cur_max, mut n) = (f32::MAX, f32::MIN, 0u64);
        for &m in mono {
            cur_min = cur_min.min(m);
            cur_max = cur_max.max(m);
            n += 1;
            if n >= chunk {
                fine.push((cur_min, cur_max));
                cur_min = f32::MAX;
                cur_max = f32::MIN;
                n = 0;
            }
        }
        if n > 0 {
            fine.push((cur_min, cur_max));
        }
        fine
    }

    #[test]
    fn finefold_matches_reference_across_boundaries() {
        // A jagged stream so min/max actually move; length is coprime with most
        // chunk sizes so partial trailing chunks and mid-packet splits are hit.
        let mono: Vec<f32> =
            (0..997).map(|i| (((i * 37 % 101) as f32) / 50.0) - 1.0).collect();
        // 1 = flush every frame; values around len exercise the trailing chunk.
        for &chunk in &[1u64, 2, 3, 7, 64, 333, 996, 997, 998, 4096] {
            let mut fold = FineFold::new(chunk);
            // Feed in irregular packet-sized slices to prove cross-packet state
            // matches one continuous stream.
            for slice in mono.chunks(53) {
                for &m in slice {
                    fold.push(m);
                }
            }
            assert_eq!(fold.finish(), reference_fine(&mono, chunk), "chunk={chunk}");
        }
    }

    #[test]
    fn stereo_mix_is_bit_identical_to_division() {
        // fold_planar's stereo arm uses `* 0.5`; the general arm and the old
        // path use `/ 2.0`. They must agree exactly for a 2-channel frame.
        for &(a, b) in &[(0.3f32, -0.7), (1.0, -1.0), (0.123_456, 0.987_654), (0.0, 0.0)] {
            assert_eq!((a + b) * 0.5, (a + b) / 2.0);
        }
    }
}
