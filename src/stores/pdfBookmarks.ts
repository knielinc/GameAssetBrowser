import { create } from "zustand";

/**
 * One resume bookmark per PDF, keyed by file path. A reading-position aid, so
 * it lives in localStorage (UI chrome, off the settings contract) like
 * panelPrefs/docView. Setting a bookmark replaces any previous one for that
 * file — there is only ever one per PDF.
 */
const KEY = "gameassetbrowser.pdfbookmarks";

function load(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return {};
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export interface PdfBookmarks {
  marks: Record<string, number>;
  setMark: (path: string, page: number) => void;
  clearMark: (path: string) => void;
}

export const usePdfBookmarks = create<PdfBookmarks>((set, get) => {
  const persist = (marks: Record<string, number>): void => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(marks));
    } catch {
      /* localStorage unavailable — the bookmark just won't survive a restart */
    }
  };
  return {
    marks: load(),
    setMark: (path, page) => {
      const marks = { ...get().marks, [path]: page };
      set({ marks });
      persist(marks);
    },
    clearMark: (path) => {
      const marks = { ...get().marks };
      delete marks[path];
      set({ marks });
      persist(marks);
    },
  };
});
