//! Dedicated audio engine thread.
//!
//! `rodio::OutputStream` is `!Send`, so it is created on this thread and
//! lives there for the whole app lifetime. The thread loops on a crossbeam
//! channel: commands are handled immediately, and a deadline-scheduled tick
//! (~20 Hz, independent of command traffic) emits the playback position
//! while playing, detects track end (for loop-restart or an "ended" event),
//! and runs a watchdog that detects a dead output stream (device unplugged
//! mid-session) so the engine never blocks on it.

use std::fs::File;
use std::io::BufReader;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError};
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};
use tauri::{AppHandle, Emitter};

use super::PlayerCmd;
use crate::types::{events, PositionPayload, StatePayload};

/// Engine tick interval — position events are emitted at ~20 Hz while playing.
const TICK: Duration = Duration::from_millis(50);

/// Watchdog threshold: consecutive ticks a playing, non-empty sink's position
/// may fail to advance before the output stream is declared dead (~1 s).
/// Generous enough that stream startup or scheduler hiccups never trip it.
const STALL_TICKS: u32 = 20;

/// Upper bound for seek targets; guards the `Duration::from_secs_f64` panic
/// on absurd values coming over IPC.
const MAX_SEEK_SECONDS: f64 = 7.0 * 24.0 * 3600.0;

/// Spawn the engine thread. Failure to spawn is logged, not fatal — every
/// subsequent `AudioController::send` will just log that the engine is gone.
pub fn spawn(app: AppHandle, rx: Receiver<PlayerCmd>) {
    if let Err(e) = std::thread::Builder::new()
        .name("audio-engine".into())
        .spawn(move || run(app, rx))
    {
        eprintln!("[audio] failed to spawn engine thread: {e}");
    }
}

