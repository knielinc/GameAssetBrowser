/**
 * Adjustment layers, as lookup tables.
 *
 * Most of Photoshop's adjustments are per-channel transfer functions: levels,
 * curves, invert, posterize and legacy brightness/contrast all answer the same
 * question, "given this input byte, what comes out?". Baking each into a
 * 256-entry table turns them into one shader (three texture reads) and — more
 * usefully — into pure functions that can be unit-tested without a GPU.
 *
 * Photoshop applies the per-channel table first and the composite ("RGB") one
 * second, so both are folded into a single table per channel here.
 *
 * Adjustments that are NOT per-channel (hue/saturation, colour balance, black &
 * white, selective colour, gradient map, photo filter, vibrance, channel mixer,
 * colour lookup) are deliberately absent — they are reported unsupported rather
 * than approximated, so the panel can say so instead of drawing a guess.
 */

/** What the compositor needs to run one adjustment layer. */
export interface AdjustmentSpec {
  /** Photoshop's name for it, for the panel. */
  kind: string;
  /** 256 x RGBA transfer table, or null when another mode is used. */
  lut: Uint8Array | null;
  /**
   * Threshold is the one supported adjustment that isn't a colour transform at
   * all: it maps LUMINANCE to pure black or white. Non-null means "use this
   * level instead of a table".
   */
  threshold: number | null;
  /**
   * A full colour transform baked as an N^3 RGB lookup cube (trilinear
   * sampled). This is how the non-separable adjustments — hue/saturation,
   * colour balance, black & white, and friends — reach the GPU: any
   * per-pixel colour function becomes one 3D texture fetch. `lut3dSize` is N;
   * data is RGBA8 with r fastest, then g, then b.
   */
  lut3d: Uint8Array | null;
  lut3dSize: number;
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Identity table, as a starting point. */
function identity(): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    lut[i * 4] = i;
    lut[i * 4 + 1] = i;
    lut[i * 4 + 2] = i;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

/** Apply a per-channel function to one channel of the table. */
function mapChannel(lut: Uint8Array, channel: number, f: (v: number) => number): void {
  for (let i = 0; i < 256; i++) {
    lut[i * 4 + channel] = clamp255(f(lut[i * 4 + channel]));
  }
}

export interface LevelsChannel {
  shadowInput: number;
  highlightInput: number;
  shadowOutput: number;
  highlightOutput: number;
  midtoneInput: number;
}

/**
 * One channel of a Levels adjustment: remap [shadowIn, highlightIn] to 0..1,
 * apply the midtone gamma, then expand into [shadowOut, highlightOut].
 */
export function levelsFn(c: LevelsChannel): (v: number) => number {
  const inLo = c.shadowInput ?? 0;
  const inHi = c.highlightInput ?? 255;
  const outLo = c.shadowOutput ?? 0;
  const outHi = c.highlightOutput ?? 255;
  // Photoshop stores the midtone slider as a gamma. Files in the wild carry it
  // both as a float (1.0) and hundredths (100); treat anything implausibly
  // large as the latter rather than raising everything to the power of 1/100.
  let gamma = c.midtoneInput ?? 1;
  if (gamma > 10) gamma /= 100;
  if (!(gamma > 0)) gamma = 1;
  const span = inHi - inLo;
  return (v) => {
    let t = span === 0 ? (v >= inHi ? 1 : 0) : (v - inLo) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (gamma !== 1) t = Math.pow(t, 1 / gamma);
    return outLo + t * (outHi - outLo);
  };
}

/**
 * Monotone cubic (Fritsch–Carlson) through the curve's control points.
 *
 * A plain natural spline overshoots between close points and would brighten
 * past the neighbouring control point, which is visible as a halo; the monotone
 * variant cannot overshoot, which is what Photoshop's curve does too.
 */
export function curveFn(points: { input: number; output: number }[]): (v: number) => number {
  const pts = [...points].sort((a, b) => a.input - b.input);
  if (pts.length === 0) return (v) => v;
  if (pts.length === 1) return () => pts[0].output;

  const n = pts.length;
  const xs = pts.map((p) => p.input);
  const ys = pts.map((p) => p.output);
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i];
    slope.push(dx === 0 ? 0 : (ys[i + 1] - ys[i]) / dx);
  }
  const tangent: number[] = new Array(n).fill(0);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) tangent[i] = 0;
    else tangent[i] = (slope[i - 1] + slope[i]) / 2;
  }
  // Fritsch–Carlson: clamp tangents so the interpolant stays monotone.
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      tangent[i] = t * a * slope[i];
      tangent[i + 1] = t * b * slope[i];
    }
  }
  return (v) => {
    if (v <= xs[0]) return ys[0];
    if (v >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && v > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    if (h === 0) return ys[i];
    const t = (v - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * tangent[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * tangent[i + 1]
    );
  };
}

/**
 * Run an adjustment over RGBA8 pixels in place. Alpha is never touched — an
 * adjustment layer changes colour, not coverage. This is the CPU twin of the
 * shader in `gl/shader.ts`; keeping both means the canvas-2D fallback behaves
 * the same as the GPU path.
 */
export function applyAdjustment(data: Uint8ClampedArray, spec: AdjustmentSpec): void {
  if (spec.threshold !== null) {
    const level = spec.threshold;
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2];
      const v = luma >= level ? 255 : 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
    return;
  }
  if (spec.lut3d !== null) {
    const N = spec.lut3dSize;
    const cube = spec.lut3d;
    const s = (N - 1) / 255;
    for (let i = 0; i < data.length; i += 4) {
      // Trilinear sample of the cube, the CPU twin of the sampler3D fetch.
      const fr = data[i] * s;
      const fg = data[i + 1] * s;
      const fb = data[i + 2] * s;
      const r0 = Math.min(N - 2, Math.floor(fr));
      const g0 = Math.min(N - 2, Math.floor(fg));
      const b0 = Math.min(N - 2, Math.floor(fb));
      const tr = fr - r0;
      const tg = fg - g0;
      const tb = fb - b0;
      for (let ch = 0; ch < 3; ch++) {
        const at = (r: number, g: number, b: number): number => cube[(((b * N + g) * N + r) << 2) + ch];
        const c00 = at(r0, g0, b0) * (1 - tr) + at(r0 + 1, g0, b0) * tr;
        const c10 = at(r0, g0 + 1, b0) * (1 - tr) + at(r0 + 1, g0 + 1, b0) * tr;
        const c01 = at(r0, g0, b0 + 1) * (1 - tr) + at(r0 + 1, g0, b0 + 1) * tr;
        const c11 = at(r0, g0 + 1, b0 + 1) * (1 - tr) + at(r0 + 1, g0 + 1, b0 + 1) * tr;
        data[i + ch] = (c00 * (1 - tg) + c10 * tg) * (1 - tb) + (c01 * (1 - tg) + c11 * tg) * tb;
      }
    }
    return;
  }
  const lut = spec.lut;
  if (lut === null) return;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i] * 4];
    data[i + 1] = lut[data[i + 1] * 4 + 1];
    data[i + 2] = lut[data[i + 2] * 4 + 2];
  }
}

