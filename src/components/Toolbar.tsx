import { useMemo, type ReactElement } from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Layers, LayoutGrid, List, Search, X } from "lucide-react";
import { EXTENSIONS, SORT_FIELDS_BY_KIND, type AssetKind, type SortField } from "../types";
import { useLibraryStore } from "../stores/libraryStore";
import { usePresentExts } from "../hooks/useVisibleFiles";
import { MAX_CELL, MIN_CELL } from "../stores/settings";

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
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
      <div className="relative w-56 shrink-0">
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"
        />
        <input
          type="text"
          value={query}
          spellCheck={false}
          placeholder={PLACEHOLDER[kind]}
          className="h-7 w-full rounded-md border border-border bg-raised pl-8 pr-7 text-xs text-text outline-none transition-colors duration-[120ms] placeholder:text-dim focus:border-accent"
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

      {/* Only formats that actually exist here. No overflow scroll: the row is
          short because the data is, and every chip can produce a result. An
          active filter whose format left the scope stays visible, or you'd be
          filtering by something you can no longer see or clear. */}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
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
            className="text-dim transition-colors duration-[120ms] hover:text-text"
            onClick={() => clearExts(kind)}
          >
            <X size={11} />
          </button>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {kind === "texture" && viewMode === "grid" && (
          <button
            type="button"
            title="Collapse loose files that form one PBR material into a single cell"
            className={clsx(
              "flex h-[26px] items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors duration-[120ms]",
              groupMaterials
                ? "border-accent/45 bg-accent/12 text-accent"
                : "border-border text-dim hover:bg-raised hover:text-text",
            )}
            onClick={() => patchTab(kind, { groupMaterials: !groupMaterials })}
          >
            <Layers size={12} />
            Group materials
          </button>
        )}

        {canGrid && viewMode === "grid" && (
          <input
            type="range"
            aria-label="Cell size"
            min={MIN_CELL}
            max={MAX_CELL}
            step={4}
            value={cellSize}
            className="volume w-20"
            style={{ ["--fill" as string]: `${((cellSize - MIN_CELL) / (MAX_CELL - MIN_CELL)) * 100}%` }}
            onChange={(e) => patchTab(kind, { cellSize: Number(e.currentTarget.value) })}
          />
        )}

        <select
          value={sortField}
          aria-label="Sort by"
          className="sort-select"
          onChange={(e) => setSort(kind, e.currentTarget.value as SortField)}
        >
          {SORT_FIELDS_BY_KIND[kind].map((f) => (
            <option key={f} value={f}>
              {SORT_LABELS[f]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-btn"
          title={sortDir === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}
          onClick={() => toggleSortDir(kind)}
        >
          {sortDir === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
        </button>

        {canGrid && (
          <div className="ml-1 flex overflow-hidden rounded-md border border-border">
            {(["grid", "list"] as const).map((mode) => {
              const Icon = mode === "grid" ? LayoutGrid : List;
              return (
                <button
                  key={mode}
                  type="button"
                  title={mode === "grid" ? "Grid" : "List"}
                  className={clsx(
                    "flex h-[26px] w-7 items-center justify-center transition-colors duration-[120ms]",
                    viewMode === mode
                      ? "bg-accent/12 text-accent"
                      : "text-dim hover:bg-raised hover:text-text",
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
    </div>
  );
}