fn run(app: AppHandle, rx: Receiver<PlayerCmd>) {
    let mut engine = Engine {
        app,
        stream: None,
        sink: None,
        path: None,
        volume: 1.0,
        loop_enabled: false,
        last_pos: Duration::ZERO,
        stalled_ticks: 0,
    };

    // Open the output device eagerly so a missing device is reported at
    // startup. The engine keeps running either way: the rest of the app
    // (scanning, browsing, waveforms) stays fully functional, every load
    // retries `ensure_stream` (resurfacing the error, and recovering if a
    // device appears later).
    if let Err(msg) = engine.ensure_stream() {
        emit_state(&engine.app, None, "error", Some(msg));
    }

    // Ticks are scheduled by deadline, not by a fresh 50 ms window per
    // received command — a sustained command stream (e.g. a volume-slider
    // drag invoking at 60+ Hz) must not starve position emission or
    // end-of-track detection.
    let mut next_tick = Instant::now() + TICK;
    loop {
        let timeout = next_tick.saturating_duration_since(Instant::now());
        match rx.recv_timeout(timeout) {
            Ok(cmd) => engine.handle_cmd(cmd),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if Instant::now() >= next_tick {
            engine.tick();
            next_tick = Instant::now() + TICK;
        }
    }
}

struct Engine {
    app: AppHandle,
    /// Output stream + handle. `None` until a device is opened; dropped when
    /// the tick watchdog detects device death and reopened on the next load.
    /// `OutputStream` is `!Send`, which is fine here: `Engine` is created on
    /// the engine thread and never leaves it.
    stream: Option<(OutputStream, OutputStreamHandle)>,
    /// A fresh sink is created per loaded track; stopped sinks are never reused.
    sink: Option<Sink>,
    /// Path of the currently (or most recently) loaded track.
    path: Option<String>,
    volume: f32,
    loop_enabled: bool,
    /// Watchdog: last observed playback position, and how many consecutive
    /// ticks it failed to advance while supposedly playing.
    last_pos: Duration,
    stalled_ticks: u32,
}

impl Engine {
    fn handle_cmd(&mut self, cmd: PlayerCmd) {
        match cmd {
            PlayerCmd::Load { path, autoplay } => self.load(path, autoplay),
            PlayerCmd::Play => self.play(),
            PlayerCmd::Pause => self.pause(),
            PlayerCmd::Stop => self.stop(),
            PlayerCmd::Seek { seconds } => self.seek(seconds),
            PlayerCmd::SetVolume(volume) => self.set_volume(volume),
            PlayerCmd::SetLoop(enabled) => self.loop_enabled = enabled,
        }
    }

    /// Return a handle to the output stream, opening the default device if
    /// none is currently open. The error string is user-facing.
    fn ensure_stream(&mut self) -> Result<OutputStreamHandle, String> {
        if self.stream.is_none() {
            match OutputStream::try_default() {
                Ok(pair) => self.stream = Some(pair),
                Err(e) => return Err(format!("Audio output device unavailable: {e}")),
            }
        }
        Ok(self
            .stream
            .as_ref()
            .expect("stream was just opened")
            .1
            .clone())
    }

    /// Deadline tick: emit position while playing; detect end of track; run
    /// the dead-output watchdog.
    fn tick(&mut self) {
        let (ended, pos, paused) = match &self.sink {
            None => return,
            Some(sink) => (sink.empty(), sink.get_pos(), sink.is_paused()),
        };

        if ended {
            self.sink = None;
            if self.loop_enabled {
                if let Some(path) = self.path.clone() {
                    self.load(path, true);
                    return;
                }
            }
            emit_state(&self.app, self.path.clone(), "ended", None);
            return;
        }

        if paused {
            self.stalled_ticks = 0;
            return;
        }

        // Watchdog: a playing, non-empty sink whose position stops advancing
        // means the output stream died (e.g. USB/Bluetooth device unplugged
        // mid-session). rodio 0.20 surfaces no error for this, and a later
        // `try_seek` on a dead stream would block this thread forever — so
        // drop the sink *and* the stream; the next load reopens the (new)
        // default device.
        if pos == self.last_pos {
            self.stalled_ticks += 1;
        } else {
            self.stalled_ticks = 0;
        }
        self.last_pos = pos;
        if self.stalled_ticks >= STALL_TICKS {
            self.stalled_ticks = 0;
            self.sink = None;
            self.stream = None;
            emit_state(
                &self.app,
                self.path.clone(),
                "error",
                Some("Audio output device lost; playback stopped".into()),
            );
            return;
        }

        if let Some(path) = &self.path {
            emit_position(&self.app, path, pos.as_secs_f64(), true);
        }
    }

    fn load(&mut self, path: String, autoplay: bool) {
        // Dropping the previous sink stops its playback immediately.
        self.sink = None;
        self.last_pos = Duration::ZERO;
        self.stalled_ticks = 0;

        let handle = match self.ensure_stream() {
            Ok(h) => h,
            Err(msg) => {
                self.path = None;
                emit_state(&self.app, Some(path), "error", Some(msg));
                return;
            }
        };

        let file = match File::open(&path) {
            Ok(f) => f,
            Err(e) => {
                self.path = None;
                let msg = format!("Could not open file: {e}");
                emit_state(&self.app, Some(path), "error", Some(msg));
                return;
            }
        };
        // Header probe only — milliseconds even for large files.
        let source = match Decoder::new(BufReader::new(file)) {
            Ok(s) => s,
            Err(e) => {
                self.path = None;
                let msg = format!("Unsupported or corrupt audio file: {e}");
                emit_state(&self.app, Some(path), "error", Some(msg));
                return;
            }
        };
        let sink = match Sink::try_new(&handle) {
            Ok(s) => s,
            Err(e) => {
                self.path = None;
                let msg = format!("Audio output error: {e}");
                emit_state(&self.app, Some(path), "error", Some(msg));
                return;
            }
        };

        sink.set_volume(self.volume);
        if !autoplay {
            // Pause before append so no samples slip out.
            sink.pause();
        }
        sink.append(source);

        let state = if autoplay { "playing" } else { "paused" };
        emit_state(&self.app, Some(path.clone()), state, None);
        emit_position(&self.app, &path, 0.0, autoplay);

        self.path = Some(path);
        self.sink = Some(sink);
    }

    fn play(&mut self) {
        let resumed = match &self.sink {
            Some(sink) if !sink.empty() => {
                sink.play();
                true
            }
            _ => false,
        };
        if resumed {
            emit_state(&self.app, self.path.clone(), "playing", None);
        } else if let Some(path) = self.path.clone() {
            // Nothing loaded, or the loaded track already finished: restart it.
            self.load(path, true);
        }
    }

    fn pause(&self) {
        let Some(sink) = &self.sink else { return };
        sink.pause();
        emit_state(&self.app, self.path.clone(), "paused", None);
        if let Some(path) = &self.path {
            emit_position(&self.app, path, sink.get_pos().as_secs_f64(), false);
        }
    }

    fn stop(&mut self) {
        if self.sink.take().is_some() {
            emit_state(&self.app, self.path.clone(), "stopped", None);
        }
    }

    fn seek(&self, seconds: f64) {
        // `Sink::try_seek` blocks until the output stream's periodic access
        // services it — on a dead stream that is forever. The tick watchdog
        // drops the sink once the stream stalls, so a sink being present here
        // means the stream advanced within the last ~STALL_TICKS ticks.
        let Some(sink) = &self.sink else { return };
        if !seconds.is_finite() {
            return;
        }
        let target = Duration::from_secs_f64(seconds.clamp(0.0, MAX_SEEK_SECONDS));
        // Coarse or failed seeks (some mp3/vorbis files) are logged, never fatal.
        if let Err(e) = sink.try_seek(target) {
            eprintln!("[audio] seek to {seconds:.2}s failed: {e}");
            return;
        }
        if let Some(path) = &self.path {
            emit_position(
                &self.app,
                path,
                sink.get_pos().as_secs_f64(),
                !sink.is_paused(),
            );
        }
    }

    fn set_volume(&mut self, volume: f32) {
        if !volume.is_finite() {
            return;
        }
        self.volume = volume.clamp(0.0, 1.0);
        if let Some(sink) = &self.sink {
            sink.set_volume(self.volume);
        }
    }
}

fn emit_state(app: &AppHandle, path: Option<String>, state: &'static str, message: Option<String>) {
    let payload = StatePayload {
        path,
        state,
        message,
    };
    if let Err(e) = app.emit(events::PLAYBACK_STATE, payload) {
        eprintln!("[audio] failed to emit playback state: {e}");
    }
}

fn emit_position(app: &AppHandle, path: &str, seconds: f64, playing: bool) {
    let payload = PositionPayload {
        path: path.to_string(),
        seconds,
        playing,
    };
    if let Err(e) = app.emit(events::PLAYBACK_POSITION, payload) {
        eprintln!("[audio] failed to emit playback position: {e}");
    }
}
