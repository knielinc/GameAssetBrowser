import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { Bookmark, ChevronDown, ChevronUp } from "lucide-react";
import { docUrl } from "./doc";
import { basename } from "../../stores/libraryStore";
import { useDocView, MD_BASE_EBOOK } from "../../stores/docView";
import { useEbookBookmarks } from "../../stores/ebookBookmarks";
import type { FoliateSection } from "../../vendor/foliate-js/view.js";

/**
 * In-app ebook reader for EPUB / MOBI / AZW3 / FB2 / CBZ.
 *
 * foliate-js is used ONLY as a parser: makeBook() decodes the container and each
 * section's load() returns a blob: URL for the section's fully-resolved (X)HTML
 * — images/SVG rewritten to blob: URLs, `<a>` links deliberately left relative.
 * We fetch that HTML and render it OURSELVES in a Shadow DOM host inside the
 * app's own document — NOT in foliate's paginated iframes.
 *
 * Why: the target WebView2's Chromium build (150.0.4078) miscomputes layout
 * geometry for content inside sandboxed iframes (CSS multi-column explodes into
 * phantom columns; constrained widths collapse to one word per line), which
 * breaks foliate's renderer completely there — while the identical code renders
 * fine in Google Chrome. Shadow DOM gives us the same style isolation as an
 * iframe but lays out in the main document, which the WebView2 renders correctly.
 *
 * NOTE we render from load() (which resolves resources), NOT createDocument()
 * (which parses raw text with relative, unresolved URLs) — otherwise images and
 * links would point at the app origin and 404.
 *
 * Trade vs foliate's renderer: continuous SCROLL (no pagination), scroll-based
 * bookmarks, and author stylesheets dropped for one consistent reading theme.
 * Internal links resolve to a section (+ anchor) and scroll there.
 */

const XHTML = "application/xhtml+xml";

type LoadState = "loading" | "ready" | "error";

/** Reading stylesheet injected into every section's shadow root. Sizing comes
 *  from CSS custom properties set on the scroll container (they inherit across
 *  the shadow boundary). `position: static !important` on descendants neutralises
 *  any author position:fixed/absolute so a book can never overlay the app. */
const READER_CSS = `
  :host { display: block; }
  .ebk {
    max-width: var(--eb-mw, 40rem);
    margin: 0 auto;
    padding: 0 24px 2.2em;
    font-family: Georgia, "Iowan Old Style", "Palatino Linotype", Cambria, "Noto Serif", serif;
    font-size: var(--eb-fs, 18px);
    line-height: 1.62;
    color: #1a1712;
    overflow-wrap: break-word;
    -webkit-hyphens: auto;
    hyphens: auto;
    text-rendering: optimizeLegibility;
  }
  .ebk * { position: static !important; float: none !important; max-width: 100% !important; }
  .ebk img, .ebk svg, .ebk image, .ebk video {
    max-width: 100% !important; height: auto !important; display: block; margin: 1em auto;
  }
  .ebk p { margin: 0 0 1em; text-align: start; }
  .ebk h1,.ebk h2,.ebk h3,.ebk h4,.ebk h5,.ebk h6 { line-height: 1.25; margin: 1.3em 0 .5em; font-weight: 600; }
  .ebk a { color: #1a5fb4; text-decoration: underline; cursor: pointer; }
  .ebk ul,.ebk ol { padding-left: 1.4em; margin: 0 0 1em; }
  .ebk li { margin: 0 0 .3em; }
  .ebk pre { white-space: pre-wrap; overflow-x: auto; }
  .ebk hr { border: 0; border-top: 1px solid #ccc3ad; margin: 1.6em 0; }
  .ebk blockquote { margin: 1em 0 1em 1em; padding-left: 1em; border-left: 3px solid #d8cdb0; color: #4a4436; }
  .ebk table { border-collapse: collapse; max-width: 100%; }
  .ebk td,.ebk th { border: 1px solid #d8cdb0; padding: .3em .5em; }
`;

const DANGEROUS = "script, style, link, meta, title, base, iframe, object, embed, noscript, head";

/** A parsed, resource-resolved section Document → safe HTML for shadow injection.
 *  Drops stylesheets / scripts / framed content and event handlers. Resolved
 *  image (blob:) URLs and relative `<a href>` are preserved. */
function sanitizeBody(doc: Document): string {
  const body = doc.body?.cloneNode(true) as HTMLElement | undefined;
  if (!body) return "";
  body.querySelectorAll(DANGEROUS).forEach((n) => n.remove());
  body.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith("on")) el.removeAttribute(attr.name);
    }
  });
  body.querySelectorAll("img").forEach((img) => img.setAttribute("loading", "lazy"));
  return body.innerHTML;
}

/** Fetch and sanitize one section's rendered HTML. Returns "" on failure so a
 *  single broken section doesn't sink the whole book. */
