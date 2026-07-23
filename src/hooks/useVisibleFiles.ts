import { useEffect, useMemo, useState } from "react";
import { scopePredicate, useLibraryStore, type LibFile } from "../stores/libraryStore";
import { FAVORITES_SCOPE, RECENTS_SCOPE, useFavoritesStore } from "../stores/favoritesStore";
import { channelGroupOf } from "../material/classify";
import { useMaterialMembership } from "./useMaterialMembership";
import {
  CHANNEL_GROUPS,
  EXTENSIONS,
  MIB,
  rangeActive,
  type AssetKind,
  type AudioChannelGroup,
  type ChannelGroup,
  type CollectionSettings,
  type ColorBucket,
  type RangeFilter,
  type RecentSettings,
  type SampleRateBucket,
  type SortField,
} from "../types";

// Stable empties returned by the collection-scope subscriptions when their
// scope is inactive. Constant identity means the selector value never changes
// while the scope is off, so favoriting/recording a play (a fresh Set/array in
// the store) can't re-render — or re-sort — a list that doesn't depend on it.
const EMPTY_FAVORITES: ReadonlySet<string> = new Set();
const EMPTY_RECENTS: readonly RecentSettings[] = [];
const EMPTY_COLLECTIONS: readonly CollectionSettings[] = [];

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function makeComparator(
  field: SortField,
  durations: Map<number, number>,
): (a: LibFile, b: LibFile) => number {
  switch (field) {
    case "name":
      return (a, b) => (a.nameLower < b.nameLower ? -1 : a.nameLower > b.nameLower ? 1 : 0);
    case "size":
      return (a, b) => a.size - b.size;
    case "modified":
      return (a, b) => a.modified - b.modified;
    case "ext":
      return (a, b) =>
        a.ext < b.ext
          ? -1
          : a.ext > b.ext
            ? 1
            : a.nameLower < b.nameLower
              ? -1
              : a.nameLower > b.nameLower
                ? 1
                : 0;
    case "duration":
      // Unknown durations sort as Infinity (always after known ones, asc).
      return (a, b) => {
        const da = durations.get(a.id) ?? Infinity;
        const db = durations.get(b.id) ?? Infinity;
        return da < db ? -1 : da > db ? 1 : 0;
      };
  }
}

/**
 * The filtered + sorted view of ONE tab's slice of the library. Filtering and
 * sorting stay in JS — even at 50k files this is a handful of milliseconds,
 * and it never round-trips the list over IPC.
 *
 * Call this from inside TabPane, which is keyed on the active tab. The remount
 * that gives you is load-bearing: `useDebounced` holds React state, so without
 * it a tab switch would keep showing the previous tab's query for 100 ms.
 */
// Exported for useFacetCounts: counts must use the exact same predicate as the
// filter, so there is exactly one definition.
/** v passes iff within both set ends. min > max simply matches nothing —
 *  never swap or error; the live count is the feedback. */
export const inRange = (v: number, r: RangeFilter): boolean =>
  (r.min === null || v >= r.min) && (r.max === null || v <= r.max);
export const isPot = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

/**
 * Mean sRGB (0–1, from ThumbInfo) → color bucket. Total — every measured
 * texture lands in exactly one bucket. Lightness and saturation outrank hue,
 * then the hue table beside COLOR_BUCKETS in types.ts decides. Exported for
 * useFacetCounts: one definition, counts can never disagree with the filter.
 */
export function colorBucketOf(r: number, g: number, b: number): ColorBucket {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (l < 0.13) return "dark";
  if (l > 0.87) return "light";
  const d = mx - mn;
  // HSL saturation; the l-guard above keeps the denominator well away from 0.
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.12) return "gray";
  let h = mx === r ? (g - b) / d : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  if (h < 15 || h >= 345) return "red";
  if (h < 45) return "orange";
  if (h < 70) return "yellow";
  if (h < 165) return "green";
  if (h < 200) return "cyan";
  if (h < 255) return "blue";
  if (h < 290) return "purple";
  return "pink";
}

/** Channel count (≥1) → layout bucket. Callers gate out 0 (= unmeasured). */
export const audioChannelGroupOf = (channels: number): AudioChannelGroup =>
  channels === 1 ? "mono" : channels === 2 ? "stereo" : "multi";

/** Sample rate in Hz (≥1) → the nearest canonical tier at or above, so odd
 *  rates (24k, 96k) never fall between chips. Callers gate out 0. */
