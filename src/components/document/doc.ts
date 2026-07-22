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

export type DocFormat = "markdown" | "text" | "pdf" | "psd" | "unsupported";

export function docFormat(ext: string): DocFormat {
  const e = ext.toLowerCase();
  if (e === "md" || e === "markdown") return "markdown";
  if (e === "txt") return "text";
  if (e === "pdf") return "pdf";
  if (e === "psd" || e === "psb") return "psd";
  return "unsupported";
}

/** Whether the A−/A+ zoom applies. PSD has its own fit/layer UI. */
export function docSupportsZoom(ext: string): boolean {
  const f = docFormat(ext);
  return f === "markdown" || f === "text" || f === "pdf";
}

/** Whether to show the PDF-only page-layout control. */
export function docIsPdf(ext: string): boolean {
  return docFormat(ext) === "pdf";
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