// ---------------------------------------------------------------------------
// Colour-transform adjustments, baked into an N^3 cube
// ---------------------------------------------------------------------------

type ColorFn = (r: number, g: number, b: number) => [number, number, number];

const LUT3D_N = 33;

/** Bake a colour function into an RGBA8 cube for trilinear sampling. */
export function bakeCube(fn: ColorFn, n = LUT3D_N): Uint8Array {
  const cube = new Uint8Array(n * n * n * 4);
  const step = 255 / (n - 1);
  let o = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const [nr, ng, nb] = fn(r * step, g * step, b * step);
        cube[o] = clamp255(nr);
        cube[o + 1] = clamp255(ng);
        cube[o + 2] = clamp255(nb);
        cube[o + 3] = 255;
        o += 4;
      }
    }
  }
  return cube;
}

const lum255 = (r: number, g: number, b: number): number => 0.3 * r + 0.59 * g + 0.11 * b;

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (mx === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number): number => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

const srgbToLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
const linearToSrgb = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

interface HueSatChannel {
  a: number;
  b: number;
  c: number;
  d: number;
  hue: number;
  saturation: number;
  lightness: number;
}

/** Apply one hue/sat channel's shift to an HSL triple, weighted by `w`. */
function applyHueSat(hsl: [number, number, number], ch: HueSatChannel, w: number): void {
  if (w <= 0) return;
  hsl[0] = (((hsl[0] + (ch.hue / 360) * w) % 1) + 1) % 1;
  const sat = ch.saturation * w;
  if (sat >= 0) hsl[1] = Math.min(1, hsl[1] * (1 + sat / 100) + hsl[1] * (sat / 100) * (1 - hsl[1]));
  else hsl[1] = hsl[1] * (1 + sat / 100);
  const light = ch.lightness * w;
  if (light >= 0) hsl[2] = hsl[2] + (1 - hsl[2]) * (light / 100);
  else hsl[2] = hsl[2] * (1 + light / 100);
}