async function loadSectionHtml(section: FoliateSection): Promise<string> {
  try {
    const url = await section.load?.();
    if (typeof url !== "string" || url === "") return "";
    const text = await (await fetch(url)).text();
    // Parse as XHTML first (EPUB is XML); fall back to lenient HTML on error.
    let doc = new DOMParser().parseFromString(text, XHTML);
    if (doc.querySelector("parsererror")) doc = new DOMParser().parseFromString(text, "text/html");
    return sanitizeBody(doc);
  } catch {
    return "";
  }
}

/** One section, rendered into an isolated shadow root. Registers its host so the
 *  reader can scroll to it, and routes link clicks through `onNav`. */
function Section({
  html,
  index,
  registerHost,
  onNav,
}: {
  html: string;
  index: number;
  registerHost: (i: number, el: HTMLDivElement | null) => void;
  onNav: (fromIndex: number, href: string) => void;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (host === null) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${READER_CSS}</style><div class="ebk">${html}</div>`;
    root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const href = a.getAttribute("href");
        if (href !== null && href !== "") onNav(index, href);
      });
    });
  }, [html, index, onNav]);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        registerHost(index, el);
      }}
    />
  );
}

export default function EbookView({
  path,
  autoFocus = false,
}: {
  path: string;
  /** Grab focus on mount so keyboard scrolling works immediately (fullscreen). */
  autoFocus?: boolean;
}): ReactElement {
  const scale = useDocView((s) => s.fontScale);
  const full = useDocView((s) => s.readWidth) === "full";
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostsRef = useRef<(HTMLDivElement | null)[]>([]);
  const metaRef = useRef<FoliateSection[]>([]);
  const [sections, setSections] = useState<string[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [progress, setProgress] = useState(0);
  const restoredRef = useRef(false);
  // Live scroll ratio (mirrors `progress` without re-rendering) + the last
  // applied font/width, so a reflow can re-pin the reading position by ratio.
  const progressRef = useRef(0);
  const reflowKeyRef = useRef("");

  const bookmark = useEbookBookmarks((s) => s.marks[path] ?? null);
  const setMark = useEbookBookmarks((s) => s.setMark);
  const clearMark = useEbookBookmarks((s) => s.clearMark);
  const onBookmark = bookmark !== null && Math.abs(progress - bookmark) < 0.01;

  // Parse the book once per path and stream its sanitized sections into state as
  // they decode, so the first pages are readable while the rest still load.
  useEffect(() => {
    let cancelled = false;
    let loaded: FoliateSection[] = [];
    setState("loading");
    setSections([]);
    setProgress(0);
    restoredRef.current = false;
    reflowKeyRef.current = "";
    progressRef.current = 0;
    hostsRef.current = [];
    metaRef.current = [];

    void (async () => {
      try {
        // Dynamic-import so foliate's parser stays out of the main chunk.
        const { makeBook } = await import("../../vendor/foliate-js/view.js");
        const blob = await (await fetch(docUrl(path))).blob();
        if (cancelled) return;
        // The name drives .cbz/.fb2/.fbz detection; the rest sniff by bytes.
        const book = await makeBook(new File([blob], basename(path)));
        if (cancelled) return;
        const spine = book.sections ?? [];
        loaded = spine;
        metaRef.current = spine;
        hostsRef.current = new Array(spine.length).fill(null);
        if (spine.length === 0) {
          setState("error");
          return;
        }
        const html: string[] = [];
        for (const section of spine) {
          if (cancelled) return;
          html.push(await loadSectionHtml(section));
          setSections([...html]);
          if (html.length === 1) setState("ready");
        }
        if (!cancelled) setState((s) => (s === "loading" ? "ready" : s));
      } catch (e) {
        if (!cancelled) {
          console.error("[doc] ebook load failed", e);
          setState("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      // Revoke every section's blob: resources (images etc.) now.
      for (const s of loaded) {
        try {
          s.unload?.();
        } catch {
          /* ignore */
        }
      }
    };
  }, [path]);

  // Restore the bookmark once content has settled (heights known).
  useEffect(() => {
    if (state !== "ready" || restoredRef.current) return;
    const el = scrollRef.current;
    if (el === null) return;
    restoredRef.current = true;
    if (bookmark !== null && bookmark > 0) {
      const id = window.setTimeout(() => {
        const max = el.scrollHeight - el.clientHeight;
        el.scrollTop = Math.max(0, Math.min(max, bookmark * max));
      }, 120);
      return () => window.clearTimeout(id);
    }
    if (autoFocus) el.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const registerHost = useCallback((i: number, el: HTMLDivElement | null): void => {
    hostsRef.current[i] = el;
  }, []);

  // Resolve an internal link to a section (+ anchor) and scroll there. Uses the
  // section's own href resolver + id list, so it works for every format without
  // depending on foliate's per-format resolveHref.
  const onNav = useCallback((fromIndex: number, rawHref: string): void => {
    const from = metaRef.current[fromIndex];
    let resolved = rawHref;
    try {
      if (from?.resolveHref) resolved = from.resolveHref(rawHref) ?? rawHref;
    } catch {
      /* fall back to the raw href */
    }
    const [rawPath, hash] = decodeURI(resolved).split("#");
    let targetIndex = fromIndex;
    if (rawPath) {
      const idx = metaRef.current.findIndex((s) => {
        try {
          return decodeURI(s.id ?? "") === rawPath;
        } catch {
          return s.id === rawPath;
        }
      });
      if (idx >= 0) targetIndex = idx;
      else if (!hash) return; // unknown target and no in-page anchor
    }
    const host = hostsRef.current[targetIndex];
    if (host == null) return;
    if (hash && host.shadowRoot) {
      const target =
        host.shadowRoot.getElementById(hash) ??
        host.shadowRoot.querySelector(`[name="${CSS.escape(hash)}"]`);
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
    host.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const max = el.scrollHeight - el.clientHeight;
    const ratio = max > 0 ? el.scrollTop / max : 0;
    progressRef.current = ratio;
    setProgress(ratio);
  }, []);

  // Changing the font size or column width reflows the text, which moves the
  // same reading position to a different scrollTop. Re-pin by RATIO after each
  // such change so you stay where you were reading. Keyed only on scale/full
  // (not `progress`) so ordinary scrolling is never hijacked; the first settle
  // per book just records the key and leaves the bookmark-restore effect alone.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null || state !== "ready") return;
    const key = `${scale}|${full ? "full" : "col"}`;
    if (reflowKeyRef.current === key) return;
    const first = reflowKeyRef.current === "";
    reflowKeyRef.current = key;
    if (first) return; // initial layout — don't fight the bookmark restore
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = max > 0 ? progressRef.current * max : 0;
  }, [scale, full, state]);

  const scrollByScreen = useCallback((dir: 1 | -1): void => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollBy({ top: dir * el.clientHeight * 0.9, behavior: "smooth" });
  }, []);

  const toggleBookmark = useCallback((): void => {
    if (onBookmark) clearMark(path);
    else setMark(path, progress);
    scrollRef.current?.focus({ preventScroll: true });
  }, [onBookmark, clearMark, setMark, path, progress]);

  const goToBookmark = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null || bookmark === null) return;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTo({ top: Math.max(0, Math.min(max, bookmark * max)), behavior: "smooth" });
    el.focus({ preventScroll: true });
  }, [bookmark]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
      case "PageDown":
      case " ":
        scrollByScreen(1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
      case "PageUp":
        scrollByScreen(-1);
        break;
      case "Home":
        scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
        break;
      case "End":
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto bg-[#f6f2e8] outline-none"
        style={
          {
            "--eb-fs": `${Math.round(MD_BASE_EBOOK * scale)}px`,
            "--eb-mw": full ? "none" : "40rem",
          } as CSSProperties
        }
      >
        <div className="py-6">
          {sections.map((html, i) => (
            <Section key={i} html={html} index={i} registerHost={registerHost} onNav={onNav} />
          ))}
        </div>
      </div>

      {state === "ready" && (
        <div className="absolute bottom-2 left-1/2 z-10 flex max-w-[92%] -translate-x-1/2 items-center gap-1 rounded-full bg-black/65 px-1.5 py-1 text-[11px] text-white/90 shadow-e2">
          <button
            type="button"
            title="Back"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white"
            onClick={() => scrollByScreen(-1)}
          >
            <ChevronUp size={15} />
          </button>
          <span className="shrink-0 tabular-nums text-white/60">{Math.round(progress * 100)}%</span>
          <button
            type="button"
            title="Forward"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white"
            onClick={() => scrollByScreen(1)}
          >
            <ChevronDown size={15} />
          </button>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-white/20" />
          {bookmark !== null && !onBookmark && (
            <button
              type="button"
              title={`Go to bookmark (${Math.round(bookmark * 100)}%)`}
              className="flex h-6 shrink-0 items-center gap-1 rounded-full pl-1.5 pr-2 text-amber-300/90 transition-colors hover:bg-white/15 hover:text-amber-300"
              onClick={goToBookmark}
            >
              <Bookmark size={13} fill="currentColor" />
              <span className="text-[10px] tabular-nums">{Math.round(bookmark * 100)}%</span>
            </button>
          )}
          <button
            type="button"
            title={onBookmark ? "Remove bookmark" : "Bookmark this spot"}
            className={
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors " +
              (onBookmark ? "text-amber-300 hover:bg-white/15" : "text-white/80 hover:bg-white/15 hover:text-white")
            }
            onClick={toggleBookmark}
          >
            <Bookmark size={14} fill={onBookmark ? "currentColor" : "none"} />
          </button>
        </div>
      )}
      {state === "loading" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-dim">
          Loading ebook…
        </div>
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-dim">
          Couldn’t open this ebook.
        </div>
      )}
    </div>
  );
}
