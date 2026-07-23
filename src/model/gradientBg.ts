import * as THREE from "three";

/** Every light-rig id that maps to a backdrop. Superset of the model viewport's
 *  rigs (studio/sun/rim/soft) plus the texture preview's extra `unlit`. */
export type BackdropMode = "studio" | "sun" | "rim" | "soft" | "unlit";

const cache = new Map<BackdropMode, THREE.CanvasTexture>();

/**
 * Vertical gradient backdrop matching a light rig's mood — warm for the sun
 * key, cool-and-dark to pop a silhouette under rim, a bright lightbox for soft,
 * neutral for studio, near-black for unlit (so raw albedo reads honestly).
 *
 * Shared by the 3D model viewport and the texture/material 3D preview so the
 * four common rigs look identical in both. A CanvasTexture set as
 * scene.background renders as a full-screen quad, so the gradient reads top
 * (sky) to bottom (ground) behind the subject. Built lazily once per mode and
 * shared across every viewport and renderer (never disposed, like the UV
 * checker); three uploads it per-context on first use.
 */
export function gradientBackground(mode: BackdropMode): THREE.CanvasTexture {
  const cached = cache.get(mode);
  if (cached !== undefined) return cached;
  // [top, bottom] sRGB stops per rig.
  const stops: Record<BackdropMode, [string, string]> = {
    studio: ["#26262e", "#0b0b10"],
    sun: ["#33291b", "#0e0b07"],
    rim: ["#141826", "#050506"],
    soft: ["#35363f", "#15161d"],
    unlit: ["#0f0f13", "#08080b"],
  };
  const [top, bottom] = stops[mode];
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
  cache.set(mode, tex);
  return tex;
}
