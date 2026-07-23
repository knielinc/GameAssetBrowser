//! Spectrogram rendering for the player bar's waveform ⇄ spectrogram toggle.
//!
//! A full symphonia decode (mirroring waveform.rs — that decode is entangled
//! with its incremental min/max folding, so the loop is restated here rather
//! than contorted into a shared callback) is downmixed to mono, run through a
//! Hann-windowed STFT (1024-point FFT, hop chosen so the image is ≤ 1024
//! columns wide), folded to 128 linear frequency rows, mapped to dB and
//! normalized to u8. The image ships base64 over the `spectrogram:ready`
//! event and is cached in an LRU keyed by file identity, with the same
//! request-generation cancellation as waveform.rs: a newer request makes an
//! in-flight decode bail between packets and never emit.

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use base64::Engine as _;
use lru::LruCache;
use parking_lot::Mutex;
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::errors::Error as SymphoniaError;
use tauri::{AppHandle, Emitter, Manager};

use crate::types::{events, SpectrogramReady};

/// STFT window / FFT size. 1024 at 44.1 kHz ≈ 43 Hz per raw bin — plenty for
/// a 128-row picture.
const FFT_SIZE: usize = 1024;
/// Output frequency rows (linear fold of the 513 usable bins).
const ROWS: usize = 128;
/// Output width cap; the hop is chosen to land at or under it.
const MAX_COLS: usize = 1024;
/// Decode cap: ~11 minutes of 48 kHz mono (128 MB of f32). Game SFX/music
/// stems sit far below this; a longer file is truncated rather than allowed
/// to balloon memory — the picture stays honest for everything auditioned.
const MAX_SAMPLES: usize = 32 * 1024 * 1024;
/// Dynamic range mapped onto 0..255: dB below (peak − 80) clamp to 0.
const DB_RANGE: f32 = 80.0;
/// Rendered images are ≤ 128 KB each; 24 covers a listening session.
const CACHE_CAPACITY: usize = 24;

/// One rendered image, ready to re-emit on a cache hit.
struct SpecImage {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

/// Managed state: image cache plus the live request generation.
pub struct SpectrogramState {
    cache: Mutex<LruCache<String, Arc<SpecImage>>>,
    generation: AtomicU32,
}

impl Default for SpectrogramState {
    fn default() -> Self {
        Self {
            cache: Mutex::new(LruCache::new(
                NonZeroUsize::new(CACHE_CAPACITY).expect("cache capacity is non-zero"),
            )),
            generation: AtomicU32::new(0),
        }
    }
}

/// File identity (size + mtime) in the key so an overwritten file re-decodes —
/// the waveform.rs idiom, minus the `bins` dimension (the shape is fixed).
fn cache_key(path: &str) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let size = meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            format!("{size}:{mtime}:{path}")
        }
        Err(_) => path.to_string(),
    }
}

/// How a decode ended without producing an image.
enum DecodeAbort {
    /// A newer request superseded this one — say nothing.
    Stale,
    Failed(String),
}

#[tauri::command]
pub async fn request_spectrogram(app: AppHandle, path: String) {
    let key = cache_key(&path);

    // Every request bumps the generation, cancelling any in-flight decode.
    let gen = {
        let state = app.state::<SpectrogramState>();
        let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(image) = state.cache.lock().get(&key).cloned() {
            emit_ready(&app, &path, &image);
            return;
        }
        gen
    };

    let _ = tauri::async_runtime::spawn_blocking(move || {
        let samples = match decode_mono(&app, &path, gen) {
            Ok(s) => s,
            Err(DecodeAbort::Stale) => return,
            Err(DecodeAbort::Failed(msg)) => {
                eprintln!("[spectrogram] {path}: {msg}");
                return;
            }
        };
        let image = Arc::new(stft_image(&samples));
        let state = app.state::<SpectrogramState>();
        // Completed work is worth caching even if it just went stale...
        state.cache.lock().put(key, Arc::clone(&image));
        // ...but stale results are never emitted.
        if state.generation.load(Ordering::SeqCst) == gen {
            emit_ready(&app, &path, &image);
        }
    });
}

