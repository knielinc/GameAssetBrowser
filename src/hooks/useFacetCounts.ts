import { useEffect, useMemo, useState } from "react";
import { scopePredicate, useLibraryStore } from "../stores/libraryStore";
import { useFavoritesStore } from "../stores/favoritesStore";
import { channelGroupOf } from "../material/classify";
import {
  audioChannelGroupOf,
  colorBucketOf,
  inRange,
  isPot,
  sampleRateBucketOf,
  useCollectionMembers,
} from "./useVisibleFiles";
import { type MaterialMembership } from "./useMaterialMembership";
import {
  AUDIO_CHANNEL_GROUPS,
  CHANNEL_GROUPS,
  COLOR_BUCKETS,
  EXTENSIONS,
  MIB,
  SAMPLE_RATE_BUCKETS,
  rangeActive,
  type AssetKind,
  type AudioChannelGroup,
  type ChannelGroup,
  type ColorBucket,
  type RangeFilter,
  type SampleRateBucket,
} from "../types";

// Private twin of useVisibleFiles' debounce (not exported there on purpose).
// Two instances reading the same query may skew by one tick — acceptable: both
// settle on the same value 100 ms after the last keystroke.
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** One option row: identity + self-excluded faceted count + selection. */
export interface FacetOption<V> {
  value: V;
  /** Scope + query + every OTHER active constraint; measured-only numerator
   *  (unknowns count in no bucket). */
  count: number;
  selected: boolean;
}

/** One Shape boolean row. Counts self-exclude per-ROW: Square's count still
 *  applies an active PoT constraint, and vice versa. */
export interface ShapeRow {
  count: number;
  selected: boolean;
}

export const HISTOGRAM_BINS = 16;

/** Non-interactive distribution strip for one range facet. */
export interface RangeHistogram {
  /** HISTOGRAM_BINS counts of measured, self-excluded values (scope + query +
   *  every OTHER facet applied — the option-count rule). */
  bins: number[];
  /** HISTOGRAM_BINS + 1 edges in the facet's UI unit (s / px / MB / unix s);
   *  edges[0]/edges[last] = the SCOPE-wide measured min/max, deliberately NOT
   *  the filtered subset's — the axis must never rescale under the user.
   *  Empty ⇔ nothing measured in scope at all. */
  edges: number[];
  /** Measured values under the current other-facet constraints — the bars'
   *  total, which can be 0 while the axis still exists. */
  measured: number;
}

export interface FacetCounts {
  /** Rows = scope-present exts ∪ selected exts, EXTENSIONS[kind] order.
   *  Row existence is scope-only (stable under other facets/query);
   *  counts are faceted and may be 0. */
  format: FacetOption<string>[];
  duration: RangeHistogram | null;             // audio only; null otherwise
  /** texture: scope-present groups ∪ selected, CHANNEL_GROUPS order; else []. */
  channels: FacetOption<ChannelGroup>[];
  /** texture: measured-present buckets ∪ selected, COLOR_BUCKETS order; else [].
   *  Presence needs a landed thumb (color is thumb-derived), so swatches grow
   *  in as decode batches arrive — same canonical order, never a reshuffle. */
  colors: FacetOption<ColorBucket>[];
  /** audio: measured-present groups ∪ selected, AUDIO_CHANNEL_GROUPS order;
   *  else []. */
  audioChannels: FacetOption<AudioChannelGroup>[];
  /** audio: measured-present buckets ∪ selected, SAMPLE_RATE_BUCKETS order;
   *  else []. */
  sampleRates: FacetOption<SampleRateBucket>[];
  /** texture with a non-null membership map: the single "Material" row
   *  (member of a material group), self-excluded. null otherwise. */
  material: ShapeRow | null;
  res: RangeHistogram | null;                  // texture only
  /** texture only; null otherwise. */
  shape: { square: ShapeRow; pot: ShapeRow } | null;
  size: RangeHistogram | null;                 // model + document
  /** All kinds — the single "Favorite" row (starred file), self-excluded. */
  favorite: ShapeRow;
  /** All kinds — one row per collection present in scope ∪ selected, in the
   *  user's collection order; self-excluded counts. */
  collections: FacetOption<string>[];
  /** All kinds — mtimes are always known, so `measured` = every file passing
   *  the other constraints. Linear bins (see histogram()). */
  modified: RangeHistogram;
  /** Files passing scope + query + ALL active constraints with the live
   *  unknown=keep predicate semantics — never a sum of bucket counts. */
  visible: number;
  /** kind + scope only — identical definition to useScopeCount. */
  scoped: number;
}

