/**
 * Blend modes for the layered-art compositor.
 *
 * Canvas 2D's `globalCompositeOperation` already implements the 16 separable +
 * non-separable modes the CSS/PDF compositing spec defines, and Photoshop,
 * Krita and Aseprite all agree with that spec for those. What none of the three
 * agree to stop at is that list: Photoshop adds linear burn / vivid light /
 * linear light / pin light / hard mix / darker+lighter color / subtract /
 * divide, Krita ships all of those under different names, and Aseprite adds
 * subtract and divide of its own.
 *
 * So: canvas does the 16 it knows (fast, GPU, correct), and `blendPixels` does
 * the rest per-pixel. Layers using a hand-blended mode are the minority in real
 * files, and the pixel path only ever touches the layer's bounding box.
 */

/** Every mode we can name. Anything unrecognized falls back to `normal`. */
export type BlendKey =
  | "normal"
  | "dissolve"
  | "darken"
  | "multiply"
  | "colorBurn"
  | "linearBurn"
  | "darkerColor"
  | "lighten"
  | "screen"
  | "colorDodge"
  | "linearDodge"
  | "lighterColor"
  | "overlay"
  | "softLight"
  | "hardLight"
  | "vividLight"
  | "linearLight"
  | "pinLight"
  | "hardMix"
  | "difference"
  | "exclusion"
  | "subtract"
  | "divide"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity"
  | "passThrough";

/**
 * Every spelling the three formats use for a mode, folded to one key.
 *
 * Lookup is by the name with spaces, underscores and hyphens stripped and the
 * whole thing lower-cased, so "color burn" (Photoshop), "colorburn" (Aseprite's
 * Debug name) and "burn" (Krita's compositeop id) all land on the same entry.
 */
const ALIASES: Record<string, BlendKey> = {
  // --- spec modes canvas implements natively -------------------------------
  normal: "normal",
  src: "normal",
  copy: "normal",
  over: "normal",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  colordodge: "colorDodge",
  dodge: "colorDodge",
  colorburn: "colorBurn",
  burn: "colorBurn",
  hardlight: "hardLight",
  softlight: "softLight",
  softlightsvg: "softLight",
  softlightie: "softLight",
  difference: "difference",
  diff: "difference",
  exclusion: "exclusion",
  hue: "hue",
  huehsl: "hue",
  huehsv: "hue",
  saturation: "saturation",
  saturationhsl: "saturation",
  saturationhsv: "saturation",
  color: "color",
  colorhsl: "color",
  colorhsv: "color",
  luminosity: "luminosity",
  luminize: "luminosity",
  luminizehsl: "luminosity",
  lightness: "luminosity",
  // --- hand-blended ---------------------------------------------------------
  lineardodge: "linearDodge",
  add: "linearDodge",
  addition: "linearDodge",
  plus: "linearDodge",
  linearburn: "linearBurn",
  inversesubtract: "linearBurn",
  vividlight: "vividLight",
  linearlight: "linearLight",
  pinlight: "pinLight",
  hardmix: "hardMix",
  darkercolor: "darkerColor",
  lightercolor: "lighterColor",
  subtract: "subtract",
  divide: "divide",
  dissolve: "dissolve",
  // --- structural -----------------------------------------------------------
  passthrough: "passThrough",
  passthrough0: "passThrough",
};

/** Fold a format's blend-mode name to a [`BlendKey`]. */
export function normalizeBlend(name: string | null | undefined): BlendKey {
  const k = (name ?? "").toLowerCase().replace(/[\s_-]/g, "");
  return ALIASES[k] ?? "normal";
}

/**
 * Canvas op for a mode, or null when it has to go through [`blendPixels`].
 *
 * `linearDodge` maps to `lighter` deliberately. `lighter` is additive on
 * PREMULTIPLIED colour, which matches linear dodge exactly wherever the
 * backdrop is opaque and drifts brighter where it isn't. Additive glow layers
 * are everywhere in game art and usually cover most of the canvas, so paying
 * the pixel path for them would be the single slowest thing this compositor
 * does; the drift only shows on transparent backdrop, where nothing is visible
 * anyway.
 */
export function canvasOp(key: BlendKey): GlobalCompositeOperation | null {
  switch (key) {
    case "normal":
    case "passThrough":
    case "dissolve": // no stochastic dither in a preview — plain normal reads better
      return "source-over";
    case "multiply":
    case "screen":
    case "overlay":
    case "darken":
    case "lighten":
    case "difference":
    case "exclusion":
    case "hue":
    case "saturation":
    case "color":
    case "luminosity":
      return key;
    case "colorDodge":
      return "color-dodge";
    case "colorBurn":
      return "color-burn";
    case "hardLight":
      return "hard-light";
    case "softLight":
      return "soft-light";
    case "linearDodge":
      return "lighter";
    default:
      return null;
  }
}

