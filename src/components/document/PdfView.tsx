import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Bookmark, ChevronLeft, ChevronRight } from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
// `?url` emits the worker as a standalone asset and returns its URL; pdf.js
// itself is dynamic-imported below, so nothing heavy lands in the main chunk.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { docUrl } from "./doc";
import { useDocView } from "../../stores/docView";
import { usePdfBookmarks } from "../../stores/pdfBookmarks";

/**
 * PDF preview with our own renderer (not the WebView's native viewer) so page
 * layout is ours to control: fit-width, one whole page per screen, or a
 * two-page facing spread.
 *
 * Loading is RANGE-BASED: pdf.js is handed a PDFDataRangeTransport that fetches
 * bytes over `doc://` with HTTP Range headers, so opening a 500 MB PDF reads
 * only its cross-reference table plus the pages you actually view — never the
 * whole file. Rendering is virtualized on top of that: a page rasterizes only
 * when it nears the viewport and clears when it leaves.
 *
 * Navigation: ←/→ (PageUp/Down, Home/End, the on-screen arrows, or the page
 * box) retarget a single fixed-duration scroll animation. Spamming ← / → piles
 * onto the target and the viewer glides to the final page in one move's worth
 * of time rather than stepping through each. ↑/↓ stay native scrolling. The
 * handler stops propagation on keys it owns so the window-level list-nav
 * shortcut never also fires while the viewer is focused.
 */

const GAP = 8; // px between pages / spread columns
const PAD = 16; // total horizontal padding of the scroll area (p-2)
const SCROLL_MS = 280; // one "move" — the glide-to-target duration
// Cap the rasterized pixel width. Scanned manga pages carry 2–4k-px images;
// rendering them at full device-pixel resolution is what makes turning lag.
// This keeps rasterization fast while staying crisp at fit-width.
const MAX_CANVAS_W = 2200;

/** One page. Rasterizes when it nears the viewport, KEEPS the bitmap while it's
 *  within a few screens (so scrolling back is instant), and only frees it when
 *  far away. The wrapper holds its size whether or not the canvas is painted, so
 *  scroll height is stable and virtualization never shifts the layout. */
function PdfPage({
  doc,
  root,
  pageNum,
  width,
  aspect,
}: {
  doc: PDFDocumentProxy;
  root: HTMLElement | null;
  pageNum: number;
  width: number;
  aspect: number;
}): ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const height = width / aspect;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (wrap === null) return;
    let disposed = false;
    let visible = false;
    let rendering = false;
    let rendered = false; // painted at THIS effect's width
    let task: RenderTask | null = null;

    const ensure = async (): Promise<void> => {
      if (disposed || rendering || rendered || !visible) return;
      const canvas = canvasRef.current;
      if (canvas === null) return;
      rendering = true;
      try {
        const page = await doc.getPage(pageNum);
        if (disposed || !visible) return;
        const base = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const targetPx = Math.min(width * dpr, MAX_CANVAS_W);
        const viewport = page.getViewport({ scale: targetPx / base.width });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d");
        if (ctx === null) return;
        task = page.render({ canvas, canvasContext: ctx, viewport });
        await task.promise;
        rendered = true;
      } catch {
        rendered = false; // cancelled / failed — allow a retry
      } finally {
        rendering = false;
        task = null;
        // Visibility or size may have changed under us — re-check once.
        if (!disposed && visible && !rendered) void ensure();
      }
    };
    const evict = (): void => {
      const canvas = canvasRef.current;
      if (canvas !== null && rendered) {
        canvas.width = 0;
        canvas.height = 0;
        rendered = false;
      }
    };

    // Render within ~1.5 screens of the viewport; hold the bitmap cached until
    // ~3.5 screens away. Two margins so scrolling never re-renders the pages you
    // just passed, and never leaves the visible ones blank.
    const renderIo = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible = e.isIntersecting;
        if (visible) void ensure();
      },
      { root: root ?? null, rootMargin: "1200px 0px" },
    );
    const evictIo = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (!e.isIntersecting) evict();
      },
      { root: root ?? null, rootMargin: "3500px 0px" },
    );
    renderIo.observe(wrap);
    evictIo.observe(wrap);
    return () => {
      disposed = true;
      renderIo.disconnect();
      evictIo.disconnect();
      task?.cancel();
    };
  }, [doc, root, pageNum, width, aspect]);

  return (
    <div
      ref={wrapRef}
      style={{ width, height }}
      className="relative shrink-0 overflow-hidden rounded bg-white shadow-e1"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}

