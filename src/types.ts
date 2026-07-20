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

/** Count-readout noun per kind ("623 of 11,501 files"). Shared by StatusBar
 *  and the filter popup so the two readouts can never disagree. */
export const NOUN: Record<AssetKind, string> = {
  audio: "files",
  texture: "textures",
  model: "models",
};

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

/** Batched [file id, seconds, sample rate Hz, channels, bits per sample] from
 *  the audio probe — 0 = unknown for every field but the id. Carries the scan
 *  generation for the same reason DimensionBatch does: ids restart at 0 every
 *  scan, so a late batch from a superseded scan would land on the wrong files. */
export interface AudioMetaBatch {
  gen: number;
  entries: [id: number, seconds: number, rate: number, channels: number, bits: number][];
}

/** Batched [file id, width, height] triples from the texture dimension probe.
 *  Carries the scan generation: ids restart at 0 every scan, so a late batch
 *  from a superseded scan would land on the wrong files. */
export interface DimensionBatch {
  gen: number;
  entries: [id: number, w: number, h: number][];
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
  META_AUDIO: "meta:audio",
  META_DIMENSIONS: "meta:dimensions",
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

// ---- filter facets ----
//
// Ranges are typed min/max in UI units; the invariant everywhere is still
// unknown = keep — a filter may only remove files it has positively measured,
// so a restored filter on a cold library shows everything and narrows as
// probe batches land — never a flash-of-empty.

/** Half-open-ended numeric constraint in the facet's UI unit (s / px / MB).
 *  null = unbounded on that side. Active ⇔ either end is set. */
export interface RangeFilter {
  min: number | null;
  max: number | null;
}

export const rangeActive = (r: RangeFilter): boolean => r.min !== null || r.max !== null;

export const emptyRange = (): RangeFilter => ({ min: null, max: null });

/** 1 MB as the size facet's unit (binary MiB; matches humanSize). */
export const MIB = 1_048_576;


/** Seconds per day — the Modified range facet works in whole local days. */
export const DAY_SECONDS = 86_400;

/**
 * The filter vocabulary of 10 groups over table.ts's 23 channels — a chip row
 * of 23 would be unusable, and nobody filters for "Cavity vs Curvature".
 * Canonical order; chips render in it so they never reshuffle.
 */
export const CHANNEL_GROUPS = ["baseColor", "normal", "roughness", "metallic", "ao",
  "height", "emissive", "opacity", "packed", "other"] as const;
export type ChannelGroup = (typeof CHANNEL_GROUPS)[number];
export const CHANNEL_GROUP_LABEL: Record<ChannelGroup, string> = {
  baseColor: "Base Color", normal: "Normal", roughness: "Roughness", metallic: "Metallic",
  ao: "AO", height: "Height", emissive: "Emissive", opacity: "Opacity",
  packed: "Packed", other: "Other",
};

/** Persisted twin of TabState.filters (Sets → arrays; RangeFilter is already
 *  plain JSON and persists as-is). */
export interface TabFilterSettings {
  duration: RangeFilter;       // audio only — seconds, decimals allowed
  modified: RangeFilter;       // all kinds — unix seconds, day-granular from the UI
  channels: string[];          // ChannelGroup[] — texture only
  material: boolean;           // texture only — on = member of a material group
  res: RangeFilter;            // texture only — px, applied to max(w, h), integers
  square: boolean;             // texture only
  pot: boolean;                // texture only
  size: RangeFilter;           // model only — MB (× MIB internally)
}

/**
 * One shape for every kind, gated per kind by the sanitizer + the popup —
 * the SORT_FIELDS_BY_KIND idiom, so an inapplicable facet can neither be
 * shown nor restored.
 */
export const FILTER_FACETS_BY_KIND = {
  audio: ["duration", "modified"],
  texture: ["channels", "material", "res", "square", "pot", "modified"],
  model: ["size", "modified"],
} as const satisfies Record<AssetKind, readonly (keyof TabFilterSettings)[]>;

/** Per-tab persisted view state. */
export interface TabSettings {
  sortField: SortField;
  sortDir: SortDir;
  extFilter: string[];
  viewMode: ViewMode;
  cellSize: number;
  groupMaterials: boolean;
  filters: TabFilterSettings;
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
  /** Selected parent folders scoping the file list; empty = whole library.
   *  Shared across tabs (see libraryStore). */
  folderScopes: string[];
  /** Folders whose content is excluded from the query (the tree's eye-toggle). */
  hiddenFolders: string[];
  /** packDir (lowercased) -> chosen atlas. Persisted because re-picking the
   *  atlas on every launch would be worse than the bug it fixes. */
  atlases: Record<string, AtlasChoiceSettings>;
}
