/**
 * GLSL for the layered-art compositor.
 *
 * Everything here works in STRAIGHT (non-premultiplied) alpha and sRGB space,
 * which is what Photoshop, Krita and Aseprite all blend in. The shader is handed
 * the backdrop as a texture rather than using fixed-function blending, because
 * fixed-function can express `source-over` and little else — the moment a file
 * uses vivid light or a non-separable mode like `color`, the blend has to read
 * the backdrop and compute it. Sampling it makes all 26 modes one code path.
 *
 * The compositing algebra is the W3C/PDF one all three apps agree on:
 *
 * ```text
 * as = srcAlpha * opacity          (optionally masked / clipped, see uFlags)
 * ar = as + ab*(1 - as)
 * Co = (1 - as/ar)*Cb + (as/ar)*((1 - ab)*Cs + ab*B(Cb, Cs))
 * ```
 *
 * Every rect uniform is in CANVAS pixels with y pointing down, including the
 * one describing the framebuffer being drawn into — framebuffers are sized to
 * the content they hold, not to the canvas, so they each have their own origin.
 */

/** Blend modes in the order the shader's `switch` expects. */
export const GL_BLEND_ORDER = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "colorDodge",
  "colorBurn",
  "hardLight",
  "softLight",
  "difference",
  "exclusion",
  "linearBurn",
  "linearDodge",
  "linearLight",
  "vividLight",
  "pinLight",
  "hardMix",
  "subtract",
  "divide",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "darkerColor",
  "lighterColor",
] as const;

export type GlBlend = (typeof GL_BLEND_ORDER)[number];

const INDEX = new Map<string, number>(GL_BLEND_ORDER.map((k, i) => [k, i]));

/** Shader index for a blend key; unknown / structural keys fall back to normal. */
export function blendIndex(key: string): number {
  return INDEX.get(key) ?? 0;
}

/** Bit flags for the fragment shader's `uFlags`. */
export const FLAG_MASK = 1; // multiply source alpha by uMask's alpha
export const FLAG_CLIP_TEX = 2; // ...and by uClip's alpha (Photoshop clipping run)
export const FLAG_CLIP_BACKDROP = 4; // ...and by the backdrop's own alpha (Krita inherit-alpha)
export const FLAG_SRC_IS_FBO = 8; // source texture is a framebuffer (rows run bottom-up)

export const VERTEX_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;   // 0..1 across the rect being drawn
uniform vec4 uQuad;                     // x, y, w, h in canvas pixels
uniform vec4 uDstRect;                  // the framebuffer's own canvas-space rect
out vec2 vCanvas;
void main() {
  vCanvas = uQuad.xy + aCorner * uQuad.zw;
  vec2 local = (vCanvas - uDstRect.xy) / uDstRect.zw;
  gl_Position = vec4(local.x * 2.0 - 1.0, 1.0 - local.y * 2.0, 0.0, 1.0);
}`;

/**
 * The adjustment pass: read the backdrop, push it through the layer's transfer
 * table, write the result. Whoever calls it then composites that result back
 * over the backdrop with the adjustment layer's blend, opacity and mask — which
 * is exactly how Photoshop treats an adjustment layer at less than 100%.
 */
export const ADJUST_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform sampler2D uSrc;       // the backdrop being adjusted
uniform sampler2D uLut;       // 256x1 RGBA transfer table
uniform highp sampler3D uLut3d; // N^3 colour cube (hue/sat, balance, ...)
uniform vec4 uSrcRect;
uniform int uMode;            // 0 = table, 1 = threshold, 2 = colour cube
uniform float uThreshold;
uniform float uLutN;          // cube edge length
in vec2 vCanvas;
out vec4 outColor;

/** Land exactly on a texel centre rather than between two entries. */
float lut(float v, int ch) {
  vec4 s = texture(uLut, vec2((v * 255.0 + 0.5) / 256.0, 0.5));
  return ch == 0 ? s.r : ch == 1 ? s.g : s.b;
}

void main() {
  vec2 uv = (vCanvas - uSrcRect.xy) / uSrcRect.zw;
  uv.y = 1.0 - uv.y;
  vec4 c = texture(uSrc, uv);
  if (uMode == 1) {
    float l = dot(c.rgb, vec3(0.3, 0.59, 0.11));
    float v = l * 255.0 >= uThreshold ? 1.0 : 0.0;
    outColor = vec4(v, v, v, c.a);
  } else if (uMode == 2) {
    // Map 0..1 onto texel centres so the cube's endpoints land exactly.
    vec3 coord = c.rgb * ((uLutN - 1.0) / uLutN) + 0.5 / uLutN;
    outColor = vec4(texture(uLut3d, coord).rgb, c.a);
  } else {
    outColor = vec4(lut(c.r, 0), lut(c.g, 1), lut(c.b, 2), c.a);
  }
}`;

