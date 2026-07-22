import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import clsx from "clsx";
import {
  ArrowDown,
  ArrowUp,
  Blend,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Grid2x2,
  Layers,
  LayoutGrid,
  List,
  PanelLeft,
  PanelRight,
  Search,
  Shuffle,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { SORT_FIELDS_BY_KIND, type AssetKind, type SortField } from "../types";
import { activeFilterCount, useLibraryStore } from "../stores/libraryStore";
import FilterMenu from "./FilterMenu";
import { useRenderPrefs } from "../stores/renderPrefs";
import { usePanelPrefs } from "../stores/panelPrefs";
import { shuffleVisible, useShuffleStore } from "../stores/shuffle";
import { MAX_CELL, MIN_CELL } from "../stores/settings";
import { useOverflowCollapse } from "../hooks/useOverflowCollapse";

/** A folder/inspector panel toggle, sitting next to the panel it opens. */
function PanelToggle({
  on,
  onClick,
  icon: Icon,
  title,
}: {
  on: boolean;
  onClick: () => void;
  icon: typeof PanelLeft;
  title: string;
}): ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      className={clsx(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors duration-[120ms]",
        on ? "bg-accent-fill text-accent-fg" : "text-dim hover:bg-overlay hover:text-text",
      )}
      onClick={onClick}
    >
      <Icon size={14} />
    </button>
  );
}

/**
 * A labelled toggle pill (Smooth, Group materials, Info). Renders as a rounded
 * pill on the bar, or a full-width row when it lives inside the overflow popup
 * — same behaviour, so the two layouts share one component.
 */
function PillToggle({
  active,
  icon: Icon,
  label,
  title,
  onClick,
  menu = false,
}: {
  active: boolean;
  icon: typeof Layers;
  label: string;
  title: string;
  onClick: () => void;
  menu?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      className={clsx(
        "flex items-center gap-1.5 text-[11px] font-medium transition-[background-color,transform,color] duration-[120ms]",
        menu ? "h-9 w-full justify-start rounded-lg px-3" : "h-8 rounded-full px-3",
        active
          ? "bg-accent-fill text-accent-fg shadow-e1"
          : clsx("bg-bg text-dim hover:bg-overlay hover:text-text", !menu && "hover:-translate-y-px"),
      )}
      onClick={onClick}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}

/** The cell-size slider — inline on the bar, or stacked in the popup. */
function CellSizeControl({
  cellSize,
  onChange,
  menu = false,
}: {
  cellSize: number;
  onChange: (v: number) => void;
  menu?: boolean;
}): ReactElement {
  return (
    <div className={menu ? "flex flex-col gap-1.5 px-1 py-1" : "flex items-center gap-2"}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-faint">Cell size</span>
      <input
        type="range"
        aria-label="Cell size"
        title={`Thumbnail size — ${cellSize}px`}
        min={MIN_CELL}
        max={MAX_CELL}
        step={4}
        value={cellSize}
        className={clsx("volume", menu ? "w-full" : "w-20")}
        style={{ ["--fill" as string]: `${((cellSize - MIN_CELL) / (MAX_CELL - MIN_CELL)) * 100}%` }}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
    </div>
  );
}

const SORT_LABELS: Record<SortField, string> = {
  name: "Name",
  ext: "Format",
  size: "Size",
  modified: "Modified",
  duration: "Length",
};

const PLACEHOLDER: Record<AssetKind, string> = {
  audio: "Search samples…",
  texture: "Search images…",
  model: "Search models…",
  document: "Search documents…",
};

/** Close a popup on outside-click or Escape. Escape is captured + stopped so it
 *  doesn't also reach the window shortcut handler (which clears selection). */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, close, ref]);
}


export interface ToolbarProps {
  kind: AssetKind;
}

