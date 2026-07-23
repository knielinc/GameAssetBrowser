import { create } from "zustand";

/**
 * Reading preferences for the document preview — a font/zoom scale and the PDF
 * page layout — shared so the docked inspector and the fullscreen viewer agree
 * and the controls in either place drive both. Persisted to localStorage (UI
 * chrome, off the settings contract), like panelPrefs.
 */
const KEY = "gameassetbrowser.docview";

export const MIN_SCALE = 0.7;
export const MAX_SCALE = 2.4;
const STEP = 0.15;

/** Base body font size (px) the ebook viewer scales from with fontScale. */
export const MD_BASE_EBOOK = 16;

/** PDF page layout: fit to the column width, one whole page per screen, or a
 *  two-page facing spread. */
export type PdfLayout = "width" | "single" | "spread";
const PDF_LAYOUTS: readonly PdfLayout[] = ["width", "single", "spread"];

/** Text/markdown/ebook column: a centered readable measure, or edge-to-edge. */
export type ReadWidth = "readable" | "full";
const READ_WIDTHS: readonly ReadWidth[] = ["readable", "full"];

const clamp = (n: number): number =>
  // Round to the nearest step so the A−/A+ pair always lands on clean values.
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(n / STEP) * STEP));

interface Persisted {
  fontScale: number;
  pdfLayout: PdfLayout;
  readWidth: ReadWidth;
}

function load(): Persisted {
  const fallback: Persisted = {
    fontScale: 1,
    pdfLayout: "width",
    readWidth: "readable",
  };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return fallback;
    const p = JSON.parse(raw) as Partial<Persisted>;
    const n = Number(p.fontScale);
    return {
      fontScale: Number.isFinite(n) ? clamp(n) : 1,
      pdfLayout: PDF_LAYOUTS.includes(p.pdfLayout as PdfLayout) ? (p.pdfLayout as PdfLayout) : "width",
      readWidth: READ_WIDTHS.includes(p.readWidth as ReadWidth)
        ? (p.readWidth as ReadWidth)
        : "readable",
    };
  } catch {
    return fallback;
  }
}

export interface DocViewPrefs {
  /** Multiplier on the preview's base font size / PDF page width. */
  fontScale: number;
  pdfLayout: PdfLayout;
  readWidth: ReadWidth;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  setPdfLayout: (layout: PdfLayout) => void;
  setReadWidth: (width: ReadWidth) => void;
}

export const useDocView = create<DocViewPrefs>((set, get) => {
  const persist = (): void => {
    try {
      window.localStorage.setItem(
        KEY,
        JSON.stringify({
          fontScale: get().fontScale,
          pdfLayout: get().pdfLayout,
          readWidth: get().readWidth,
        }),
      );
    } catch {
      /* localStorage unavailable — prefs just won't survive a restart */
    }
  };
  const init = load();
  return {
    fontScale: init.fontScale,
    pdfLayout: init.pdfLayout,
    readWidth: init.readWidth,
    zoomIn: () => {
      set({ fontScale: clamp(get().fontScale + STEP) });
      persist();
    },
    zoomOut: () => {
      set({ fontScale: clamp(get().fontScale - STEP) });
      persist();
    },
    reset: () => {
      set({ fontScale: 1 });
      persist();
    },
    setPdfLayout: (pdfLayout) => {
      set({ pdfLayout });
      persist();
    },
    setReadWidth: (readWidth) => {
      set({ readWidth });
      persist();
    },
  };
});
