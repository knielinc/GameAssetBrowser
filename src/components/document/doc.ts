import { schemeBase } from "../../platform";

/** Shared document helpers — kept dependency-free (no three.js, no pdf.js) so
 *  both the light text/markdown paths and the heavy PDF renderer can import them
 *  without pulling each other in. */

/** `\` → `/`, drop the leading slash, keep `/` and `:` literal so the Rust
 *  handler still sees a multi-segment path. Mirrors schemePath in loadModel.ts,
 *  duplicated to keep three.js out of the document chunk. */
function schemePath(path: string): string {
  return encodeURI(path.replace(/\\/g, "/").replace(/^\//, ""));
}

/** URL for a document file over the `doc://` scheme. */
export function docUrl(path: string): string {
  return `${schemeBase("doc")}/${schemePath(path)}`;
}

export type DocFormat = "markdown" | "text" | "pdf" | "psd" | "ebook" | "unsupported";

/** Ebook formats the foliate-js viewer renders. `fbz` is FB2-in-a-zip; the
 *  plain `.fb2.zip` double extension isn't listed because the scanner keys off
 *  the last extension only ("zip"), and sweeping every .zip into Documents is
 *  worse than missing that one variant. Mirrors the ebook slice of
 *  DOCUMENT_EXTENSIONS in types.ts / types.rs. */
export const EBOOK_EXTENSIONS = ["epub", "mobi", "azw", "azw3", "fb2", "fbz", "cbz"] as const;

export function docFormat(ext: string): DocFormat {
  const e = ext.toLowerCase();
  if (e === "md" || e === "markdown") return "markdown";
  if (e === "txt") return "text";
  if (e === "pdf") return "pdf";
  if (e === "psd" || e === "psb") return "psd";
  if ((EBOOK_EXTENSIONS as readonly string[]).includes(e)) return "ebook";
  return "unsupported";
}

/** Whether the A−/A+ zoom applies. PSD has its own fit/layer UI. */
export function docSupportsZoom(ext: string): boolean {
  const f = docFormat(ext);
  return f === "markdown" || f === "text" || f === "pdf" || f === "ebook";
}

/** Whether to show the PDF-only page-layout control. */
export function docIsPdf(ext: string): boolean {
  return docFormat(ext) === "pdf";
}

/** EPUB / MOBI / AZW3 / FB2 / CBZ — rendered by the foliate-js viewer. */
export function docIsEbook(ext: string): boolean {
  return docFormat(ext) === "ebook";
}

/** Text/markdown — the formats that take the readable-width toggle. */
export function docIsTextual(ext: string): boolean {
  const f = docFormat(ext);
  return f === "markdown" || f === "text";
}

/** Photoshop documents — parsed in-browser with a layer show/hide panel. */
export function docIsPsd(ext: string): boolean {
  return docFormat(ext) === "psd";
}
