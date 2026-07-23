// Minimal typings for the vendored foliate-js entry point (view.js is plain JS
// with no bundled types). Only the surface EbookView.tsx and docThumb.ts touch
// is declared; everything else stays untyped on purpose.

/** One spine item. `createDocument` parses the section's (X)HTML and rewrites
 *  its resource references (images, etc.) to blob: URLs — the app renders that
 *  document's body itself (see EbookView) rather than letting foliate paginate
 *  it in an iframe. */
export interface FoliateSection {
  /** The section's path within the container (e.g. "OEBPS/ch1.xhtml"). */
  id?: string;
  linear?: string;
  /** Blob: URL of the section's fully-resolved (X)HTML — images become blob:
   *  URLs, `<a href>` is left relative. This is foliate's real render source. */
  load?: () => Promise<string>;
  /** Parses the raw section text WITHOUT resolving resources (relative URLs). */
  createDocument?: () => Promise<Document>;
  /** Resolve a relative href against this section's path → container path#hash. */
  resolveHref?: (href: string) => string | null;
  /** Revoke the blob: URLs load() created for this section. */
  unload?: () => void;
}

/** A parsed book, as returned by makeBook and exposed on a foliate-view. */
export interface FoliateBook {
  metadata?: {
    title?: string | Record<string, string>;
    author?: unknown;
    language?: string;
  };
  /** Table of contents (array of { label, href, subitems? }), when present. */
  toc?: unknown;
  /** "ltr" | "rtl" — page progression direction. */
  dir?: string;
  sections?: FoliateSection[];
  /** Cover image, when the format carries one. */
  getCover?: () => Promise<Blob | null> | Blob | null;
  /** Emits a `data` event per loaded resource, letting a listener rewrite/guard
   *  the resource body (we use it to swallow failed-resource rejections). */
  transformTarget?: EventTarget;
}

/** Where a relocate event's `detail` lands us. */
export interface FoliateLocation {
  /** Reading progress across the whole book, 0–1. */
  fraction?: number;
  /** Coarse location counter, when the format provides one. */
  location?: { current?: number; total?: number };
  /** Current table-of-contents entry. */
  tocItem?: { label?: string; href?: string };
  pageItem?: { label?: string };
  /** Stable, reflow-proof pointer to the current spot — persist this to resume. */
  cfi?: string;
}

/** The renderer element (foliate-paginator / foliate-fxl) created by open(). */
export interface FoliateRenderer extends HTMLElement {
  next: (distance?: number) => Promise<void>;
  prev: (distance?: number) => Promise<void>;
  setStyles?: (css: string) => void;
}

/** The <foliate-view> custom element. */
export interface FoliateView extends HTMLElement {
  book: FoliateBook;
  renderer: FoliateRenderer;
  open: (source: File | Blob | string | FoliateBook) => Promise<void>;
  close: () => void;
  next: (distance?: number) => Promise<void>;
  prev: (distance?: number) => Promise<void>;
  goLeft: () => Promise<void> | void;
  goRight: () => Promise<void> | void;
  goTo: (target: unknown) => Promise<unknown>;
  goToFraction: (fraction: number) => Promise<void>;
  getSectionFractions: () => number[];
}

/** Detect the format and parse `file` (a named File/Blob) into a book. */
export function makeBook(file: File | Blob | string): Promise<FoliateBook>;
