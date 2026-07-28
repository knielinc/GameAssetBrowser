import { create } from "zustand";
// theme.ts imports nothing from here, so this is a one-way edge. Importing it
// also guarantees applyTheme() has run before we read the mode below.
import { THEMES, useThemeStore } from "./theme";

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

/** Reading page for every prose document — ebook, markdown, plain text (NOT
 *  pdf, whose pages are images of paper the file itself produced). Dark or the
 *  light sepia paper.
 *
 *  Seeded from the app theme's light/dark mode on first run, then INDEPENDENT
 *  of it: you read in whichever page colour suits the room, not whichever
 *  chrome the app wears, so switching app themes later never overwrites a
 *  reading choice you made deliberately. */
export type ReadTheme = "dark" | "light";
const READ_THEMES: readonly ReadTheme[] = ["dark", "light"];

/** The app's current mode, as the first-run default for the reading page. */
function themeDefault(): ReadTheme {
  const { themeId } = useThemeStore.getState();
  return THEMES.find((t) => t.id === themeId)?.light === true ? "light" : "dark";
}

const clamp = (n: number): number =>
  // Round to the nearest step so the A−/A+ pair always lands on clean values.
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(n / STEP) * STEP));

interface Persisted {
  fontScale: number;
  pdfLayout: PdfLayout;
  readWidth: ReadWidth;
  readTheme: ReadTheme;
}

function load(): Persisted {
  const fallback: Persisted = {
    fontScale: 1,
    pdfLayout: "width",
    readWidth: "readable",
    readTheme: themeDefault(),
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
      readTheme: READ_THEMES.includes(p.readTheme as ReadTheme)
        ? (p.readTheme as ReadTheme)
        : themeDefault(),
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
  readTheme: ReadTheme;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  setPdfLayout: (layout: PdfLayout) => void;
  setReadWidth: (width: ReadWidth) => void;
  setReadTheme: (theme: ReadTheme) => void;
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
          readTheme: get().readTheme,
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
    readTheme: init.readTheme,
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
    setReadTheme: (readTheme) => {
      set({ readTheme });
      persist();
    },
  };
});
