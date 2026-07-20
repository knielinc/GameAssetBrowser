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
const INFO_KEY = "gameassetbrowser.showCellInfo";
const WIRE_KEY = "gameassetbrowser.modelWireframe";
const CHECKER_KEY = "gameassetbrowser.modelChecker";
const SILHOUETTE_KEY = "gameassetbrowser.modelSilhouette";
const TURNTABLE_KEY = "gameassetbrowser.modelTurntable";

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

/** Defaults ON — the pills are useful; hiding them is the opt-in. */
function loadInfo(): boolean {
  try {
    return localStorage.getItem(INFO_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Off-by-default viewport toggles (wireframe, checker, silhouette, turntable)
 *  — the plain model view is the honest default; overlays are opt-in. */
function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function saveFlag(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* private mode / storage disabled — keep it in-memory only */
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
  /** Show the info pills (size, format, dimensions, badges) on grid cells. */
  showCellInfo: boolean;
  setShowCellInfo: (v: boolean) => void;
  toggleCellInfo: () => void;
  /** Which light rig the 3D model viewport uses. */
  modelLight: ModelLight;
  setModelLight: (v: ModelLight) => void;
  /** Model viewport: render every material as wireframe. */
  modelWireframe: boolean;
  setModelWireframe: (v: boolean) => void;
  /** Model viewport: swap base-colour maps for a UV checker grid. */
  modelChecker: boolean;
  setModelChecker: (v: boolean) => void;
  /** Model viewport: show a 1.8-unit human capsule for scale reference. */
  modelSilhouette: boolean;
  setModelSilhouette: (v: boolean) => void;
  /** Model viewport: slow auto-rotation of the model. */
  modelTurntable: boolean;
  setModelTurntable: (v: boolean) => void;
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
  showCellInfo: loadInfo(),
  setShowCellInfo: (v) => {
    try {
      localStorage.setItem(INFO_KEY, v ? "1" : "0");
    } catch {
      /* storage disabled — in-memory only */
    }
    set({ showCellInfo: v });
  },
  toggleCellInfo: () => get().setShowCellInfo(!get().showCellInfo),
  modelLight: loadLight(),
  setModelLight: (v) => {
    try {
      localStorage.setItem(LIGHT_KEY, v);
    } catch {
      /* storage disabled — keep it in-memory only */
    }
    set({ modelLight: v });
  },
  modelWireframe: loadFlag(WIRE_KEY),
  setModelWireframe: (v) => {
    saveFlag(WIRE_KEY, v);
    set({ modelWireframe: v });
  },
  modelChecker: loadFlag(CHECKER_KEY),
  setModelChecker: (v) => {
    saveFlag(CHECKER_KEY, v);
    set({ modelChecker: v });
  },
  modelSilhouette: loadFlag(SILHOUETTE_KEY),
  setModelSilhouette: (v) => {
    saveFlag(SILHOUETTE_KEY, v);
    set({ modelSilhouette: v });
  },
  modelTurntable: loadFlag(TURNTABLE_KEY),
  setModelTurntable: (v) => {
    saveFlag(TURNTABLE_KEY, v);
    set({ modelTurntable: v });
  },
}));
