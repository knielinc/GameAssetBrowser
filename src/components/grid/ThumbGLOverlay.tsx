import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import { useRenderPrefs } from "../../stores/renderPrefs";
import { ThumbGL, type DrawCell } from "./thumbGL";

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
 * there, so the canvas can never drift from the cells. The rAF loop self-stops
 * once every visible thumbnail is uploaded, and restarts on scroll/resize/data.
 */
export default function ThumbGLOverlay({ scrollRef, revision }: ThumbGLOverlayProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const glRef = useRef<ThumbGL | null>(null);
  const scheduleRef = useRef<(() => void) | null>(null);
  const pixelArt = useRenderPrefs((s) => s.pixelArt);

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
    gl.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
    host.appendChild(gl.canvas);

    let raf: number | null = null;
    const draw = (): void => {
      raf = null;
      const canvasRect = gl.canvas.getBoundingClientRect();
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
      if (missing && raf === null) raf = requestAnimationFrame(draw); // keep polling until uploads land
    };

    const schedule = (): void => {
      if (raf === null) raf = requestAnimationFrame(draw);
    };
    scheduleRef.current = schedule;

    scroll.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    schedule();

    return () => {
      scroll.removeEventListener("scroll", schedule);
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

  return <div ref={hostRef} className="pointer-events-none absolute inset-0 z-0" />;
}