/** True when the mode needs the per-pixel path. */
export const needsPixelBlend = (key: BlendKey): boolean => canvasOp(key) === null;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Rec. 601 luma, the weighting Photoshop's darker/lighter color compare on. */
const lum = (r: number, g: number, b: number): number => 0.3 * r + 0.59 * g + 0.11 * b;

/**
 * The non-separable blends from the W3C compositing spec — hue, saturation,
 * color and luminosity mix whole colours rather than channels, so they can't go
 * through `channelFn`. The TS twin of `blendColor` in gl/shader.ts.
 */
function nonSeparable(
  key: BlendKey,
  b: [number, number, number],
  s: [number, number, number],
): [number, number, number] | null {
  const clipColor = (c: [number, number, number]): [number, number, number] => {
    const l = lum(c[0], c[1], c[2]);
    const n = Math.min(c[0], c[1], c[2]);
    const x = Math.max(c[0], c[1], c[2]);
    let out = c;
    if (n < 0) out = out.map((v) => l + ((v - l) * l) / Math.max(l - n, 1e-6)) as typeof c;
    if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / Math.max(x - l, 1e-6)) as typeof c;
    return out;
  };
  const setLum = (c: [number, number, number], l: number): [number, number, number] => {
    const d = l - lum(c[0], c[1], c[2]);
    return clipColor([c[0] + d, c[1] + d, c[2] + d]);
  };
  const sat = (c: [number, number, number]): number =>
    Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
  const setSat = (c: [number, number, number], v: number): [number, number, number] => {
    const mx = Math.max(c[0], c[1], c[2]);
    const mn = Math.min(c[0], c[1], c[2]);
    return mx > mn
      ? (c.map((x) => ((x - mn) * v) / (mx - mn)) as [number, number, number])
      : [0, 0, 0];
  };
  const lb = lum(b[0], b[1], b[2]);
  switch (key) {
    case "hue":
      return setLum(setSat(s, sat(b)), lb);
    case "saturation":
      return setLum(setSat(b, sat(s)), lb);
    case "color":
      return setLum(s, lb);
    case "luminosity":
      return setLum(b, lum(s[0], s[1], s[2]));
    case "darkerColor":
      return lum(s[0], s[1], s[2]) < lb ? s : b;
    case "lighterColor":
      return lum(s[0], s[1], s[2]) > lb ? s : b;
    default:
      return null;
  }
}

/** Colour burn below the midpoint, colour dodge above it. */
function vividLight(b: number, s: number): number {
  if (s <= 0.5) {
    const d = 2 * s;
    return d <= 0 ? 0 : clamp01(1 - Math.min(1, (1 - b) / d));
  }
  const d = 2 * (s - 0.5);
  return d >= 1 ? 1 : clamp01(Math.min(1, b / (1 - d)));
}

const multiply = (b: number, s: number): number => b * s;
const screen = (b: number, s: number): number => b + s - b * s;
const colorDodge = (b: number, s: number): number =>
  b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));
const colorBurn = (b: number, s: number): number =>
  b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
const hardLight = (b: number, s: number): number =>
  s <= 0.5 ? multiply(b, 2 * s) : screen(b, 2 * s - 1);
const softLight = (b: number, s: number): number => {
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (d - b);
};

/**
 * The per-channel blend for a separable mode, resolved ONCE per layer.
 *
 * Deliberately not a `switch` inside the pixel loop: this runs three times per
 * pixel over an area that can be tens of millions of pixels, and hoisting the
 * dispatch out of the loop is most of what makes the hand-blended path usable.
 *
 * Covers the FULL separable set, not just the modes canvas 2D lacks. The
 * compositor only ever asks for the latter — but `blendSolid` does the blending
 * itself for layer effects, so a missing case there silently returns the raw
 * source colour instead of blending it.
 */
function channelFn(key: BlendKey): (b: number, s: number) => number {
  switch (key) {
    case "multiply":
      return multiply;
    case "screen":
      return screen;
    case "overlay":
      return (b, s) => hardLight(s, b);
    case "darken":
      return Math.min;
    case "lighten":
      return Math.max;
    case "colorDodge":
      return colorDodge;
    case "colorBurn":
      return colorBurn;
    case "hardLight":
      return hardLight;
    case "softLight":
      return softLight;
    case "difference":
      return (b, s) => Math.abs(b - s);
    case "exclusion":
      return (b, s) => b + s - 2 * b * s;
    case "linearBurn":
      return (b, s) => clamp01(b + s - 1);
    case "linearLight":
      return (b, s) => clamp01(b + 2 * s - 1);
    case "vividLight":
      return vividLight;
    case "pinLight":
      return (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1));
    case "hardMix":
      // Vivid light thresholded — Photoshop's own definition.
      return (b, s) => (vividLight(b, s) < 0.5 ? 0 : 1);
    case "subtract":
      return (b, s) => clamp01(b - s);
    case "divide":
      // 0/0 is BLACK, not white — see the note in the GLSL twin.
      return (b, s) => (s <= 0 ? (b <= 0 ? 0 : 1) : clamp01(b / s));
    case "linearDodge":
      return (b, s) => clamp01(b + s);
    default:
      return (_b, s) => s;
  }
}

