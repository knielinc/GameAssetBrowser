import { create } from "zustand";

/**
 * One resume bookmark per ebook, keyed by file path — the reader's twin of
 * usePdfBookmarks. The iframe-free ebook reader (EbookView) is a single scroll
 * surface, so a bookmark is just the scroll progress (0–1) through the book,
 * like the PDF bookmark is a page number. `view.scrollTo(fraction)` returns
 * there. Setting replaces any previous mark for that file.
 *
 * Lives in localStorage (UI chrome, off the settings contract) like docView.
 */
const KEY = "gameassetbrowser.ebookbookmarks";

function load(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return {};
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export interface EbookBookmarks {
  marks: Record<string, number>;
  setMark: (path: string, fraction: number) => void;
  clearMark: (path: string) => void;
}

export const useEbookBookmarks = create<EbookBookmarks>((set, get) => {
  const persist = (marks: Record<string, number>): void => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(marks));
    } catch {
      /* localStorage unavailable — the bookmark just won't survive a restart */
    }
  };
  return {
    marks: load(),
    setMark: (path, fraction) => {
      const marks = { ...get().marks, [path]: fraction };
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
