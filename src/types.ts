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
//   player_set_speed    { speed: number }               // 0.25..2, clamped in the engine
//   request_waveform    { path: string, bins: number }  // result arrives via EVT.WAVEFORM_READY
//   request_spectrogram { path: string }                // result arrives via EVT.SPECTROGRAM_READY
//   show_in_explorer    { path: string }                // reveal file in Windows Explorer; rejects if path is gone
//   open_in_explorer    { path: string }                // open a folder window in Explorer; rejects if not a directory
//   filter_dirs         { paths: string[] }             → Promise<string[]> (only the paths that are directories)
//   copy_image_to_clipboard { path: string }            // decode to RGBA and put on the OS clipboard; rejects on failure
//   open_with           { exe: string, path: string }   // spawn a registered external app, detached; rejects on spawn error
//   settings_store_path {}                              → Promise<string> (absolute settings.json path, portable-aware)

import { schemeBase } from "./platform";

/**
 * Which lens (tab) a scanned file belongs to. `"all"` is a PSEUDO-kind: no
 * `FileEntry` ever carries it — it's only ever a tab identity, showing files
 * of every real kind at once (useVisibleFiles bypasses its `f.kind === kind`
 * filter for it). It leads the list so it's the default landing tab.
 */
export type AssetKind = "all" | "audio" | "texture" | "model" | "document";
export const ASSET_KINDS = ["all", "audio", "texture", "model", "document"] as const;
/** The four real, file-backed kinds — everything except the "all" pseudo-tab.
 *  Iterate this for anything keyed by a file's actual kind: per-kind stat
 *  tables, external-app targets, folder-tree counts. */
export const REAL_ASSET_KINDS = ["audio", "texture", "model", "document"] as const;

/** Count-readout noun per kind ("623 of 11,501 files"). Shared by StatusBar
 *  and the filter popup so the two readouts can never disagree. */
