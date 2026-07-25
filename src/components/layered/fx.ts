/**
 * Photoshop layer effects, rendered in the worker at load time.
 *
 * Effects never change interactively in a preview (there is no style editor
 * here), so they are baked ONCE per layer instead of being recomputed per
 * frame: interior effects (overlays, satin, inner glow/shadow, bevel) are
 * blended straight into the layer's own pixels, and exterior effects (drop
 * shadow, outer glow, stroke) become extra cels the compositor draws beneath /
 * above the fill with their own blend mode and opacity — a drop shadow
 * multiplies against whatever ends up UNDER the layer, so it cannot be
 * pre-flattened into it.
 *
 * Every formula here is checked against Photoshop's own baked composite for
 * `layer_effects.psd` / `effect-stroke-gradient.psd` (psd-tools fixtures); an
 * effect we cannot get acceptably close to is skipped and reported by name
 * rather than shipped as a guess.
 */

import type { Layer, LayerEffectsInfo, EffectSolidGradient } from "ag-psd";
import { mixColor, normalizeBlend, type BlendKey } from "./blend";

/** An exterior effect's pixels, positioned on the canvas. */
export interface FxDraw {
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  x: number;
  y: number;
  blend: BlendKey;
  opacity: number;
  /** Drawn beneath the fill (shadows, glows) instead of above it (stroke). */
  under: boolean;
}

export interface FxResult {
  draws: FxDraw[];
  /** Effect kinds present and enabled that were NOT rendered. */
  skipped: string[];
}

/** The layer's pixels, in canvas space, that interior effects bake into. */
export interface FillBuffer {
  data: Uint8ClampedArray;
  w: number;
  h: number;
  x: number;
  y: number;
}

const on = (e: { enabled?: boolean; present?: boolean } | undefined): boolean =>
  e !== undefined && e.enabled !== false && e.present !== false;

const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** ag-psd descriptor colours are 0..255 floats; grayscale is black-%. */
export function toRgb(color: unknown): [number, number, number] {
  const c = (color ?? {}) as Record<string, number>;
  if (typeof c.r === "number") return [c.r, c.g ?? 0, c.b ?? 0];
  if (typeof c.k === "number") {
    const v = 255 - (c.k / 100) * 255;
    return [v, v, v];
  }
  return [0, 0, 0];
}

/**
 * An effect measurement in pixels.
 *
 * ag-psd hands these over as `{ value, units }` and resolves nearly all of them
 * to pixels already, which is exactly what we want. Anything that arrives in
 * points still has to be converted, which is what `perPoint` is for.
 */
const px = (
  u: { value?: number; units?: string } | number | undefined,
  perPoint = 1,
): number => {
  if (typeof u === "number") return u;
  if (u === undefined) return 0;
  const v = u.value ?? 0;
  return u.units === "Pixels" ? v : v * perPoint;
};

// ---------------------------------------------------------------------------
// Plane math (Float32, 0..1)
// ---------------------------------------------------------------------------

/** The three box radii whose iterated blur approximates a gaussian of sigma. */
function gaussBoxes(sigma: number): number[] {
  const n = 3;
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => ((i < m ? wl : wu) - 1) / 2);
}

function boxBlurPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  // Horizontal running-sum box blur; caller transposes for vertical.
  const ir = Math.floor(r);
  const norm = 1 / (2 * ir + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -ir; x <= ir; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * norm;
      const add = Math.min(w - 1, x + ir + 1);
      const sub = Math.max(0, x - ir);
      acc += src[row + add] - src[row + sub];
    }
  }
}

function transpose(src: Float32Array, dst: Float32Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) dst[x * h + y] = src[y * w + x];
  }
}

/**
 * Gaussian-ish blur of a plane, in place. Photoshop's "size" slider spans the
 * full falloff of the effect, which a gaussian of sigma = size/2 reproduces
 * closely (checked against the drop-shadow fixture region).
 */
export function blurPlane(plane: Float32Array, w: number, h: number, size: number): void {
  if (size < 0.5) return;
  const boxes = gaussBoxes(size / 2);
  const tmp = new Float32Array(plane.length);
  for (const r of boxes) {
    boxBlurPass(plane, tmp, w, h, r);
    plane.set(tmp);
  }
  // Vertical: transpose, blur rows, transpose back.
  const t = new Float32Array(plane.length);
  transpose(plane, t, w, h);
  for (const r of boxes) {
    boxBlurPass(t, tmp, h, w, r);
    t.set(tmp);
  }
  transpose(t, plane, h, w);
}

