//! Shared IPC contract — mirrored by `src/types.ts`. Field names cross the
//! IPC boundary as camelCase; renaming anything here breaks the frontend.

use serde::Serialize;

pub const AUDIO_EXTENSIONS: [&str; 7] = ["wav", "mp3", "flac", "ogg", "aiff", "aif", "m4a"];

/// `gif` and `webp` are here for 2D artists — animated GIFs preview and play.
/// `kra`/`aseprite`/`ase`/`psd`/`psb` are layered art sources decoded to their
/// flattened image (see thumbs::decode_image); the preview shows their layers.
/// `afphoto`/`afdesign`/`afpub` (Affinity) are closed-format art whose only
/// readable pixels are the embedded PNG preview — decoded flat, no layer panel.
/// Camera RAW. Decoded by extracting the camera's embedded full-res JPEG
/// preview (thumbs::decode_raw) — fast, and no debayering dependency. The
/// preview panel tone-maps these like HDR/EXR (see tonemap.rs); the fixed set
/// covers the mainstream TIFF-based formats plus Fuji RAF.
pub const RAW_EXTENSIONS: [&str; 13] = [
    "cr2", "cr3", "nef", "nrw", "arw", "sr2", "srf", "dng", "raf", "orf", "rw2", "pef", "srw",
];

pub const TEXTURE_EXTENSIONS: [&str; 33] = [
    "png", "jpg", "jpeg", "bmp", "tga", "dds", "tif", "tiff", "exr", "hdr", "gif", "webp", "kra",
    "aseprite", "ase", "psd", "psb", "afphoto", "afdesign", "afpub", // camera raw (RAW_EXTENSIONS):
    "cr2", "cr3", "nef", "nrw", "arw", "sr2", "srf", "dng", "raf", "orf", "rw2", "pef", "srw",
];

/// `blend` is scanned but not previewable — listing it beats it silently
/// vanishing from a folder the user knows has models in it.
pub const MODEL_EXTENSIONS: [&str; 9] = [
    "fbx", "obj", "gltf", "glb", "dae", "3ds", "ply", "stl", "blend",
];

/// Documents game devs keep alongside assets — design docs, references, notes.
/// pdf/md/txt render in the webview directly. (Photoshop psd/psb moved to the
/// Images tab, where they preview with a layer panel like kra/aseprite.)
/// The ebook formats (epub/mobi/azw/azw3/fb2/fbz/cbz) render in-app via the
/// vendored foliate-js viewer — see components/document/EbookView.tsx. `.fb2.zip`
/// is intentionally absent: the last extension is "zip", and classifying every
/// zip as a document would flood the tab.
pub const DOCUMENT_EXTENSIONS: [&str; 11] = [
    "pdf", "md", "markdown", "txt", // ebooks (foliate-js):
    "epub", "mobi", "azw", "azw3", "fb2", "fbz", "cbz",
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
    pub const META_AUDIO: &str = "meta:audio";
    pub const META_DIMENSIONS: &str = "meta:dimensions";
    pub const WAVEFORM_READY: &str = "waveform:ready";
    pub const SPECTROGRAM_READY: &str = "spectrogram:ready";
    pub const PLAYBACK_POSITION: &str = "playback:position";
    pub const PLAYBACK_STATE: &str = "playback:state";
    pub const THUMB_READY: &str = "thumb:ready";
    pub const DUPES_PROGRESS: &str = "dupes:progress";
    pub const DUPES_DONE: &str = "dupes:done";
}

/// Per-image facts derived while building the thumbnail — free, since the
/// pixels are already decoded and downscaled.
///
/// These SUPPLEMENT the name-based channel classifier, never override it: a
/// filename is the author's stated intent, a histogram is an inference.
#[derive(Clone, Copy, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThumbInfo {
    /// Thumbnail dimensions, not the source's.
    pub width: u32,
    pub height: u32,
    /// The source image's real pixel dimensions, before downscale — what the
    /// status bar shows as the resolution.
    pub source_width: u32,
    pub source_height: u32,
    /// Mean ≈ (0.5, 0.5, 1.0) — tangent-space normal map.
    pub normal_like: bool,
    /// Near-zero chroma — roughness/height/AO/metallic are single-channel.
    pub grayscale: bool,
    /// Luma piles up at both ends, empty middle — an opacity/cutout mask.
    pub bimodal: bool,
    pub has_alpha: bool,
    pub mean_r: f32,
    pub mean_g: f32,
    pub mean_b: f32,
}

/// Batched `(file id, stats, cache key)`. The key is a URL, not bytes — the
/// pixels come back over the `thumb://` scheme, off the JS main thread.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbBatch {
    pub entries: Vec<(u32, ThumbInfo, String)>,
}

/// Which lens (tab) a scanned file belongs to. Serializes as
/// `"audio" | "texture" | "model" | "document"`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Audio,
    Texture,
    Model,
    Document,
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

/// Batched audio metadata: `(file id, seconds, sample rate Hz, channels, bits
/// per sample)` — 0 = unknown for every field but the id. Carries the scan
/// generation for the same reason `DimensionBatch` does (see below): file ids
/// restart at 0 every scan, so the frontend drops stale-gen batches.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMetaBatch {
    pub gen: u32,
    pub entries: Vec<(u32, f32, u32, u16, u16)>,
}

/// Batched `(file id, width, height)` triples. Carries the scan generation:
/// file ids RESTART AT 0 every scan, so unlike a keyed cache a late batch from
/// a superseded scan would land on the wrong files — the frontend drops any
/// batch whose generation is not current.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionBatch {
    pub gen: u32,
    pub entries: Vec<(u32, u32, u32)>,
}

/// `peaks` is interleaved `[min0, max0, min1, max1, ...]`, `2 * bins` floats in `[-1, 1]`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformReady {
    pub path: String,
    pub bins: u32,
    pub peaks: Vec<f32>,
}

/// One rendered spectrogram image. `data` is base64 of `width × height`
/// row-major u8 magnitudes (0 = silence floor, 255 = peak), row 0 at the TOP
/// (highest frequency) so the frontend's ImageData needs no flip. Base64
/// because a 1024×128 image as a JSON number array would be ~half a MB of
/// digits; keyed by path like the waveform, so no scan generation is needed.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectrogramReady {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub data: String,
}

/// Duplicate-hunt progress: `done` of `total` files hashed so far. `total`
/// starts as the size-collision candidate count (the prefix stage) and grows as
/// the full-file confirm pass re-reads a subset, each of which also advances
/// `done` — so `done <= total` holds throughout and the bar keeps moving during
/// long confirms. Keyed by path, not file id, so no scan generation is needed.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupeProgress {
    pub done: u32,
    pub total: u32,
}

/// One confirmed duplicate set: files whose full content hashed identical.
/// `size` is the byte size of EACH member.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupeGroup {
    pub size: u64,
    pub paths: Vec<String>,
}

/// Groups sorted by wasted bytes — `size × (n − 1)` — descending.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupesDone {
    pub groups: Vec<DupeGroup>,
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