export function sampleRateBucketOf(rate: number): SampleRateBucket {
  if (rate <= 22050) return "le22";
  if (rate <= 32000) return "32k";
  if (rate <= 44100) return "44k";
  if (rate <= 48000) return "48k";
  return "hi";
}

/**
 * The UNION of every active collection scope's members — favorites, recents,
 * and/or user collections — or null when no collection scope is active. Each
 * collection behaves like a folder: its members are the WHOLE-LIBRARY set, and
 * callers UNION this with the folder-scoped files (never intersect), so a
 * Ctrl-combined "Kick folder + Favourites" shows both. Exported so the visible
 * list, the facet counts, and the scope count all agree on membership.
 */
export function collectionMembersUnion(
  collectionScopes: readonly string[],
  favorites: ReadonlySet<string>,
  recents: readonly RecentSettings[],
  collections: readonly CollectionSettings[],
): ReadonlySet<string> | null {
  if (collectionScopes.length === 0) return null;
  const out = new Set<string>();
  for (const key of collectionScopes) {
    if (key === FAVORITES_SCOPE) {
      for (const p of favorites) out.add(p);
    } else if (key === RECENTS_SCOPE) {
      for (const r of recents) out.add(r.path);
    } else {
      const col = collections.find((c) => `col:${c.name}` === key);
      if (col !== undefined) for (const p of col.paths) out.add(p);
    }
  }
  return out;
}

/** Paths of the collections whose NAME is in `names` (the collection FILTER
 *  facet), unioned. Distinct from collectionMembersUnion, which keys by scope
 *  id ("fav"/"recent"/"col:*"); the facet only ever names user collections. */
export function collectionFacetPaths(
  names: ReadonlySet<string>,
  collections: readonly CollectionSettings[],
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const c of collections) {
    if (names.has(c.name)) for (const p of c.paths) out.add(p);
  }
  return out;
}