/** Membership of hue `h` (0..360) in a channel's a→b..c→d wedge, with ramps. */
function hueWeight(h: number, ch: HueSatChannel): number {
  const wrap = (x: number): number => ((x % 360) + 360) % 360;
  const between = (x: number, lo: number, hi: number): boolean =>
    lo <= hi ? x >= lo && x <= hi : x >= lo || x <= hi;
  const a = wrap(ch.a);
  const b = wrap(ch.b);
  const c = wrap(ch.c);
  const d = wrap(ch.d);
  if (between(h, b, c)) return 1;
  if (between(h, a, b)) {
    const span = wrap(b - a) || 1;
    return wrap(h - a) / span;
  }
  if (between(h, c, d)) {
    const span = wrap(d - c) || 1;
    return 1 - wrap(h - c) / span;
  }
  return 0;
}

/** GIMP's classic shadows/midtones/highlights transfer weights (0..1 input). */
function balanceWeight(zone: "shadows" | "midtones" | "highlights", v: number): number {
  if (zone === "shadows") return 1.075 - 1 / (v / 0.0625 + 1);
  if (zone === "highlights") return 1.075 - 1 / ((1 - v) / 0.0625 + 1);
  const x = (v - 0.5) * 2;
  return 0.667 * (1 - x * x);
}