// One bit per countable unit; a unit that is inapplicable to the kind or has
// no active selection is pre-set in `base`, so per-file mask math is uniform.
const EXT = 1;
const DUR = 2;
const CHAN = 4;
const MAT = 8;
const RES = 16;
const SQ = 32;
const POT = 64;
const SIZE = 128;
const MOD = 256;
const COLOR = 512;
const ACHAN = 1024;
const RATE = 2048;
const FAV = 4096;
const COL = 8192;
const FULL = 16383;

function zeroRecord<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = 0;
  return out;
}

/** Histogram over measured values (UI units), binned over a FIXED domain —
 *  the scope-wide measured min/max, not the min/max of `values`. The bars
 *  shrink as other filters narrow the set, but the axis (and with it the
 *  slider and its endpoint labels) never rescales under the user. Log-spaced
 *  for the numeric facets — durations, resolutions, and sizes each span 3+
 *  orders of magnitude, and linear bins would crush everything into bin 0.
 *  Linear for dates. Values ≤ 0 clamp to EPS in log mode; a degenerate
 *  all-equal domain collapses to one full bar in bin 0. `domain` null (nothing
 *  measured in scope) ⇒ the "no data" state (empty edges). */
function histogram(
  values: number[],
  log: boolean,
  domain: readonly [number, number] | null,
): RangeHistogram {
  const bins = new Array<number>(HISTOGRAM_BINS).fill(0);
  if (domain === null) return { bins, edges: [], measured: 0 };
  const EPS = 1e-3;
  const scale = (v: number): number => (log ? Math.log(Math.max(v, EPS)) : v);
  const unscale = (s: number): number => (log ? Math.exp(s) : s);
  const lo = scale(domain[0]);
  let hi = scale(domain[1]);
  if (hi <= lo) hi = log ? lo + Math.LN2 : lo + 1;
  const span = hi - lo;
  for (const v of values) {
    const i = Math.min(HISTOGRAM_BINS - 1, Math.floor(((scale(v) - lo) / span) * HISTOGRAM_BINS));
    bins[i]!++;
  }
  const edges: number[] = [];
  for (let i = 0; i <= HISTOGRAM_BINS; i++) {
    edges.push(unscale(lo + (span * i) / HISTOGRAM_BINS));
  }
  return { bins, edges, measured: values.length };
}

/** Running scope-wide min/max of one facet's measured values. */
interface Domain {
  lo: number;
  hi: number;
}
const newDomain = (): Domain => ({ lo: Infinity, hi: -Infinity });
const widen = (d: Domain, v: number): void => {
  if (v < d.lo) d.lo = v;
  if (v > d.hi) d.hi = v;
};
const asRangeDomain = (d: Domain): readonly [number, number] | null =>
  d.lo <= d.hi ? [d.lo, d.hi] : null;

