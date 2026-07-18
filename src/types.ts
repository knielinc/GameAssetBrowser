// Shared IPC contract — mirrors src-tauri/src/types.rs. Do not drift.
//
// Tauri commands (invoke name → args, camelCase over IPC):
//   start_scan          { roots: string[] }            → Promise<number> (scan generation)
//   player_load         { path: string, autoplay: boolean }
//   player_play         {}
//   player_pause        {}
//   player_stop         {}
//   player_seek         { seconds: number }
//   player_set_volume   { volume: number }              // 0..1
//   player_set_loop     { enabled: boolean }
//   request_waveform    { path: string, bins: number }  // result arrives via EVT.WAVEFORM_READY
//   show_in_explorer    { path: string }                // reveal file in Windows Explorer; rejects if path is gone
//   open_in_explorer    { path: string }                // open a folder window in Explorer; rejects if not a directory
//   settings_store_path {}                              → Promise<string> (absolute settings.json path, portable-aware)

/** Which lens (tab) a scanned file belongs to. */
export type AssetKind = "audio" | "texture" | "model";
export const ASSET_KINDS = ["audio", "texture", "model"] as const;

export interface FileEntry {
  id: number;
  path: string;
  name: string;
  ext: string;
  kind: AssetKind;
  size: number;
  /** Unix seconds. */
  modified: number;
}

export interface ScanBatch {
  gen: number;
  files: FileEntry[];
}

export interface ScanDone {
  gen: number;
  total: number;
  elapsedMs: number;
}

/** Batched [file id, duration seconds] pairs. */
export interface DurationBatch {
  entries: [id: number, seconds: number][];
}

/** `peaks` is interleaved [min0, max0, min1, max1, ...], 2 * bins floats in [-1, 1]. */
export interface WaveformReady {
  path: string;
  bins: number;
  peaks: number[];
}

export interface PositionPayload {
  path: string;
  seconds: number;
  playing: boolean;
}

export type PlaybackStateKind = "playing" | "paused" | "stopped" | "ended" | "error";

export interface StatePayload {
  path: string | null;
  state: PlaybackStateKind;
  message?: string;
}

export const EVT = {
  SCAN_BATCH: "scan:batch",
  SCAN_DONE: "scan:done",
  META_DURATIONS: "meta:durations",
  WAVEFORM_READY: "waveform:ready",
  PLAYBACK_POSITION: "playback:position",
  PLAYBACK_STATE: "playback:state",
  THUMB_READY: "thumb:ready",
} as const;

/**
 * Per-image facts derived while building the thumbnail. These SUPPLEMENT the
 * name-based channel classifier, never override it — a filename is the
 * author's stated intent, a histogram is an inference.
 */
export interface ThumbInfo {
  /** Thumbnail dimensions, not the source's. */
  width: number;
  height: number;
  /** The source image's real pixel dimensions (before downscale). */
  sourceWidth: number;
  sourceHeight: number;
  /** Mean ≈ (0.5, 0.5, 1.0) — tangent-space normal map. */
  normalLike: boolean;
  /** Near-zero chroma — roughness/height/AO/metallic are single-channel. */
  grayscale: boolean;
  /** Luma at both ends, empty middle — an opacity/cutout mask. */
  bimodal: boolean;
  hasAlpha: boolean;
  meanR: number;
  meanG: number;
  meanB: number;
}

/** Batched `[file id, stats, cache key]`. The key is a URL, not bytes. */
export interface ThumbBatch {
  entries: [id: number, info: ThumbInfo, key: string][];
}

/** Thumbnails are fetched by WebView2 over their own scheme, off the JS main
 *  thread. On Windows a custom scheme resolves as http://<name>.localhost. */
export function thumbUrl(key: string): string {
  return `http://thumb.localhost/${key}`;
}

/** Raw RGBA for the WebGL grid: `[u32 w][u32 h][rgba]`. Uploaded straight to
 *  the GPU atlas — no PNG decode. Served by the `tex://` scheme. */
export function texUrl(key: string): string {
  return `http://tex.localhost/${key}`;
}

export const AUDIO_EXTENSIONS = ["wav", "mp3", "flac", "ogg", "aiff", "aif", "m4a"] as const;
export type AudioExt = (typeof AUDIO_EXTENSIONS)[number];

export const TEXTURE_EXTENSIONS = [
  "png", "jpg", "jpeg", "bmp", "tga", "dds", "tif", "tiff", "exr", "hdr", "gif", "webp",
] as const;
export const MODEL_EXTENSIONS = [
  "fbx", "obj", "gltf", "glb", "dae", "3ds", "ply", "stl", "blend",
] as const;

/** Per-kind extension vocabularies. Mirrors the three lists in types.rs. */
export const EXTENSIONS: Record<AssetKind, readonly string[]> = {
  audio: AUDIO_EXTENSIONS,
  texture: TEXTURE_EXTENSIONS,
  model: MODEL_EXTENSIONS,
};

export type SortField = "name" | "size" | "modified" | "ext" | "duration";
export type SortDir = "asc" | "desc";
export type ViewMode = "list" | "grid";

/**
 * One union, gated per kind — "Length" is meaningless on a texture. The
 * Toolbar dropdown and the settings sanitizer both read this map, so an
 * inapplicable field can neither be shown nor restored from disk.
 */
export const SORT_FIELDS_BY_KIND: Record<AssetKind, readonly SortField[]> = {
  audio: ["name", "ext", "size", "modified", "duration"],
  texture: ["name", "ext", "size", "modified"],
  model: ["name", "ext", "size", "modified"],
};

/** Per-tab persisted view state. */
export interface TabSettings {
  sortField: SortField;
  sortDir: SortDir;
  extFilter: string[];
  viewMode: ViewMode;
  cellSize: number;
  groupMaterials: boolean;
}

/**
 * Persisted via @tauri-apps/plugin-store in `settings.json`.
 *
 * v1 (SoundPreviewer) had single-valued sortField/sortDir/extFilter at the top
 * level; `version` was absent. sanitize() upgrades that shape — see settings.ts.
 */
/** A manually-chosen atlas for one asset pack. See stores/atlasStore.ts for
 *  why this cannot be inferred. */
export interface AtlasChoiceSettings {
  path: string;
  flipY: boolean;
}

export interface Settings {
  version: 2;
  roots: string[];
  volume: number;
  loop: boolean;
  autoplay: boolean;
  activeTab: AssetKind;
  tabs: Record<AssetKind, TabSettings>;
  /** packDir (lowercased) -> chosen atlas. Persisted because re-picking the
   *  atlas on every launch would be worse than the bug it fixes. */
  atlases: Record<string, AtlasChoiceSettings>;
}
