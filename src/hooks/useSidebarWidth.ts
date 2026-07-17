import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 240;

/** UI-chrome state, deliberately kept out of the settings store. */
const STORAGE_KEY = "sidebarWidth";

/** Added to <html> while a drag is live; styles.css pins the col-resize
    cursor and kills user-select everywhere for the duration. */
const RESIZING_CLASS = "sidebar-resizing";

function clampWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return SIDEBAR_DEFAULT_WIDTH;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return SIDEBAR_DEFAULT_WIDTH;
    return clampWidth(Math.round(parsed));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function persistWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // localStorage unavailable — the width just won't survive a restart.
  }
}

export interface SidebarResizeHandleProps {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}

export interface SidebarWidthApi {
  /** Current sidebar width in px, always within [MIN, MAX]. */
  width: number;
  /** True while the handle is being dragged. */
  isDragging: boolean;
  /** Spread onto the resize-handle element. */
  handleProps: SidebarResizeHandleProps;
}

/**
 * Sidebar width state + the Pointer Events drag machinery for the resize
 * handle. Pointer capture keeps the drag alive when the cursor leaves the
 * window; width is persisted to localStorage on drag end (never per-move).
 */
export function useSidebarWidth(): SidebarWidthApi {
  const [width, setWidth] = useState<number>(readStoredWidth);
  const [isDragging, setIsDragging] = useState(false);

  // Latest width without re-binding handlers; drag origin while capturing.
  const widthRef = useRef(width);
  const dragStartRef = useRef<{ pointerX: number; width: number } | null>(null);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    // No default actions (text-selection initiation, focus shifts) from here.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = { pointerX: e.clientX, width: widthRef.current };
    setIsDragging(true);
    document.documentElement.classList.add(RESIZING_CLASS);
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    const start = dragStartRef.current;
    if (start === null) return;
    // Delta from the grab point preserves the pointer's offset on the handle.
    const next = clampWidth(start.width + (e.clientX - start.pointerX));
    if (next !== widthRef.current) {
      widthRef.current = next;
      setWidth(next);
    }
  }, []);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragStartRef.current === null) return;
    dragStartRef.current = null;
    setIsDragging(false);
    document.documentElement.classList.remove(RESIZING_CLASS);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    persistWidth(widthRef.current);
  }, []);

  const onDoubleClick = useCallback((): void => {
    widthRef.current = SIDEBAR_DEFAULT_WIDTH;
    setWidth(SIDEBAR_DEFAULT_WIDTH);
    persistWidth(SIDEBAR_DEFAULT_WIDTH);
  }, []);

  // Safety net: never leave the global resizing class behind on unmount.
  useEffect(() => {
    return () => document.documentElement.classList.remove(RESIZING_CLASS);
  }, []);

  return {
    width,
    isDragging,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick,
    },
  };
}
