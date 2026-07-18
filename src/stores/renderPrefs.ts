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
const KEY = "gameassetbrowser.pixelArt";
const LIGHT_KEY = "gameassetbrowser.modelLight";

/** Lighting rigs for the 3D model viewport. Studio is the balanced default
 *  (and what thumbnails are baked with, for agreement between the two). */
export type ModelLight = "studio" | "sun" | "rim" | "soft";
export const MODEL_LIGHTS: { id: ModelLight; label: string }[] = [
  { id: "studio", label: "Studio" },
  { id: "sun", label: "Sun" },
  { id: "rim", label: "Rim" },
  { id: "soft", label: "Soft" },
];

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function loadLight(): ModelLight {
  try {
    const v = localStorage.getItem(LIGHT_KEY);
    if (v !== null && MODEL_LIGHTS.some((l) => l.id === v)) return v as ModelLight;
  } catch {
    /* storage disabled */
  }
  return "studio";
}

export interface RenderPrefs {
  /** Nearest-neighbour scaling everywhere — pixel art stays crisp. */
  pixelArt: boolean;
  setPixelArt: (v: boolean) => void;
  toggle: () => void;
  /** Which light rig the 3D model viewport uses. */
  modelLight: ModelLight;
  setModelLight: (v: ModelLight) => void;
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
  modelLight: loadLight(),
  setModelLight: (v) => {
    try {
      localStorage.setItem(LIGHT_KEY, v);
    } catch {
      /* storage disabled — keep it in-memory only */
    }
    set({ modelLight: v });
  },
}));