/** Build the colour function for one adjustment type, or null if unsupported. */
function colorFnFor(adj: RawAdjustment): ColorFn | null {
  switch (adj.type) {
    case "hue/saturation": {
      const channels = ["reds", "yellows", "greens", "cyans", "blues", "magentas"]
        .map((k) => adj[k] as HueSatChannel | undefined)
        .filter((c): c is HueSatChannel => c !== undefined);
      const master = adj.master as HueSatChannel | undefined;
      return (r, g, b) => {
        const hsl = rgbToHsl(r, g, b);
        const h360 = hsl[0] * 360;
        if (master !== undefined) applyHueSat(hsl, master, 1);
        for (const ch of channels) applyHueSat(hsl, ch, hueWeight(h360, ch));
        hsl[1] = Math.min(1, Math.max(0, hsl[1]));
        hsl[2] = Math.min(1, Math.max(0, hsl[2]));
        return hslToRgb(hsl[0], hsl[1], hsl[2]);
      };
    }

    case "color balance": {
      const zones = ["shadows", "midtones", "highlights"] as const;
      const values = zones.map(
        (z) => adj[z] as { cyanRed: number; magentaGreen: number; yellowBlue: number } | undefined,
      );
      const preserve = adj.preserveLuminosity !== false;
      return (r, g, b) => {
        let nr = r;
        let ng = g;
        let nb = b;
        for (let i = 0; i < 3; i++) {
          const v = values[i];
          if (v === undefined) continue;
          nr += v.cyanRed * balanceWeight(zones[i], nr / 255);
          ng += v.magentaGreen * balanceWeight(zones[i], ng / 255);
          nb += v.yellowBlue * balanceWeight(zones[i], nb / 255);
        }
        nr = Math.min(255, Math.max(0, nr));
        ng = Math.min(255, Math.max(0, ng));
        nb = Math.min(255, Math.max(0, nb));
        if (preserve) {
          const [h, s] = rgbToHsl(nr, ng, nb);
          const [, , l] = rgbToHsl(r, g, b);
          return hslToRgb(h, s, l);
        }
        return [nr, ng, nb];
      };
    }

    case "black & white": {
      // Adobe's own decomposition: colour = min·white + secondary + primary,
      // each weighted by the matching slider.
      const w = {
        reds: ((adj.reds as number) ?? 40) / 100,
        yellows: ((adj.yellows as number) ?? 60) / 100,
        greens: ((adj.greens as number) ?? 40) / 100,
        cyans: ((adj.cyans as number) ?? 60) / 100,
        blues: ((adj.blues as number) ?? 20) / 100,
        magentas: ((adj.magentas as number) ?? 80) / 100,
      };
      return (r, g, b) => {
        const mn = Math.min(r, g, b);
        let gray = mn;
        if (r >= g && g >= b) gray = mn + (g - b) * w.yellows + (r - g) * w.reds;
        else if (r >= b && b >= g) gray = mn + (b - g) * w.magentas + (r - b) * w.reds;
        else if (g >= r && r >= b) gray = mn + (r - b) * w.yellows + (g - r) * w.greens;
        else if (g >= b && b >= r) gray = mn + (b - r) * w.cyans + (g - b) * w.greens;
        else if (b >= g && g >= r) gray = mn + (g - r) * w.cyans + (b - g) * w.blues;
        else gray = mn + (r - g) * w.magentas + (b - r) * w.blues;
        gray = Math.min(255, Math.max(0, gray));
        return [gray, gray, gray];
      };
    }

    case "photo filter": {
      const c = adj.color as Record<string, number> | undefined;
      // Colour may arrive as Lab; only rgb is handled.
      if (c === undefined || typeof c.r !== "number") return null;
      const density = ((adj.density as number) ?? 25) / 100;
      const preserve = adj.preserveLuminosity !== false;
      return (r, g, b) => {
        let nr = r * (1 - density) + ((r * c.r) / 255) * density;
        let ng = g * (1 - density) + ((g * c.g) / 255) * density;
        let nb = b * (1 - density) + ((b * c.b) / 255) * density;
        if (preserve) {
          const before = lum255(r, g, b);
          const after = lum255(nr, ng, nb);
          const k = after > 0 ? before / after : 1;
          nr *= k;
          ng *= k;
          nb *= k;
        }
        return [nr, ng, nb];
      };
    }

    case "vibrance": {
      const vib = ((adj.vibrance as number) ?? 0) / 100;
      const sat = ((adj.saturation as number) ?? 0) / 100;
      return (r, g, b) => {
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const s = mx > 0 ? (mx - mn) / mx : 0;
        // Vibrance boosts the least-saturated colours the most.
        const amount = vib * (1 - s) + sat;
        const l = lum255(r, g, b);
        return [l + (r - l) * (1 + amount), l + (g - l) * (1 + amount), l + (b - l) * (1 + amount)];
      };
    }

    case "exposure": {
      const exposure = (adj.exposure as number) ?? 0;
      const offset = (adj.offset as number) ?? 0;
      let gamma = (adj.gamma as number) ?? 1;
      if (!(gamma > 0)) gamma = 1;
      const mul = Math.pow(2, exposure);
      return (r, g, b) => {
        const one = (v: number): number => {
          let lv = srgbToLinear(v / 255) * mul + offset;
          lv = Math.max(0, lv);
          lv = Math.pow(lv, 1 / gamma);
          return linearToSrgb(Math.min(1, lv)) * 255;
        };
        return [one(r), one(g), one(b)];
      };
    }

    case "channel mixer": {
      interface Mix {
        red: number;
        green: number;
        blue: number;
        constant: number;
      }
      const mono = adj.monochrome === true;
      const cr = adj.red as Mix | undefined;
      const cg = adj.green as Mix | undefined;
      const cb = adj.blue as Mix | undefined;
      const gray = adj.gray as Mix | undefined;
      const mix = (m: Mix | undefined, r: number, g: number, b: number, fallback: number): number =>
        m === undefined
          ? fallback
          : (r * m.red + g * m.green + b * m.blue) / 100 + (m.constant / 100) * 255;
      return (r, g, b) => {
        if (mono) {
          const v = mix(gray, r, g, b, lum255(r, g, b));
          return [v, v, v];
        }
        return [mix(cr, r, g, b, r), mix(cg, r, g, b, g), mix(cb, r, g, b, b)];
      };
    }

    case "gradient map": {
      const stops = adj.colorStops as { color: unknown; location: number; midpoint: number }[] | undefined;
      if (stops === undefined || stops.length === 0 || adj.gradientType === "noise") return null;
      const reverse = adj.reverse === true;
      // 256-entry ramp over luminance, reusing the effects gradient evaluator's
      // conventions (location 0..1 or 0..4096, midpoint skew).
      const ramp = gradientRamp(stops, reverse);
      return (r, g, b) => {
        const t = Math.round(lum255(r, g, b));
        return [ramp[t * 3], ramp[t * 3 + 1], ramp[t * 3 + 2]];
      };
    }

    case "selective color": {
      interface CMYK {
        c: number;
        m: number;
        y: number;
        k: number;
      }
      const relative = (adj.mode ?? "relative") === "relative";
      const get = (k: string): CMYK | undefined => adj[k] as CMYK | undefined;
      const ranges: [string, (r: number, g: number, b: number) => number][] = [
        ["reds", (r, g, b) => r - Math.max(g, b)],
        ["yellows", (r, g, b) => Math.min(r, g) - b],
        ["greens", (r, g, b) => g - Math.max(r, b)],
        ["cyans", (r, g, b) => Math.min(g, b) - r],
        ["blues", (r, g, b) => b - Math.max(r, g)],
        ["magentas", (r, g, b) => Math.min(r, b) - g],
        ["whites", (r, g, b) => Math.min(r, g, b) * 2 - 255],
        ["neutrals", (r, g, b) => 255 - (Math.abs(Math.max(r, g, b) * 2 - 255) + Math.abs(Math.min(r, g, b) * 2 - 255)) / 2],
        ["blacks", (r, g, b) => 255 - Math.max(r, g, b) * 2],
      ];
      return (r, g, b) => {
        let nr = r;
        let ng = g;
        let nb = b;
        for (const [key, weightOf] of ranges) {
          const amt = get(key);
          if (amt === undefined) continue;
          const w = Math.min(255, Math.max(0, weightOf(r, g, b))) / 255;
          if (w <= 0) continue;
          const apply = (v: number, a: number): number => {
            const total = (a / 100 + amt.k / 100) * w * 255;
            return v - (relative ? total * (v / 255) : total);
          };
          nr = apply(nr, amt.c);
          ng = apply(ng, amt.m);
          nb = apply(nb, amt.y);
        }
        return [nr, ng, nb];
      };
    }

    case "brightness/contrast": {
      // The MODERN algorithm (useLegacy false). Not published by Adobe; this is
      // an approximation — contrast pivots on the stored histogram mean, and
      // brightness lifts midtones on a sine curve that pins black and white —
      // scored against Photoshop's own composite in the fixture set.
      if (adj.useLegacy === true) return null; // handled exactly by the 256-LUT path
      const brightness = (adj.brightness as number) ?? 0;
      const contrast = (adj.contrast as number) ?? 0;
      const mean = (adj.meanValue as number) ?? 127;
      const slope = Math.tan(((contrast / 100 + 1) * Math.PI) / 4);
      return (r, g, b) => {
        const one = (v: number): number => {
          let x = v + brightness * Math.sin((Math.PI * v) / 255) * 0.6;
          x = (x - mean) * slope + mean;
          return x;
        };
        return [one(r), one(g), one(b)];
      };
    }

    default:
      return null;
  }
}

