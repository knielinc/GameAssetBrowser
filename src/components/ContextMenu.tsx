import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";

export interface ContextMenuItem {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
}

export interface ContextMenuProps {
  /** Cursor position in viewport coordinates; the menu clamps itself to fit. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/** Gap kept between the menu and the viewport edge when clamping. */
const EDGE_MARGIN = 4;

/**
 * Custom context menu, portalled to <body> at a fixed position. The parent
 * owns the open state (render = open), which also guarantees only one menu
 * at a time. Self-closes on outside mousedown, Escape, window blur, or any
 * scroll; an item click runs its action and closes.
 */
export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps): ReactElement {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  // Measure and clamp before paint so the menu never overflows the
  // right/bottom viewport edges, even near the window borders.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - width - EDGE_MARGIN)),
      y: Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - height - EDGE_MARGIN)),
    });
  }, [x, y]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent): void => {
      const el = menuRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        // The menu swallows Escape so e.g. the search box doesn't also clear.
        e.stopPropagation();
        onClose();
      }
    };
    // Capture phase everywhere: a right-click's mousedown on another row must
    // close this menu before that row's contextmenu handler reopens it, and
    // the virtualized list's scroll events don't bubble.
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onClose, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onClose, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 min-w-44 rounded-xl bg-raised py-1.5 shadow-e2"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className="flex h-7 w-full items-center gap-2.5 px-3 text-[13px] text-text transition-colors duration-[120ms] hover:bg-raised"
          onClick={() => {
            onClose();
            item.onClick();
          }}
        >
          <item.icon size={14} className="shrink-0 text-dim" />
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
