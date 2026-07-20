import { create } from "zustand";
import { open } from "@tauri-apps/plugin-dialog";
import { startScan } from "../ipc/commands";
import { ASSET_KINDS, FILTER_FACETS_BY_KIND, emptyRange, rangeActive } from "../types";
import type {
  AssetKind,
  AudioChannelGroup,
  AudioMetaBatch,
  ChannelGroup,
  ColorBucket,
  DimensionBatch,
  FileEntry,
  RangeFilter,
  SampleRateBucket,
  ScanDone,
  SortDir,
  SortField,
  ThumbBatch,
  ThumbInfo,
  ViewMode,
} from "../types";

/** A scanned file plus the precomputed lowercase name used for filtering. */
export interface LibFile extends FileEntry {
  nameLower: string;
}

/** Session shape of one tab's filters: Sets for O(1) membership in the 50k
 *  loop; ranges as plain {min,max} in UI units. Persisted twin is
 *  TabFilterSettings. */
export interface TabFilters {
  duration: RangeFilter;
  /** Unix seconds, day-granular from the UI. */
  modified: RangeFilter;
  channels: Set<ChannelGroup>;
  /** On = only files that are members of a derived material group. */
  material: boolean;
  res: RangeFilter;
  square: boolean;
  pot: boolean;
  size: RangeFilter;
  /** Texture only — mean-color buckets from ThumbInfo (unmeasured = keep). */
  colors: Set<ColorBucket>;
  /** Audio only — channel-layout buckets from the audio probe. */
  audioChannels: Set<AudioChannelGroup>;
  /** Audio only — sample-rate buckets from the audio probe. */
  sampleRates: Set<SampleRateBucket>;
  /** All kinds — on = only starred files. A view filter (ANDs with the folder
   *  scope), distinct from the sidebar's whole-library Favorites scope. */
  favorite: boolean;
}

export function defaultFilters(): TabFilters {
  return {
    duration: emptyRange(),
    modified: emptyRange(),
    channels: new Set(),
    material: false,
    res: emptyRange(),
    square: false,
    pot: false,
    size: emptyRange(),
    colors: new Set(),
    audioChannels: new Set(),
    sampleRates: new Set(),
    favorite: false,
  };
}

/** Is one facet's value an active constraint? Total over every value shape in
 *  TabFilters: Set (multi-select), boolean (shape/material), RangeFilter. */
export function facetActive(v: TabFilters[keyof TabFilters]): boolean {
  if (v instanceof Set) return v.size > 0;
  if (typeof v === "boolean") return v;
  return rangeActive(v);
}

/** Active-facet count for kind — "how many kinds of constraint must I undo",
 *  not how many chips are lit. Drives the button pill, StatusBar, Clear-all
 *  visibility, and the empty-state action. Format (extFilter) counts as one
 *  facet: its chips live in the filter popup, so it must be undone there. An
 *  active range counts as ONE facet whether one or both ends are set — it is
 *  one token, one undo. */
export function activeFilterCount(
  kind: AssetKind,
  t: Pick<TabState, "filters" | "extFilter">,
): number {
  let n = t.extFilter.size > 0 ? 1 : 0;
  for (const facet of FILTER_FACETS_BY_KIND[kind]) {
    if (facetActive(t.filters[facet])) n++;
  }
  return n;
}

/** View state owned by one tab. Never shared — switching tabs must not carry
 *  a texture sort field into the audio list. */
export interface TabState {
  query: string;
  /** Empty set = show all extensions. */
  extFilter: Set<string>;
  sortField: SortField;
  sortDir: SortDir;
  /** Index into the *visible* (filtered/sorted) list; -1 = none. */
  selectedIndex: number;
  selectedPath: string | null;
  /**
   * Multi-selection membership, keyed the same way `selectedPath` is (file
   * path, or a material's group key in the grouped texture view). The focused
   * item (`selectedPath`) is the keyboard cursor and normally a member, but
   * Ctrl+click can toggle it out — focus ≠ membership. Session-only, never
   * persisted (tabToSettings picks fields explicitly, so nothing extra needed).
   */
  selectedPaths: Set<string>;
  /** Shift-range pivot: set by plain/Ctrl click, kept across Shift+clicks. */
  selectionAnchor: string | null;
  viewMode: ViewMode;
  /** Grid cell edge in px. */
  cellSize: number;
  /** Textures only: collapse loose files into materials. */
  groupMaterials: boolean;
  /** ANDs with query/ext/scope; values within one facet OR. */
  filters: TabFilters;
}

