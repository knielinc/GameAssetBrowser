import { create } from "zustand";
import { open } from "@tauri-apps/plugin-dialog";
import { startScan } from "../ipc/commands";
import type {
  AudioExt,
  DurationBatch,
  FileEntry,
  ScanDone,
  SortDir,
  SortField,
} from "../types";

/** A scanned file plus the precomputed lowercase name used for filtering. */
export interface LibFile extends FileEntry {
  nameLower: string;
}

export interface LibraryState {
  roots: string[];
  allFiles: LibFile[];
  /** Generation id of the scan we accept batches from. */
  scanGen: number;
  scanning: boolean;
  /** Total reported by the last completed scan. */
  total: number;
  /** file id → duration seconds. Mutated in place; `durationsVersion` signals changes. */
  durations: Map<number, number>;
  durationsVersion: number;
  query: string;
  /** Empty set = show all extensions. */
  extFilter: Set<AudioExt>;
  sortField: SortField;
  sortDir: SortDir;
  /**
   * Folder subtree the file list is scoped to (a root or any subfolder);
   * null = whole library. Session-only — deliberately not persisted.
   */
  folderScope: string | null;
  /** Index into the *visible* (filtered/sorted) list; -1 = none. */
  selectedIndex: number;
  selectedPath: string | null;

  setRoots: (roots: string[]) => void;
  beginScan: (gen: number) => void;
  appendFiles: (files: FileEntry[]) => void;
  finishScan: (done: ScanDone) => void;
  mergeDurations: (entries: DurationBatch["entries"]) => void;
  setQuery: (query: string) => void;
  toggleExt: (ext: AudioExt) => void;
  /** Header-click semantics: same field toggles direction, new field resets to asc. */
  setSort: (field: SortField) => void;
  toggleSortDir: () => void;
  setFolderScope: (scope: string | null) => void;
  select: (index: number, path: string | null) => void;
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
  query: "",
  extFilter: new Set<AudioExt>(),
  sortField: "name",
  sortDir: "asc",
  folderScope: null,
  selectedIndex: -1,
  selectedPath: null,

  setRoots: (roots) => set({ roots }),

  beginScan: (gen) =>
    set((s) => ({
      scanGen: gen,
      scanning: true,
      allFiles: [],
      total: 0,
      durations: new Map<number, number>(),
      durationsVersion: s.durationsVersion + 1,
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

  setQuery: (query) => set({ query }),

  toggleExt: (ext) =>
    set((s) => {
      const next = new Set(s.extFilter);
      if (next.has(ext)) {
        next.delete(ext);
      } else {
        next.add(ext);
      }
      return { extFilter: next };
    }),

  setSort: (field) =>
    set((s) =>
      field === s.sortField
        ? { sortDir: s.sortDir === "asc" ? "desc" : "asc" }
        : { sortField: field, sortDir: "asc" },
    ),

  toggleSortDir: () =>
    set((s) => ({ sortDir: s.sortDir === "asc" ? "desc" : "asc" })),

  setFolderScope: (scope) => set({ folderScope: scope }),

  select: (index, path) => set({ selectedIndex: index, selectedPath: path }),
}));

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
