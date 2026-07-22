import { useEffect, useMemo, useState, type ReactElement } from "react";
// GitHub's dark Markdown stylesheet, scoped entirely to `.markdown-body` — it
// styles the rendered readme and nothing else in the app. Small; eager is fine.
import "github-markdown-css/github-markdown-dark.css";
import { docFormat, docUrl } from "./doc";
import { useDocView } from "../../stores/docView";
import PdfView from "./PdfView";
import PsdView from "./PsdView";

/**
 * In-app document preview for the formats Phase 1 covers (pdf, md/markdown,
 * txt). Markdown renders to GitHub-styled HTML (markdown-it, dynamic-imported);
 * plain text shows in an editor-style pane with line numbers; PDFs go to our
 * own virtualized renderer (see PdfView). File bytes come over the `doc://`
 * scheme (Rust reads them with the same scope check as model://).
 */

type LoadState = "loading" | "ready" | "error";
/** Base font size (px) the text-ish views scale from. */
const MD_BASE = 16;
const TEXT_BASE = 12.5;

function Centered({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-xs text-dim">
      {children}
    </div>
  );
}

/** Fetch a document's bytes as decoded UTF-8 text. */
function useDocText(path: string): { text: string | null; state: LoadState } {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setText(null);
    void (async () => {
      try {
        const t = await (await fetch(docUrl(path))).text();
        if (cancelled) return;
        setText(t);
        setState("ready");
      } catch (e) {
        if (cancelled) return;
        console.error("[doc] text load failed", e);
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);
  return { text, state };
}

/** Markdown → GitHub-styled HTML. html:false escapes any raw HTML in the source,
 *  so the rendered string carries no author markup we didn't generate. */
function MarkdownView({
  path,
  scale,
  full,
}: {
  path: string;
  scale: number;
  full: boolean;
}): ReactElement {
  const { text, state } = useDocText(path);
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (text === null) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { default: MarkdownIt } = await import("markdown-it");
      // linkify off: a clickable http link would navigate the whole SPA away.
      const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
      if (!cancelled) setHtml(md.render(text));
    })();
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (state === "error") return <Centered>Couldn’t read this document.</Centered>;
  if (html === null) return <Centered>Loading…</Centered>;
  return (
    <div className="doc-markdown min-h-0 flex-1 overflow-y-auto">
      <div
        className={
          full
            ? "markdown-body w-full px-5 py-4"
            : "markdown-body mx-auto max-w-[820px] px-5 py-4"
        }
        style={{ fontSize: MD_BASE * scale }}
        // Safe: markdown-it ran with html:false, so this is only the structural
        // HTML it generated, never raw markup from the file.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/** Plain text in an editor-style pane: a line-number gutter that stays pinned
 *  during horizontal scroll, monospaced, no wrap — reads like a file, not a
 *  paragraph pasted into the panel. */
const TEXT_LINE_CAP = 5000;

function TextView({
  path,
  scale,
  full,
}: {
  path: string;
  scale: number;
  full: boolean;
}): ReactElement {
  const { text, state } = useDocText(path);
  const lines = useMemo(() => (text === null ? [] : text.split(/\r\n|\r|\n/)), [text]);
  const shown = lines.length > TEXT_LINE_CAP ? lines.slice(0, TEXT_LINE_CAP) : lines;
  const gutterCh = String(Math.max(shown.length, 1)).length;

  if (state === "error") return <Centered>Couldn’t read this document.</Centered>;
  if (text === null) return <Centered>Loading…</Centered>;
  return (
    <div
      className="min-h-0 flex-1 overflow-auto bg-header font-mono"
      style={{ fontSize: TEXT_BASE * scale, lineHeight: 1.6, tabSize: 4 }}
    >
      <div className={full ? "min-w-max py-1.5" : "mx-auto w-fit py-1.5"}>
        {shown.map((line, i) => (
          <div key={i} className="flex">
            <span
              className="sticky left-0 z-10 shrink-0 select-none border-r border-overlay/60 bg-header pl-3 pr-3 text-right text-faint"
              style={{ minWidth: `calc(${gutterCh}ch + 1.6rem)` }}
            >
              {i + 1}
            </span>
            <span className="whitespace-pre pl-3 pr-4 text-text">{line.length > 0 ? line : " "}</span>
          </div>
        ))}
        {lines.length > TEXT_LINE_CAP && (
          <div className="px-3 py-2 text-[11px] italic text-faint">
            … {(lines.length - TEXT_LINE_CAP).toLocaleString()} more lines not shown
          </div>
        )}
      </div>
    </div>
  );
}

export interface DocumentPreviewProps {
  path: string;
  ext: string;
  /** Fullscreen only: let the PDF grab focus so ←/→ page nav works at once. */
  autoFocusPdf?: boolean;
}

/** Format-dispatching preview surface. Keyed by path upstream so switching files
 *  remounts and cancels cleanly. Zoom/layout come from the shared docView store,
 *  so the docked and fullscreen views stay in lockstep. */
export default function DocumentPreview({
  path,
  ext,
  autoFocusPdf = false,
}: DocumentPreviewProps): ReactElement {
  const scale = useDocView((s) => s.fontScale);
  const full = useDocView((s) => s.readWidth) === "full";
  const fmt = docFormat(ext);
  if (fmt === "markdown") return <MarkdownView path={path} scale={scale} full={full} />;
  if (fmt === "text") return <TextView path={path} scale={scale} full={full} />;
  if (fmt === "pdf") return <PdfView path={path} autoFocus={autoFocusPdf} />;
  if (fmt === "psd") return <PsdView path={path} />;
  return <Centered>No in-app preview for “.{ext}” yet.</Centered>;
}