export interface LibraryState {
  // ---- shared: one library, three lenses ----
  roots: string[];
  /** Every scanned file of every kind. Filtered per tab by `kind`. */
  allFiles: LibFile[];
  /** Generation id of the scan we accept batches from. */
  scanGen: number;
  scanning: boolean;
  /** Total reported by the last completed scan. */
  total: number;
  /** file id → duration seconds. Mutated in place; `durationsVersion` signals changes. */
  durations: Map<number, number>;
  durationsVersion: number;
  /** file id → [sample rate Hz, channels, bits per sample] from the audio
   *  probe (0 = unknown part). Kept beside `durations` — same probe, same
   *  batch — but separate so every duration consumer keeps its plain-seconds
   *  map. Same mutate-in-place + version-counter idiom. */
  audioMeta: Map<number, readonly [rate: number, channels: number, bits: number]>;
  audioMetaVersion: number;
  /** file id → thumbnail cache key + image stats. Same mutate-in-place +
   *  version-counter idiom as `durations`. */
  thumbs: Map<number, { key: string; info: ThumbInfo | null }>;
  thumbsVersion: number;
  /** file id → source [w, h] from the texture dimension probe. Same idiom. */
  dims: Map<number, readonly [w: number, h: number]>;
  dimsVersion: number;
  /**
   * Selected parent folders the file list is scoped to (roots or any
   * subfolders); empty = whole library. A file is in scope if it lives inside
   * ANY selected folder. Persisted so a working set of packs survives a
   * restart. SHARED across tabs on purpose: scoping to one pack and flipping
   * tabs to see its audio/textures/models is the core interaction.
   */
  folderScopes: string[];
  /**
   * Folders whose content is excluded from the list, ext chips, and counts —
   * the eye-toggle in the tree. A file is dropped if it lives inside ANY hidden
   * folder, even when an ancestor is scoped in (hidden always wins). Persisted.
   */
  hiddenFolders: string[];
  /**
   * Active collection scope narrowing the visible list ON TOP of the folder
   * scopes: `"fav"` (favorites), `"recent"`, or `"col:<name>"` (a user
   * collection — see favoritesStore). null = off. Session-only on purpose:
   * a restart lands on the whole library, like selection. Shared across tabs
   * for the same reason folderScopes is — a collection spans kinds.
   */
  collectionScope: string | null;
  activeTab: AssetKind;

  // ---- per-tab ----
  tabs: Record<AssetKind, TabState>;

  setRoots: (roots: string[]) => void;
  beginScan: (gen: number) => void;
  appendFiles: (files: FileEntry[]) => void;
  finishScan: (done: ScanDone) => void;
  mergeAudioMeta: (entries: AudioMetaBatch["entries"]) => void;
  mergeDims: (entries: DimensionBatch["entries"]) => void;
  mergeThumbs: (entries: ThumbBatch["entries"]) => void;
  /** Model thumbnails: rendered in the webview, so they arrive as a bare key
   *  with no image statistics (those are a texture-decode by-product). */
  setModelThumbs: (entries: [id: number, key: string][]) => void;
  setActiveTab: (kind: AssetKind) => void;
  patchTab: (kind: AssetKind, patch: Partial<TabState>) => void;
  setQuery: (kind: AssetKind, query: string) => void;
  toggleExt: (kind: AssetKind, ext: string) => void;
  /** Reset every filter facet of one tab, format included — the toolbar X,
   *  the popup's "Clear all", and the empty-state chip all route here. */
  clearFilters: (kind: AssetKind) => void;
  /** Header-click semantics: same field toggles direction, new field resets to asc. */
  setSort: (kind: AssetKind, field: SortField) => void;
  toggleSortDir: (kind: AssetKind) => void;
  /** Focus the shown set on exactly this folder (click). Clicking the already-
   *  soloed folder clears back to "show everything". Also un-hides it. */
  soloScope: (path: string) => void;
  /** Add/remove a folder from the shown set (ctrl-click). Adding un-hides it. */
  toggleScope: (path: string) => void;
  /** Clear the scope set (→ show the whole library). */
  clearScopes: () => void;
  /** Set (or clear with null) the active collection scope. Toggling off an
   *  active row is the caller's job — it knows which row was clicked. */
  setCollectionScope: (scope: string | null) => void;
  /** Add/remove a folder from the hidden set (shift-click / eye / context). */
  toggleHidden: (path: string) => void;
  /** Un-hide a folder and every hidden folder beneath it (reset a subtree). */
  resetHidden: (path: string) => void;
  select: (kind: AssetKind, index: number, path: string | null) => void;
  /** Ctrl+click: toggle membership; focus and anchor follow the clicked item. */
  toggleSelect: (kind: AssetKind, index: number, path: string) => void;
  /** Shift+click: replace the selection with anchor→item over `order` — the
   *  current visible key order, which only the pane knows, so it passes it in. */
  rangeSelect: (kind: AssetKind, index: number, path: string, order: readonly string[]) => void;
  /** Ctrl+A: select every visible item; focus and anchor stay put. */
  selectAll: (kind: AssetKind, order: readonly string[]) => void;
  /** Escape: collapse the multi-selection back to just the focused item. */
  collapseSelection: (kind: AssetKind) => void;
}