export function useVisibleFiles(kind: AssetKind): LibFile[] {
  const allFiles = useLibraryStore((s) => s.allFiles);
  const folderScopes = useLibraryStore((s) => s.folderScopes);
  const hiddenFolders = useLibraryStore((s) => s.hiddenFolders);
  const collectionScopes = useLibraryStore((s) => s.collectionScopes);
  const tab = useLibraryStore((s) => s.tabs[kind]);
  const { query, extFilter, sortField, sortDir, filters } = tab;
  // Collection inputs are consumed ONLY when a scope or the collection filter
  // facet needs them, so subscribe to each conditionally: while off, the
  // selector yields the stable empty and this hook ignores the store's per-play
  // churn (recordRecent builds a fresh `recents` array on every audio load)
  // instead of re-sorting 50k files on every keypress. collectionScopes is
  // subscribed above, so toggling a scope re-renders and flips the right
  // subscription live.
  const scopeHasFavorites = collectionScopes.includes(FAVORITES_SCOPE);
  const scopeHasRecents = collectionScopes.includes(RECENTS_SCOPE);
  const scopeHasUserCollection = collectionScopes.some((k) => k.startsWith("col:"));
  // Favorites feed BOTH the Favorites scope and the favorite filter facet, so
  // subscribe whenever either is live (still off for the common case).
  const needFavorites = scopeHasFavorites || filters.favorite;
  // Collections feed BOTH a user-collection scope and the collection filter facet.
  const needCollections = scopeHasUserCollection || filters.collections.size > 0;
  const favorites = useFavoritesStore((s) => (needFavorites ? s.favorites : EMPTY_FAVORITES));
  const recents = useFavoritesStore((s) => (scopeHasRecents ? s.recents : EMPTY_RECENTS));
  const collections = useFavoritesStore((s) => (needCollections ? s.collections : EMPTY_COLLECTIONS));
  // The probe maps are mutated in place (stable ref → no re-render); only their
  // *version* counters trigger a rebuild. Gate each to 0 unless THIS kind can
  // actually use that probe (the same discipline thumbsVersion already applies
  // below), so e.g. the default "all" tab — which reads none of them — doesn't
  // re-filter+re-sort the whole library on every audio/dimension batch during a
  // scan. durations feed only the audio duration facet/sort; dims only texture
  // res/shape; audioMeta only the audio channel/rate facets.
  const durations = useLibraryStore((s) => s.durations);
  const durationsVersion = useLibraryStore((s) => (kind === "audio" ? s.durationsVersion : 0));
  const dims = useLibraryStore((s) => s.dims);
  const dimsVersion = useLibraryStore((s) => (kind === "texture" ? s.dimsVersion : 0));
  const audioMeta = useLibraryStore((s) => s.audioMeta);
  const audioMetaVersion = useLibraryStore((s) => (kind === "audio" ? s.audioMetaVersion : 0));
  const thumbs = useLibraryStore((s) => s.thumbs);
  // Only the color facet reads thumb pixels. `thumbs` itself is mutated in
  // place (stable ref → no re-render), but thumbsVersion ticks on every batch;
  // gate it to 0 unless the color facet is on, so the texture grid's own thumb
  // stream can't feed a rebuild→re-render→re-request churn loop, and the audio
  // and model tabs never rebuild for texture batches they can't use.
  const colorFacetActive = kind === "texture" && filters.colors.size > 0;
  const thumbsVersion = useLibraryStore((s) => (colorFacetActive ? s.thumbsVersion : 0));
  const debouncedQuery = useDebounced(query, 100);
  // The grouping pass runs only while the material facet is actually active —
  // idle browsing pays nothing.
  const membership = useMaterialMembership(kind === "texture" && filters.material);

  return useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    const hasQuery = q !== "";
    // Exclude terms are stored pre-lowercased; substring-match against nameLower.
    const excludeList = [...filters.excludeTerms];
    const hasExclude = excludeList.length > 0;
    const hasExtFilter = extFilter.size > 0;
    // Folder scope (selected minus hidden) narrows the library BEFORE query/ext
    // filters apply.
    const inScope = scopePredicate(folderScopes, hiddenFolders);

    // Collection scopes: favorites, recents, and/or user collections. Each acts
    // like a FOLDER — its members show across the whole library — and the shown
    // set is the UNION of the folder-scoped files and the collection members
    // (the sidebar's Favorites row is "show me all my favourites", not
    // "favourites within this folder"; the favorite/collection FILTER facets
    // cover the within-scope case). Paths that fell out of the library (deleted
    // files) simply never match.
    const collMembers = collectionMembersUnion(collectionScopes, favorites, recents, collections);
    const hasFolderScope = folderScopes.length > 0;
    const hasCollScope = collMembers !== null;
    const anyScope = hasFolderScope || hasCollScope;
    // Recency ordering is that view's whole point, but it only makes sense when
    // Recent is the SOLE scope — combined with a folder or another collection
    // there is nothing to interleave against, so fall back to the toolbar sort.
    const recentRank =
      folderScopes.length === 0 &&
      collectionScopes.length === 1 &&
      collectionScopes[0] === RECENTS_SCOPE
        ? new Map(recents.map((r) => [r.path, r.ts]))
        : null;

    // Collection FILTER facet — narrows the CURRENT view to members of ANY
    // selected collection (OR within the facet), ANDed with the scope below.
    const collFacet =
      filters.collections.size > 0
        ? collectionFacetPaths(filters.collections, collections)
        : null;

    // Facet gates hoisted out of the loop; each per-file check is O(1).
    const flt = filters;
    const hasDur = kind === "audio" && rangeActive(flt.duration);
    const hasChan = kind === "texture" && flt.channels.size > 0;
    const hasMat = kind === "texture" && flt.material && membership !== null;
    const hasRes = kind === "texture" && rangeActive(flt.res);
    const needShape = kind === "texture" && (flt.square || flt.pot);
    const hasColor = kind === "texture" && flt.colors.size > 0;
    const hasAChan = kind === "audio" && flt.audioChannels.size > 0;
    const hasRate = kind === "audio" && flt.sampleRates.size > 0;
    const hasFav = flt.favorite; // all kinds — membership is always "known"
    const hasSize = (kind === "model" || kind === "document") && rangeActive(flt.size);
    // Size is stored in MB; compare in bytes, converted once outside the loop.
    const sizeBytes: RangeFilter = {
      min: flt.size.min === null ? null : flt.size.min * MIB,
      max: flt.size.max === null ? null : flt.size.max * MIB,
    };
    const hasMod = rangeActive(flt.modified);

    // Always a filtering pass now — every tab shows a subset by kind — so the
    // old "copy the whole array" fast path can't apply. The "all" tab is the one
    // exception to the per-kind narrowing: it shows every real kind at once.
    const allKind = kind === "all";
    const files: LibFile[] = [];
    for (const f of allFiles) {
      if (!allKind && f.kind !== kind) continue;
      // Scope = union of the selected folders and collections. With nothing
      // selected, only the hidden filter applies (empty folderScopes).
      if (anyScope) {
        const inFolders = hasFolderScope && inScope(f.path);
        const inColls = hasCollScope && collMembers.has(f.path);
        if (!inFolders && !inColls) continue;
      } else if (!inScope(f.path)) continue;
      if (collFacet !== null && !collFacet.has(f.path)) continue;
      if (hasFav && !favorites.has(f.path)) continue;
      if (hasExtFilter && !extFilter.has(f.ext)) continue;
      // Facets before the query: Map lookups beat the substring scan.
      if (hasMod && !inRange(f.modified, flt.modified)) continue; // always known
      if (hasSize && !inRange(f.size, sizeBytes)) continue; // size always known
      if (hasChan && !flt.channels.has(channelGroupOf(f))) continue;
      if (hasMat) {
        const m = membership!.get(f.id);
        // Unknown = keep (the map covers every scoped texture, but stay total).
        if (m === "standalone") continue;
      }
      if (hasDur) {
        const d = durations.get(f.id);
        // Unknown = keep: a filter may only remove files it has positively
        // measured. The list narrows as probe batches land (durationsVersion is
        // already a memo dep) — never a flash-of-empty on a cold library.
        if (d !== undefined && !inRange(d, flt.duration)) continue;
      }
      if (hasRes || needShape) {
        const dm = dims.get(f.id);
        if (dm !== undefined) { // unknown = keep, same rule
          if (hasRes && !inRange(Math.max(dm[0], dm[1]), flt.res)) continue;
          if (flt.square && dm[0] !== dm[1]) continue;
          if (flt.pot && !(isPot(dm[0]) && isPot(dm[1]))) continue;
        }
      }
      if (hasColor) {
        // Color is measured by the thumbnail decode — unknown = keep until the
        // thumb batch lands, the same lazy-probe rule as duration/dims.
        const info = thumbs.get(f.id)?.info;
        if (info != null && !flt.colors.has(colorBucketOf(info.meanR, info.meanG, info.meanB))) {
          continue;
        }
      }
      if (hasAChan || hasRate) {
        // Per-FIELD unknowns: the probe emits 0 for a field it couldn't read,
        // so channels can be known while the rate isn't (and vice versa).
        const am = audioMeta.get(f.id);
        if (am !== undefined) { // unknown = keep, same rule
          if (hasAChan && am[1] > 0 && !flt.audioChannels.has(audioChannelGroupOf(am[1]))) {
            continue;
          }
          if (hasRate && am[0] > 0 && !flt.sampleRates.has(sampleRateBucketOf(am[0]))) {
            continue;
          }
        }
      }
      if (hasQuery && !f.nameLower.includes(q)) continue;
      if (hasExclude && excludeList.some((ex) => f.nameLower.includes(ex))) continue;
      files.push(f);
    }

    if (recentRank !== null && files.length > 1) {
      // The Recent scope overrides the toolbar sort: most-recently-used first
      // — recency IS that view's point, and the ts ranking exists nowhere in
      // SortField's vocabulary. Ties (never recorded) sink to the bottom.
      const rank = recentRank;
      files.sort((a, b) => (rank.get(b.path) ?? 0) - (rank.get(a.path) ?? 0));
    } else if (files.length > 1) {
      const cmp = makeComparator(sortField, durations);
      const dir = sortDir === "asc" ? 1 : -1;
      files.sort((a, b) => dir * cmp(a, b));
    }
    return files;
  }, [kind, allFiles, folderScopes, hiddenFolders, collectionScopes, favorites, collections, recents, debouncedQuery, extFilter, sortField, sortDir, filters, durations, durationsVersion, dims, dimsVersion, audioMeta, audioMetaVersion, thumbs, thumbsVersion, membership]);
}

