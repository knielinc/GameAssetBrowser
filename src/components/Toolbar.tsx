import type { ReactElement } from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { AUDIO_EXTENSIONS, type SortField } from "../types";
import { useLibraryStore } from "../stores/libraryStore";

const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "ext", label: "Type" },
  { value: "size", label: "Size" },
  { value: "modified", label: "Modified" },
  { value: "duration", label: "Length" },
];

export default function Toolbar(): ReactElement {
  const query = useLibraryStore((s) => s.query);
  const setQuery = useLibraryStore((s) => s.setQuery);
  const extFilter = useLibraryStore((s) => s.extFilter);
  const toggleExt = useLibraryStore((s) => s.toggleExt);
  const sortField = useLibraryStore((s) => s.sortField);
  const sortDir = useLibraryStore((s) => s.sortDir);
  const setSort = useLibraryStore((s) => s.setSort);
  const toggleSortDir = useLibraryStore((s) => s.toggleSortDir);

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
      <div className="relative w-64 shrink-0">
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"
        />
        <input
          type="text"
          value={query}
          spellCheck={false}
          placeholder="Search samples…"
          className="h-7 w-full rounded-md border border-border bg-raised pl-8 pr-7 text-xs text-text outline-none transition-colors duration-[120ms] placeholder:text-dim focus:border-accent"
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
        />
        {query !== "" && (
          <button
            type="button"
            title="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-dim transition-colors duration-[120ms] hover:text-text"
            onClick={() => setQuery("")}
          >
            <X size={12} />
          </button>
        )}
      </div>

      <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
        {AUDIO_EXTENSIONS.map((ext) => (
          <button
            key={ext}
            type="button"
            className={clsx("chip shrink-0", extFilter.has(ext) && "chip-active")}
            onClick={() => toggleExt(ext)}
          >
            {ext}
          </button>
        ))}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <select
          value={sortField}
          aria-label="Sort by"
          className="sort-select"
          onChange={(e) => setSort(e.currentTarget.value as SortField)}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-btn"
          title={sortDir === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}
          onClick={toggleSortDir}
        >
          {sortDir === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
        </button>
      </div>
    </div>
  );
}