function defaultTab(kind: AssetKind): TabState {
  return {
    query: "",
    extFilter: new Set<string>(),
    sortField: "name",
    sortDir: "asc",
    selectedIndex: -1,
    selectedPath: null,
    // Fresh Set per tab — a shared mutable default would alias across tabs.
    selectedPaths: new Set<string>(),
    selectionAnchor: null,
    // Audio's list is the workflow that already works; visual assets are
    // scanned by eye, so they default to the grid.
    viewMode: kind === "audio" ? "list" : "grid",
    cellSize: 132,
    groupMaterials: true,
    // Fresh Sets per tab — a shared mutable default would alias across tabs.
    filters: defaultFilters(),
  };
}

export function defaultTabs(): Record<AssetKind, TabState> {
  return {
    audio: defaultTab("audio"),
    texture: defaultTab("texture"),
    model: defaultTab("model"),
  };
}

/**
 * Prefix matcher for "is `path` strictly inside directory `folder`". Paths are
 * compared exactly as the scanner emitted them (single scanner → consistent
 * casing/separators), so a plain prefix + separator check is sufficient.
 * Trailing separators on `folder` (e.g. a drive root "C:\") are trimmed so the
 * separator test lands on the right character.
 */
export function folderMatcher(folder: string): (path: string) => boolean {
  const dir = folder.replace(/[\\/]+$/, "");
  const len = dir.length;
  return (path) => {
    if (!path.startsWith(dir)) return false;
    const c = path.charCodeAt(len);
    return c === 92 /* \ */ || c === 47 /* / */;
  };
}

/**
 * Build the combined scope filter: keep a path only if it is inside one of the
 * selected `scopes` (empty = no scope restriction, keep everything) AND inside
 * none of the `hidden` folders (hidden always wins). Shared by every consumer
 * — the file list, ext chips, and all the counts — so they can never disagree
 * about what "in scope" means.
 */
export function scopePredicate(
  scopes: readonly string[],
  hidden: readonly string[],
): (path: string) => boolean {
  const scopeMatchers = scopes.map(folderMatcher);
  const hiddenMatchers = hidden.map(folderMatcher);
  return (path) => {
    if (scopeMatchers.length > 0 && !scopeMatchers.some((m) => m(path))) return false;
    for (const m of hiddenMatchers) if (m(path)) return false;
    return true;
  };
}

/**
 * A scoped/hidden folder survives a scan only if it still exists in the derived
 * tree: it is one of the roots (roots always render, even when empty), or at
 * least one scanned file lives inside it. Drops the rest so a folder deleted on
 * disk (or under a removed root) doesn't linger in the persisted set.
 */
function pruneFolders(
  folders: readonly string[],
  s: Pick<LibraryState, "roots" | "allFiles">,
): string[] {
  return folders.filter((folder) => {
    if (s.roots.includes(folder)) return true;
    const inside = folderMatcher(folder);
    return s.allFiles.some((f) => inside(f.path));
  });
}

