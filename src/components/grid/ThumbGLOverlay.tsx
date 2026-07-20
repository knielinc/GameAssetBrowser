import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import { useRenderPrefs } from "../../stores/renderPrefs";
import { useThemeStore } from "../../stores/theme";
import { ThumbGL, type DrawCell } from "./thumbGL";

/** Read a `#rrggbb` CSS var as [r,g,b] in 0..1 for a GL uniform. */
function cssRgb(name: string, fallback: [number, number, number]): [number, number, number] {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = /^#?([0-9a-fA-F]{6})$/.exec(v);
  if (m === null) return fallback;
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Letterbox = raised, checker = raised/panel — matches the CSS alpha-checker,
 *  so the thumbnail stage follows the active theme. */
function applyThemeColors(gl: ThumbGL): void {
  const raised = cssRgb("--color-raised", [0.153, 0.165, 0.208]);
  const panel = cssRgb("--color-panel", [0.118, 0.129, 0.165]);
  gl.setColors(raised, raised, panel);
}

export interface ThumbGLOverlayProps {
  /** The scrolling grid container to draw behind. */
  scrollRef: RefObject<HTMLElement | null>;
  /** Bumped by the owner whenever the item set or decoded thumbs change, so
   *  slots get (re-)measured and any 404'd fetches retried. */
  revision: number;
}

/**
 * Draws every visible thumbnail through ONE WebGL canvas, behind the grid.
 *
 * Cells render a transparent `[data-thumb-key]` slot instead of an `<img>`; the
 * canvas sits behind them (z-0, pointer-events:none) and paints each slot's
 * letterbox, checker and image from a GPU atlas in a single instanced draw. No
 * PNG, one draw call — #1 and #2. Chrome (badges, labels, selection) stays as
 * DOM on top.
 *
 * Alignment is by DOM measurement: each frame we read the slots' rects and draw
 * there, so the canvas can never drift from the cells. Compositor scrolling
 * moves the DOM before JS runs, so the repaint is inherently ≥1 frame late —
 * scroll events bridge the gap by translating the canvas by the scroll delta
 * until the next paint lands. The rAF loop stays hot through recent movement
 * and pending uploads, then self-stops; scroll/resize/data restart it.
 */
export default function ThumbGLOverlay({ scrollRef, revision }: ThumbGLOverlayProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const glRef = useRef<ThumbGL | null>(null);
  const scheduleRef = useRef<(() => void) | null>(null);
  const pixelArt = useRenderPrefs((s) => s.pixelArt);
  const themeId = useThemeStore((s) => s.themeId);

  useEffect(() => {
    const host = hostRef.current;
    const scroll = scrollRef.current;
    if (host === null || scroll === null) return;

    let gl: ThumbGL;
    try {
      gl = new ThumbGL();
    } catch {
      return; // no WebGL2 — cells keep their placeholder; no crash
    }
    glRef.current = gl;
    gl.setPixelArt(useRenderPrefs.getState().pixelArt); // honour the current setting on mount
    applyThemeColors(gl); // honour the current theme on mount
    gl.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
    host.appendChild(gl.canvas);

    let raf: number | null = null;
    /** scrollTop the canvas was last PAINTED for — the reference the scroll
     *  compensation shifts against. */
    let drawnTop = 0;
    /** Consecutive frames without scroll movement; the loop stays hot until
     *  this passes IDLE_FRAMES (see below). */
    let idle = 0;
    /** Compositor scrolling moves the DOM before any JS runs, so a repaint is
     *  always ≥1 frame late. Keep the loop alive briefly after the last
     *  movement instead of waiting for the next scroll EVENT — events lag the
     *  compositor too, and re-arming from them alone reintroduces the trail. */
    const IDLE_FRAMES = 30;

    const draw = (): void => {
      raf = null;
      const top = scroll.scrollTop;
      const moved = top !== drawnTop;
      // Measure against the HOST, not the canvas: the compensation transform
      // below shifts the canvas's own rect, and rects must be transform-free.
      const canvasRect = host.getBoundingClientRect();
      const cells: DrawCell[] = [];
      let missing = false;
      const slots = scroll.querySelectorAll<HTMLElement>("[data-thumb-key]");
      for (const el of slots) {
        const key = el.dataset.thumbKey;
        if (key === undefined || key === "") continue;
        const r = el.getBoundingClientRect();
        if (r.bottom < canvasRect.top || r.top > canvasRect.bottom) continue; // off-screen
        const slot = gl.slot(key);
        if (slot === undefined) {
          gl.request(key);
          missing = true;
          continue;
        }
        cells.push({ x: r.left - canvasRect.left, y: r.top - canvasRect.top, w: r.width, h: r.height, slot });
      }
      gl.draw(cells, canvasRect.width, canvasRect.height, Math.min(window.devicePixelRatio, 2));
      // The fresh paint is at true positions — drop the interim shift in the
      // same frame, so compensation and repaint land atomically.
      gl.canvas.style.transform = "";
      drawnTop = top;
      idle = moved ? 0 : idle + 1;
      if (missing || idle < IDLE_FRAMES) schedule();
    };

    const schedule = (): void => {
      if (raf === null) raf = requestAnimationFrame(draw);
    };
    scheduleRef.current = schedule;

    const onScroll = (): void => {
      // Instant compensation: the DOM has already moved compositor-side, so
      // shift the last-painted pixels by the same delta NOW (a cheap style
      // write, no redraw) and let the next draw normalize. Absolute against
      // drawnTop, so stacked events before a slow frame can't drift it.
      const delta = scroll.scrollTop - drawnTop;
      gl.canvas.style.transform = delta === 0 ? "" : `translateY(${-delta}px)`;
      idle = 0;
      schedule();
    };

    scroll.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    schedule();

    return () => {
      scroll.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
      scheduleRef.current = null;
      gl.canvas.remove();
      gl.dispose();
      glRef.current = null;
    };
  }, [scrollRef]);

  // Item set changed (filter, group toggle, scan) or a decode landed: new slots
  // may need uploading, and 404'd fetches should be retried.
  useEffect(() => {
    glRef.current?.clearFailed();
    scheduleRef.current?.();
  }, [revision]);

  // Global smooth ↔ pixel-art flip: reswitch the atlas filter and repaint.
  useEffect(() => {
    glRef.current?.setPixelArt(pixelArt);
    scheduleRef.current?.();
  }, [pixelArt]);

  // Theme change: re-read the letterbox/checker colours and repaint.
  useEffect(() => {
    const gl = glRef.current;
    if (gl === null) return;
    applyThemeColors(gl);
    scheduleRef.current?.();
  }, [themeId]);

  return <div ref={hostRef} className="pointer-events-none absolute inset-0 z-0" />;
}