/**
 * Extensions of `kind` that actually exist in the current folder scope, with
 * counts, in the canonical order from EXTENSIONS.
 *
 * The toolbar used to render every extension the app knows about — 10 chips
 * for textures — which overflowed into a horizontal scroll and offered
 * filters that could only ever produce zero results. Deriving from the data
 * makes the row short, stable, and every chip meaningful. Canonical order
 * (not count order) so chips never reshuffle under the cursor as a scan
 * streams in.
 */
export function usePresentExts(kind: AssetKind): { ext: string; count: number }[] {
  const allFiles = useLibraryStore((s) => s.allFiles);
  const folderScopes = useLibraryStore((s) => s.folderScopes);
  const hiddenFolders = useLibraryStore((s) => s.hiddenFolders);
  return useMemo(() => {
    const inScope = scopePredicate(folderScopes, hiddenFolders);
    const allKind = kind === "all";
    const counts = new Map<string, number>();
    for (const f of allFiles) {
      if (!allKind && f.kind !== kind) continue;
      if (!inScope(f.path)) continue;
      counts.set(f.ext, (counts.get(f.ext) ?? 0) + 1);
    }
    return EXTENSIONS[kind]
      .filter((e) => counts.has(e))
      .map((e) => ({ ext: e, count: counts.get(e)! }));
  }, [kind, allFiles, folderScopes, hiddenFolders]);
}

