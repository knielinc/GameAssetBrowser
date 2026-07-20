import { create } from "zustand";
import type { CollectionSettings, RecentSettings } from "../types";
import { useLibraryStore } from "./libraryStore";

/** Hard cap on the recents list — beyond this "recent" stops meaning anything,
 *  and the list persists into settings.json on every save. */
export const RECENTS_CAP = 200;
/** Re-recording the same path inside this window is a no-op, so arrow-key
 *  scrubbing through the audio list doesn't churn the order (or the save). */
const RECENT_THROTTLE_SECONDS = 60;

/** Collection-scope keys as libraryStore.collectionScopes stores them: the two
 *  pinned rows get fixed ids, user collections are keyed by name. */
export const FAVORITES_SCOPE = "fav";
export const RECENTS_SCOPE = "recent";
export const collectionScopeKey = (name: string): string => `col:${name}`;
/** True for a user-collection scope key (not the pinned Favorites/Recent rows). */
export const isUserCollectionKey = (key: string): boolean => key.startsWith("col:");

/** The single user collection currently scoped, or null when the scope isn't
 *  exactly one user collection. "Remove from collection" only has an
 *  unambiguous target in that case (Favorites/Recent aren't collections, and a
 *  multi-scope union names no single collection to remove from). */
export function soleUserCollectionName(scopes: readonly string[]): string | null {
  if (scopes.length !== 1) return null;
  const key = scopes[0]!;
  return isUserCollectionKey(key) ? key.slice(4) : null;
}

export interface FavoritesState {
  /** Starred file paths. Membership is O(1) for the 50k filter loop. */
  favorites: Set<string>;
  collections: CollectionSettings[];
  /** Most-recent-first, deduped by path, capped at RECENTS_CAP. */
  recents: RecentSettings[];

  /** Replace everything from persisted settings (startup / import). */
  hydrate: (
    favorites: string[],
    collections: CollectionSettings[],
    recents: RecentSettings[],
  ) => void;
  toggleFavorite: (path: string) => void;
  /** Set several paths to one state at once — the multi-select star action.
   *  One state update, so a mixed selection settles instead of flipping. */
  setFavorites: (paths: readonly string[], on: boolean) => void;
  /** Create an empty collection; a duplicate name is a silent no-op. */
  addCollection: (name: string) => void;
  /** Rename; no-op if `name` is missing or `nextName` is taken/empty. */
  renameCollection: (name: string, nextName: string) => void;
  deleteCollection: (name: string) => void;
  addToCollection: (name: string, paths: readonly string[]) => void;
  removeFromCollection: (name: string, paths: readonly string[]) => void;
  /** Note a play/preview. Throttled per path (see RECENT_THROTTLE_SECONDS). */
  recordRecent: (path: string) => void;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

// Every mutation builds fresh identities (Set/array) — the settings save
// subscription and React consumers both compare by identity, the same contract
// libraryStore's selection actions follow.
export const useFavoritesStore = create<FavoritesState>()((set) => ({
  favorites: new Set<string>(),
  collections: [],
  recents: [],

  hydrate: (favorites, collections, recents) =>
    set({
      favorites: new Set(favorites),
      collections: collections.map((c) => ({ name: c.name, paths: [...new Set(c.paths)] })),
      recents: recents.slice(0, RECENTS_CAP),
    }),

  toggleFavorite: (path) =>
    set((s) => {
      const next = new Set(s.favorites);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { favorites: next };
    }),

  setFavorites: (paths, on) =>
    set((s) => {
      const next = new Set(s.favorites);
      for (const p of paths) {
        if (on) {
          next.add(p);
        } else {
          next.delete(p);
        }
      }
      // One direction per call, so an unchanged size means an unchanged set —
      // skip the identity churn (and the settings save it would schedule).
      return next.size === s.favorites.size ? {} : { favorites: next };
    }),

  addCollection: (name) =>
    set((s) => {
      const trimmed = name.trim();
      if (trimmed === "" || s.collections.some((c) => c.name === trimmed)) return {};
      return { collections: [...s.collections, { name: trimmed, paths: [] }] };
    }),

  renameCollection: (name, nextName) => {
    const trimmed = nextName.trim();
    const s = useFavoritesStore.getState();
    if (trimmed === "" || trimmed === name) return;
    if (s.collections.some((c) => c.name === trimmed)) return;
    if (!s.collections.some((c) => c.name === name)) return;
    set({
      collections: s.collections.map((c) => (c.name === name ? { ...c, name: trimmed } : c)),
    });
    // Follow the rename in any live scope key and the collection filter facets.
    useLibraryStore.getState().onCollectionRenamed(name, trimmed);
  },

  deleteCollection: (name) => {
    set((s) => ({ collections: s.collections.filter((c) => c.name !== name) }));
    // Drop the now-dangling scope key and any filter-facet reference to it.
    useLibraryStore.getState().onCollectionRenamed(name, null);
  },

  addToCollection: (name, paths) =>
    set((s) => ({
      collections: s.collections.map((c) => {
        if (c.name !== name) return c;
        // Preserve insertion order, drop duplicates — a collection is a set
        // the user built by hand, so their ordering is the ordering.
        const merged = [...c.paths];
        for (const p of paths) {
          if (!merged.includes(p)) merged.push(p);
        }
        return merged.length === c.paths.length ? c : { ...c, paths: merged };
      }),
    })),

  removeFromCollection: (name, paths) =>
    set((s) => ({
      collections: s.collections.map((c) => {
        if (c.name !== name) return c;
        const drop = new Set(paths);
        const kept = c.paths.filter((p) => !drop.has(p));
        return kept.length === c.paths.length ? c : { ...c, paths: kept };
      }),
    })),

  recordRecent: (path) =>
    set((s) => {
      const ts = nowSeconds();
      const existing = s.recents.find((r) => r.path === path);
      if (existing !== undefined && ts - existing.ts < RECENT_THROTTLE_SECONDS) return {};
      return {
        recents: [
          { path, ts },
          ...s.recents.filter((r) => r.path !== path),
        ].slice(0, RECENTS_CAP),
      };
    }),
}));

/**
 * Star-action semantics shared by the cell/row star buttons and the F key:
 * when the pressed item is part of a real multi-selection, the toggle applies
 * to EVERY selected file; otherwise just to `path`. Selection keys can be
 * material group keys in the grouped texture view — those name nothing on
 * disk, so targets are resolved against real scanned paths only (favoriting a
 * group key would persist garbage). Direction comes from the pressed item so
 * a mixed selection settles to one state instead of flipping per file.
 */
export function toggleFavoriteSmart(path: string): void {
  const lib = useLibraryStore.getState();
  const tab = lib.tabs[lib.activeTab];
  const fav = useFavoritesStore.getState();
  const multi = tab.selectedPaths.size > 1 && tab.selectedPaths.has(path);
  const targets: string[] = [];
  if (multi) {
    for (const f of lib.allFiles) {
      if (tab.selectedPaths.has(f.path)) targets.push(f.path);
    }
  } else if (lib.allFiles.some((f) => f.path === path)) {
    targets.push(path);
  }
  if (targets.length === 0) return;
  const on = targets.includes(path)
    ? !fav.favorites.has(path)
    : targets.some((p) => !fav.favorites.has(p));
  fav.setFavorites(targets, on);
}
