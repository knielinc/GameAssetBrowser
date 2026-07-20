//! Audio playback: a dedicated engine thread owns the (`!Send`) rodio output
//! stream; the rest of the app talks to it exclusively through [`PlayerCmd`]
//! messages sent via the managed [`AudioController`].

pub mod commands;
pub mod engine;

use crossbeam_channel::Sender;

/// Commands accepted by the audio engine thread.
pub enum PlayerCmd {
    Load { path: String, autoplay: bool },
    Play,
    Pause,
    Stop,
    Seek { seconds: f64 },
    SetVolume(f32),
    SetLoop(bool),
    /// Playback rate 0.25–2.0 (clamped in the engine). rodio's speed is a
    /// resample, so pitch shifts with it — accepted for auditioning.
    SetSpeed(f32),
}

/// Managed state: the only handle the rest of the app holds to the engine.
pub struct AudioController {
    tx: Sender<PlayerCmd>,
}

impl AudioController {
    pub fn new(tx: Sender<PlayerCmd>) -> Self {
        Self { tx }
    }

    /// Forward a command to the engine thread. If the engine thread is gone
    /// the command is dropped and logged — audio must never panic the app.
    pub fn send(&self, cmd: PlayerCmd) {
        if self.tx.send(cmd).is_err() {
            eprintln!("[audio] engine thread not running; command dropped");
        }
    }
}