/** 256×RGB ramp from gradient stops — shared with the gradient-map path. */
function gradientRamp(
  stops: { color: unknown; location: number; midpoint?: number }[],
  reverse: boolean,
): Float32Array {
  const sorted = [...stops].sort((a, b) => a.location - b.location);
  const maxLoc = Math.max(1, ...sorted.map((s) => s.location));
  const norm = maxLoc > 1.0001 ? 1 / 4096 : 1;
  const toRgb = (color: unknown): [number, number, number] => {
    const c = (color ?? {}) as Record<string, number>;
    if (typeof c.r === "number") return [c.r, c.g ?? 0, c.b ?? 0];
    return [0, 0, 0];
  };
  const out = new Float32Array(256 * 3);
  for (let x = 0; x < 256; x++) {
    let t = x / 255;
    if (reverse) t = 1 - t;
    let i = 0;
    while (i < sorted.length - 1 && t > sorted[i + 1].location * norm) i++;
    const a = sorted[i];
    const b = sorted[Math.min(i + 1, sorted.length - 1)];
    const la = a.location * norm;
    const lb = b.location * norm;
    let lt = lb <= la ? 0 : Math.min(1, Math.max(0, (t - la) / (lb - la)));
    let m = (a.midpoint ?? 50) / 100;
    m = Math.min(0.99, Math.max(0.01, m));
    lt = lt <= m ? 0.5 * (lt / m) : 0.5 + 0.5 * ((lt - m) / (1 - m));
    const ca = toRgb(a.color);
    const cb = toRgb(b.color);
    out[x * 3] = ca[0] + (cb[0] - ca[0]) * lt;
    out[x * 3 + 1] = ca[1] + (cb[1] - ca[1]) * lt;
    out[x * 3 + 2] = ca[2] + (cb[2] - ca[2]) * lt;
  }
  return out;
}

