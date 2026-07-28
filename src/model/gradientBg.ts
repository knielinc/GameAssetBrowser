import * as THREE from "three";

/** Every light-rig id that maps to a backdrop. Superset of the model viewport's
 *  rigs (studio/sun/rim/soft) plus the texture preview's extra `unlit`. */
export type BackdropMode = "studio" | "sun" | "rim" | "soft" | "unlit";

const cache = new Map<string, THREE.CanvasTexture>();

/** [top, bottom] sRGB stops per rig, per app mode. The light set mirrors each
 *  rig's MOOD rather than its literal values — warm for sun, cool for rim, a
 *  bright lightbox for soft — so a model reads the same way in either mode,
 *  just against paper instead of a darkroom. */
const STOPS: Record<"dark" | "light", Record<BackdropMode, [string, string]>> = {
  dark: {
    studio: ["#26262e", "#0b0b10"],
    sun: ["#33291b", "#0e0b07"],
    rim: ["#141826", "#050506"],
    soft: ["#35363f", "#15161d"],
    unlit: ["#0f0f13", "#08080b"],
  },
  light: {
    studio: ["#fafbfc", "#d9dbe1"],
    sun: ["#fdf4e4", "#e6d8c0"],
    rim: ["#eef1f8", "#c6ccd9"],
    soft: ["#ffffff", "#e6e7ec"],
    unlit: ["#f4f4f7", "#e4e4e9"],
  },
};

/** The app's light/dark mode, as stamped on :root by applyTheme(). */
function appMode(): "dark" | "light" {
  return document.documentElement.dataset.uiMode === "light" ? "light" : "dark";
}

/**
 * Vertical gradient backdrop matching a light rig's mood — warm for the sun
 * key, cool to pop a silhouette under rim, a bright lightbox for soft, neutral
 * for studio, flat for unlit (so raw albedo reads honestly).
 *
 * Follows the app's light/dark mode: a near-black stage under a light theme was
 * the one surface that never got the memo, and it read as a hole punched in the
 * window next to the paper-white 2D and document previews.
 *
 * Shared by the 3D model viewport and the texture/material 3D preview so the
 * four common rigs look identical in both. A CanvasTexture set as
 * scene.background renders as a full-screen quad, so the gradient reads top
 * (sky) to bottom (ground) behind the subject. Built lazily once per
 * mode+scheme and shared across every viewport and renderer (never disposed,
 * like the UV checker); three uploads it per-context on first use.
 */
export function gradientBackground(mode: BackdropMode): THREE.CanvasTexture {
  const scheme = appMode();
  const key = `${mode}|${scheme}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const [top, bottom] = STOPS[scheme][mode];
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 8, 256);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, tex);
  return tex;
}
