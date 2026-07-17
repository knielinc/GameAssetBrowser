//! Shared IPC contract — mirrored by `src/types.ts`. Field names cross the
//! IPC boundary as camelCase; renaming anything here breaks the frontend.

use serde::Serialize;

pub const AUDIO_EXTENSIONS: [&str; 7] = ["wav", "mp3", "flac", "ogg", "aiff", "aif", "m4a"];

/// `psd` is deliberately absent: Synty and freestylized ship PSD *sources*,
/// which would roughly double the texture grid with files that aren't assets.
pub const TEXTURE_EXTENSIONS: [&str; 10] = [
    "png", "jpg", "jpeg", "bmp", "tga", "dds", "tif", "tiff", "exr", "hdr",
];

/// `blend` is scanned but not previewable — listing it beats it silently
/// vanishing from a folder the user knows has models in it.
pub const MODEL_EXTENSIONS: [&str; 9] = [
    "fbx", "obj", "gltf", "glb", "dae", "3ds", "ply", "stl", "blend",
];

/// Directories never worth walking.
///
/// Deliberately tiny. The obvious additions — `obj`, `bin`, `target`,
/// `Library`, `Temp` — are all real asset-folder names in the wild, and
/// skipping one silently deletes assets from the UI with no error. Synty's
/// POLYGON packs ship their models in `Source Files/OBJ/`; skipping `obj` to
/// keep a C++ build's COFF files out of the Models tab cost 225 real models
/// in exactly that pack.
///
/// The asymmetry decides it: under-skipping costs scan time on a folder no
/// one points an asset browser at; over-skipping loses assets and looks like
/// a scanner bug. Everything here is either dot-prefixed tooling metadata or
/// `node_modules` — names no one ships assets under.
pub const SKIP_DIRS: [&str; 1] = ["node_modules"];

pub mod events {
    pub const SCAN_BATCH: &str = "scan:batch";
    pub const SCAN_DONE: &str = "scan:done";
    pub const META_DURATIONS: &str = "meta:durations";
    pub const WAVEFORM_READY: &str = "waveform:ready";
    pub const PLAYBACK_POSITION: &str = "playback:position";
    pub const PLAYBACK_STATE: &str = "playback:state";
}

/// Which lens (tab) a scanned file belongs to. Serializes as
/// `"audio" | "texture" | "model"`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Audio,
    Texture,
    Model,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: u32,
    pub path: String,
    pub name: String,
    pub ext: String,
    pub kind: AssetKind,
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