/** Any adjustment descriptor ag-psd hands us; only `type` is relied on. */
type RawAdjustment = { type?: string } & Record<string, unknown>;

/**
 * Translate an ag-psd adjustment into something the compositor can run, or null
 * when it is one we don't implement.
 */
export function buildAdjustment(adj: RawAdjustment | undefined): AdjustmentSpec | null {
  if (adj?.type === undefined) return null;
  const kind = adj.type;
  const lut = identity();

  const perChannel = (key: string, channel: number, make: (c: never) => (v: number) => number): void => {
    const c = adj[key];
    if (c !== undefined && c !== null) mapChannel(lut, channel, make(c as never));
  };

  switch (kind) {
    case "invert":
      for (let ch = 0; ch < 3; ch++) mapChannel(lut, ch, (v) => 255 - v);
      return { kind, lut, threshold: null, lut3d: null, lut3dSize: 0 };

    case "posterize": {
      const levels = Math.max(2, Math.min(255, (adj.levels as number) ?? 4));
      const step = (v: number): number => Math.round((Math.round((v / 255) * (levels - 1)) / (levels - 1)) * 255);
      for (let ch = 0; ch < 3; ch++) mapChannel(lut, ch, step);
      return { kind, lut, threshold: null, lut3d: null, lut3dSize: 0 };
    }

    case "threshold":
      return { kind, lut: null, threshold: (adj.level as number) ?? 128, lut3d: null, lut3dSize: 0 };

    case "levels": {
      perChannel("red", 0, levelsFn);
      perChannel("green", 1, levelsFn);
      perChannel("blue", 2, levelsFn);
      // The composite curve runs after the per-channel ones.
      perChannel("rgb", 0, levelsFn);
      perChannel("rgb", 1, levelsFn);
      perChannel("rgb", 2, levelsFn);
      return { kind, lut, threshold: null, lut3d: null, lut3dSize: 0 };
    }

    case "curves": {
      const mk = (pts: never): ((v: number) => number) =>
        curveFn(pts as unknown as { input: number; output: number }[]);
      perChannel("red", 0, mk);
      perChannel("green", 1, mk);
      perChannel("blue", 2, mk);
      perChannel("rgb", 0, mk);
      perChannel("rgb", 1, mk);
      perChannel("rgb", 2, mk);
      return { kind, lut, threshold: null, lut3d: null, lut3dSize: 0 };
    }

    case "brightness/contrast": {
      // The LEGACY formula is public and exact — handled here as a 256-LUT.
      // The modern one falls through to the colour-cube approximation below.
      if (adj.useLegacy !== true) break;
      const b = (adj.brightness as number) ?? 0;
      const c = (adj.contrast as number) ?? 0;
      const scale = c >= 0 ? 1 + c / 100 : 1 + c / 100;
      const f = (v: number): number => (v - 128) * scale + 128 + b;
      for (let ch = 0; ch < 3; ch++) mapChannel(lut, ch, f);
      return { kind, lut, threshold: null, lut3d: null, lut3dSize: 0 };
    }

    default:
      break;
  }

  // Everything else is a full colour transform → bake it into a cube the
  // shader (sampler3D) and the CPU path (trilinear) both sample.
  const fn = colorFnFor(adj);
  if (fn === null) return null;
  return { kind, lut: null, threshold: null, lut3d: bakeCube(fn), lut3dSize: LUT3D_N };
}