/// Full decode → mono mix, capped at [`MAX_SAMPLES`]. Structure mirrors
/// waveform.rs's `decode_peaks` (same probe, same error tolerance, same
/// between-packet cancellation) — only the fold differs.
fn decode_mono(app: &AppHandle, path: &str, gen: u32) -> Result<Vec<f32>, DecodeAbort> {
    let state = app.state::<SpectrogramState>();
    let is_stale = || state.generation.load(Ordering::SeqCst) != gen;

    let (mut format, track_id, mut decoder) =
        crate::audio_probe::open_default_track(path).map_err(DecodeAbort::Failed)?;

    let mut mono: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        // Cancellation point between packets.
        if is_stale() {
            return Err(DecodeAbort::Stale);
        }
        if mono.len() >= MAX_SAMPLES {
            break; // truncated, not failed — see MAX_SAMPLES
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
                eprintln!("[spectrogram] {path}: packet read stopped early: {e}");
                break;
            }
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymphoniaError::DecodeError(e)) => {
                eprintln!("[spectrogram] {path}: skipping undecodable packet: {e}");
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
            mono.push(frame.iter().copied().sum::<f32>() / channels as f32);
        }
    }
    if mono.is_empty() {
        return Err(DecodeAbort::Failed("no audio frames decoded".into()));
    }
    Ok(mono)
}

/// Hann-windowed STFT → 128 linear rows × ≤ 1024 columns of normalized u8 dB.
fn stft_image(samples: &[f32]) -> SpecImage {
    // Shorter than one window: zero-pad so even a click renders one column.
    let padded;
    let samples = if samples.len() < FFT_SIZE {
        padded = {
            let mut v = samples.to_vec();
            v.resize(FFT_SIZE, 0.0);
            v
        };
        &padded[..]
    } else {
        samples
    };

    // hop ≥ (n − window) / (MAX_COLS − 1) keeps cols ≤ MAX_COLS; short files
    // get hop 1 and simply render fewer, denser columns.
    let span = samples.len() - FFT_SIZE;
    let hop = (span.div_ceil(MAX_COLS - 1)).max(1);
    let cols = span / hop + 1;

    let hann: Vec<f32> = (0..FFT_SIZE)
        .map(|i| {
            let x = (i as f32) / (FFT_SIZE as f32 - 1.0);
            0.5 - 0.5 * (2.0 * std::f32::consts::PI * x).cos()
        })
        .collect();

    let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
    let mut buf = vec![Complex::new(0.0f32, 0.0f32); FFT_SIZE];
    let mut scratch = vec![Complex::new(0.0f32, 0.0f32); fft.get_inplace_scratch_len()];

    // Usable rFFT bins: DC..Nyquist inclusive.
    const BINS: usize = FFT_SIZE / 2 + 1;
    let mut db = vec![0.0f32; cols * ROWS]; // [col][row], row 0 = LOW freq
    let mut peak = f32::MIN;

    for c in 0..cols {
        let start = c * hop;
        for i in 0..FFT_SIZE {
            buf[i] = Complex::new(samples[start + i] * hann[i], 0.0);
        }
        fft.process_with_scratch(&mut buf, &mut scratch);

        for r in 0..ROWS {
            // Linear fold: row r averages magnitude over its slice of bins.
            let lo = r * BINS / ROWS;
            let hi = (((r + 1) * BINS) / ROWS).max(lo + 1).min(BINS);
            let mut sum = 0.0f32;
            for bin in lo..hi {
                sum += buf[bin].norm();
            }
            let mag = sum / (hi - lo) as f32;
            // −180 dB floor keeps log10 finite on digital silence.
            let v = 20.0 * (mag + 1e-9).log10();
            peak = peak.max(v);
            db[c * ROWS + r] = v;
        }
    }

    // Normalize to the file's own peak over an 80 dB range — a quiet ambience
    // still shows structure instead of a black rectangle.
    let floor = peak - DB_RANGE;
    let mut data = vec![0u8; cols * ROWS];
    for c in 0..cols {
        for r in 0..ROWS {
            let t = ((db[c * ROWS + r] - floor) / DB_RANGE).clamp(0.0, 1.0);
            // Row 0 of the OUTPUT is the top of the image = highest frequency.
            data[(ROWS - 1 - r) * cols + c] = (t * 255.0) as u8;
        }
    }

    SpecImage {
        width: cols as u32,
        height: ROWS as u32,
        data,
    }
}

fn emit_ready(app: &AppHandle, path: &str, image: &SpecImage) {
    let payload = SpectrogramReady {
        path: path.to_string(),
        width: image.width,
        height: image.height,
        data: base64::engine::general_purpose::STANDARD.encode(&image.data),
    };
    if let Err(e) = app.emit(events::SPECTROGRAM_READY, payload) {
        eprintln!("[spectrogram] failed to emit spectrogram:ready: {e}");
    }
}