/**
 * Blend one colour pair through a mode — all channels 0..1, straight alpha
 * ignored. The single-pixel core `blendSolid` and the layer-effects baker
 * share, so an effect's multiply is bit-identical to a layer's multiply.
 */
export function mixColor(
  key: BlendKey,
  br: number,
  bg: number,
  bb: number,
  sr: number,
  sg: number,
  sb: number,
): [number, number, number] {
  const ns = nonSeparable(key, [br, bg, bb], [sr, sg, sb]);
  if (ns !== null) return ns;
  const f = channelFn(key);
  return [f(br, sr), f(bg, sg), f(bb, sb)];
}

/**
 * Blend a SOLID colour over `dst` in place, keeping every pixel's alpha.
 *
 * This is what Photoshop's Color Overlay does: the colour covers the layer's
 * own pixels with the effect's blend mode and opacity, but it is clipped to the
 * layer, so coverage never changes — only colour. That "alpha is preserved"
 * part is why this can't just call `blendPixels`, which would drive alpha
 * toward opaque.
 */
export function blendSolid(
  dst: Uint8ClampedArray,
  color: readonly [number, number, number],
  key: BlendKey,
  opacity: number,
): void {
  if (opacity <= 0) return;
  const f = channelFn(key);
  const src: [number, number, number] = [color[0] / 255, color[1] / 255, color[2] / 255];
  for (let i = 0; i < dst.length; i += 4) {
    if (dst[i + 3] === 0) continue;
    const back: [number, number, number] = [dst[i] / 255, dst[i + 1] / 255, dst[i + 2] / 255];
    const ns = nonSeparable(key, back, src);
    const m: [number, number, number] =
      ns ?? [f(back[0], src[0]), f(back[1], src[1]), f(back[2], src[2])];
    dst[i] = (back[0] + (m[0] - back[0]) * opacity) * 255;
    dst[i + 1] = (back[1] + (m[1] - back[1]) * opacity) * 255;
    dst[i + 2] = (back[2] + (m[2] - back[2]) * opacity) * 255;
  }
}

/**
 * Blend `src` over `dst` in place, both non-premultiplied RGBA8 buffers of the
 * same length, using the full Porter-Duff-with-blend formula:
 *
 * ```text
 * Ar = As + Ab*(1 - As)
 * Cr = (1 - As/Ar)*Cb + (As/Ar)*((1 - Ab)*Cs + Ab*B(Cb, Cs))
 * ```
 *
 * `alpha` is the layer's opacity, folded into the source alpha.
 */
export function blendPixels(
  dst: Uint8ClampedArray,
  src: Uint8ClampedArray,
  key: BlendKey,
  alpha: number,
): void {
  const darker = key === "darkerColor";
  const separable = !darker && key !== "lighterColor";
  const f = channelFn(key);
  for (let i = 0; i < dst.length; i += 4) {
    const as = (src[i + 3] / 255) * alpha;
    if (as <= 0) continue;
    const ab = dst[i + 3] / 255;
    const ar = as + ab * (1 - as);
    if (ar <= 0) {
      dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
      continue;
    }
    const sr = src[i] / 255;
    const sg = src[i + 1] / 255;
    const sb = src[i + 2] / 255;
    const br = dst[i] / 255;
    const bg = dst[i + 1] / 255;
    const bb = dst[i + 2] / 255;

    let mr: number;
    let mg: number;
    let mb: number;
    if (separable) {
      mr = f(br, sr);
      mg = f(bg, sg);
      mb = f(bb, sb);
    } else {
      // Darker/lighter colour pick a WHOLE colour by luma — not per channel.
      const ls = lum(sr, sg, sb);
      const lb = lum(br, bg, bb);
      const takeSrc = darker ? ls < lb : ls > lb;
      mr = takeSrc ? sr : br;
      mg = takeSrc ? sg : bg;
      mb = takeSrc ? sb : bb;
    }

    // Cr = (1 - w)*Cb + w*((1 - Ab)*Cs + Ab*B(Cb, Cs)), inlined per channel —
    // a closure here would be allocated once per pixel.
    const w = as / ar;
    const iw = 1 - w;
    const ia = 1 - ab;
    dst[i] = (iw * br + w * (ia * sr + ab * mr)) * 255;
    dst[i + 1] = (iw * bg + w * (ia * sg + ab * mg)) * 255;
    dst[i + 2] = (iw * bb + w * (ia * sb + ab * mb)) * 255;
    dst[i + 3] = ar * 255;
  }
}