export const FRAGMENT_SRC = `#version 300 es
precision highp float;

uniform sampler2D uBackdrop;  // what has been composited so far (same rect as dst)
uniform sampler2D uSrc;       // the layer, or an isolated group's buffer
uniform sampler2D uMask;      // a group's mask stencil, alpha only
uniform sampler2D uClip;      // the base a clipping run clips to, alpha only

uniform vec4 uDstRect;
uniform vec4 uSrcRect;
uniform vec4 uMaskRect;
uniform vec4 uClipRect;
uniform float uMaskDefault;   // mask value outside uMaskRect (0 hides, 1 reveals)
uniform float uOpacity;
uniform int uBlend;
uniform int uFlags;

in vec2 vCanvas;
out vec4 outColor;

// --- separable blends ------------------------------------------------------

float bMultiply(float b, float s) { return b * s; }
float bScreen(float b, float s) { return b + s - b * s; }
float bColorDodge(float b, float s) {
  if (b <= 0.0) return 0.0;
  if (s >= 1.0) return 1.0;
  return min(1.0, b / (1.0 - s));
}
float bColorBurn(float b, float s) {
  if (b >= 1.0) return 1.0;
  if (s <= 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - b) / s);
}
float bHardLight(float b, float s) {
  return s <= 0.5 ? bMultiply(b, 2.0 * s) : bScreen(b, 2.0 * s - 1.0);
}
float bSoftLight(float b, float s) {
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b)
                  : b + (2.0 * s - 1.0) * (d - b);
}
float bVividLight(float b, float s) {
  return s <= 0.5 ? bColorBurn(b, 2.0 * s) : bColorDodge(b, 2.0 * (s - 0.5));
}

float blendChannel(int mode, float b, float s) {
  switch (mode) {
    case 1: return bMultiply(b, s);
    case 2: return bScreen(b, s);
    case 3: return bHardLight(s, b);                    // overlay = hard light, swapped
    case 4: return min(b, s);
    case 5: return max(b, s);
    case 6: return bColorDodge(b, s);
    case 7: return bColorBurn(b, s);
    case 8: return bHardLight(b, s);
    case 9: return bSoftLight(b, s);
    case 10: return abs(b - s);
    case 11: return b + s - 2.0 * b * s;
    case 12: return clamp(b + s - 1.0, 0.0, 1.0);       // linear burn
    case 13: return clamp(b + s, 0.0, 1.0);             // linear dodge / add
    case 14: return clamp(b + 2.0 * s - 1.0, 0.0, 1.0); // linear light
    case 15: return bVividLight(b, s);
    case 16: return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0); // pin light
    case 17: return bVividLight(b, s) < 0.5 ? 0.0 : 1.0;                // hard mix
    case 18: return clamp(b - s, 0.0, 1.0);             // subtract
    // Divide. 0/0 is BLACK, not white — verified against Photoshop's own
    // composite for tests/fixtures/blending/blue-red-1x1-divide.psd, where
    // returning white put the green channel 65/255 out.
    case 19: return s <= 0.0 ? (b <= 0.0 ? 0.0 : 1.0) : clamp(b / s, 0.0, 1.0);
    default: return s;
  }
}

// --- non-separable blends (W3C compositing spec) ---------------------------

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }

vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}

vec3 blendColor(int mode, vec3 b, vec3 s) {
  if (mode == 20) return setLum(setSat(s, sat(b)), lum(b));   // hue
  if (mode == 21) return setLum(setSat(b, sat(s)), lum(b));   // saturation
  if (mode == 22) return setLum(s, lum(b));                   // color
  if (mode == 23) return setLum(b, lum(s));                   // luminosity
  if (mode == 24) return lum(s) < lum(b) ? s : b;             // darker color
  if (mode == 25) return lum(s) > lum(b) ? s : b;             // lighter color
  return vec3(blendChannel(mode, b.r, s.r),
              blendChannel(mode, b.g, s.g),
              blendChannel(mode, b.b, s.b));
}

// --- sampling --------------------------------------------------------------

/** Framebuffer rows run bottom-up; the rect says where the buffer sits. */
vec2 fboUv(vec2 canvas, vec4 rect) {
  return vec2((canvas.x - rect.x) / rect.z, 1.0 - (canvas.y - rect.y) / rect.w);
}

void main() {
  vec4 backdrop = texture(uBackdrop, fboUv(vCanvas, uDstRect));

  vec2 su = (vCanvas - uSrcRect.xy) / uSrcRect.zw;
  if ((uFlags & 8) != 0) su.y = 1.0 - su.y;
  vec4 src = texture(uSrc, su);

  float as = src.a * uOpacity;
  if ((uFlags & 1) != 0) {
    vec2 mu = (vCanvas - uMaskRect.xy) / uMaskRect.zw;
    float m = (mu.x < 0.0 || mu.x > 1.0 || mu.y < 0.0 || mu.y > 1.0)
      ? uMaskDefault
      : texture(uMask, mu).a;
    as *= m;
  }
  if ((uFlags & 2) != 0) as *= texture(uClip, fboUv(vCanvas, uClipRect)).a;
  if ((uFlags & 4) != 0) as *= backdrop.a;

  float ab = backdrop.a;
  float ar = as + ab * (1.0 - as);
  if (ar <= 0.0) {
    outColor = vec4(0.0);
    return;
  }
  vec3 mixed = blendColor(uBlend, backdrop.rgb, src.rgb);
  float w = as / ar;
  vec3 co = (1.0 - w) * backdrop.rgb + w * ((1.0 - ab) * src.rgb + ab * mixed);
  outColor = vec4(clamp(co, 0.0, 1.0), ar);
}`;