export const useLibraryStore = create<LibraryState>()((set) => ({
  roots: [],
  allFiles: [],
  scanGen: 0,
  scanning: false,
  total: 0,
  durations: new Map<number, number>(),
  durationsVersion: 0,
  audioMeta: new Map<number, readonly [number, number, number]>(),
  audioMetaVersion: 0,
  thumbs: new Map<number, { key: string; info: ThumbInfo | null }>(),
  thumbsVersion: 0,
  dims: new Map<number, readonly [number, number]>(),
  dimsVersion: 0,
  folderScopes: [],
  hiddenFolders: [],
  collectionScope: null,
  activeTab: "audio",
  tabs: defaultTabs(),

  setRoots: (roots) => set({ roots }),

  beginScan: (gen) =>
    set((s) => ({
      scanGen: gen,
      scanning: true,
      allFiles: [],
      total: 0,
      durations: new Map<number, number>(),
      durationsVersion: s.durationsVersion + 1,
      audioMeta: new Map<number, readonly [number, number, number]>(),
      audioMetaVersion: s.audioMetaVersion + 1,
      // File ids are per-scan, so a stale id would index the wrong texture.
      thumbs: new Map<number, { key: string; info: ThumbInfo | null }>(),
      thumbsVersion: s.thumbsVersion + 1,
      dims: new Map<number, readonly [number, number]>(),
      dimsVersion: s.dimsVersion + 1,
    })),

  appendFiles: (files) =>
    set((s) => ({
      allFiles: s.allFiles.concat(
        files.map((f) => ({ ...f, nameLower: f.name.toLowerCase() })),
      ),
    })),

  // A rescan may have removed a scoped/hidden folder from disk (or the roots
  // may have changed) — once the full file set is in, drop any that no longer
  // exist in the tree.
  finishScan: (done) =>
    set((s) => ({
      scanning: false,
      total: done.total,
      // Drop any scoped/hidden folder that no longer exists in the tree.
      folderScopes: pruneFolders(s.folderScopes, s),
      hiddenFolders: pruneFolders(s.hiddenFolders, s),
    })),

  mergeAudioMeta: (entries) =>
    set((s) => {
      for (const [id, seconds, rate, channels, bits] of entries) {
        // 0 = unmeasured. Keep `durations` holding only real values, so the
        // duration sort/filter's unknown-handling (absent = keep / sort last)
        // stays exactly as it was.
        if (seconds > 0) s.durations.set(id, seconds);
        if (rate > 0 || channels > 0 || bits > 0) s.audioMeta.set(id, [rate, channels, bits]);
      }
      // Map identity is stable on purpose — the version counters are the signal.
      return {
        durationsVersion: s.durationsVersion + 1,
        audioMetaVersion: s.audioMetaVersion + 1,
      };
    }),

  mergeDims: (entries) =>
    set((s) => {
      for (const [id, w, h] of entries) {
        s.dims.set(id, [w, h]);
      }
      return { dimsVersion: s.dimsVersion + 1 };
    }),

  mergeThumbs: (entries) =>
    set((s) => {
      let dimsAdded = false;
      for (const [id, info, key] of entries) {
        s.thumbs.set(id, { key, info });
        // Backfill dims for formats the header probe can't parse — the thumb
        // decode had to learn the real size anyway. The probe stays primary;
        // never overwrite it.
        if (info !== null && info.sourceWidth > 0 && !s.dims.has(id)) {
          s.dims.set(id, [info.sourceWidth, info.sourceHeight]);
          dimsAdded = true;
        }
      }
      return {
        thumbsVersion: s.thumbsVersion + 1,
        ...(dimsAdded ? { dimsVersion: s.dimsVersion + 1 } : {}),
      };
    }),

  setModelThumbs: (entries) =>
    set((s) => {
      for (const [id, key] of entries) {
        s.thumbs.set(id, { key, info: null });
      }
      return { thumbsVersion: s.thumbsVersion + 1 };
    }),

  setActiveTab: (kind) => set({ activeTab: kind }),

  // Every per-tab mutation funnels through here, so `tabs` gets a fresh
  // identity exactly when something persisted changed — which is what the
  // settings subscription in settings.ts watches.
  patchTab: (kind, patch) =>
    set((s) => ({ tabs: { ...s.tabs, [kind]: { ...s.tabs[kind], ...patch } } })),

  setQuery: (kind, query) =>
    set((s) => ({ tabs: { ...s.tabs, [kind]: { ...s.tabs[kind], query } } })),

  toggleExt: (kind, ext) =>
    set((s) => {
      const next = new Set(s.tabs[kind].extFilter);
      if (next.has(ext)) {
        next.delete(ext);
      } else {
        next.add(ext);
      }
      return { tabs: { ...s.tabs, [kind]: { ...s.tabs[kind], extFilter: next } } };
    }),

  // Fresh filters object → fresh `tabs` identity → the settings save
  // subscription fires; zero new persistence plumbing. Format is one of the
  // popup's facets, so "clear filters" clears it with the rest.
  clearFilters: (kind) =>
    set((s) => ({
      tabs: {
        ...s.tabs,
        [kind]: { ...s.tabs[kind], filters: defaultFilters(), extFilter: new Set<string>() },
      },
    })),

  setSort: (kind, field) =>
    set((s) => {
      const t = s.tabs[kind];
      const patch: Partial<TabState> =
        field === t.sortField
          ? { sortDir: t.sortDir === "asc" ? "desc" : "asc" }
          : { sortField: field, sortDir: "asc" };
      return { tabs: { ...s.tabs, [kind]: { ...t, ...patch } } };
    }),

  toggleSortDir: (kind) =>
    set((s) => ({
      tabs: {
        ...s.tabs,
        [kind]: { ...s.tabs[kind], sortDir: s.tabs[kind].sortDir === "asc" ? "desc" : "asc" },
      },
    })),

  soloScope: (path) =>
    set((s) => {
      // Click the already-soloed folder to clear back to the whole library.
      if (s.folderScopes.length === 1 && s.folderScopes[0] === path) {
        return { folderScopes: [] };
      }
      // Only-show-this: also drop it from hidden so it actually shows.
      return { folderScopes: [path], hiddenFolders: s.hiddenFolders.filter((p) => p !== path) };
    }),

  toggleScope: (path) =>
    set((s) => {
      if (s.folderScopes.includes(path)) {
        return { folderScopes: s.folderScopes.filter((p) => p !== path) };
      }
      // "Also show this" — adding to the shown set un-hides it too.
      return {
        folderScopes: [...s.folderScopes, path],
        hiddenFolders: s.hiddenFolders.filter((p) => p !== path),
      };
    }),

  clearScopes: () => set((s) => (s.folderScopes.length === 0 ? {} : { folderScopes: [] })),

  setCollectionScope: (scope) => set({ collectionScope: scope }),

  toggleHidden: (path) =>
    set((s) => ({
      hiddenFolders: s.hiddenFolders.includes(path)
        ? s.hiddenFolders.filter((p) => p !== path)
        : [...s.hiddenFolders, path],
    })),

  resetHidden: (path) =>
    set((s) => {
      const under = folderMatcher(path);
      const next = s.hiddenFolders.filter((p) => p !== path && !under(p));
      return next.length === s.hiddenFolders.length ? {} : { hiddenFolders: next };
    }),

  // Plain click / arrow nav: focus + collapse the multi-selection to that one
  // item. Every pre-multi-select caller keeps its exact semantics through this
  // single funnel — nothing else has to know the multi layer exists.
  select: (kind, index, path) =>
    set((s) => ({
      tabs: {
        ...s.tabs,
        [kind]: {
          ...s.tabs[kind],
          selectedIndex: index,
          selectedPath: path,
          selectedPaths: path === null ? new Set<string>() : new Set([path]),
          selectionAnchor: path,
        },
      },
    })),

  toggleSelect: (kind, index, path) =>
    set((s) => {
      const t = s.tabs[kind];
      // Fresh Set identity on every action — consumers (StatusBar's size sum)
      // memoize on it, and zustand's shallow compare needs it anyway.
      const next = new Set(t.selectedPaths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return {
        tabs: {
          ...s.tabs,
          [kind]: {
            ...t,
            selectedIndex: index,
            selectedPath: path,
            selectedPaths: next,
            selectionAnchor: path,
          },
        },
      };
    }),

  rangeSelect: (kind, index, path, order) =>
    set((s) => {
      const t = s.tabs[kind];
      // No anchor yet (fresh pane) → the range degenerates to the clicked item.
      const anchor = t.selectionAnchor ?? t.selectedPath ?? path;
      const b = order.indexOf(path);
      let a = order.indexOf(anchor);
      // Anchor filtered/regrouped away since it was set — degenerate likewise.
      if (a < 0) a = b;
      const next = new Set<string>();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(order[i]!);
      // Anchor deliberately unchanged: another Shift+click extends from the
      // same pivot, per the platform convention.
      return {
        tabs: {
          ...s.tabs,
          [kind]: { ...t, selectedIndex: index, selectedPath: path, selectedPaths: next },
        },
      };
    }),

  selectAll: (kind, order) =>
    set((s) => ({
      tabs: { ...s.tabs, [kind]: { ...s.tabs[kind], selectedPaths: new Set(order) } },
    })),

  collapseSelection: (kind) =>
    set((s) => {
      const t = s.tabs[kind];
      return {
        tabs: {
          ...s.tabs,
          [kind]: {
            ...t,
            selectedPaths:
              t.selectedPath === null ? new Set<string>() : new Set([t.selectedPath]),
            selectionAnchor: t.selectedPath,
          },
        },
      };
    }),
}));

/** `id → ThumbInfo` view of the thumbs map, for the material classifier.
 *  Call inside a memo keyed on `thumbsVersion` — the copy is O(n) but so is
 *  the grouping pass it feeds. */
export function thumbInfos(): Map<number, ThumbInfo> {
  const out = new Map<number, ThumbInfo>();
  for (const [id, t] of useLibraryStore.getState().thumbs) {
    if (t.info !== null) out.set(id, t.info);
  }
  return out;
}

/** Files of one kind. The single O(n) pass callers already do is cheap enough
 *  that pre-partitioning by kind would be speculative — `useVisibleFiles`
 *  folds this into its existing filter loop. */
export function countByKind(files: readonly LibFile[]): Record<AssetKind, number> {
  const counts: Record<AssetKind, number> = { audio: 0, texture: 0, model: 0 };
  for (const f of files) counts[f.kind]++;
  return counts;
}

export { ASSET_KINDS };

/** Last path segment of a file or folder path (Windows or POSIX separators). */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segment = trimmed.split(/[\\/]/).pop();
  return segment !== undefined && segment !== "" ? segment : path;
}