export const NOUN: Record<AssetKind, string> = {
  all: "files",
  audio: "files",
  texture: "images",
  model: "models",
  document: "documents",
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

/** One rendered spectrogram: `data` is base64 of `width × height` row-major
 *  u8 magnitudes (0 = silence floor, 255 = peak), row 0 at the TOP (highest
 *  frequency) so it maps straight onto an ImageData. Keyed by path like the
 *  waveform — no scan generation needed. */
export interface SpectrogramReady {
  path: string;
  width: number;
  height: number;
  data: string;
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
  SPECTROGRAM_READY: "spectrogram:ready",
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

/** Thumbnails are fetched by the webview over their own scheme, off the JS main
 *  thread. The base differs per platform (see schemeBase); the key is opaque
 *  and single-segment, so it slots straight in. */
export function thumbUrl(key: string): string {
  return `${schemeBase("thumb")}/${key}`;
}

/** Raw RGBA for the WebGL grid: `[u32 w][u32 h][rgba]`. Uploaded straight to
 *  the GPU atlas — no PNG decode. Served by the `tex://` scheme. */
export function texUrl(key: string): string {
  return `${schemeBase("tex")}/${key}`;
}

export const AUDIO_EXTENSIONS = ["wav", "mp3", "flac", "ogg", "aiff", "aif", "m4a"] as const;
export type AudioExt = (typeof AUDIO_EXTENSIONS)[number];

/** Camera RAW — decoded via the embedded JPEG preview in Rust (thumbs::
 *  decode_raw). Mirrors RAW_EXTENSIONS in types.rs. */
export const RAW_EXTENSIONS = [
  "cr2", "cr3", "nef", "nrw", "arw", "sr2", "srf", "dng", "raf", "orf", "rw2", "pef", "srw",
] as const;

export const TEXTURE_EXTENSIONS = [
  "png", "jpg", "jpeg", "bmp", "tga", "dds", "tif", "tiff", "exr", "hdr", "gif", "webp",
  "kra", "aseprite", "ase", "psd", "psb", "afphoto", "afdesign", "afpub",
  ...RAW_EXTENSIONS,
] as const;
export const MODEL_EXTENSIONS = [
  "fbx", "obj", "gltf", "glb", "dae", "3ds", "ply", "stl", "blend",
] as const;
/** Design docs, references, notes, plus ebooks (epub/mobi/azw3/fb2/cbz, rendered
 *  by the vendored foliate-js viewer). Mirrors types.rs. */
export const DOCUMENT_EXTENSIONS = [
  "pdf", "md", "markdown", "txt",
  "epub", "mobi", "azw", "azw3", "fb2", "fbz", "cbz",
] as const;

/** Per-kind extension vocabularies. Mirrors the four lists in types.rs. The
 *  "all" entry is the union — the four real kinds' extensions are disjoint, so
 *  no dedupe is needed; it drives the All tab's format facet + ext sanitizer. */
export const EXTENSIONS: Record<AssetKind, readonly string[]> = {
  all: [...AUDIO_EXTENSIONS, ...TEXTURE_EXTENSIONS, ...MODEL_EXTENSIONS, ...DOCUMENT_EXTENSIONS],
  audio: AUDIO_EXTENSIONS,
  texture: TEXTURE_EXTENSIONS,
  model: MODEL_EXTENSIONS,
  document: DOCUMENT_EXTENSIONS,
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
  // "all" mixes kinds, so only the fields every file has — "duration" is
  // audio-only and would be meaningless on a texture.
  all: ["name", "ext", "size", "modified"],
  audio: ["name", "ext", "size", "modified", "duration"],
  texture: ["name", "ext", "size", "modified"],
  model: ["name", "ext", "size", "modified"],
  document: ["name", "ext", "size", "modified"],
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

/**
 * Color facet vocabulary over ThumbInfo.meanR/G/B (0–1 sRGB means from the
 * thumbnail decode). Canonical order — swatches render in it so they never
 * reshuffle. Lightness and saturation outrank hue (a near-black red reads as
 * "dark", not "red"); the classifier (useVisibleFiles.colorBucketOf) uses:
 *
 *   lightness < 0.13 → dark      hue table (degrees):
 *   lightness > 0.87 → light       red    345–15    cyan   165–200
 *   saturation < 0.12 → gray       orange  15–45    blue   200–255
 *   else → hue bucket              yellow  45–70    purple 255–290
 *                                  green   70–165   pink   290–345
 */
export const COLOR_BUCKETS = ["red", "orange", "yellow", "green", "cyan", "blue",
  "purple", "pink", "dark", "light", "gray"] as const;
export type ColorBucket = (typeof COLOR_BUCKETS)[number];
export const COLOR_BUCKET_LABEL: Record<ColorBucket, string> = {
  red: "Red", orange: "Orange", yellow: "Yellow", green: "Green", cyan: "Cyan",
  blue: "Blue", purple: "Purple", pink: "Pink", dark: "Dark", light: "Light",
  gray: "Gray",
};

/** Audio channel-layout facet vocabulary: 1 / 2 / >2 channels from the audio
 *  probe (AudioMetaBatch). 0 channels = unmeasured, which is no bucket. */
export const AUDIO_CHANNEL_GROUPS = ["mono", "stereo", "multi"] as const;
export type AudioChannelGroup = (typeof AUDIO_CHANNEL_GROUPS)[number];
export const AUDIO_CHANNEL_GROUP_LABEL: Record<AudioChannelGroup, string> = {
  mono: "Mono", stereo: "Stereo", multi: "Multi",
};

/** Sample-rate facet vocabulary — the canonical tiers audio actually ships in.
 *  Real rates bucket to the nearest tier at or above (a 24k file lands in 32k;
 *  see useVisibleFiles.sampleRateBucketOf), so odd rates never vanish. */
export const SAMPLE_RATE_BUCKETS = ["le22", "32k", "44k", "48k", "hi"] as const;
export type SampleRateBucket = (typeof SAMPLE_RATE_BUCKETS)[number];
export const SAMPLE_RATE_BUCKET_LABEL: Record<SampleRateBucket, string> = {
  le22: "≤22.05k", "32k": "32k", "44k": "44.1k", "48k": "48k", hi: "88.2k+",
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
  colors: string[];            // ColorBucket[] — texture only
  audioChannels: string[];     // AudioChannelGroup[] — audio only
  sampleRates: string[];       // SampleRateBucket[] — audio only
  favorite: boolean;           // all kinds — on = starred (favoritesStore). The
                               // sidebar "Favorites" row is a whole-library
                               // SCOPE; this facet narrows the CURRENT view.
  collections: string[];       // all kinds — collection names (favoritesStore).
                               // The sidebar collection rows are whole-library
                               // SCOPES; this facet narrows the CURRENT view to
                               // members of ANY selected collection (OR within
                               // the facet, AND across facets). Dynamic
                               // vocabulary — validated by dedupe, not a table.
  excludeTerms: string[];      // all kinds — hide files whose name contains ANY
                               // term (substring, lowercased). OR within the
                               // facet, AND across facets. Dynamic vocabulary
                               // (free text) — validated by dedupe, not a table.
}

/**
 * One shape for every kind, gated per kind by the sanitizer + the popup —
 * the SORT_FIELDS_BY_KIND idiom, so an inapplicable facet can neither be
 * shown nor restored.
 */
export const FILTER_FACETS_BY_KIND = {
  // "all" mixes kinds, so only the kind-agnostic facets apply (a channel or
  // resolution filter is meaningless across a mixed list).
  all: ["favorite", "collections", "modified", "excludeTerms"],
  audio: ["favorite", "collections", "duration", "audioChannels", "sampleRates", "modified", "excludeTerms"],
  texture: ["favorite", "collections", "channels", "material", "colors", "res", "square", "pot", "modified", "excludeTerms"],
  model: ["favorite", "collections", "size", "modified", "excludeTerms"],
  document: ["favorite", "collections", "size", "modified", "excludeTerms"],
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

/** A user-named, ordered set of file paths (stores/favoritesStore.ts). */
export interface CollectionSettings {
  name: string;
  paths: string[];
}

/** One recently-auditioned/previewed file. `ts` is unix seconds. */
export interface RecentSettings {
  path: string;
  ts: number;
}

/** One user-registered external app ("Open with…" — stores/externalApps.ts).
 *  `kind` gates which context menus offer it; `exe` is the absolute path. */
export interface ExternalAppSettings {
  kind: AssetKind;
  name: string;
  exe: string;
  /** Restrict the entry to these file extensions (lowercase, no dot) — e.g.
   *  an Aseprite editor only for ["aseprite","ase"] rather than every image.
   *  Absent/empty means every file of `kind`, the pre-feature behaviour. */
  exts?: string[];
}

export interface Settings {
  version: 2;
  roots: string[];
  volume: number;
  loop: boolean;
  autoplay: boolean;
  /** When a track ends (loop off), advance to the next visible audio file and
   *  play it — the player-bar toggle next to loop. */
  autoAdvance: boolean;
  /** Auto-advance in a random (Spotify-style) order rather than list order. */
  shuffle: boolean;
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
  /** Starred file paths (the ★ button / F key). Absent pre-feature → empty. */
  favorites: string[];
  /** User-named collections, in creation order. */
  collections: CollectionSettings[];
  /** Recently played/previewed files, most-recent-first, capped (see
   *  favoritesStore.RECENTS_CAP). */
  recents: RecentSettings[];
  /** "Open with…" apps (SettingsMenu → External apps…). Absent pre-feature →
   *  empty. */
  externalApps: ExternalAppSettings[];
}
