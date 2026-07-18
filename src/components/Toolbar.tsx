import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
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
  X,
} from "lucide-react";
import { EXTENSIONS, SORT_FIELDS_BY_KIND, type AssetKind, type SortField } from "../types";
import { useLibraryStore } from "../stores/libraryStore";
import { useRenderPrefs } from "../stores/renderPrefs";
import { usePanelPrefs } from "../stores/panelPrefs";
import { usePresentExts } from "../hooks/useVisibleFiles";
import { MAX_CELL, MIN_CELL } from "../stores/settings";

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

const SORT_LABELS: Record<SortField, string> = {
  name: "Name",
  ext: "Type",
  size: "Size",
  modified: "Modified",
  duration: "Length",
};

const PLACEHOLDER: Record<AssetKind, string> = {
  audio: "Search samples…",
  texture: "Search textures…",
  model: "Search models…",
};

export interface ToolbarProps {
  kind: AssetKind;
}

export default function Toolbar({ kind }: ToolbarProps): ReactElement {
  const tab = useLibraryStore((s) => s.tabs[kind]);
  const setQuery = useLibraryStore((s) => s.setQuery);
  const toggleExt = useLibraryStore((s) => s.toggleExt);
  const clearExts = useLibraryStore((s) => s.clearExts);
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

  // A custom sort dropdown — the native <select> popup can't be rounded or
  // themed in WebView2, so it never matched the rest of the app.
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!sortOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (sortRef.current !== null && !sortRef.current.contains(e.target as Node)) setSortOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setSortOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [sortOpen]);

  const { query, extFilter, sortField, sortDir, viewMode, cellSize, groupMaterials } = tab;
  // Audio has no grid implementation — never render a control that does nothing.
  const canGrid = kind !== "audio";

  const present = usePresentExts(kind);
  // Keep an active filter's chip even if its format has left the scope —
  // otherwise the filter is applied with no way to see or clear it.
  const chips = useMemo(() => {
    const shown = new Map(present.map((p) => [p.ext, p]));
    for (const e of extFilter) if (!shown.has(e)) shown.set(e, { ext: e, count: 0 });
    return EXTENSIONS[kind].filter((e) => shown.has(e)).map((e) => shown.get(e)!);
  }, [present, extFilter, kind]);

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-y border-bg bg-panel px-3">
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

      {/* Only formats that actually exist here; an active filter whose format
          left the scope stays visible, or you'd be filtering by something you
          can no longer see or clear. This flexes to fill the leftover width and
          scrolls horizontally (bar hidden) when the window is too narrow to lay
          every chip out — chips must never wrap and clip under the fixed
          toolbar height. */}
      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {chips.map(({ ext, count }) => (
          <button
            key={ext}
            type="button"
            title={`${count.toLocaleString()} ${ext} file${count === 1 ? "" : "s"}`}
            className={clsx("chip shrink-0", extFilter.has(ext) && "chip-active")}
            onClick={() => toggleExt(kind, ext)}
          >
            {ext}
            <span className="ml-1 tabular-nums opacity-55">{count}</span>
          </button>
        ))}
        {extFilter.size > 0 && (
          <button
            type="button"
            title="Clear format filter"
            className="shrink-0 text-dim transition-colors duration-[120ms] hover:text-text"
            onClick={() => clearExts(kind)}
          >
            <X size={11} />
          </button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {kind === "texture" && (
          <button
            type="button"
            title={
              pixelArt
                ? "Pixel — nearest-neighbour scaling (crisp). Click for smooth. Applies to every thumbnail and preview."
                : "Smooth — bilinear scaling. Click for pixel. Applies to every thumbnail and preview."
            }
            className={clsx(
              "flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium transition-[background-color,transform,color] duration-[120ms]",
              pixelArt
                ? "bg-accent-fill font-medium text-accent-fg shadow-e1"
                : "bg-bg text-dim hover:-translate-y-px hover:bg-overlay hover:text-text",
            )}
            onClick={togglePixelArt}
          >
            {pixelArt ? <Grid2x2 size={12} /> : <Blend size={12} />}
            {pixelArt ? "Pixel" : "Smooth"}
          </button>
        )}

        {kind === "texture" && viewMode === "grid" && (
          <button
            type="button"
            title="Collapse loose files that form one PBR material into a single cell"
            className={clsx(
              "flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium transition-[background-color,transform,color] duration-[120ms]",
              groupMaterials
                ? "bg-accent-fill font-medium text-accent-fg shadow-e1"
                : "bg-bg text-dim hover:-translate-y-px hover:bg-overlay hover:text-text",
            )}
            onClick={() => patchTab(kind, { groupMaterials: !groupMaterials })}
          >
            <Layers size={12} />
            Group materials
          </button>
        )}

        {canGrid && viewMode === "grid" && (
          <button
            type="button"
            title={showCellInfo ? "Hide info pills on cells" : "Show info pills on cells"}
            className={clsx(
              "flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] font-medium transition-[background-color,transform,color] duration-[120ms]",
              showCellInfo
                ? "bg-accent-fill font-medium text-accent-fg shadow-e1"
                : "bg-bg text-dim hover:-translate-y-px hover:bg-overlay hover:text-text",
            )}
            onClick={toggleCellInfo}
          >
            {showCellInfo ? <Eye size={12} /> : <EyeOff size={12} />}
            Info
          </button>
        )}

        {canGrid && viewMode === "grid" && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-faint">Cell size</span>
            <input
              type="range"
              aria-label="Cell size"
              title={`Thumbnail size — ${cellSize}px`}
              min={MIN_CELL}
              max={MAX_CELL}
              step={4}
              value={cellSize}
              className="volume w-20"
              style={{ ["--fill" as string]: `${((cellSize - MIN_CELL) / (MAX_CELL - MIN_CELL)) * 100}%` }}
              onChange={(e) => patchTab(kind, { cellSize: Number(e.currentTarget.value) })}
            />
          </div>
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