type LoadState = "loading" | "ready" | "error";

export default function PdfView({
  path,
  autoFocus = false,
}: {
  path: string;
  /** Grab keyboard focus on mount so ←/→ page nav works immediately (fullscreen). */
  autoFocus?: boolean;
}): ReactElement {
  const layout = useDocView((s) => s.pdfLayout);
  const zoom = useDocView((s) => s.fontScale);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [aspect, setAspect] = useState(1); // page-1 width/height, sizes all slots
  const [state, setState] = useState<LoadState>("loading");
  const [row, setRow] = useState(0); // current (or in-flight target) row
  const rowEls = useRef<(HTMLDivElement | null)[]>([]);
  const targetRow = useRef(0); // authoritative nav target, updated synchronously
  const targetScroll = useRef(0); // absolute scrollTop the glide heads for
  const animRef = useRef<number | null>(null);
  const wheelAccum = useRef(0); // paginated-mode wheel delta accumulator
  const wheelLock = useRef(false); // one page per wheel gesture

  // Load the document once per path — range-based so a huge PDF opens instantly.
  useEffect(() => {
    let cancelled = false;
    let task: { promise: Promise<PDFDocumentProxy>; destroy: () => Promise<void> } | null = null;
    setState("loading");
    setDoc(null);
    setNumPages(0);
    setRow(0);
    targetRow.current = 0;
    targetScroll.current = 0;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const { invoke } = await import("@tauri-apps/api/core");

        // Byte size over the reliable binary IPC channel — no custom-scheme
        // Range guesswork.
        let total = 0;
        try {
          total = await invoke<number>("pdf_size", { path });
        } catch (e) {
          console.error("[doc] pdf_size failed", e);
        }
        if (cancelled) return;

        if (total > 0) {
          // pdf.js pulls ONLY the xref + visited pages through this transport,
          // each byte range delivered as raw bytes over IPC (invoke → ArrayBuffer).
          const transport = new pdfjs.PDFDataRangeTransport(total, new Uint8Array(0), false);
          transport.requestDataRange = (begin: number, end: number): void => {
            void invoke<ArrayBuffer>("pdf_range", { path, start: begin, end })
              .then((b) => transport.onDataRange(begin, new Uint8Array(b)))
              .catch((err) => console.error("[doc] pdf_range failed", err));
          };
          task = pdfjs.getDocument({
            range: transport,
            disableAutoFetch: true,
            disableStream: true,
            rangeChunkSize: 1 << 20, // 1 MB — fewer IPC round-trips per page
          });
        } else {
          // Fallback: whole file over the doc:// scheme (small PDFs, or if the
          // size probe failed for some reason).
          const buf = await (await fetch(docUrl(path))).arrayBuffer();
          if (cancelled) return;
          task = pdfjs.getDocument({ data: new Uint8Array(buf) });
        }

        const d = await task.promise;
        if (cancelled) return;
        const p1 = await d.getPage(1);
        const vp = p1.getViewport({ scale: 1 });
        if (cancelled) return;
        setAspect(vp.width / vp.height);
        setDoc(d);
        setNumPages(d.numPages);
        setState("ready");
      } catch (e) {
        if (!cancelled) {
          console.error("[doc] pdf load failed", e);
          setState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [path]);

  // Track the scroll area's size — both dimensions matter for single-page fit.
  useEffect(() => {
    if (root === null) return;
    const measure = (): void => setSize({ w: root.clientWidth, h: root.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [root]);

  // Focus the scroll area so arrow nav works without a click (fullscreen).
  useEffect(() => {
    if (autoFocus && root !== null) root.focus({ preventScroll: true });
  }, [autoFocus, root]);

  // Cancel any in-flight glide on unmount.
  useEffect(() => {
    return () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    };
  }, []);

  // "single" and "spread" are PAGINATED reading modes: one page/spread per
  // screen, sized to fit the whole viewport (both axes) with a little breathing
  // room — never partially showing the neighbour. "width" is continuous scroll.
  const framed = layout === "single" || layout === "spread";
  const frameW = Math.max(80, size.w - 24);
  const frameH = Math.max(80, size.h - 24);
  let pageW: number;
  if (layout === "spread") {
    pageW = Math.min((frameW - GAP) / 2, frameH * aspect) * zoom;
  } else if (layout === "single") {
    pageW = Math.min(frameW, frameH * aspect) * zoom;
  } else {
    pageW = Math.max(80, size.w - PAD) * zoom;
  }

  // Rows: pairs for the spread, one page each otherwise.
  const rows: (number | null)[][] = [];
  if (layout === "spread") {
    for (let i = 1; i <= numPages; i += 2) rows.push([i, i + 1 <= numPages ? i + 1 : null]);
  } else {
    for (let i = 1; i <= numPages; i++) rows.push([i]);
  }
  const rowCount = rows.length;

  // Absolute scrollTop that brings row `i` to the top of the viewport.
  const rowScrollTarget = useCallback(
    (i: number): number => {
      const el = rowEls.current[i];
      if (el === null || el === undefined || root === null) return root?.scrollTop ?? 0;
      const delta = el.getBoundingClientRect().top - root.getBoundingClientRect().top;
      return root.scrollTop + delta - 8;
    },
    [root],
  );

  // Fixed-duration glide toward targetScroll.current (updated synchronously so
  // spamming a key piles onto it), restarting from wherever we are on each call.
  const glide = useCallback(() => {
    const cont = root;
    if (cont === null) return;
    if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    const max = cont.scrollHeight - cont.clientHeight;
    const target = Math.max(0, Math.min(max, targetScroll.current));
    targetScroll.current = target;
    const start = cont.scrollTop;
    const dist = target - start;
    if (Math.abs(dist) < 1) return;
    let t0: number | null = null;
    const frame = (t: number): void => {
      if (t0 === null) t0 = t;
      const p = Math.min(1, (t - t0) / SCROLL_MS);
      const ease = 1 - Math.pow(1 - p, 3); // easeOutCubic
      cont.scrollTop = start + dist * ease;
      if (p < 1) animRef.current = requestAnimationFrame(frame);
      else animRef.current = null;
    };
    animRef.current = requestAnimationFrame(frame);
  }, [root]);

  // Framed modes (single/spread): frame a whole page/spread by bringing its row
  // to the viewport top — the page is sized to fit, so it lands maximized.
  const navToRow = useCallback(
    (i: number): void => {
      const clamped = Math.max(0, Math.min(rowEls.current.length - 1, i));
      targetRow.current = clamped;
      setRow(clamped);
      targetScroll.current = rowScrollTarget(clamped);
      glide();
    },
    [glide, rowScrollTarget],
  );

  // Continuous (fit-width) mode: move the view by ~a screen so you keep reading
  // a tall page instead of skipping to the next page's top.
  const navByScreen = useCallback(
    (dir: 1 | -1): void => {
      const cont = root;
      if (cont === null) return;
      const screen = Math.max(80, (cont.clientHeight - PAD) * 0.9);
      // Accumulate off the in-flight target while a glide runs, else off the
      // live position.
      const base = animRef.current !== null ? targetScroll.current : cont.scrollTop;
      targetScroll.current = base + dir * screen;
      glide();
    },
    [root, glide],
  );

  // In paginated modes `row` IS the shown page — advancing just swaps it. In
  // continuous mode we scroll by a screen.
  const step = (dir: 1 | -1): void => {
    if (framed) setRow((r) => Math.max(0, Math.min(rowCount - 1, r + dir)));
    else navByScreen(dir);
  };

  // Paginated wheel/trackpad: one page per gesture, no partial scrolling.
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>): void => {
    if (!framed) return; // continuous mode scrolls natively
    if (wheelLock.current) return;
    wheelAccum.current += e.deltaY;
    if (Math.abs(wheelAccum.current) >= 24) {
      const dir = wheelAccum.current > 0 ? 1 : -1;
      wheelAccum.current = 0;
      wheelLock.current = true;
      window.setTimeout(() => {
        wheelLock.current = false;
      }, 220);
      setRow((r) => Math.max(0, Math.min(rowCount - 1, r + dir)));
    }
  };

  // While a glide runs, keep the target authoritative (don't let programmatic
  // scroll events fight it); once settled, follow manual scrolling.
  const syncRow = useCallback((): void => {
    const cont = root;
    if (cont === null || animRef.current !== null) return;
    targetScroll.current = cont.scrollTop;
    const top = cont.getBoundingClientRect().top;
    let idx = 0;
    for (let i = 0; i < rowEls.current.length; i++) {
      const el = rowEls.current[i];
      if (el === null) continue;
      if (el.getBoundingClientRect().top - top <= 4) idx = i;
      else break;
    }
    targetRow.current = idx;
    setRow(idx);
  }, [root]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Typing in the page-jump box: leave keys alone (its own handler jumps).
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    // ↑/↓ stay native scrolling, but shield them from the window-level list-nav
    // shortcut (which would preventDefault the scroll AND move the selection).
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.stopPropagation();
      return;
    }
    switch (e.key) {
      case "ArrowRight":
      case "PageDown":
        step(1);
        break;
      case "ArrowLeft":
      case "PageUp":
        step(-1);
        break;
      case "Home":
        if (framed) setRow(0);
        else {
          targetScroll.current = 0;
          glide();
        }
        break;
      case "End":
        if (framed) setRow(rowCount - 1);
        else {
          targetScroll.current = Number.MAX_SAFE_INTEGER;
          glide();
        }
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  // Page-jump box state, kept in sync with the visible row.
  const curPage = rows[Math.min(row, Math.max(rowCount - 1, 0))]?.[0] ?? 1;
  const curPair = rows[Math.min(row, Math.max(rowCount - 1, 0))];
  const [jump, setJump] = useState("1");
  useEffect(() => {
    setJump(String(curPage));
  }, [curPage]);
  const rowForPage = (p: number): number =>
    layout === "spread" ? Math.floor((p - 1) / 2) : p - 1;
  const commitJump = (): void => {
    const n = Math.max(1, Math.min(numPages, Math.round(Number(jump) || curPage)));
    const r = rowForPage(n);
    if (framed) setRow(Math.max(0, Math.min(rowCount - 1, r)));
    else navToRow(r);
    root?.focus({ preventScroll: true });
  };

  // One bookmark per PDF (by path). "On" when the mark falls on the page/spread
  // currently in view; toggling then removes it, otherwise it moves to here.
  const bookmark = usePdfBookmarks((s) => s.marks[path] ?? null);
  const setMark = usePdfBookmarks((s) => s.setMark);
  const clearMark = usePdfBookmarks((s) => s.clearMark);
  const onBookmark = bookmark !== null && (curPair?.includes(bookmark) ?? false);
  const toggleBookmark = (): void => {
    if (onBookmark) clearMark(path);
    else setMark(path, curPage);
    root?.focus({ preventScroll: true });
  };
  const goToBookmark = (): void => {
    if (bookmark === null) return;
    const r = rowForPage(bookmark);
    if (framed) setRow(Math.max(0, Math.min(rowCount - 1, r)));
    else navToRow(r);
    root?.focus({ preventScroll: true });
  };

  // The page(s) of one row.
  const rowPages = (d: PDFDocumentProxy, r: (number | null)[]): ReactElement[] =>
    r.map((n, ci) =>
      n === null ? (
        <div key={`pad-${ci}`} style={{ width: pageW, height: pageW / aspect }} />
      ) : (
        <PdfPage key={n} doc={d} root={root} pageNum={n} width={pageW} aspect={aspect} />
      ),
    );

  // Paginated modes keep the current spread and its two neighbours mounted (so
  // turning is instant) but show only the current one.
  const windowRows = framed
    ? [row - 1, row, row + 1].filter((i) => i >= 0 && i < rowCount)
    : [];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {framed ? (
        <div
          ref={setRoot}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onWheel={onWheel}
          className="relative min-h-0 flex-1 overflow-hidden bg-header outline-none"
        >
          {doc !== null &&
            size.w > 0 &&
            windowRows.map((i) => (
              <div
                key={i}
                className="absolute inset-0 flex items-center justify-center transition-opacity duration-150"
                style={{
                  gap: GAP,
                  opacity: i === row ? 1 : 0,
                  pointerEvents: i === row ? undefined : "none",
                }}
              >
                {rowPages(doc, rows[i])}
              </div>
            ))}
        </div>
      ) : (
        <div
          ref={setRoot}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onScroll={syncRow}
          className="min-h-0 flex-1 overflow-auto bg-header p-2 outline-none"
        >
          {doc !== null && size.w > 0 && (
            <div className="mx-auto flex w-fit flex-col gap-2">
              {rows.map((r, ri) => (
                <div
                  key={ri}
                  ref={(el) => {
                    rowEls.current[ri] = el;
                  }}
                  className="flex"
                  style={{ gap: GAP }}
                >
                  {rowPages(doc, r)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Page navigator — prev / jump-box / next. Outside the scroll area so it
          stays put as pages move. */}
      {state === "ready" && numPages > 0 && (
        <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/65 px-1.5 py-1 text-[11px] text-white/90 shadow-e2">
          <button
            type="button"
            title="Previous page"
            className="flex h-6 w-6 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-30"
            disabled={framed && row <= 0}
            onClick={() => step(-1)}
          >
            <ChevronLeft size={15} />
          </button>
          <input
            value={jump}
            inputMode="numeric"
            spellCheck={false}
            aria-label="Go to page"
            className="w-9 rounded bg-white/10 py-0.5 text-center tabular-nums text-white outline-none focus:bg-white/20"
            onChange={(e) => setJump(e.currentTarget.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                commitJump();
              }
            }}
            onBlur={() => setJump(String(curPage))}
          />
          <span className="tabular-nums text-white/60">/ {numPages}</span>
          <button
            type="button"
            title="Next page"
            className="flex h-6 w-6 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-30"
            disabled={framed && row >= rowCount - 1}
            onClick={() => step(1)}
          >
            <ChevronRight size={15} />
          </button>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-white/20" />
          {bookmark !== null && !onBookmark && (
            <button
              type="button"
              title={`Go to bookmark (page ${bookmark})`}
              className="flex h-6 items-center gap-1 rounded-full pl-1.5 pr-2 text-amber-300/90 transition-colors hover:bg-white/15 hover:text-amber-300"
              onClick={goToBookmark}
            >
              <Bookmark size={13} fill="currentColor" />
              <span className="text-[10px] tabular-nums">{bookmark}</span>
            </button>
          )}
          <button
            type="button"
            title={onBookmark ? "Remove bookmark" : "Bookmark this page"}
            className={
              "flex h-6 w-6 items-center justify-center rounded-full transition-colors " +
              (onBookmark
                ? "text-amber-300 hover:bg-white/15"
                : "text-white/80 hover:bg-white/15 hover:text-white")
            }
            onClick={toggleBookmark}
          >
            <Bookmark size={14} fill={onBookmark ? "currentColor" : "none"} />
          </button>
        </div>
      )}
      {state === "loading" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-white/80">
          Loading PDF…
        </div>
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-white/80">
          Couldn’t open this PDF.
        </div>
      )}
    </div>
  );
}
