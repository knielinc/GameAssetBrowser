//! Shared IPC contract — mirrored by `src/types.ts`. Field names cross the
//! IPC boundary as camelCase; renaming anything here breaks the frontend.

use serde::Serialize;

pub const AUDIO_EXTENSIONS: [&str; 7] = ["wav", "mp3", "flac", "ogg", "aiff", "aif", "m4a"];

pub mod events {
    pub const SCAN_BATCH: &str = "scan:batch";
    pub const SCAN_DONE: &str = "scan:done";
    pub const META_DURATIONS: &str = "meta:durations";
    pub const WAVEFORM_READY: &str = "waveform:ready";
    pub const PLAYBACK_POSITION: &str = "playback:position";
    pub const PLAYBACK_STATE: &str = "playback:state";
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: u32,
    pub path: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
    /// Unix seconds.
    pub modified: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanBatch {
    pub gen: u32,
    pub files: Vec<FileEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanDone {
    pub gen: u32,
    pub total: u64,
    pub elapsed_ms: u64,
}

/// Batched `(file id, duration seconds)` pairs.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurationBatch {
    pub entries: Vec<(u32, f32)>,
}

/// `peaks` is interleaved `[min0, max0, min1, max1, ...]`, `2 * bins` floats in `[-1, 1]`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformReady {
    pub path: String,
    pub bins: u32,
    pub peaks: Vec<f32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionPayload {
    pub path: String,
    pub seconds: f64,
    pub playing: bool,
}

/// `state` is one of: "playing" | "paused" | "stopped" | "ended" | "error".
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePayload {
    pub path: Option<String>,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