/**
 * Squared euclidean distance transform (Felzenszwalb–Huttenlocher), distance to
 * the nearest pixel where `inside` is true. Exact, O(n).
 */
export function edtSq(inside: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e12;
  const f = new Float32Array(Math.max(w, h));
  const d = new Float32Array(Math.max(w, h));
  const z = new Float32Array(Math.max(w, h) + 1);
  const v = new Int32Array(Math.max(w, h));
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = inside[i] !== 0 ? 0 : INF;

  const dt1d = (n: number): void => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    dt1d(w);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x];
    dt1d(h);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  return out;
}

/** Shift a plane by whole pixels; vacated area is zero. */
function shiftPlane(plane: Float32Array, w: number, h: number, dx: number, dy: number): Float32Array {
  const out = new Float32Array(plane.length);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= w) continue;
      out[y * w + x] = plane[sy * w + sx];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------

/** Evaluate a solid gradient into a 256-entry table of [r,g,b,a] (0..255/0..1). */
export function gradientTable(
  g: EffectSolidGradient,
  reverse: boolean,
): { rgb: Float32Array; alpha: Float32Array } {
  const rgb = new Float32Array(256 * 3);
  const alpha = new Float32Array(256).fill(1);
  const stops = [...(g.colorStops ?? [])].sort((a, b) => a.location - b.location);
  const ops = [...(g.opacityStops ?? [])].sort((a, b) => a.location - b.location);
  // Locations arrive as 0..1 or Photoshop's raw 0..4096 depending on source.
  const maxLoc = Math.max(1, ...stops.map((s) => s.location), ...ops.map((s) => s.location));
  const norm = maxLoc > 1.0001 ? 1 / 4096 : 1;

  const seg = (arr: { location: number; midpoint?: number }[], t: number): [number, number, number] => {
    // Returns [index of left stop, index of right stop, local t with midpoint skew].
    if (arr.length === 0) return [0, 0, 0];
    let i = 0;
    while (i < arr.length - 1 && t > arr[i + 1].location * norm) i++;
    const a = arr[i];
    const b = arr[Math.min(i + 1, arr.length - 1)];
    const la = a.location * norm;
    const lb = b.location * norm;
    let lt = lb <= la ? 0 : (t - la) / (lb - la);
    lt = Math.min(1, Math.max(0, lt));
    let m = (a.midpoint ?? 50) / 100;
    m = Math.min(0.99, Math.max(0.01, m));
    lt = lt <= m ? 0.5 * (lt / m) : 0.5 + 0.5 * ((lt - m) / (1 - m));
    return [i, Math.min(i + 1, arr.length - 1), lt];
  };

  for (let x = 0; x < 256; x++) {
    let t = x / 255;
    if (reverse) t = 1 - t;
    if (stops.length > 0) {
      const [i, j, lt] = seg(stops, t);
      const ca = toRgb(stops[i].color);
      const cb = toRgb(stops[j].color);
      rgb[x * 3] = ca[0] + (cb[0] - ca[0]) * lt;
      rgb[x * 3 + 1] = ca[1] + (cb[1] - ca[1]) * lt;
      rgb[x * 3 + 2] = ca[2] + (cb[2] - ca[2]) * lt;
    }
    if (ops.length > 0) {
      const [i, j, lt] = seg(ops, t);
      const oa = ops[i].opacity ?? 1;
      const ob = ops[j].opacity ?? 1;
      alpha[x] = oa + (ob - oa) * lt;
    }
  }
  return { rgb, alpha };
}

/**
 * Gradient parameter t for a pixel over a bounding box, per Photoshop's
 * geometry: linear spans the box corner-to-corner along the angle, radial from
 * the centre, reflected mirrors around the centre.
 *
 * `scale` is the fraction ag-psd reports (1 = Photoshop's 100%), NOT a
 * percentage: below 1 it compresses the ramp towards the centre, above 1 it
 * stretches it past the box.
 */
