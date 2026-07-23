import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { docFormat, docUrl } from "./doc";
import { basename } from "../../stores/libraryStore";

/**
 * Grid thumbnails for documents, rendered in the webview and cached by path.
 * PDF → its first page (via the pdf_range IPC transport, so a 500 MB file only
 * reads the pages it needs). PSD → the baked composite (ag-psd, layer pixels
 * skipped for speed). Ebooks → the embedded cover (foliate-js). md/txt have no
 * raster — the cell shows an icon.
 *
 * Renders are concurrency-limited so scrolling a big folder doesn't spawn dozens
 * of parses at once, and memoised so a cell that scrolls back is instant.
 */

const cache = new Map<string, string>(); // path → data URL
export const docThumbCache = cache;

const MAX = 3;
let active = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= MAX) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

const TARGET = 260; // thumbnail width in px

async function pdfThumb(path: string): Promise<string | null> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const { invoke } = await import("@tauri-apps/api/core");
  let task: {
    promise: Promise<import("pdfjs-dist").PDFDocumentProxy>;
    destroy: () => Promise<void>;
  };
  let total = 0;
  try {
    total = await invoke<number>("pdf_size", { path });
  } catch {
    /* fall through to full load */
  }
  if (total > 0) {
    const transport = new pdfjs.PDFDataRangeTransport(total, new Uint8Array(0), false);
    transport.requestDataRange = (begin: number, end: number): void => {
      void invoke<ArrayBuffer>("pdf_range", { path, start: begin, end })
        .then((b) => transport.onDataRange(begin, new Uint8Array(b)))
        .catch(() => {});
    };
    task = pdfjs.getDocument({ range: transport, disableAutoFetch: true, disableStream: true });
  } else {
    const buf = await (await fetch(docUrl(path))).arrayBuffer();
    task = pdfjs.getDocument({ data: new Uint8Array(buf) });
  }
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: TARGET / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/webp", 0.8);
  } finally {
    void task.destroy();
  }
}

/** md/txt → a "page" of the first lines of text, so the cell reads as a document
 *  at a glance. Uses the app's theme colours (read from the CSS variables) so it
 *  matches the actual text preview rather than looking like light paper. */
async function textThumb(path: string): Promise<string | null> {
  const text = (await (await fetch(docUrl(path))).text()).slice(0, 4000);
  const lines = text.split(/\r\n|\r|\n/).slice(0, 34);
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue("--color-header").trim() || "#16181f";
  const fg = cs.getPropertyValue("--color-text").trim() || "#edeff4";
  const W = 200;
  const H = 260;
  const dpr = 2;
  const canvas = document.createElement("canvas");
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = fg;
  ctx.font = "6px ui-monospace, 'Cascadia Code', Consolas, monospace";
  ctx.textBaseline = "top";
  const pad = 10;
  const lineH = 7.1;
  let y = pad;
  for (const line of lines) {
    ctx.fillText(line.slice(0, 64), pad, y);
    y += lineH;
    if (y > H - pad) break;
  }
  return canvas.toDataURL("image/webp", 0.85);
}

/** Ebook → its embedded cover, downscaled. foliate parses the whole (small)
 *  archive to reach the cover; some books carry none, so this may be null and
 *  the cell falls back to a book icon. The named File lets foliate detect the
 *  container format (see EbookView). */
async function ebookThumb(path: string): Promise<string | null> {
  const blob = await (await fetch(docUrl(path))).blob();
  const file = new File([blob], basename(path));
  const { makeBook } = await import("../../vendor/foliate-js/view.js");
  const book = await makeBook(file);
  const cover = await book.getCover?.();
  if (cover == null) return null;
  const bmp = await createImageBitmap(cover);
  try {
    const scale = Math.min(1, TARGET / bmp.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/webp", 0.85);
  } finally {
    bmp.close();
  }
}

async function psdThumb(path: string): Promise<string | null> {
  const buf = await (await fetch(docUrl(path))).arrayBuffer();
  const { readPsd } = await import("ag-psd");
  // Skip per-layer pixels — the baked composite (or embedded thumbnail) is all a
  // grid cell needs, and it parses far faster.
  const psd = readPsd(buf, { skipLayerImageData: true });
  const src = psd.canvas ?? psd.imageResources?.thumbnail;
  if (src == null) return null;
  const scale = Math.min(1, TARGET / src.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(src.width * scale));
  canvas.height = Math.max(1, Math.round(src.height * scale));
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", 0.85);
}

/** Data URL for a document's thumbnail, or null if the format has no raster. */
export async function renderDocThumb(path: string, ext: string): Promise<string | null> {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  const fmt = docFormat(ext);
  if (fmt === "unsupported") return null;
  return withSlot(async () => {
    const again = cache.get(path);
    if (again !== undefined) return again;
    let url: string | null = null;
    try {
      if (fmt === "pdf") url = await pdfThumb(path);
      else if (fmt === "ebook") url = await ebookThumb(path);
      else if (fmt === "psd") url = await psdThumb(path);
      else url = await textThumb(path); // markdown | text
    } catch (e) {
      console.error("[doc] thumb failed", path, e);
    }
    if (url !== null) cache.set(path, url);
    return url;
  });
}