/**
 * Faceted counts for the filter popup: every option row answers "what would I
 * see if my selection in THIS facet were exactly {…, this option}" — i.e. each
 * row's count applies scope + query + every other active facet, excluding its
 * own (digitec semantics; OR within a facet, AND across facets). Shape is the
 * exception: its two rows AND with each other, so each excludes only itself.
 * Range facets are a single interval constraint; their histogram is the
 * self-excluded distribution rather than option counts.
 *
 * One O(n) pass with a per-file bitmask of predicate results — the standard
 * one-pass self-exclusion trick ((mask | ownBit) === FULL), never one pass per
 * facet. Numerators are measured-only, while `visible` keeps the live
 * unknown=keep semantics, so `visible` can exceed a lazy facet's bucket sum
 * until probe batches land — the popup footnote covers exactly that gap.
 *
 * The membership map is computed by the CALLER (FilterPopup) — never in here —
 * so exactly one instance of the grouping pass serves both the counts and the
 * Material rows.
 */
export function useFacetCounts(
  kind: AssetKind,
  membership: Map<number, MaterialMembership> | null,
): FacetCounts {
  const allFiles = useLibraryStore((s) => s.allFiles);
  const folderScopes = useLibraryStore((s) => s.folderScopes);
  const hiddenFolders = useLibraryStore((s) => s.hiddenFolders);
  // Scope = union of the selected folders and collections, matching
  // useVisibleFiles. `favorites`/`collections` also drive their filter facet
  // rows; the popup is open-only, so unconditional subscriptions are fine.
  const collMembers = useCollectionMembers();
  const favorites = useFavoritesStore((s) => s.favorites);
  const collections = useFavoritesStore((s) => s.collections);
  const query = useLibraryStore((s) => s.tabs[kind].query);
  const extFilter = useLibraryStore((s) => s.tabs[kind].extFilter);
  const filters = useLibraryStore((s) => s.tabs[kind].filters);
  const durations = useLibraryStore((s) => s.durations);
  const durationsVersion = useLibraryStore((s) => s.durationsVersion);
  const dims = useLibraryStore((s) => s.dims);
  const dimsVersion = useLibraryStore((s) => s.dimsVersion);
  const audioMeta = useLibraryStore((s) => s.audioMeta);
  const audioMetaVersion = useLibraryStore((s) => s.audioMetaVersion);
  const thumbs = useLibraryStore((s) => s.thumbs);
  const thumbsVersion = useLibraryStore((s) => s.thumbsVersion);
  const debouncedQuery = useDebounced(query, 100);

  return useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    const hasQuery = q !== "";
    const inScope = scopePredicate(folderScopes, hiddenFolders);
    const flt = filters;
    // Mirror useVisibleFiles: exclusion narrows the pool that every OTHER
    // facet's counts are measured against, exactly as the query does.
    const excludeList = [...flt.excludeTerms];
    const hasExclude = excludeList.length > 0;

    // Same kind-gating as useVisibleFiles' facet gates.
    const extActive = extFilter.size > 0;
    const durActive = kind === "audio" && rangeActive(flt.duration);
    const chanActive = kind === "texture" && flt.channels.size > 0;
    const matActive = kind === "texture" && flt.material && membership !== null;
    const resActive = kind === "texture" && rangeActive(flt.res);
    const sqActive = kind === "texture" && flt.square;
    const potActive = kind === "texture" && flt.pot;
    const sizeActive = (kind === "model" || kind === "document") && rangeActive(flt.size);
    const modActive = rangeActive(flt.modified);
    const colorActive = kind === "texture" && flt.colors.size > 0;
    const achanActive = kind === "audio" && flt.audioChannels.size > 0;
    const srActive = kind === "audio" && flt.sampleRates.size > 0;
    const favActive = flt.favorite;
    const colActive = flt.collections.size > 0;
    // Per-collection path sets, built once for the O(files × collections)
    // membership scan (collections are few; the popup is open-only).
    const colSets = collections.map((c) => ({ name: c.name, set: new Set(c.paths) }));

    // Size is stored in MB; compare in bytes, converted once outside the loop.
    const sizeBytes: RangeFilter = {
      min: flt.size.min === null ? null : flt.size.min * MIB,
      max: flt.size.max === null ? null : flt.size.max * MIB,
    };

    let base = FULL;
    if (extActive) base &= ~EXT;
    if (durActive) base &= ~DUR;
    if (chanActive) base &= ~CHAN;
    if (matActive) base &= ~MAT;
    if (resActive) base &= ~RES;
    if (sqActive) base &= ~SQ;
    if (potActive) base &= ~POT;
    if (sizeActive) base &= ~SIZE;
    if (modActive) base &= ~MOD;
    if (colorActive) base &= ~COLOR;
    if (achanActive) base &= ~ACHAN;
    if (srActive) base &= ~RATE;
    if (favActive) base &= ~FAV;
    if (colActive) base &= ~COL;

    // Range facets collect self-excluded measured VALUES for the histogram;
    // multi-select facets keep small fixed count records.
    const extHist = new Map<string, number>();
    const chanHist = zeroRecord(CHANNEL_GROUPS);
    const colorHist = zeroRecord(COLOR_BUCKETS);
    const achanHist = zeroRecord(AUDIO_CHANNEL_GROUPS);
    const rateHist = zeroRecord(SAMPLE_RATE_BUCKETS);
    let matCount = 0;
    const durValues: number[] = [];   // seconds
    const resValues: number[] = [];   // px (max edge)
    const sizeValues: number[] = [];  // MB
    const modValues: number[] = [];   // unix seconds
    // Slider/label domains: min/max of ALL measured values in scope — stable
    // under the query and every facet, like the row sets below.
    const durDomain = newDomain();
    const resDomain = newDomain();
    const sizeDomain = newDomain();
    const modDomain = newDomain();
    let sqCount = 0;
    let potCount = 0;
    let favCount = 0;
    const colCount = new Map<string, number>();

    // Row sets are scope-only presence — stable under other facets and the
    // query, so rows never appear/disappear as the user narrows. The three
    // probe-derived sets below additionally need a measurement to exist —
    // scope-stable once measured, growing only as batches land.
    const presentExts = new Set<string>();
    const presentChans = new Set<ChannelGroup>();
    const presentColors = new Set<ColorBucket>();
    const presentAChans = new Set<AudioChannelGroup>();
    const presentRates = new Set<SampleRateBucket>();
    const presentCols = new Set<string>();

    let scoped = 0;
    let visible = 0;

    const hasFolderScope = folderScopes.length > 0;
    const hasCollScope = collMembers !== null;
    const anyScope = hasFolderScope || hasCollScope;

    for (const f of allFiles) {
      if (f.kind !== kind) continue;
      // Scope = union of the selected folders and collections, matching
      // useVisibleFiles.
      if (anyScope) {
        const inFolders = hasFolderScope && inScope(f.path);
        const inColls = hasCollScope && collMembers.has(f.path);
        if (!inFolders && !inColls) continue;
      } else if (!inScope(f.path)) continue;
      scoped++;
      presentExts.add(f.ext);
      // Collection memberships (scope-only presence + faceted counts below).
      // Computed here so presence is stable under the query and other facets.
      const memberCols: string[] = [];
      for (const cs of colSets) {
        if (cs.set.has(f.path)) {
          memberCols.push(cs.name);
          presentCols.add(cs.name);
        }
      }
      // The classifier is total (name-cached), so compute once per file and
      // reuse for presence, predicate, and histogram.
      const g = kind === "texture" ? channelGroupOf(f) : null;
      if (g !== null) presentChans.add(g);

      // Measured BEFORE the query gate: domains cover the whole scope.
      const d = kind === "audio" ? durations.get(f.id) : undefined;
      const dm = kind === "texture" ? dims.get(f.id) : undefined;
      const edge = dm === undefined ? null : Math.max(dm[0], dm[1]);
      // Probe-derived bucket memberships, computed once per file and reused
      // for presence, predicate, and numerator — the channelGroupOf pattern.
      // null = unmeasured (no thumb yet / a probe field the decoder couldn't
      // read, which A1's probe reports as 0).
      const ti = kind === "texture" ? thumbs.get(f.id)?.info : undefined;
      const cb = ti == null ? null : colorBucketOf(ti.meanR, ti.meanG, ti.meanB);
      const am = kind === "audio" ? audioMeta.get(f.id) : undefined;
      const ag = am !== undefined && am[1] > 0 ? audioChannelGroupOf(am[1]) : null;
      const rb = am !== undefined && am[0] > 0 ? sampleRateBucketOf(am[0]) : null;
      if (cb !== null) presentColors.add(cb);
      if (ag !== null) presentAChans.add(ag);
      if (rb !== null) presentRates.add(rb);
      if (d !== undefined) widen(durDomain, d);
      if (edge !== null) widen(resDomain, edge);
      if (kind === "model" || kind === "document") widen(sizeDomain, f.size / MIB);
      // mtime 0/negative marks a stat error (see scanner.rs unix_seconds) —
      // one 1970 outlier would flatten the whole date axis.
      if (f.modified > 0) widen(modDomain, f.modified);

      if (hasQuery && !f.nameLower.includes(q)) continue;
      if (hasExclude && excludeList.some((ex) => f.nameLower.includes(ex))) continue;
      // Looked up for every scoped texture while the popup holds a map, not
      // only when the facet is active — the Material rows need counts before
      // anything is selected.
      const mem = matActive || kind === "texture" ? membership?.get(f.id) : undefined;

      // Unknown = keep on the lazily-probed facets, exactly as in
      // useVisibleFiles — a filter may only remove what it has measured.
      let mask = base;
      if (extActive && extFilter.has(f.ext)) mask |= EXT;
      if (durActive && (d === undefined || inRange(d, flt.duration))) mask |= DUR;
      if (chanActive && flt.channels.has(g!)) mask |= CHAN;
      if (matActive && mem !== "standalone") mask |= MAT; // undefined = keep
      if (resActive && (edge === null || inRange(edge, flt.res))) mask |= RES;
      if (sqActive && (dm === undefined || dm[0] === dm[1])) mask |= SQ;
      if (potActive && (dm === undefined || (isPot(dm[0]) && isPot(dm[1])))) mask |= POT;
      if (sizeActive && inRange(f.size, sizeBytes)) mask |= SIZE; // always measured
      if (modActive && inRange(f.modified, flt.modified)) mask |= MOD; // always measured
      if (colorActive && (cb === null || flt.colors.has(cb))) mask |= COLOR;
      if (achanActive && (ag === null || flt.audioChannels.has(ag))) mask |= ACHAN;
      if (srActive && (rb === null || flt.sampleRates.has(rb))) mask |= RATE;
      if (favActive && favorites.has(f.path)) mask |= FAV; // always known
      if (colActive && memberCols.some((n) => flt.collections.has(n))) mask |= COL; // always known

      // Numerators are measured-only: an unmeasured file sits in no bucket
      // (while `visible` still keeps it — the documented discrepancy).
      if ((mask | EXT) === FULL) extHist.set(f.ext, (extHist.get(f.ext) ?? 0) + 1);
      if (d !== undefined && (mask | DUR) === FULL) durValues.push(d);
      if (g !== null && (mask | CHAN) === FULL) chanHist[g]++;
      if (cb !== null && (mask | COLOR) === FULL) colorHist[cb]++;
      if (ag !== null && (mask | ACHAN) === FULL) achanHist[ag]++;
      if (rb !== null && (mask | RATE) === FULL) rateHist[rb]++;
      if (mem === "grouped" && (mask | MAT) === FULL) matCount++;
      if (edge !== null && (mask | RES) === FULL) resValues.push(edge);
      if (dm !== undefined) {
        // Per-ROW exclusion: Square's count still honors an active PoT
        // constraint (the rows AND with each other), and vice versa.
        if (dm[0] === dm[1] && (mask | SQ) === FULL) sqCount++;
        if (isPot(dm[0]) && isPot(dm[1]) && (mask | POT) === FULL) potCount++;
      }
      if ((kind === "model" || kind === "document") && (mask | SIZE) === FULL)
        sizeValues.push(f.size / MIB);
      if (f.modified > 0 && (mask | MOD) === FULL) modValues.push(f.modified);
      if (favorites.has(f.path) && (mask | FAV) === FULL) favCount++;
      if ((mask | COL) === FULL) {
        for (const n of memberCols) colCount.set(n, (colCount.get(n) ?? 0) + 1);
      }
      if (mask === FULL) visible++;
    }

    // Union with the selection keeps an active row visible (and clearable) at
    // count 0 even after its ext/group left the scope.
    const format = EXTENSIONS[kind]
      .filter((e) => presentExts.has(e) || extFilter.has(e))
      .map((e) => ({ value: e, count: extHist.get(e) ?? 0, selected: extFilter.has(e) }));
    const channels =
      kind !== "texture"
        ? []
        : CHANNEL_GROUPS.filter((c) => presentChans.has(c) || flt.channels.has(c)).map((c) => ({
            value: c,
            count: chanHist[c],
            selected: flt.channels.has(c),
          }));
    const colors =
      kind !== "texture"
        ? []
        : COLOR_BUCKETS.filter((c) => presentColors.has(c) || flt.colors.has(c)).map((c) => ({
            value: c,
            count: colorHist[c],
            selected: flt.colors.has(c),
          }));
    const audioChannels =
      kind !== "audio"
        ? []
        : AUDIO_CHANNEL_GROUPS.filter(
            (c) => presentAChans.has(c) || flt.audioChannels.has(c),
          ).map((c) => ({
            value: c,
            count: achanHist[c],
            selected: flt.audioChannels.has(c),
          }));
    const sampleRates =
      kind !== "audio"
        ? []
        : SAMPLE_RATE_BUCKETS.filter((r) => presentRates.has(r) || flt.sampleRates.has(r)).map(
            (r) => ({
              value: r,
              count: rateHist[r],
              selected: flt.sampleRates.has(r),
            }),
          );

    // Rows in the user's collection order; present-in-scope ∪ selected keeps an
    // active row visible (and clearable) at count 0 even after it leaves scope.
    const collectionRows = collections
      .filter((c) => presentCols.has(c.name) || flt.collections.has(c.name))
      .map((c) => ({
        value: c.name,
        count: colCount.get(c.name) ?? 0,
        selected: flt.collections.has(c.name),
      }));

    return {
      format,
      collections: collectionRows,
      duration: kind !== "audio" ? null : histogram(durValues, true, asRangeDomain(durDomain)),
      channels,
      colors,
      audioChannels,
      sampleRates,
      material:
        kind !== "texture" || membership === null
          ? null
          : { count: matCount, selected: flt.material },
      res: kind !== "texture" ? null : histogram(resValues, true, asRangeDomain(resDomain)),
      shape:
        kind !== "texture"
          ? null
          : {
              square: { count: sqCount, selected: flt.square },
              pot: { count: potCount, selected: flt.pot },
            },
      size:
        kind === "model" || kind === "document"
          ? histogram(sizeValues, true, asRangeDomain(sizeDomain))
          : null,
      favorite: { count: favCount, selected: flt.favorite },
      modified: histogram(modValues, false, asRangeDomain(modDomain)),
      visible,
      scoped,
    };
  }, [kind, allFiles, folderScopes, hiddenFolders, collMembers, favorites, collections, debouncedQuery, extFilter, filters, durations, durationsVersion, dims, dimsVersion, audioMeta, audioMetaVersion, thumbs, thumbsVersion, membership]);
}
