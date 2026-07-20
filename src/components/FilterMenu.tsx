import { useEffect, useRef, useState, type ReactElement } from "react";
import clsx from "clsx";
import { ListFilter } from "lucide-react";
import { rangeActive, type AssetKind } from "../types";
import { activeFilterCount, useLibraryStore } from "../stores/libraryStore";
import FilterPopup, { FACET_ORDER, type FacetId } from "./FilterPopup";

/**
 * The Filter button + lazily-mounted popup. Only the popup subtree (see
 * FilterPopup) runs the counting and grouping passes — while it is closed this
 * component subscribes to filters/extFilter alone, so duration/dims/thumb
 * batches during a scan re-render nothing but the O(1) button.
 */
export default function FilterMenu({ kind }: { kind: AssetKind }): ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const filters = useLibraryStore((s) => s.tabs[kind].filters);
  const extFilter = useLibraryStore((s) => s.tabs[kind].extFilter);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Capture + stop: Escape closes the filter popup without also reaching the
      // window-level shortcut handler, which would collapse a multi-selection.
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const facetBadge = (id: FacetId): number => {
    switch (id) {
      case "format":
        return extFilter.size;
      case "favorite":
        return filters.favorite ? 1 : 0;
      case "collections":
        return filters.collections.size;
      case "duration":
        return rangeActive(filters.duration) ? 1 : 0;
      case "audioChannels":
        return filters.audioChannels.size;
      case "sampleRate":
        return filters.sampleRates.size;
      case "color":
        return filters.colors.size;
      case "material":
        // The group hosts membership AND the channel rows — badge both.
        return (filters.material ? 1 : 0) + filters.channels.size;
      case "res":
        return rangeActive(filters.res) ? 1 : 0;
      case "shape":
        return (filters.square ? 1 : 0) + (filters.pot ? 1 : 0);
      case "size":
        return rangeActive(filters.size) ? 1 : 0;
      case "modified":
        return rangeActive(filters.modified) ? 1 : 0;
    }
  };

  // Session-only collapse state, derived ONCE on mount: first facet open plus
  // every facet with an active selection. Never auto-mutated afterwards — a
  // selection can only happen inside an already-open body. Toolbar mounts this
  // component with key={kind}, so a tab switch remounts and re-derives per
  // kind (Toolbar itself is not keyed — only TabPane is). Lives HERE, not in
  // FilterPopup, so collapse choices survive popup close/reopen in a session.
  const [openGroups, setOpenGroups] = useState<Record<FacetId, boolean>>(() => {
    const init = {} as Record<FacetId, boolean>;
    for (const id of FACET_ORDER[kind]) init[id] = id === "format" || facetBadge(id) > 0;
    return init;
  });
  const toggleGroup = (id: FacetId): void => setOpenGroups((s) => ({ ...s, [id]: !s[id] }));

  const n = activeFilterCount(kind, { filters, extFilter });

  return (
    <div ref={ref} className="relative shrink-0">
      {n > 0 ? (
        <button
          type="button"
          title={`${n} filter${n === 1 ? "" : "s"} active`}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-accent-fill px-2.5 text-[11px] font-medium text-accent-fg transition-colors duration-[120ms]"
        >
          <ListFilter size={13} />
          <span className="tabular-nums">{n}</span>
        </button>
      ) : (
        <button
          type="button"
          title="Filters"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={clsx(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors duration-[120ms]",
            open ? "bg-accent-fill text-accent-fg" : "text-dim hover:bg-overlay hover:text-text",
          )}
        >
          <ListFilter size={14} />
        </button>
      )}

      {open && (
        <FilterPopup kind={kind} openGroups={openGroups} onToggleGroup={toggleGroup} badge={facetBadge} />
      )}
    </div>
  );
}
