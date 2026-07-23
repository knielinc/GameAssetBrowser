import { create } from "zustand";

/**
 * Tone-mapping for HDR/EXR (and developed camera-RAW) previews: which operator
 * squeezes the wider-than-display float range into sRGB, and an exposure
 * offset in EV stops.
 *
 * ONE global choice, shared by the inspector drawer and the fullscreen overlay
 * (same rationale as envPrefs). Session-only: a viewing preference, not worth
 * persisting a possibly-changed default across launches.
 *
 * The operator ids are the wire tokens the `preview://…?tm=<id>&ev=<stops>`
 * query carries, and each maps to the identical three.js tone-mapping constant
 * so the 2D preview (tone-mapped in Rust) matches the lit 3D surface (tone-
 * mapped live by three). Keep in lockstep with `Tonemap` in
 * `src-tauri/src/tonemap.rs`.
 *
 * Grid thumbnails are NOT affected — they use a fixed ACES default so the whole
 * library needn't re-decode when you audition an operator. The control only
 * appears for float-source previews (see isFloatPreview in loadModel.ts).
 */
export const TONEMAPS = [
  { id: "linear", label: "Linear", short: "Lin" },
  { id: "reinhard", label: "Reinhard", short: "Rein" },
  { id: "aces", label: "ACES Filmic", short: "ACES" },
  { id: "agx", label: "AgX", short: "AgX" },
  { id: "neutral", label: "Neutral", short: "Neut" },
] as const;

export type TonemapId = (typeof TONEMAPS)[number]["id"];

/** EV clamp for the exposure stepper — ±6 stops covers any real HDRI. */
export const EV_MIN = -6;
export const EV_MAX = 6;
export const EV_STEP = 0.5;

export interface TonemapPrefs {
  tonemap: TonemapId;
  /** Exposure offset in EV stops; the Rust/three side multiplies by 2^ev. */
  exposure: number;
  setTonemap: (t: TonemapId) => void;
  setExposure: (ev: number) => void;
}

export const useTonemapPrefs = create<TonemapPrefs>((set) => ({
  tonemap: "aces",
  exposure: 0,
  setTonemap: (tonemap) => set({ tonemap }),
  setExposure: (exposure) =>
    set({ exposure: Math.min(EV_MAX, Math.max(EV_MIN, Math.round(exposure / EV_STEP) * EV_STEP)) }),
}));
