import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Bookmark, Plus } from "lucide-react";
import { useFavoritesStore } from "../stores/favoritesStore";
import { useThemeStore } from "../stores/theme";

export interface CollectionPopupProps {
  /** Anchor position in viewport coordinates (the context-menu click). */
  x: number;
  y: number;
  /** File paths the pick applies to — the selection snapshot the opening
   *  context menu already resolved (materials expanded to member paths). */
  paths: string[];
  onClose: () => void;
}

/** Gap kept between the popup and the viewport edge when clamping. */
const EDGE_MARGIN = 4;

/**
 * "Add to collection…" chooser: a small anchored popup — the ContextMenu
 * portal/clamp/close idiom — listing every collection (click = add the
 * selection) plus a "New collection" input that creates and fills in one
 * stroke. Parent owns the open state (render = open), same as ContextMenu.
 */
export default function CollectionPopup({
  x,
  y,
  paths,
  onClose,
}: CollectionPopupProps): ReactElement {
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });
  const [name, setName] = useState("");
  const collections = useFavoritesStore((s) => s.collections);
  const addCollection = useFavoritesStore((s) => s.addCollection);
  const addToCollection = useFavoritesStore((s) => s.addToCollection);
  // Same zoom correction as ContextMenu: clamp in real px, place divided by
  // the UI-scale zoom.
  const z = useThemeStore((s) => s.uiScale) / 100;

  useLayoutEffect(() => {
    const el = popupRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - width - EDGE_MARGIN)),
      y: Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - height - EDGE_MARGIN)),
    });
  }, [x, y]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent): void => {
      const el = popupRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        // Swallow it — Escape must not also clear the search box behind us.
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const createAndAdd = (): void => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    // addCollection dedupes by name, so on a collision this just adds to the
    // existing collection — which is what typing its name means anyway.
    addCollection(trimmed);
    addToCollection(trimmed, paths);
    onClose();
  };

  return createPortal(
    <div
      ref={popupRef}
      className="fixed z-50 w-56 rounded-xl bg-raised py-1.5 shadow-e2"
      style={{ left: pos.x / z, top: pos.y / z }}
    >
      {collections.length === 0 ? (
        <p className="px-3 py-1 text-[11px] text-dim">No collections yet.</p>
      ) : (
        collections.map((c) => (
          <button
            key={c.name}
            type="button"
            className="flex h-7 w-full items-center gap-2.5 px-3 text-[13px] text-text transition-colors duration-[120ms] hover:bg-overlay"
            onClick={() => {
              addToCollection(c.name, paths);
              onClose();
            }}
          >
            <Bookmark size={13} className="shrink-0 text-dim" />
            <span className="min-w-0 flex-1 truncate text-left">{c.name}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-dim">{c.paths.length}</span>
          </button>
        ))
      )}
      <div className="mx-3 my-1.5 h-px bg-overlay" />
      <div className="flex items-center gap-1.5 px-3 pb-1">
        <input
          type="text"
          value={name}
          autoFocus
          spellCheck={false}
          placeholder="New collection…"
          className="h-7 min-w-0 flex-1 rounded-lg border-0 bg-bg px-2 text-xs text-text outline-none placeholder:text-faint focus:ring-2 focus:ring-accent/35"
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") createAndAdd();
          }}
        />
        <button
          type="button"
          title="Create the collection and add the selection"
          disabled={name.trim() === ""}
          className={clsx(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-[120ms]",
            name.trim() === ""
              ? "text-faint"
              : "text-accent hover:bg-overlay",
          )}
          onClick={createAndAdd}
        >
          <Plus size={14} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
