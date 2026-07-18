import { create } from "zustand";

/**
 * Show/hide state for the two side panels — the left folder sidebar and the
 * right inspector. Persisted to localStorage (UI chrome, off the settings
 * contract), shared so App can toggle the left panel and TabPane the right.
 */
const KEY = "gameassetbrowser.panels";

function load(): { left: boolean; right: boolean } {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return { left: true, right: true };
    const p = JSON.parse(raw) as { left?: unknown; right?: unknown };
    return { left: p.left !== false, right: p.right !== false };
  } catch {
    return { left: true, right: true };
  }
}

export interface PanelPrefs {
  left: boolean;
  right: boolean;
  toggleLeft: () => void;
  toggleRight: () => void;
}

export const usePanelPrefs = create<PanelPrefs>((set, get) => {
  const persist = (): void => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ left: get().left, right: get().right }));
    } catch {
      /* localStorage unavailable — visibility just won't survive a restart */
    }
  };
  const init = load();
  return {
    left: init.left,
    right: init.right,
    toggleLeft: () => {
      set({ left: !get().left });
      persist();
    },
    toggleRight: () => {
      set({ right: !get().right });
      persist();
    },
  };
});