function gradientT(
  style: string,
  angleDeg: number,
  scaleFrac: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  x: number,
  y: number,
): number {
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const a = (angleDeg * Math.PI) / 180;
  const dirX = Math.cos(a);
  const dirY = -Math.sin(a); // canvas y runs down
  const span = (Math.abs(dirX) * bw + Math.abs(dirY) * bh) / 2;
  const proj = (x - cx) * dirX + (y - cy) * dirY;
  const scale = Math.max(0.01, scaleFrac);
  let t: number;
  if (style === "radial") {
    t = Math.hypot(x - cx, y - cy) / (Math.hypot(bw, bh) / 2);
  } else if (style === "reflected") {
    t = Math.abs(proj) / Math.max(1, span);
  } else {
    // linear (angle/diamond fall back to linear)
    t = 0.5 + proj / Math.max(1, 2 * span);
  }
  t = 0.5 + (t - 0.5) / scale;
  return Math.min(1, Math.max(0, t));
}

// ---------------------------------------------------------------------------
// Baking
// ---------------------------------------------------------------------------

/**
 * Blend a coloured plane into the fill's COLOUR, never its coverage — the
 * interior half of every effect. Photoshop clips interior effects to the layer,
 * so a pixel's alpha is already the ceiling of what can show; re-compositing
 * would grow alpha at antialiased edges and visibly fringe them. `weight` is
 * the effect's own strength 0..1 per pixel.
 */
function bakeInterior(
  fill: FillBuffer,
  weight: Float32Array,
  colorOf: (i: number) => [number, number, number],
  blend: BlendKey,
  opacity: number,
): void {
  const n = fill.w * fill.h;
  const d = fill.data;
  for (let i = 0; i < n; i++) {
    const w = weight[i] * opacity;
    if (w <= 0 || d[i * 4 + 3] === 0) continue;
    const [sr, sg, sb] = colorOf(i);
    const br = d[i * 4] / 255;
    const bg = d[i * 4 + 1] / 255;
    const bb = d[i * 4 + 2] / 255;
    const [mr, mg, mb] = mixColor(blend, br, bg, bb, sr / 255, sg / 255, sb / 255);
    d[i * 4] = (br + (mr - br) * w) * 255;
    d[i * 4 + 1] = (bg + (mg - bg) * w) * 255;
    d[i * 4 + 2] = (bb + (mb - bb) * w) * 255;
  }
}

/** Build an FxDraw from a plane, trimmed to its non-zero bounds. */
function planeDraw(
  plane: Float32Array,
  w: number,
  h: number,
  originX: number,
  originY: number,
  rgb: [number, number, number],
  blend: BlendKey,
  opacity: number,
  under: boolean,
): FxDraw | null {
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (plane[y * w + x] > 0.002) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const dw = maxX - minX + 1;
  const dh = maxY - minY + 1;
  const rgba = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const a = plane[(y + minY) * w + (x + minX)];
      if (a <= 0) continue;
      const o = (y * dw + x) * 4;
      rgba[o] = rgb[0];
      rgba[o + 1] = rgb[1];
      rgba[o + 2] = rgb[2];
      rgba[o + 3] = a * 255;
    }
  }
  return { rgba, w: dw, h: dh, x: originX + minX, y: originY + minY, blend, opacity, under };
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

/** Effect sizes are capped so a corrupt file can't demand a gigabyte of blur. */
const MAX_SIZE = 250;

