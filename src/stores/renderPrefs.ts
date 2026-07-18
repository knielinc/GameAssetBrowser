import { create } from "zustand";

/**
 * Global rendering preferences that apply across every asset surface, not one
 * preview. Today that's just pixel-art (nearest-neighbour) vs smooth scaling —
 * flipping it must refresh BOTH the WebGL grid (atlas LINEAR ↔ NEAREST) and the
 * flat/fullscreen image previews at once, which a per-preview flag can't do.
 *
 * Persisted to localStorage rather than settings.json: it's a pure frontend
 * render choice with no Rust side, so it stays off the mirrored IPC contract.
 */
const KEY = "assetpreviewer.pixelArt";

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export interface RenderPrefs {
  /** Nearest-neighbour scaling everywhere — pixel art stays crisp. */
  pixelArt: boolean;
  setPixelArt: (v: boolean) => void;
  toggle: () => void;
}

export const useRenderPrefs = create<RenderPrefs>((set, get) => ({
  pixelArt: load(),
  setPixelArt: (v) => {
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      /* private mode / storage disabled — keep it in-memory only */
    }
    set({ pixelArt: v });
  },
  toggle: () => get().setPixelArt(!get().pixelArt),
}));
