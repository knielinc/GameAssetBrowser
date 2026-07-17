import { create } from "zustand";
import { open } from "@tauri-apps/plugin-dialog";
import { startScan } from "../ipc/commands";
import { ASSET_KINDS } from "../types";
import type {
  AssetKind,
  DurationBatch,
  FileEntry,
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
  viewMode: ViewMode;
  /** Grid cell edge in px. */
  cellSize: number;
  /** Textures only: collapse loose files into materials. */
  groupMaterials: boolean;
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
  /** file id → thumbnail cache key + image stats. Same mutate-in-place +
   *  version-counter idiom as `durations`. */
  thumbs: Map<number, { key: string; info: ThumbInfo | null }>;
  thumbsVersion: number;
  /**
   * Folder subtree the file list is scoped to (a root or any subfolder);
   * null = whole library. Session-only — deliberately not persisted.
   * SHARED across tabs on purpose: scoping to one pack and flipping tabs to
   * see its audio/textures/models is the core interaction.
   */
  folderScope: string | null;
  activeTab: AssetKind;

  // ---- per-tab ----
  tabs: Record<AssetKind, TabState>;

  setRoots: (roots: string[]) => void;
  beginScan: (gen: number) => void;
  appendFiles: (files: FileEntry[]) => void;
  finishScan: (done: ScanDone) => void;
  mergeDurations: (entries: DurationBatch["entries"]) => void;
  mergeThumbs: (entries: ThumbBatch["entries"]) => void;
  /** Model thumbnails: rendered in the webview, so they arrive as a bare key
   *  with no image statistics (those are a texture-decode by-product). */
  setModelThumbs: (entries: [id: number, key: string][]) => void;
  setActiveTab: (kind: AssetKind) => void;
  patchTab: (kind: AssetKind, patch: Partial<TabState>) => void;
  setQuery: (kind: AssetKind, query: string) => void;
  toggleExt: (kind: AssetKind, ext: string) => void;
  clearExts: (kind: AssetKind) => void;
  /** Header-click semantics: same field toggles direction, new field resets to asc. */
  setSort: (kind: AssetKind, field: SortField) => void;
  toggleSortDir: (kind: AssetKind) => void;
  setFolderScope: (scope: string | null) => void;
  select: (kind: AssetKind, index: number, path: string | null) => void;
}

function defaultTab(kind: AssetKind): TabState {
  return {
    query: "",
    extFilter: new Set<string>(),
    sortField: "name",
    sortDir: "asc",
    selectedIndex: -1,
    selectedPath: null,
    // Audio's list is the workflow that already works; visual assets are
    // scanned by eye, so they default to the grid.
    viewMode: kind === "audio" ? "list" : "grid",
    cellSize: 132,
    groupMaterials: true,
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
 * A folder scope survives a scan only if it still exists in the derived tree:
 * it is one of the roots (roots always render, even when empty), or at least
 * one scanned file lives inside it. Returns the scope to keep, or null.
 */
function validScope(s: Pick<LibraryState, "folderScope" | "roots" | "allFiles">): string | null {
  const scope = s.folderScope;
  if (scope === null) return null;
  if (s.roots.includes(scope)) return scope;
  const inside = folderMatcher(scope);
  for (const f of s.allFiles) {
    if (inside(f.path)) return scope;
  }
  return null;
}

export const useLibraryStore = create<LibraryState>()((set) => ({
  roots: [],
  allFiles: [],
  scanGen: 0,
  scanning: false,
  total: 0,
  durations: new Map<number, number>(),
  durationsVersion: 0,
  thumbs: new Map<number, { key: string; info: ThumbInfo | null }>(),
  thumbsVersion: 0,
  folderScope: null,
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
      // File ids are per-scan, so a stale id would index the wrong texture.
      thumbs: new Map<number, { key: string; info: ThumbInfo | null }>(),
      thumbsVersion: s.thumbsVersion + 1,
    })),

  appendFiles: (files) =>
    set((s) => ({
      allFiles: s.allFiles.concat(
        files.map((f) => ({ ...f, nameLower: f.name.toLowerCase() })),
      ),
    })),

  // A rescan may have removed the scoped folder from disk (or the roots may
  // have changed) — once the full file set is in, drop a scope that no longer
  // exists in the tree.
  finishScan: (done) =>
    set((s) => ({ scanning: false, total: done.total, folderScope: validScope(s) })),

  mergeDurations: (entries) =>
    set((s) => {
      for (const [id, seconds] of entries) {
        s.durations.set(id, seconds);
      }
      // Map identity is stable on purpose — the version counter is the signal.
      return { durationsVersion: s.durationsVersion + 1 };
    }),

  mergeThumbs: (entries) =>
    set((s) => {
      for (const [id, info, key] of entries) {
        s.thumbs.set(id, { key, info });
      }
      return { thumbsVersion: s.thumbsVersion + 1 };
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

  clearExts: (kind) =>
    set((s) => ({
      tabs: { ...s.tabs, [kind]: { ...s.tabs[kind], extFilter: new Set<string>() } },
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

  setFolderScope: (scope) => set({ folderScope: scope }),

  select: (kind, index, path) =>
    set((s) => ({
      tabs: { ...s.tabs, [kind]: { ...s.tabs[kind], selectedIndex: index, selectedPath: path } },
    })),
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
  // A scope at or under the removed root goes with it — clear it now rather
  // than showing a stale empty list until finishScan's guard runs. Keep it
  // only if a *remaining* root still covers it (nested roots).
  const scope = state.folderScope;
  if (
    scope !== null &&
    (scope === path || folderMatcher(path)(scope)) &&
    !next.some((r) => scope === r || folderMatcher(r)(scope))
  ) {
    useLibraryStore.setState({ folderScope: null });
  }
  state.setRoots(next);
  void rescanRoots(next);
}
