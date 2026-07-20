import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import clsx from "clsx";
import { Check, ChevronDown, X } from "lucide-react";
import {
  AUDIO_CHANNEL_GROUP_LABEL,
  CHANNEL_GROUP_LABEL,
  COLOR_BUCKET_LABEL,
  DAY_SECONDS,
  NOUN,
  SAMPLE_RATE_BUCKET_LABEL,
  emptyRange,
  rangeActive,
  type AssetKind,
  type ColorBucket,
  type RangeFilter,
} from "../types";
import { useLibraryStore, type TabFilters } from "../stores/libraryStore";
import { HISTOGRAM_BINS, useFacetCounts, type RangeHistogram } from "../hooks/useFacetCounts";
import { useMaterialMembership } from "../hooks/useMaterialMembership";

// ---- local-day helpers for the Modified facet ----
// min binds to the day's first second and max to its last, so an equal
// from/to pair means "that whole day". All in LOCAL time — "files I touched
// yesterday" is a local-calendar question, not a UTC one.

function dayAlign(sec: number, end: boolean): number {
  const d = new Date(sec * 1000);
  const start = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
  return end ? start + DAY_SECONDS - 1 : start;
}

function formatDate(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "2026-07-19" (what the app prints) or "19.07.2026". Impossible dates
 *  (2026-02-31) are rejected, not rolled over. */
function parseDate(s: string, end: boolean): number | null {
  const t = s.trim();
  let y: number, mo: number, da: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (iso !== null) {
    [y, mo, da] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else {
    const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
    if (dotted === null) return null;
    [y, mo, da] = [Number(dotted[3]), Number(dotted[2]), Number(dotted[1])];
  }
  const d = new Date(y, mo - 1, da);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
  const start = Math.floor(d.getTime() / 1000);
  return end ? start + DAY_SECONDS - 1 : start;
}

/** UI facet groups (not 1:1 with store keys — `shape` spans square+pot, and
 *  `material` hosts both the membership toggle and the channel rows). */
export type FacetId =
  | "format" | "favorite" | "duration" | "audioChannels" | "sampleRate" | "material"
  | "color" | "res" | "shape" | "size" | "modified";

export const FACET_ORDER: Record<AssetKind, readonly FacetId[]> = {
  audio: ["format", "favorite", "duration", "audioChannels", "sampleRate", "modified"],
  texture: ["format", "favorite", "material", "color", "res", "shape", "modified"],
  model: ["format", "favorite", "size", "modified"],
};

const FACET_LABEL: Record<FacetId, string> = {
  format: "Format",
  favorite: "Favorite",
  duration: "Length",
  audioChannels: "Channels",
  sampleRate: "Sample rate",
  material: "Material",
  color: "Color",
  res: "Resolution",
  shape: "Shape",
  size: "File size",
  modified: "Modified",
};

/** Swatch fills for the color facet — representative, not exact: a bucket
 *  spans a hue arc, the swatch is its recognizable center. dark/light/gray sit
 *  at fixed lightness so they read against both themes. */
const COLOR_SWATCH: Record<ColorBucket, string> = {
  red: "#e5484d",
  orange: "#f76b15",
  yellow: "#f5d90a",
  green: "#46a758",
  cyan: "#0ea5c6",
  blue: "#3e63dd",
  purple: "#8e4ec6",
  pink: "#d6409f",
  dark: "#232326",
  light: "#f0f0f3",
  gray: "#8b8d98",
};

/** Per-range-facet UI unit, rounding, and axis; the store patch key is the
 *  facet id. `log` must match the histogram's binning (useFacetCounts) so the
 *  slider's equal pixel steps land on equal bin widths. */
const RANGE_FACET = {
  duration: { unit: "s", integer: false, date: false, log: true },
  res: { unit: "px", integer: true, date: false, log: true },
  size: { unit: "MB", integer: false, date: false, log: true },
  modified: { unit: "", integer: false, date: true, log: false },
} as const;

/** "Length 1–10 s" | "Resolution ≥ 2048 px" | "Modified ≥ 2026-07-01".
 *  Plain String()/formatDate, not toLocaleString(): the app must never display
 *  a form ("2,048") that retyping into the range input would parse differently. */
function rangeToken(
  name: string,
  r: RangeFilter,
  unit: string,
  fmt: (n: number) => string = String,
): string {
  const u = unit === "" ? "" : ` ${unit}`;
  if (r.min !== null && r.max !== null) return `${name} ${fmt(r.min)}–${fmt(r.max)}${u}`;
  if (r.min !== null) return `${name} ≥ ${fmt(r.min)}${u}`;
  return `${name} ≤ ${fmt(r.max!)}${u}`;
}

/** Copy the touched Set, never mutate — the toggleExt pattern. */
function toggled<T>(prev: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(prev);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

/** Collapsible facet section: header row (label + active-count badge +
 *  chevron), body mounts/unmounts instantly — only the chevron animates, the
 *  sort-dropdown idiom. */
function FacetGroup({
  label,
  badge,
  open,
  onToggle,
  children,
}: {
  label: string;
  badge: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="group flex w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-[120ms] hover:bg-overlay"
      >
        <span className="flex-1 text-[10px] font-medium uppercase tracking-wide text-faint transition-colors duration-[120ms] group-hover:text-dim">
          {label}
        </span>
        {badge > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-fill px-1 text-[10px] font-semibold tabular-nums text-accent-fg">
            {badge}
          </span>
        )}
        <ChevronDown
          size={12}
          className={clsx(
            "shrink-0 text-faint transition-transform duration-[120ms]",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

/**
 * One option: check mark + label + proportional bar + count. The mark is
 * built from divs (a native checkbox can't be themed in WebView2). A
 * zero-count unchecked row stays rendered but disabled — hiding it would jump
 * the layout; a SELECTED row at zero stays fully live: it is the "this is why
 * you see nothing" signal and the only way to clear itself.
 */
function OptionRow({
  kind,
  label,
  count,
  max,
  selected,
  onClick,
}: {
  kind: AssetKind;
  label: string;
  count: number;
  max: number;
  selected: boolean;
  onClick: () => void;
}): ReactElement {
  const dead = count === 0 && !selected;
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={dead}
      title={`${count.toLocaleString()} ${NOUN[kind]}`}
      onClick={onClick}
      className={clsx(
        "flex w-full items-center gap-2 rounded-lg py-1.5 pl-2.5 pr-2 text-left text-[12px] transition-colors duration-[120ms]",
        selected
          ? "text-text hover:bg-overlay"
          : dead
            ? "text-faint"
            : "text-dim hover:bg-overlay hover:text-text",
      )}
    >
      <span
        className={clsx(
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded transition-colors duration-[120ms]",
          selected ? "bg-accent text-bg" : dead ? "bg-bg opacity-50" : "bg-bg",
        )}
      >
        {selected && <Check size={11} strokeWidth={3} />}
      </span>
      <span className="flex-1 truncate">{label}</span>
      <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-bg">
        {count > 0 && (
          <span
            className={clsx(
              "block h-full rounded-full transition-[width] duration-[120ms]",
              selected ? "bg-accent" : "bg-accent/40",
            )}
            style={{ width: `${Math.max(4, (count / max) * 100)}%` }}
          />
        )}
      </span>
      <span
        className={clsx(
          "w-10 shrink-0 text-right text-[11px] tabular-nums",
          selected ? "text-dim" : count === 0 ? "text-faint/60" : "text-faint",
        )}
      >
        {count.toLocaleString()}
      </span>
    </button>
  );
}

/** Free-typing field: local text state applies parsed values to the store on
 *  every change; external clears (token ×, Reset all) resync it. Unparseable
 *  non-empty text never commits — the last valid bound stays active and the
 *  field shows an error ring, because silently widening the list on a typo is
 *  the one failure the user cannot see. `parse`/`format` must round-trip
 *  (parse(format(v)) === v) or the resync would fight the user's typing. */
function RangeInput({
  value,
  placeholder,
  parse,
  format,
  onCommit,
}: {
  value: number | null;
  placeholder: string;
  parse: (t: string) => number | null;
  format: (v: number) => string;
  onCommit: (v: number | null) => void;
}): ReactElement {
  const [text, setText] = useState(value === null ? "" : format(value));
  const invalid = text.trim() !== "" && parse(text) === null;
  useEffect(() => {
    // Store changed under us (token removal, Reset all, slider, import).
    if (parse(text) !== value) setText(value === null ? "" : format(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      type="text"
      inputMode="decimal"
      spellCheck={false}
      value={text}
      placeholder={placeholder}
      className={clsx(
        "h-7 w-full min-w-0 flex-1 rounded-lg bg-bg px-2 text-[12px] tabular-nums text-text outline-none transition-[background-color,box-shadow] duration-[120ms] placeholder:text-faint hover:bg-overlay",
        invalid ? "ring-2 ring-danger/50" : "focus:ring-2 focus:ring-accent/35",
      )}
      onChange={(e) => {
        const t = e.currentTarget.value;
        setText(t);
        const v = parse(t);
        // Commit valid values and explicit clears; hold the bound on garbage.
        if (t.trim() === "" || v !== null) onCommit(v);
      }}
      // The resync effect can't catch garbage left behind when the store value
      // DIDN'T change (Reset all with the bound already null) — blur always
      // fires before the user clicks anything else, so normalize here.
      onBlur={() => {
        if (parse(text) !== value) setText(value === null ? "" : format(value));
      }}
    />
  );
}

/**
 * Dual-thumb slider over the histogram's domain, sharing its axis (log or
 * linear) so equal pixel steps match equal bin widths. Dragging PREVIEWS
 * (histogram highlight only) and commits on release — the UI-scale slider
 * precedent, and it keeps the 50k-file pass off the pointermove path. A thumb
 * released at the far end commits null: dragging fully open IS clearing the
 * bound. Custom divs, not <input type=range> — no native dual-thumb exists.
 */
function RangeSlider({
  domain,
  log,
  range,
  quantize,
  onPreview,
  onCommit,
}: {
  domain: readonly [number, number];
  log: boolean;
  range: RangeFilter;
  quantize: (v: number, side: "min" | "max") => number;
  onPreview: (r: RangeFilter | null) => void;
  onCommit: (r: RangeFilter) => void;
}): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ side: "min" | "max"; t: number } | null>(null);

  const [lo, hi] = domain;
  const sLo = log ? Math.log(lo) : lo;
  const sHi = log ? Math.log(hi) : hi;
  const toT = (v: number): number => {
    const s = log ? Math.log(Math.max(v, lo)) : v;
    return Math.min(1, Math.max(0, (s - sLo) / (sHi - sLo)));
  };
  const fromT = (t: number): number => {
    const s = sLo + t * (sHi - sLo);
    return log ? Math.exp(s) : s;
  };

  // Unbounded ends park at the extremes; the store stays authoritative for
  // the idle side while the other drags.
  const baseMin = range.min === null ? 0 : toT(range.min);
  const baseMax = range.max === null ? 1 : toT(range.max);
  const tMin = drag?.side === "min" ? drag.t : baseMin;
  const tMax = drag?.side === "max" ? drag.t : baseMax;

  const asRange = (side: "min" | "max", t: number): RangeFilter =>
    side === "min"
      ? { ...range, min: t <= 0 ? null : quantize(fromT(t), "min") }
      : { ...range, max: t >= 1 ? null : quantize(fromT(t), "max") };

  const posT = (clientX: number): number => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const clampT = (side: "min" | "max", t: number): number =>
    side === "min" ? Math.min(t, baseMax) : Math.max(t, baseMin);

  return (
    <div
      ref={ref}
      className="relative mb-1.5 h-4 cursor-ew-resize touch-none"
      onPointerDown={(e) => {
        const t = posT(e.clientX);
        // Nearest thumb wins; stacked thumbs resolve by approach side.
        const dMin = Math.abs(t - tMin);
        const dMax = Math.abs(t - tMax);
        const side = dMin < dMax ? "min" : dMax < dMin ? "max" : t < tMin ? "min" : "max";
        e.currentTarget.setPointerCapture(e.pointerId);
        const ct = clampT(side, t);
        setDrag({ side, t: ct });
        onPreview(asRange(side, ct));
      }}
      onPointerMove={(e) => {
        if (drag === null) return;
        const ct = clampT(drag.side, posT(e.clientX));
        setDrag({ side: drag.side, t: ct });
        onPreview(asRange(drag.side, ct));
      }}
      onPointerUp={() => {
        if (drag === null) return;
        onCommit(asRange(drag.side, drag.t));
        setDrag(null);
        onPreview(null);
      }}
      onPointerCancel={() => {
        setDrag(null);
        onPreview(null);
      }}
    >
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-bg" />
      <div
        className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent/70"
        style={{ left: `${tMin * 100}%`, width: `${Math.max(0, tMax - tMin) * 100}%` }}
      />
      {([["min", tMin], ["max", tMax]] as const).map(([side, t]) => (
        <div
          key={side}
          className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-e1"
          style={{ left: `${t * 100}%` }}
        />
      ))}
    </div>
  );
}

function RangeRow({
  hist,
  range,
  unit,
  integer,
  date,
  log,
  onChange,
}: {
  hist: RangeHistogram;
  range: RangeFilter;
  unit: string;
  integer: boolean;
  date: boolean;
  log: boolean;
  onChange: (r: RangeFilter) => void;
}): ReactElement {
  // Live slider preview: the store commits on release, but the histogram
  // highlight tracks the thumb mid-drag so the drag has visible feedback.
  const [preview, setPreview] = useState<RangeFilter | null>(null);

  // Group separators are stripped, not rejected: "2,048" and the Swiss
  // "2'048" both mean 2048 to anyone typing them.
  const parseNum = (t: string): number | null => {
    const s = t.trim().replace(/[\s,']/g, "");
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return null;
    return integer ? Math.round(n) : n;
  };
  // Dates parse per SIDE: "from" binds to the day's first second, "to" to its
  // last — the parse/format round-trip holds for both.
  const parseMin = date ? (s: string) => parseDate(s, false) : parseNum;
  const parseMax = date ? (s: string) => parseDate(s, true) : parseNum;
  const format = date ? formatDate : String;

  const domainOk = hist.edges.length > 0 && hist.edges[HISTOGRAM_BINS]! > hist.edges[0]!;

  return (
    <div className="px-2.5 pb-1.5 pt-0.5">
      {/* The axis exists whenever ANYTHING in scope is measured — with other
          filters excluding everything, the bars simply go flat. */}
      {domainOk ? (
        <Histogram hist={hist} range={preview ?? range} />
      ) : (
        <div className="mb-1.5 text-[10px] leading-snug text-faint">
          Nothing measured yet
        </div>
      )}
      {domainOk && (
        <>
          <RangeSlider
            domain={[hist.edges[0]!, hist.edges[HISTOGRAM_BINS]!]}
            log={log}
            range={range}
            // Slider values quantize to what a person would type: whole px,
            // 3 significant digits, whole local days.
            quantize={(v, side) =>
              date ? dayAlign(v, side === "max") : integer ? Math.round(v) : Number(v.toPrecision(3))
            }
            onPreview={setPreview}
            onCommit={onChange}
          />
          {/* Domain endpoints — what the slider's extremes mean. The outer
              edges are real measured min/max: integers stay exact (8192 must
              not print as 8190), floats show at typing precision. */}
          <div className="-mt-1 mb-1.5 flex justify-between text-[9px] tabular-nums text-faint">
            {([hist.edges[0]!, hist.edges[HISTOGRAM_BINS]!] as const).map((v, i) => (
              <span key={i}>
                {date ? formatDate(v) : integer ? Math.round(v) : Number(v.toPrecision(3))}
                {unit !== "" && ` ${unit}`}
              </span>
            ))}
          </div>
        </>
      )}
      <div className="flex items-center gap-1.5">
        <RangeInput value={range.min} placeholder={date ? "from" : "min"} parse={parseMin}
          format={format} onCommit={(min) => onChange({ ...range, min })} />
        <span className="shrink-0 text-[11px] text-faint">–</span>
        <RangeInput value={range.max} placeholder={date ? "to" : "max"} parse={parseMax}
          format={format} onCommit={(max) => onChange({ ...range, max })} />
        {unit !== "" && (
          <span className="w-6 shrink-0 text-right text-[11px] text-faint">{unit}</span>
        )}
      </div>
    </div>
  );
}

/** Informational only — no pointer handlers, aria-hidden. Bars whose bin
 *  interval intersects the active range are accent; the rest accent/25.
 *  No range set ⇒ everything is "in range" ⇒ all accent. */
function Histogram({ hist, range }: { hist: RangeHistogram; range: RangeFilter }): ReactElement {
  const max = hist.bins.reduce((m, n) => Math.max(m, n), 0);
  return (
    <div aria-hidden className="mb-1.5 flex h-6 w-full items-end gap-px">
      {hist.bins.map((n, i) => {
        const inRange =
          (range.min === null || hist.edges[i + 1]! >= range.min) &&
          (range.max === null || hist.edges[i]! <= range.max);
        return (
          <div
            key={i}
            className={clsx("flex-1 rounded-[1px]", inRange ? "bg-accent" : "bg-accent/25")}
            style={{ height: n === 0 ? "0" : `${Math.max(8, (n / max) * 100)}%` }}
          />
        );
      })}
    </div>
  );
}

const maxCount = (rows: readonly { count: number }[]): number =>
  rows.reduce((m, r) => Math.max(m, r.count), 0);

/** One active constraint in the header token row. */
interface Token {
  key: string;
  label: string;
  remove: () => void;
}

/**
 * The popup subtree, rendered ONLY while open — the hooks live here, so a
 * closed popup pays for none of the counting or grouping passes (duration/
 * dims/thumb batches during a scan re-render only FilterMenu's O(1) button).
 * Counts recompute in one frame on open — accepted.
 */
export default function FilterPopup({
  kind,
  openGroups,
  onToggleGroup,
  badge,
}: {
  kind: AssetKind;
  openGroups: Record<FacetId, boolean>;
  onToggleGroup: (id: FacetId) => void;
  badge: (id: FacetId) => number;
}): ReactElement {
  const filters = useLibraryStore((s) => s.tabs[kind].filters);
  const patchTab = useLibraryStore((s) => s.patchTab);
  const toggleExt = useLibraryStore((s) => s.toggleExt);
  const clearFilters = useLibraryStore((s) => s.clearFilters);
  // Mounted ⇔ open: one grouping pass serves both the Material rows and the
  // faceted counts. useVisibleFiles runs its own only while the facet is on.
  const membership = useMaterialMembership(kind === "texture");
  const counts = useFacetCounts(kind, membership);

  const apply = (patch: Partial<TabFilters>): void =>
    patchTab(kind, { filters: { ...filters, ...patch } });

  // The lazily-probed facets: while one is on, some files may not have been
  // measured yet, and unknown = keep means they linger until their batch lands.
  // Material is always-measured once computed — never lazy. Color rides the
  // thumbnail decode; channels/sample-rate ride the audio probe.
  const lazyFacetOn =
    (kind === "audio" &&
      (rangeActive(filters.duration) ||
        filters.audioChannels.size > 0 ||
        filters.sampleRates.size > 0)) ||
    (kind === "texture" &&
      (rangeActive(filters.res) || filters.square || filters.pot || filters.colors.size > 0));

  // Tokens in facet-group order, canonical vocabulary order within a facet —
  // never insertion order, so they don't reshuffle. Each removal is the exact
  // inverse of its option row's toggle; a range token clears the WHOLE facet
  // (both ends) — the exact inverse of "this facet is active".
  const tokens: Token[] = [];
  for (const id of FACET_ORDER[kind]) {
    switch (id) {
      case "format":
        for (const o of counts.format) {
          if (o.selected) {
            tokens.push({
              key: `format:${o.value}`,
              label: o.value,
              remove: () => toggleExt(kind, o.value),
            });
          }
        }
        break;
      case "favorite":
        if (filters.favorite) {
          tokens.push({
            key: "favorite",
            label: "Favorite",
            remove: () => apply({ favorite: false }),
          });
        }
        break;
      case "duration":
        if (rangeActive(filters.duration)) {
          tokens.push({
            key: "duration",
            label: rangeToken("Length", filters.duration, "s"),
            remove: () => apply({ duration: emptyRange() }),
          });
        }
        break;
      case "audioChannels":
        for (const o of counts.audioChannels) {
          if (o.selected) {
            tokens.push({
              key: `audioChannels:${o.value}`,
              label: AUDIO_CHANNEL_GROUP_LABEL[o.value],
              remove: () => apply({ audioChannels: toggled(filters.audioChannels, o.value) }),
            });
          }
        }
        break;
      case "sampleRate":
        for (const o of counts.sampleRates) {
          if (o.selected) {
            tokens.push({
              key: `sampleRate:${o.value}`,
              label: SAMPLE_RATE_BUCKET_LABEL[o.value],
              remove: () => apply({ sampleRates: toggled(filters.sampleRates, o.value) }),
            });
          }
        }
        break;
      case "material":
        // The group hosts two constraints: membership first, then channels.
        if (filters.material) {
          tokens.push({
            key: "material",
            label: "Material",
            remove: () => apply({ material: false }),
          });
        }
        for (const o of counts.channels) {
          if (o.selected) {
            tokens.push({
              key: `channels:${o.value}`,
              label: CHANNEL_GROUP_LABEL[o.value],
              remove: () => apply({ channels: toggled(filters.channels, o.value) }),
            });
          }
        }
        break;
      case "color":
        for (const o of counts.colors) {
          if (o.selected) {
            tokens.push({
              key: `color:${o.value}`,
              label: COLOR_BUCKET_LABEL[o.value],
              remove: () => apply({ colors: toggled(filters.colors, o.value) }),
            });
          }
        }
        break;
      case "res":
        if (rangeActive(filters.res)) {
          tokens.push({
            key: "res",
            label: rangeToken("Resolution", filters.res, "px"),
            remove: () => apply({ res: emptyRange() }),
          });
        }
        break;
      case "shape":
        if (filters.square) {
          tokens.push({
            key: "shape:square",
            label: "Square",
            remove: () => apply({ square: false }),
          });
        }
        if (filters.pot) {
          tokens.push({
            key: "shape:pot",
            label: "Power of two",
            remove: () => apply({ pot: false }),
          });
        }
        break;
      case "size":
        if (rangeActive(filters.size)) {
          tokens.push({
            key: "size",
            label: rangeToken("Size", filters.size, "MB"),
            remove: () => apply({ size: emptyRange() }),
          });
        }
        break;
      case "modified":
        if (rangeActive(filters.modified)) {
          tokens.push({
            key: "modified",
            label: rangeToken("Modified", filters.modified, "", formatDate),
            remove: () => apply({ modified: emptyRange() }),
          });
        }
        break;
    }
  }

  const renderRows = (id: FacetId): ReactNode => {
    switch (id) {
      case "format": {
        const max = maxCount(counts.format);
        return counts.format.map((o) => (
          <OptionRow
            key={o.value}
            kind={kind}
            label={o.value}
            count={o.count}
            max={max}
            selected={o.selected}
            onClick={() => toggleExt(kind, o.value)}
          />
        ));
      }
      case "favorite":
        return (
          <OptionRow
            kind={kind}
            label="Favorite"
            count={counts.favorite.count}
            max={counts.favorite.count}
            selected={counts.favorite.selected}
            onClick={() => apply({ favorite: !filters.favorite })}
          />
        );
      case "audioChannels": {
        const max = maxCount(counts.audioChannels);
        return counts.audioChannels.map((o) => (
          <OptionRow
            key={o.value}
            kind={kind}
            label={AUDIO_CHANNEL_GROUP_LABEL[o.value]}
            count={o.count}
            max={max}
            selected={o.selected}
            onClick={() => apply({ audioChannels: toggled(filters.audioChannels, o.value) })}
          />
        ));
      }
      case "sampleRate": {
        const max = maxCount(counts.sampleRates);
        return counts.sampleRates.map((o) => (
          <OptionRow
            key={o.value}
            kind={kind}
            label={SAMPLE_RATE_BUCKET_LABEL[o.value]}
            count={o.count}
            max={max}
            selected={o.selected}
            onClick={() => apply({ sampleRates: toggled(filters.sampleRates, o.value) })}
          />
        ));
      }
      case "color": {
        // Swatches, not OptionRows — the fill IS the label. A wrap row keeps
        // canonical order; a zero-count unselected swatch dims but stays (the
        // OptionRow dead-row rule), and count + name live in the tooltip.
        if (counts.colors.length === 0) {
          return (
            <div className="px-2.5 pb-1.5 pt-0.5 text-[10px] leading-snug text-faint">
              Nothing measured yet
            </div>
          );
        }
        return (
          <div className="flex flex-wrap gap-1.5 px-2.5 pb-1.5 pt-0.5">
            {counts.colors.map((o) => {
              const dead = o.count === 0 && !o.selected;
              return (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={o.selected}
                  disabled={dead}
                  title={`${COLOR_BUCKET_LABEL[o.value]} · ${o.count.toLocaleString()} ${NOUN[kind]}`}
                  onClick={() => apply({ colors: toggled(filters.colors, o.value) })}
                  className={clsx(
                    "flex h-6 w-6 items-center justify-center rounded-full ring-inset transition-[box-shadow,opacity] duration-[120ms]",
                    o.selected
                      ? "ring-2 ring-accent"
                      : dead
                        ? "opacity-30 ring-1 ring-bg"
                        : "ring-1 ring-bg hover:ring-2 hover:ring-accent/50",
                  )}
                  style={{ backgroundColor: COLOR_SWATCH[o.value] }}
                >
                  {o.selected && (
                    <Check
                      size={12}
                      strokeWidth={3}
                      // A white check drowns on the light/yellow swatches.
                      className={
                        o.value === "light" || o.value === "yellow" || o.value === "gray"
                          ? "text-black/75"
                          : "text-white"
                      }
                    />
                  )}
                </button>
              );
            })}
          </div>
        );
      }
      case "duration":
      case "res":
      case "size":
      case "modified": {
        const hist = counts[id];
        if (hist === null) return null;
        const cfg = RANGE_FACET[id];
        return (
          <RangeRow
            hist={hist}
            range={filters[id]}
            unit={cfg.unit}
            integer={cfg.integer}
            date={cfg.date}
            log={cfg.log}
            onChange={(r) => apply({ [id]: r })}
          />
        );
      }
      case "material": {
        if (counts.material === null) return null;
        const max = maxCount(counts.channels);
        return (
          <>
            <OptionRow
              kind={kind}
              label="Material"
              count={counts.material.count}
              max={counts.material.count}
              selected={counts.material.selected}
              onClick={() => apply({ material: !filters.material })}
            />
            {/* Channel selection lives inside the Material group, but is an
                independent constraint — a lone normal map matches "Normal"
                without being in a set. The inset label separates the two. */}
            {counts.channels.length > 0 && (
              <div className="mb-0.5 mt-1.5 pl-2.5 text-[9px] font-medium uppercase tracking-wide text-faint/80">
                Channel
              </div>
            )}
            {counts.channels.map((o) => (
              <OptionRow
                key={o.value}
                kind={kind}
                label={CHANNEL_GROUP_LABEL[o.value]}
                count={o.count}
                max={max}
                selected={o.selected}
                onClick={() => apply({ channels: toggled(filters.channels, o.value) })}
              />
            ))}
          </>
        );
      }
      case "shape": {
        if (counts.shape === null) return null;
        const { square, pot } = counts.shape;
        const max = Math.max(square.count, pot.count);
        return (
          <>
            <OptionRow
              kind={kind}
              label="Square"
              count={square.count}
              max={max}
              selected={square.selected}
              onClick={() => apply({ square: !filters.square })}
            />
            <OptionRow
              kind={kind}
              label="Power of two"
              count={pot.count}
              max={max}
              selected={pot.selected}
              onClick={() => apply({ pot: !filters.pot })}
            />
          </>
        );
      }
    }
  };

  return (
    <div className="absolute left-0 top-[calc(100%+4px)] z-50 flex w-80 flex-col rounded-xl bg-raised shadow-e2">
      {/* Header slab: active constraints as removable tokens (they ARE the
          summary), or the plain caption when nothing is active. */}
      <div className="shrink-0 p-3 pb-2">
        {tokens.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {tokens.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={t.remove}
                className="group flex h-6 items-center gap-1 rounded-full bg-accent-fill pl-2.5 pr-1 text-[11px] font-medium text-accent-fg transition-colors duration-[120ms] hover:brightness-110"
              >
                {t.label}
                <span className="flex h-4 w-4 items-center justify-center rounded-full text-accent-fg/60 transition-colors duration-[120ms] group-hover:bg-accent/25 group-hover:text-accent-fg">
                  <X size={11} />
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => clearFilters(kind)}
              className="ml-auto self-center pl-1 text-[11px] text-dim transition-colors duration-[120ms] hover:text-text"
            >
              Reset all
            </button>
          </div>
        ) : (
          <span className="text-[10px] font-medium uppercase tracking-wide text-faint">
            Filters
          </span>
        )}
      </div>

      {/* Only the body scrolls; headers render even with empty row sets —
          they are the stable skeleton. */}
      <div className="facet-scroll min-h-0 max-h-[min(60vh,440px)] overflow-y-auto px-1.5 pb-1.5">
        {FACET_ORDER[kind].map((id) => (
          <FacetGroup
            key={id}
            label={FACET_LABEL[id]}
            badge={badge(id)}
            open={openGroups[id]}
            onToggle={() => onToggleGroup(id)}
          >
            {renderRows(id)}
          </FacetGroup>
        ))}
      </div>

      <div className="shrink-0 rounded-b-xl border-t border-bg px-3 py-2">
        <div className="text-[11px] tabular-nums text-dim">
          <span className="font-medium text-text">{counts.visible.toLocaleString()}</span> of{" "}
          {counts.scoped.toLocaleString()} {NOUN[kind]}
        </div>
        {lazyFacetOn && (
          <div className="mt-1 text-[10px] leading-snug text-faint">
            Files not yet measured stay visible until their data arrives.
          </div>
        )}
      </div>
    </div>
  );
}