export default function Toolbar({ kind }: ToolbarProps): ReactElement {
  const tab = useLibraryStore((s) => s.tabs[kind]);
  const setQuery = useLibraryStore((s) => s.setQuery);
  const clearFilters = useLibraryStore((s) => s.clearFilters);
  const setSort = useLibraryStore((s) => s.setSort);
  const toggleSortDir = useLibraryStore((s) => s.toggleSortDir);
  const patchTab = useLibraryStore((s) => s.patchTab);
  const pixelArt = useRenderPrefs((s) => s.pixelArt);
  const togglePixelArt = useRenderPrefs((s) => s.toggle);
  const leftOpen = usePanelPrefs((s) => s.left);
  const rightOpen = usePanelPrefs((s) => s.right);
  const toggleLeft = usePanelPrefs((s) => s.toggleLeft);
  const toggleRight = usePanelPrefs((s) => s.toggleRight);
  const showCellInfo = useRenderPrefs((s) => s.showCellInfo);
  const toggleCellInfo = useRenderPrefs((s) => s.toggleCellInfo);
  // Published by TabPane so the dice greys out on an empty visible list.
  const shuffleCount = useShuffleStore((s) => s.count);

  // A custom sort dropdown — the native <select> popup can't be rounded or
  // themed in WebView2, so it never matched the rest of the app.
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement | null>(null);
  const closeSort = useCallback(() => setSortOpen(false), []);
  useDismiss(sortOpen, closeSort, sortRef);

  // When the bar is too narrow, the presentation controls fold into this popup.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  useDismiss(moreOpen, closeMore, moreRef);

  const { ref: barRef, compact } = useOverflowCollapse();

  const { query, sortField, sortDir, viewMode, cellSize, groupMaterials } = tab;
  // Audio has no grid implementation — never render a grid control that does
  // nothing. Documents support both (grid shows PDF/PSD thumbnails).
  const canGrid = kind !== "audio";
  const showInfo = canGrid && viewMode === "grid";

  const smoothPill = (menu: boolean): ReactElement => (
    <PillToggle
      menu={menu}
      active={pixelArt}
      icon={pixelArt ? Grid2x2 : Blend}
      label={pixelArt ? "Pixel" : "Smooth"}
      title={
        pixelArt
          ? "Pixel — nearest-neighbour scaling (crisp). Click for smooth. Applies to every thumbnail and preview."
          : "Smooth — bilinear scaling. Click for pixel. Applies to every thumbnail and preview."
      }
      onClick={togglePixelArt}
    />
  );
  const groupPill = (menu: boolean): ReactElement => (
    <PillToggle
      menu={menu}
      active={groupMaterials}
      icon={Layers}
      label="Group materials"
      title="Collapse loose files that form one PBR material into a single row/cell"
      onClick={() => patchTab(kind, { groupMaterials: !groupMaterials })}
    />
  );
  const infoPill = (menu: boolean): ReactElement => (
    <PillToggle
      menu={menu}
      active={showCellInfo}
      icon={showCellInfo ? Eye : EyeOff}
      label="Info"
      title={showCellInfo ? "Hide info pills on cells" : "Show info pills on cells"}
      onClick={toggleCellInfo}
    />
  );

  return (
    <div
      ref={barRef}
      className="flex h-12 shrink-0 items-center gap-3 border-y border-bg bg-panel px-3"
    >
      <PanelToggle
        on={leftOpen}
        onClick={toggleLeft}
        icon={PanelLeft}
        title={leftOpen ? "Hide folders panel" : "Show folders panel"}
      />
      <div className="relative w-56 min-w-[8rem] shrink">
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"
        />
        <input
          type="text"
          value={query}
          spellCheck={false}
          placeholder={PLACEHOLDER[kind]}
          className="h-8 w-full rounded-full border-0 bg-bg pl-8 pr-7 text-xs text-text outline-none transition-[background-color,box-shadow] duration-[120ms] placeholder:text-faint hover:bg-overlay focus:ring-2 focus:ring-accent/35"
          onChange={(e) => setQuery(kind, e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery(kind, "");
          }}
        />
        {query !== "" && (
          <button
            type="button"
            title="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-dim transition-colors duration-[120ms] hover:text-text"
            onClick={() => setQuery(kind, "")}
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Search and Filter — the "narrowing" controls sit together on the
          left; the right cluster stays presentation-only. Format chips live
          INSIDE the filter popup, so the bar keeps one calm cluster per side. */}
      {/* Keyed: Toolbar itself is NOT remounted per tab (only TabPane is), and
          FilterMenu's collapse state + debounced query derive per kind on
          mount — without the key they'd leak across tab switches. */}
      <FilterMenu key={kind} kind={kind} />
      {activeFilterCount(kind, tab) > 0 && (
        <button
          type="button"
          title="Clear filters"
          className="shrink-0 text-dim transition-colors duration-[120ms] hover:text-text"
          onClick={() => clearFilters(kind)}
        >
          <X size={11} />
        </button>
      )}

      {/* Shuffle sits with the narrowing cluster: it picks FROM the current
          visible list, so it reads as acting on what search/filters left. */}
      <button
        type="button"
        className="icon-btn"
        disabled={shuffleCount === 0}
        title={kind === "audio" ? "Shuffle — play a random sample" : "Shuffle — jump to a random item"}
        onClick={() => shuffleVisible(kind)}
      >
        <Shuffle size={13} />
      </button>

      <div className="min-w-0 flex-1" />

      <div className="flex shrink-0 items-center gap-1.5">
        {/* Full inline cluster. When it overflows the bar it folds into the
            popup below; the collapse hook remembers the width it gave up at and
            re-expands once the window grows clearly past it. */}
        {!compact && (
          <>
            {kind === "texture" && smoothPill(false)}
            {kind === "texture" && groupPill(false)}
            {showInfo && infoPill(false)}
            {showInfo && (
              <CellSizeControl
                cellSize={cellSize}
                onChange={(v) => patchTab(kind, { cellSize: v })}
              />
            )}

            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wide text-faint">Sort by</span>
              <div ref={sortRef} className="relative">
                <button
                  type="button"
                  aria-label="Sort by"
                  aria-expanded={sortOpen}
                  title={`Sort by — ${SORT_LABELS[sortField]}`}
                  className="flex h-[30px] items-center gap-2 rounded-full bg-bg pl-3 pr-2 text-[12px] text-text transition-colors duration-[120ms] hover:bg-overlay"
                  onClick={() => setSortOpen((o) => !o)}
                >
                  {SORT_LABELS[sortField]}
                  <ChevronDown
                    size={12}
                    className={clsx("text-faint transition-transform duration-[120ms]", sortOpen && "rotate-180")}
                  />
                </button>
                {sortOpen && (
                  <div className="absolute right-0 top-[calc(100%+6px)] z-50 min-w-[136px] rounded-xl bg-raised p-1 shadow-e2">
                    {SORT_FIELDS_BY_KIND[kind].map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={clsx(
                          "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors duration-[120ms]",
                          f === sortField
                            ? "bg-accent-fill text-accent-fg"
                            : "text-dim hover:bg-overlay hover:text-text",
                        )}
                        onClick={() => {
                          setSort(kind, f);
                          setSortOpen(false);
                        }}
                      >
                        {SORT_LABELS[f]}
                        {f === sortField && <Check size={13} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <button
              type="button"
              className="icon-btn"
              title={sortDir === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}
              onClick={() => toggleSortDir(kind)}
            >
              {sortDir === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
            </button>
          </>
        )}

        {/* Overflow popup — same controls, stacked, when the bar is too narrow. */}
        {compact && (
          <div ref={moreRef} className="relative">
            <button
              type="button"
              aria-label="View options"
              aria-expanded={moreOpen}
              title="View options"
              className={clsx("icon-btn", moreOpen && "icon-btn-active")}
              onClick={() => setMoreOpen((o) => !o)}
            >
              <SlidersHorizontal size={14} />
            </button>
            {moreOpen && (
              <div className="absolute right-0 top-[calc(100%+6px)] z-50 flex w-60 flex-col gap-1 rounded-xl bg-raised p-2 shadow-e2">
                {kind === "texture" && smoothPill(true)}
                {kind === "texture" && groupPill(true)}
                {showInfo && infoPill(true)}
                {showInfo && (
                  <CellSizeControl
                    menu
                    cellSize={cellSize}
                    onChange={(v) => patchTab(kind, { cellSize: v })}
                  />
                )}

                <div className="mt-1 border-t border-bg pt-2">
                  <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-faint">
                    Sort by
                  </div>
                  {SORT_FIELDS_BY_KIND[kind].map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={clsx(
                        "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors duration-[120ms]",
                        f === sortField
                          ? "bg-accent-fill text-accent-fg"
                          : "text-dim hover:bg-overlay hover:text-text",
                      )}
                      onClick={() => setSort(kind, f)}
                    >
                      {SORT_LABELS[f]}
                      {f === sortField && <Check size={13} />}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-dim transition-colors duration-[120ms] hover:bg-overlay hover:text-text"
                    onClick={() => toggleSortDir(kind)}
                  >
                    {sortDir === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                    {sortDir === "asc" ? "Ascending" : "Descending"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {canGrid && (
          <div className="ml-1 flex items-center gap-0.5 rounded-full bg-bg p-0.5">
            {(["grid", "list"] as const).map((mode) => {
              const Icon = mode === "grid" ? LayoutGrid : List;
              return (
                <button
                  key={mode}
                  type="button"
                  title={mode === "grid" ? "Grid" : "List"}
                  className={clsx(
                    "flex h-7 w-8 items-center justify-center rounded-full transition-[background-color,color] duration-[120ms]",
                    viewMode === mode
                      ? "bg-raised text-accent shadow-e1"
                      : "text-faint hover:text-text",
                  )}
                  onClick={() => patchTab(kind, { viewMode: mode })}
                >
                  <Icon size={13} />
                </button>
              );
            })}
          </div>
        )}
      </div>
      {canGrid && (
        <PanelToggle
          on={rightOpen}
          onClick={toggleRight}
          icon={PanelRight}
          title={rightOpen ? "Hide inspector" : "Show inspector"}
        />
      )}
    </div>
  );
}