/**
 * Start (or restart) a scan over `roots` (defaults to the current roots).
 * Always invokes `start_scan` — even with zero roots — because only the
 * backend generation bump makes an in-flight walker/duration worker go
 * quiet; an empty scan comes straight back as `scan:done { total: 0 }`.
 *
 * Events for the new generation can beat this invoke's resolution, in which
 * case the listeners in ipc/events.ts have already adopted the gen (and may
 * have appended batches) — install it here only if it is still ahead.
 */
export async function rescanRoots(roots?: string[]): Promise<void> {
  const list = roots ?? useLibraryStore.getState().roots;
  useLibraryStore.setState({ scanning: true });
  try {
    const gen = await startScan(list);
    const lib = useLibraryStore.getState();
    if (gen > lib.scanGen) lib.beginScan(gen);
  } catch (err) {
    console.error("start_scan failed", err);
    useLibraryStore.setState({ scanning: false });
  }
}

/** Open the native folder picker, merge the selection into roots, and rescan. */
export async function addFolders(): Promise<void> {
  const picked = await open({ directory: true, multiple: true });
  if (picked === null) return;
  const pickedList = Array.isArray(picked) ? picked : [picked];
  const state = useLibraryStore.getState();
  const merged = [...state.roots];
  for (const p of pickedList) {
    if (!merged.includes(p)) merged.push(p);
  }
  if (merged.length === state.roots.length) return;
  state.setRoots(merged);
  await rescanRoots(merged);
}

/** Remove one root folder and rescan what remains. */
export function removeRoot(path: string): void {
  const state = useLibraryStore.getState();
  const next = state.roots.filter((r) => r !== path);
  if (next.length === state.roots.length) return;
  // Scoped/hidden folders at or under the removed root go with it — drop them
  // now rather than showing a stale list until finishScan's guard runs. Keep a
  // folder only if a *remaining* root still covers it (nested roots).
  const underRemoved = folderMatcher(path);
  const orphaned = (folder: string): boolean =>
    (folder === path || underRemoved(folder)) &&
    !next.some((r) => folder === r || folderMatcher(r)(folder));
  const folderScopes = state.folderScopes.filter((f) => !orphaned(f));
  const hiddenFolders = state.hiddenFolders.filter((f) => !orphaned(f));
  if (
    folderScopes.length !== state.folderScopes.length ||
    hiddenFolders.length !== state.hiddenFolders.length
  ) {
    useLibraryStore.setState({ folderScopes, hiddenFolders });
  }
  state.setRoots(next);
  void rescanRoots(next);
}
