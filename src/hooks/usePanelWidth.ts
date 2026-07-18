import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** Added to <html> while a drag is live; styles.css pins the col-resize cursor
    and kills user-select everywhere for the duration. Shared by every panel. */
const RESIZING_CLASS = "sidebar-resizing";

export interface PanelWidthConfig {
  /** localStorage key — UI chrome, deliberately kept out of the settings store. */
  storageKey: string;
  min: number;
  max: number;
  defaultWidth: number;
  /** Which edge the panel is anchored to. A left panel grows as the handle
   *  moves right; a right panel grows as it moves left. */
  side: "left" | "right";
}

export interface PanelResizeHandleProps {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}

export interface PanelWidthApi {
  /** Current panel width in px, always within [min, max]. */
  width: number;
  /** True while the handle is being dragged. */
  isDragging: boolean;
  /** Spread onto the resize-handle element. */
  handleProps: PanelResizeHandleProps;
}

/**
 * Panel width state + the Pointer Events drag machinery for a resize handle,
 * generalized over which side the panel is anchored to. Pointer capture keeps
 * the drag alive when the cursor leaves the window; width is persisted to
 * localStorage on drag end (never per-move).
 */
export function usePanelWidth(config: PanelWidthConfig): PanelWidthApi {
  // Latest config without re-binding handlers each render.
  const cfgRef = useRef(config);
  cfgRef.current = config;

  const clamp = (width: number): number =>
    Math.min(cfgRef.current.max, Math.max(cfgRef.current.min, width));

  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(config.storageKey);
      if (raw === null) return config.defaultWidth;
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed)) return config.defaultWidth;
      return Math.min(config.max, Math.max(config.min, Math.round(parsed)));
    } catch {
      return config.defaultWidth;
    }
  });
  const [isDragging, setIsDragging] = useState(false);

  const widthRef = useRef(width);
  const dragStartRef = useRef<{ pointerX: number; width: number } | null>(null);

  const persist = (w: number): void => {
    try {
      window.localStorage.setItem(cfgRef.current.storageKey, String(w));
    } catch {
      // localStorage unavailable — the width just won't survive a restart.
    }
  };

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = { pointerX: e.clientX, width: widthRef.current };
    setIsDragging(true);
    document.documentElement.classList.add(RESIZING_CLASS);
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    const start = dragStartRef.current;
    if (start === null) return;
    // A right-anchored panel grows when the pointer moves LEFT, so flip the sign.
    const raw = e.clientX - start.pointerX;
    const delta = cfgRef.current.side === "right" ? -raw : raw;
    const next = clamp(start.width + delta);
    if (next !== widthRef.current) {
      widthRef.current = next;
      setWidth(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragStartRef.current === null) return;
    dragStartRef.current = null;
    setIsDragging(false);
    document.documentElement.classList.remove(RESIZING_CLASS);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    persist(widthRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDoubleClick = useCallback((): void => {
    const d = cfgRef.current.defaultWidth;
    widthRef.current = d;
    setWidth(d);
    persist(d);
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