/**
 * Channel groups that actually exist in the current folder scope, with counts,
 * in CHANNEL_GROUPS canonical order — the usePresentExts discipline applied to
 * the Channel facet: chips only for groups with members, stable order so they
 * never reshuffle under the cursor.
 */
export function usePresentChannels(kind: AssetKind): { group: ChannelGroup; count: number }[] {
  const allFiles = useLibraryStore((s) => s.allFiles);
  const folderScopes = useLibraryStore((s) => s.folderScopes);
  const hiddenFolders = useLibraryStore((s) => s.hiddenFolders);
  return useMemo(() => {
    if (kind !== "texture") return [];
    const inScope = scopePredicate(folderScopes, hiddenFolders);
    const counts = new Map<ChannelGroup, number>();
    for (const f of allFiles) {
      if (f.kind !== kind) continue;
      if (!inScope(f.path)) continue;
      const g = channelGroupOf(f);
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return CHANNEL_GROUPS.filter((g) => counts.has(g)).map((g) => ({
      group: g,
      count: counts.get(g)!,
    }));
  }, [kind, allFiles, folderScopes, hiddenFolders]);
}

/**
 * Gated subscription to the active collection scope's member set (or null when
 * off). Off-scope each selector yields a stable empty, so favoriting a file or
 * recording a play can't re-render idle consumers (the status bar sits mounted
 * for the whole session). Shared by useScopeCount and useFacetCounts so their
 * denominators match useVisibleFiles' collection-as-folder behavior.
 */
export function useCollectionMembers(): ReadonlySet<string> | null {
  const collectionScopes = useLibraryStore((s) => s.collectionScopes);
  const hasFavorites = collectionScopes.includes(FAVORITES_SCOPE);
  const hasRecents = collectionScopes.includes(RECENTS_SCOPE);
  const hasUser = collectionScopes.some((k) => k.startsWith("col:"));
  const favorites = useFavoritesStore((s) => (hasFavorites ? s.favorites : EMPTY_FAVORITES));
  const recents = useFavoritesStore((s) => (hasRecents ? s.recents : EMPTY_RECENTS));
  const collections = useFavoritesStore((s) => (hasUser ? s.collections : EMPTY_COLLECTIONS));
  return useMemo(
    () => collectionMembersUnion(collectionScopes, favorites, recents, collections),
    [collectionScopes, favorites, recents, collections],
  );
}

/** Count of one kind inside the active scope — the status bar's denominator.
 *  Union of the selected folders and collections (collection-as-folder),
 *  matching the visible list; minus the query/ext/facet filters. */
export function useScopeCount(kind: AssetKind): number {
  const allFiles = useLibraryStore((s) => s.allFiles);
  const folderScopes = useLibraryStore((s) => s.folderScopes);
  const hiddenFolders = useLibraryStore((s) => s.hiddenFolders);
  const collMembers = useCollectionMembers();
  return useMemo(() => {
    const inScope = scopePredicate(folderScopes, hiddenFolders);
    const allKind = kind === "all";
    const hasFolderScope = folderScopes.length > 0;
    const hasCollScope = collMembers !== null;
    const anyScope = hasFolderScope || hasCollScope;
    let n = 0;
    for (const f of allFiles) {
      if (!allKind && f.kind !== kind) continue;
      if (anyScope) {
        const inFolders = hasFolderScope && inScope(f.path);
        const inColls = hasCollScope && collMembers.has(f.path);
        if (!inFolders && !inColls) continue;
      } else if (!inScope(f.path)) continue;
      n++;
    }
    return n;
  }, [kind, allFiles, folderScopes, hiddenFolders, collMembers]);
}