export function renderEffects(layer: Layer, fill: FillBuffer, globalAngle: number): FxResult {
  const fx: LayerEffectsInfo | undefined = layer.effects;
  const draws: FxDraw[] = [];
  const skipped: string[] = [];
  if (fx === undefined || fx.disabled === true) return { draws, skipped };

  // NOT the "Scale Effects" percentage its name suggests: measured across
  // fixtures at 72, 150 and 300 dpi this is exactly documentResolution / 72 —
  // the factor Photoshop needs to express a point-valued slider in pixels. It
  // must therefore be applied ONLY to a measurement that is not already in
  // pixels; using it as a blanket multiplier inflated every shadow, glow and
  // stroke on any document that wasn't 72 dpi.
  const perPoint = Math.min(8, Math.max(0.05, fx.scale ?? 1));
  const sz = (u: { value?: number; units?: string } | undefined): number =>
    Math.min(MAX_SIZE, px(u, perPoint));
  const angleOf = (e: { angle?: number; useGlobalLight?: boolean }): number =>
    e.useGlobalLight === true ? (e.angle ?? globalAngle) : (e.angle ?? globalAngle);

  // Shape alpha in a padded frame that fits the largest exterior reach.
  let pad = 2;
  for (const e of list(fx.dropShadow)) if (on(e)) pad = Math.max(pad, sz(e.size) + px(e.distance, perPoint) + 2);
  if (on(fx.outerGlow)) pad = Math.max(pad, sz(fx.outerGlow?.size) + 2);
  for (const e of list(fx.stroke)) if (on(e)) pad = Math.max(pad, sz(e.size) + 2);
  pad = Math.ceil(Math.min(MAX_SIZE + 8, pad));

  const pw = fill.w + pad * 2;
  const ph = fill.h + pad * 2;
  const shape = new Float32Array(pw * ph);
  for (let y = 0; y < fill.h; y++) {
    for (let x = 0; x < fill.w; x++) {
      shape[(y + pad) * pw + (x + pad)] = fill.data[(y * fill.w + x) * 4 + 3] / 255;
    }
  }
  const ox = fill.x - pad;
  const oy = fill.y - pad;

  /** alpha at a padded-frame index, for knockout. */
  const shapeAt = (i: number): number => shape[i];

  /**
   * Signed distance from the shape's edge in the padded frame — negative inside,
   * positive outside. Both glows and the stroke need it, and the transform is
   * the most expensive thing here, so it is computed at most once per layer.
   */
  let sdfCache: Float32Array | null = null;
  const sdf = (): Float32Array => {
    if (sdfCache !== null) return sdfCache;
    const hard = new Uint8Array(pw * ph);
    const inv = new Uint8Array(pw * ph);
    for (let i = 0; i < hard.length; i++) {
      hard[i] = shape[i] > 0.5 ? 1 : 0;
      inv[i] = hard[i] === 0 ? 1 : 0;
    }
    const dOut = edtSq(hard, pw, ph);
    const dIn = edtSq(inv, pw, ph);
    const out = new Float32Array(pw * ph);
    for (let i = 0; i < out.length; i++) {
      out[i] = hard[i] === 1 ? -Math.sqrt(dIn[i]) : Math.sqrt(dOut[i]);
    }
    sdfCache = out;
    return out;
  };

  /**
   * A glow's coverage, growing `size` px from the shape's edge.
   *
   * "Precise" measures true distance from the edge; "softer" — Photoshop's
   * default — is a blur of the shape, which is why it bleeds around corners.
   *
   * Either way the raw ramp only reaches half strength AT the edge, where
   * Photoshop's glow is already at full colour. That is what `range` is for: it
   * is the fraction of the ramp the glow's contour is mapped across, so
   * dividing through by it lifts the near edge back to solid. Without this every
   * glow came out roughly twice too faint.
   */
  const glowRamp = (
    size: number,
    spread: number,
    range: number,
    precise: boolean,
    inward: boolean,
  ): Float32Array => {
    const m = new Float32Array(pw * ph);
    if (precise) {
      const d = sdf();
      const hold = Math.min(0.95, Math.max(0, spread)) * size;
      const fall = Math.max(0.5, size - hold);
      for (let i = 0; i < m.length; i++) {
        const dist = inward ? -d[i] : d[i];
        if (dist >= 0) m[i] = Math.min(1, Math.max(0, 1 - (dist - hold) / fall));
      }
      return m;
    }
    for (let i = 0; i < m.length; i++) m[i] = inward ? 1 - shape[i] : shape[i];
    blurPlane(m, pw, ph, size);
    const r = Math.min(1, Math.max(0.05, range));
    const hold = Math.min(0.95, Math.max(0, spread));
    for (let i = 0; i < m.length; i++) {
      m[i] = Math.min(1, Math.max(0, (m[i] / r - hold) / (1 - hold)));
    }
    return m;
  };

  // Interior weight helper: clip a padded plane to the shape and crop it back
  // into fill space.
  const interiorWeight = (plane: Float32Array): Float32Array => {
    const w = new Float32Array(fill.w * fill.h);
    for (let y = 0; y < fill.h; y++) {
      for (let x = 0; x < fill.w; x++) {
        const pi = (y + pad) * pw + (x + pad);
        w[y * fill.w + x] = plane[pi];
      }
    }
    return w;
  };

  // --- exterior: drop shadow (bottom-most), then outer glow ----------------
  for (const e of list(fx.dropShadow)) {
    if (!on(e)) continue;
    const size = sz(e.size);
    const dist = px(e.distance, perPoint);
    const a = (angleOf(e) * Math.PI) / 180;
    const dx = Math.round(-Math.cos(a) * dist);
    const dy = Math.round(Math.sin(a) * dist);
    let m = shiftPlane(shape, pw, ph, dx, dy);
    blurPlane(m, pw, ph, size);
    // Choke narrows the ramp.
    const choke = Math.min(0.95, (px(e.choke, perPoint)) / Math.max(1, size));
    if (choke > 0) for (let i = 0; i < m.length; i++) m[i] = Math.min(1, Math.max(0, (m[i] - choke) / (1 - choke)));
    if (e.layerConceals !== false) for (let i = 0; i < m.length; i++) m[i] *= 1 - shapeAt(i);
    const d = planeDraw(m, pw, ph, ox, oy, toRgb(e.color), normalizeBlend(e.blendMode), e.opacity ?? 1, true);
    if (d !== null) draws.push(d);
  }
  {
    const e = fx.outerGlow;
    if (on(e) && e !== undefined) {
      const size = Math.max(1, sz(e.size));
      const g = e as { technique?: string; range?: number };
      const m = glowRamp(size, px(e.choke, perPoint) / size, g.range ?? 0.5, g.technique === "precise", false);
      for (let i = 0; i < m.length; i++) m[i] *= 1 - shapeAt(i); // lives outside
      const d = planeDraw(m, pw, ph, ox, oy, toRgb(e.color), normalizeBlend(e.blendMode), e.opacity ?? 1, true);
      if (d !== null) draws.push(d);
    }
  }

  // --- interior, bottom to top: pattern, gradient, color, satin, glows, bevel
  if (on(fx.patternOverlay)) skipped.push("patternOverlay"); // pattern pixels are not decoded by ag-psd

  for (const e of list(fx.gradientOverlay)) {
    if (!on(e)) continue;
    const g = e.gradient;
    if (g === undefined || g.type !== "solid") {
      skipped.push("gradientOverlay");
      continue;
    }
    const table = gradientTable(g, e.reverse === true);
    const weight = new Float32Array(fill.w * fill.h);
    const colors: [number, number, number][] = [];
    const style = (e.type as string) ?? "linear";
    for (let y = 0; y < fill.h; y++) {
      for (let x = 0; x < fill.w; x++) {
        const i = y * fill.w + x;
        const shapeA = fill.data[i * 4 + 3] / 255;
        if (shapeA <= 0) {
          colors.push([0, 0, 0]);
          continue;
        }
        const t = gradientT(style, e.angle ?? 90, e.scale ?? 1, 0, 0, fill.w, fill.h, x, y);
        const ti = Math.round(t * 255);
        weight[i] = table.alpha[ti];
        colors.push([table.rgb[ti * 3], table.rgb[ti * 3 + 1], table.rgb[ti * 3 + 2]]);
      }
    }
    bakeInterior(fill, weight, (i) => colors[i], normalizeBlend(e.blendMode), e.opacity ?? 1);
  }

  for (const e of list(fx.solidFill)) {
    if (!on(e)) continue;
    const rgb = toRgb(e.color);
    const weight = new Float32Array(fill.w * fill.h).fill(1);
    bakeInterior(fill, weight, () => rgb, normalizeBlend(e.blendMode), e.opacity ?? 1);
  }

  {
    const e = fx.satin;
    if (on(e) && e !== undefined) {
      const size = sz(e.size);
      const dist = px(e.distance, perPoint);
      const a = ((e.angle ?? 19) * Math.PI) / 180;
      const dx = Math.round(Math.cos(a) * dist);
      const dy = Math.round(Math.sin(a) * dist);
      const b = new Float32Array(shape);
      blurPlane(b, pw, ph, size);
      const p1 = shiftPlane(b, pw, ph, dx, dy);
      const p2 = shiftPlane(b, pw, ph, -dx, -dy);
      const m = new Float32Array(pw * ph);
      for (let i = 0; i < m.length; i++) {
        let v = Math.abs(p1[i] - p2[i]);
        if (e.invert === true) v = Math.min(1, p1[i] + p2[i]) - v;
        m[i] = Math.min(1, Math.max(0, v));
      }
      bakeInterior(fill, interiorWeight(m), () => toRgb(e.color), normalizeBlend(e.blendMode), e.opacity ?? 1);
    }
  }

  {
    const e = fx.innerGlow;
    if (on(e) && e !== undefined) {
      const size = Math.max(1, sz(e.size));
      const g = e as { technique?: string; range?: number };
      let m: Float32Array;
      if (e.source === "center") {
        // Brightest deep inside the shape, fading out towards the edge.
        const d = sdf();
        m = new Float32Array(pw * ph);
        for (let i = 0; i < m.length; i++) m[i] = Math.min(1, Math.max(0, -d[i] / size));
      } else {
        m = glowRamp(size, px(e.choke, perPoint) / size, g.range ?? 0.5, g.technique === "precise", true);
      }
      bakeInterior(fill, interiorWeight(m), () => toRgb(e.color), normalizeBlend(e.blendMode), e.opacity ?? 1);
    }
  }

  for (const e of list(fx.innerShadow)) {
    if (!on(e)) continue;
    const size = sz(e.size);
    const dist = px(e.distance, perPoint);
    const a = (angleOf(e) * Math.PI) / 180;
    const dx = Math.round(-Math.cos(a) * dist);
    const dy = Math.round(Math.sin(a) * dist);
    let m = new Float32Array(pw * ph);
    for (let i = 0; i < m.length; i++) m[i] = 1 - shape[i];
    m = shiftPlane(m, pw, ph, dx, dy);
    // The vacated border must count as "outside", or the shadow vanishes there.
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const sx = x - dx;
        const sy = y - dy;
        if (sx < 0 || sx >= pw || sy < 0 || sy >= ph) m[y * pw + x] = 1;
      }
    }
    blurPlane(m, pw, ph, size);
    bakeInterior(fill, interiorWeight(m), () => toRgb(e.color), normalizeBlend(e.blendMode), e.opacity ?? 1);
  }

  {
    const e = fx.bevel;
    if (on(e) && e !== undefined) {
      const style = e.style ?? "inner bevel";
      if (style === "inner bevel" || style === "emboss") {
        const size = Math.max(1, sz(e.size));
        const hmap = new Float32Array(shape);
        blurPlane(hmap, pw, ph, size);
        const a = (angleOf(e) * Math.PI) / 180;
        const alt = ((e.altitude ?? 30) * Math.PI) / 180;
        const lx = -Math.cos(a) * Math.cos(alt);
        const ly = Math.sin(a) * Math.cos(alt);
        // `strength`, like every other percentage ag-psd reports, is a fraction.
        const depth = (e.strength ?? 1) * size * 1.5;
        const hi = new Float32Array(pw * ph);
        const lo = new Float32Array(pw * ph);
        for (let y = 1; y < ph - 1; y++) {
          for (let x = 1; x < pw - 1; x++) {
            const i = y * pw + x;
            const gx = (hmap[i + 1] - hmap[i - 1]) * depth;
            const gy = (hmap[i + pw] - hmap[i - pw]) * depth;
            const shade = -(gx * lx + gy * ly);
            if (shade > 0) hi[i] = Math.min(1, shade);
            else lo[i] = Math.min(1, -shade);
          }
        }
        const hiColor = toRgb(e.highlightColor ?? { r: 255, g: 255, b: 255 });
        const loColor = toRgb(e.shadowColor ?? { r: 0, g: 0, b: 0 });
        const hiBlend = normalizeBlend(e.highlightBlendMode);
        const loBlend = normalizeBlend(e.shadowBlendMode);
        const hiOpacity = e.highlightOpacity ?? 0.75;
        const loOpacity = e.shadowOpacity ?? 0.75;
        bakeInterior(fill, interiorWeight(hi), () => hiColor, hiBlend, hiOpacity);
        bakeInterior(fill, interiorWeight(lo), () => loColor, loBlend, loOpacity);
        // An emboss also shades the surface OUTSIDE the shape, which is what
        // makes it read as stamped rather than merely bevelled. Deriving that
        // from a blurred silhouette does not work: over the gaps inside a word
        // the height map goes flat and the shading comes out as a hard-edged
        // rectangle sitting behind the layer — a more conspicuous wrong answer
        // than leaving it out. Interior shading is rendered; the outer half is
        // reported instead of guessed.
        if (style === "emboss") skipped.push("emboss (outer shading)");
      } else {
        skipped.push("bevel");
      }
    }
  }

  // --- exterior: stroke, on top of everything -------------------------------
  for (const e of list(fx.stroke)) {
    if (!on(e)) continue;
    const size = sz(e.size);
    if (size <= 0) continue;
    const position = e.position ?? "outside";
    const sd = sdf();
    const band =
      position === "inside" ? [-size, 0] : position === "center" ? [-size / 2, size / 2] : [0, size];
    const m = new Float32Array(pw * ph);
    for (let i = 0; i < m.length; i++) {
      // 1px anti-aliased ramp at both band edges.
      const cov = Math.min(sd[i] - band[0] + 0.5, band[1] - sd[i] + 0.5);
      m[i] = Math.min(1, Math.max(0, cov));
    }
    const blend = normalizeBlend(e.blendMode);
    const opacity = e.opacity ?? 1;
    const grad = e.gradient;
    if (e.fillType === "gradient" && grad !== undefined && grad.type !== "solid") {
      // A NOISE gradient is generated from a random seed by an algorithm we
      // can't reproduce, so its exact ramp is out of reach. What we must not do
      // is fall through to the solid-colour branch below: `color` on a gradient
      // stroke is a leftover default (white), and painting a white outline is a
      // more obvious error than painting the ramp's average. Average it, and say
      // so in the panel.
      const lo = grad.min ?? [0, 0, 0];
      const hi = grad.max ?? [1, 1, 1];
      const mid: [number, number, number] = [
        (((lo[0] ?? 0) + (hi[0] ?? 1)) / 2) * 255,
        (((lo[1] ?? 0) + (hi[1] ?? 1)) / 2) * 255,
        (((lo[2] ?? 0) + (hi[2] ?? 1)) / 2) * 255,
      ];
      const d = planeDraw(m, pw, ph, ox, oy, mid, blend, opacity, false);
      if (d !== null) draws.push(d);
      skipped.push("stroke (noise gradient)");
      continue;
    }
    if (e.fillType === "gradient" && grad !== undefined && grad.type === "solid") {
      const extra = e.gradient as EffectSolidGradient & { style?: string; angle?: number; scale?: number; reverse?: boolean };
      const table = gradientTable(extra, extra.reverse === true);
      // Colour the band via the gradient projected over the LAYER bounds.
      const rgba = new Uint8ClampedArray(pw * ph * 4);
      for (let y = 0; y < ph; y++) {
        for (let x = 0; x < pw; x++) {
          const i = y * pw + x;
          if (m[i] <= 0.002) continue;
          const t = gradientT(extra.style ?? "linear", extra.angle ?? 90, extra.scale ?? 1, pad, pad, fill.w, fill.h, x, y);
          const ti = Math.round(t * 255);
          rgba[i * 4] = table.rgb[ti * 3];
          rgba[i * 4 + 1] = table.rgb[ti * 3 + 1];
          rgba[i * 4 + 2] = table.rgb[ti * 3 + 2];
          rgba[i * 4 + 3] = m[i] * table.alpha[ti] * 255;
        }
      }
      draws.push({ rgba, w: pw, h: ph, x: ox, y: oy, blend, opacity, under: false });
    } else if (e.fillType === "pattern") {
      skipped.push("stroke");
    } else {
      const d = planeDraw(m, pw, ph, ox, oy, toRgb(e.color), blend, opacity, false);
      if (d !== null) draws.push(d);
    }
  }

  return { draws, skipped };
}

/** Effects present and switched on that `renderEffects` will not handle. */
export function pendingEffectNames(fx: LayerEffectsInfo | undefined): string[] {
  if (fx === undefined || fx.disabled === true) return [];
  const names: string[] = [];
  if (on(fx.patternOverlay)) names.push("patternOverlay");
  for (const e of list(fx.gradientOverlay)) {
    if (on(e) && e.gradient !== undefined && e.gradient.type !== "solid") {
      names.push("gradientOverlay (noise)");
    }
  }
  for (const e of list(fx.stroke)) {
    if (!on(e)) continue;
    if (e.fillType === "pattern") names.push("stroke (pattern)");
    else if (e.fillType === "gradient" && e.gradient !== undefined && e.gradient.type !== "solid") {
      names.push("stroke (noise gradient)");
    }
  }
  const bevel = fx.bevel;
  if (on(bevel) && bevel?.style !== undefined) {
    if (bevel.style !== "inner bevel" && bevel.style !== "emboss") names.push("bevel");
    else if (bevel.style === "emboss") names.push("emboss (outer shading)");
  }
  return names;
}
