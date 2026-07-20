import { useEffect, useMemo, useState } from "react";
import { scopePredicate, useLibraryStore } from "../stores/libraryStore";
import { channelGroupOf } from "../material/classify";
import { inRange, isPot } from "./useVisibleFiles";
import { type MaterialMembership } from "./useMaterialMembership";
import {
  CHANNEL_GROUPS,
  EXTENSIONS,
  MIB,
  rangeActive,
  type AssetKind,
  type ChannelGroup,
  type RangeFilter,
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
  /** texture with a non-null membership map: the single "Material" row
   *  (member of a material group), self-excluded. null otherwise. */
  material: ShapeRow | null;
  res: RangeHistogram | null;                  // texture only
  /** texture only; null otherwise. */
  shape: { square: ShapeRow; pot: ShapeRow } | null;
  size: RangeHistogram | null;                 // model only
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
const FULL = 511;

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
  const query = useLibraryStore((s) => s.tabs[kind].query);
  const extFilter = useLibraryStore((s) => s.tabs[kind].extFilter);
  const filters = useLibraryStore((s) => s.tabs[kind].filters);
  const durations = useLibraryStore((s) => s.durations);
  const durationsVersion = useLibraryStore((s) => s.durationsVersion);
  const dims = useLibraryStore((s) => s.dims);
  const dimsVersion = useLibraryStore((s) => s.dimsVersion);
  const debouncedQuery = useDebounced(query, 100);

  return useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    const hasQuery = q !== "";
    const inScope = scopePredicate(folderScopes, hiddenFolders);
    const flt = filters;

    // Same kind-gating as useVisibleFiles' facet gates.
    const extActive = extFilter.size > 0;
    const durActive = kind === "audio" && rangeActive(flt.duration);
    const chanActive = kind === "texture" && flt.channels.size > 0;
    const matActive = kind === "texture" && flt.material && membership !== null;
    const resActive = kind === "texture" && rangeActive(flt.res);
    const sqActive = kind === "texture" && flt.square;
    const potActive = kind === "texture" && flt.pot;
    const sizeActive = kind === "model" && rangeActive(flt.size);
    const modActive = rangeActive(flt.modified);

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

    // Range facets collect self-excluded measured VALUES for the histogram;
    // multi-select facets keep small fixed count records.
    const extHist = new Map<string, number>();
    const chanHist = zeroRecord(CHANNEL_GROUPS);
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

    // Row sets are scope-only presence — stable under other facets and the
    // query, so rows never appear/disappear as the user narrows.
    const presentExts = new Set<string>();
    const presentChans = new Set<ChannelGroup>();

    let scoped = 0;
    let visible = 0;

    for (const f of allFiles) {
      if (f.kind !== kind) continue;
      if (!inScope(f.path)) continue;
      scoped++;
      presentExts.add(f.ext);
      // The classifier is total (name-cached), so compute once per file and
      // reuse for presence, predicate, and histogram.
      const g = kind === "texture" ? channelGroupOf(f) : null;
      if (g !== null) presentChans.add(g);

      // Measured BEFORE the query gate: domains cover the whole scope.
      const d = kind === "audio" ? durations.get(f.id) : undefined;
      const dm = kind === "texture" ? dims.get(f.id) : undefined;
      const edge = dm === undefined ? null : Math.max(dm[0], dm[1]);
      if (d !== undefined) widen(durDomain, d);
      if (edge !== null) widen(resDomain, edge);
      if (kind === "model") widen(sizeDomain, f.size / MIB);
      // mtime 0/negative marks a stat error (see scanner.rs unix_seconds) —
      // one 1970 outlier would flatten the whole date axis.
      if (f.modified > 0) widen(modDomain, f.modified);

      if (hasQuery && !f.nameLower.includes(q)) continue;
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

      // Numerators are measured-only: an unmeasured file sits in no bucket
      // (while `visible` still keeps it — the documented discrepancy).
      if ((mask | EXT) === FULL) extHist.set(f.ext, (extHist.get(f.ext) ?? 0) + 1);
      if (d !== undefined && (mask | DUR) === FULL) durValues.push(d);
      if (g !== null && (mask | CHAN) === FULL) chanHist[g]++;
      if (mem === "grouped" && (mask | MAT) === FULL) matCount++;
      if (edge !== null && (mask | RES) === FULL) resValues.push(edge);
      if (dm !== undefined) {
        // Per-ROW exclusion: Square's count still honors an active PoT
        // constraint (the rows AND with each other), and vice versa.
        if (dm[0] === dm[1] && (mask | SQ) === FULL) sqCount++;
        if (isPot(dm[0]) && isPot(dm[1]) && (mask | POT) === FULL) potCount++;
      }
      if (kind === "model" && (mask | SIZE) === FULL) sizeValues.push(f.size / MIB);
      if (f.modified > 0 && (mask | MOD) === FULL) modValues.push(f.modified);
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

    return {
      format,
      duration: kind !== "audio" ? null : histogram(durValues, true, asRangeDomain(durDomain)),
      channels,
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
      size: kind !== "model" ? null : histogram(sizeValues, true, asRangeDomain(sizeDomain)),
      modified: histogram(modValues, false, asRangeDomain(modDomain)),
      visible,
      scoped,
    };
  }, [kind, allFiles, folderScopes, hiddenFolders, debouncedQuery, extFilter, filters, durations, durationsVersion, dims, dimsVersion, membership]);
}
