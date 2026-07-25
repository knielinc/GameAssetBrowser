/**
 * Photoshop layer masks — the bit that used to be missing.
 *
 * A PSD layer mask is not part of the layer's pixels: it is a separate
 * grayscale image with its OWN rectangle, its own enable flag, and a default
 * colour governing every pixel its rectangle doesn't cover. Ignore any of those
 * three and a masked layer renders as if the mask weren't there — which is
 * exactly what the old viewer did.
 *
 * Baking the mask into the layer's alpha here, before the layer ever reaches
 * the compositor, means every blend mode, clipping run and isolated group
 * downstream handles masks correctly without knowing they exist.
 */

import type { Layer, PixelData } from "ag-psd";

/**
 * ag-psd hands back 8-, 16- or 32-bit channels depending on the document.
 * Normalize to RGBA8 the way ag-psd's own canvas conversion does — 16-bit takes
 * the high byte, float is gamma-encoded at 2.2. Returns null for layouts we
 * can't draw (CMYK arrives as five channels per pixel, not four).
 */
export function toRgba8(pd: PixelData): Uint8ClampedArray | null {
  const { width, height } = pd;
  const need = width * height * 4;
  const src = pd.data as unknown as ArrayLike<number>;
  if (src.length !== need) return null;
  if (src instanceof Uint8ClampedArray) return src;
  const out = new Uint8ClampedArray(need);
  if (src instanceof Float32Array) {
    for (let i = 0; i < need; i += 4) {
      out[i] = Math.round(Math.pow(src[i], 1 / 2.2) * 255);
      out[i + 1] = Math.round(Math.pow(src[i + 1], 1 / 2.2) * 255);
      out[i + 2] = Math.round(Math.pow(src[i + 2], 1 / 2.2) * 255);
      out[i + 3] = Math.round(src[i + 3] * 255);
    }
    return out;
  }
  const shift = src instanceof Uint16Array ? 8 : 0;
  for (let i = 0; i < need; i++) out[i] = src[i] >>> shift;
  return out;
}

/**
 * The mask Photoshop would actually render for this layer, or undefined.
 *
 * A layer keeps up to two: the user-painted one (`mask`) and the "real" one
 * (`realMask`), which is the user mask already combined with the layer's vector
 * mask. When both exist the real one is what Photoshop composites.
 */
function effectiveMask(layer: Layer): Layer["mask"] {
  const { mask, realMask } = layer;
  if (realMask?.imageData !== undefined && realMask.disabled !== true) return realMask;
  if (mask?.imageData !== undefined && mask.disabled !== true) return mask;
  return undefined;
}

/** Whether this layer has a mask that will be baked in — for the panel's badge. */
export function hasMask(layer: Layer): boolean {
  return (
    (layer.mask !== undefined && layer.mask.disabled !== true) ||
    (layer.realMask !== undefined && layer.realMask.disabled !== true)
  );
}

/**
 * A GROUP's mask, as a stencil the compositor can paint with `destination-in`.
 *
 * A group mask can't be baked into pixels the way a leaf layer's can — it
 * applies to whatever the group's whole subtree composites to, which isn't known
 * until render time. So it travels as its own bitmap: RGB is irrelevant, the
 * mask value lives in ALPHA, and the compositor intersects it with the group's
 * rendered content. `defaultColor` (what the mask means outside its rectangle)
 * comes along on the layer node, since the bitmap can't carry it.
 */
export function maskStencil(
  layer: Layer,
): { rgba: Uint8ClampedArray; x: number; y: number; w: number; h: number } | null {
  const mask = effectiveMask(layer);
  if (mask?.imageData === undefined) return null;
  const md = toRgba8(mask.imageData);
  if (md === null) return null;
  const w = mask.imageData.width;
  const h = mask.imageData.height;
  if (w <= 0 || h <= 0) return null;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = md[i * 4];
  const rel = mask.positionRelativeToLayer === true;
  return {
    rgba,
    x: (mask.left ?? 0) + (rel ? (layer.left ?? 0) : 0),
    y: (mask.top ?? 0) + (rel ? (layer.top ?? 0) : 0),
    w,
    h,
  };
}

/** What a mask means OUTSIDE its own rectangle: 0 hides, 255 reveals. */
export function maskDefault(layer: Layer): number {
  return effectiveMask(layer)?.defaultColor ?? 0;
}

/**
 * Multiply the layer's mask into `rgba` (its `w` x `h` RGBA8 pixels) in place.
 * A no-op when the layer has no usable mask.
 */
export function applyMask(layer: Layer, rgba: Uint8ClampedArray, w: number, h: number): void {
  const mask = effectiveMask(layer);
  if (mask?.imageData === undefined) return;
  const md = toRgba8(mask.imageData);
  if (md === null) return;
  const mw = mask.imageData.width;
  const mh = mask.imageData.height;
  // A mask rectangle is normally in document space; `positionRelativeToLayer`
  // says it is relative to the layer's own origin instead.
  const rel = mask.positionRelativeToLayer === true;
  const lLeft = layer.left ?? 0;
  const lTop = layer.top ?? 0;
  const mLeft = (mask.left ?? 0) + (rel ? lLeft : 0);
  const mTop = (mask.top ?? 0) + (rel ? lTop : 0);
  // Everything outside the mask's rectangle takes its default colour — black
  // (fully masked) unless the file says otherwise.
  const outside = mask.defaultColor ?? 0;
  for (let row = 0; row < h; row++) {
    const my = lTop + row - mTop;
    const rowInside = my >= 0 && my < mh;
    // A row entirely outside a fully-revealing mask needs no work at all.
    if (!rowInside && outside === 255) continue;
    for (let col = 0; col < w; col++) {
      const i = (row * w + col) * 4 + 3;
      if (rgba[i] === 0) continue;
      let m = outside;
      if (rowInside) {
        const mx = lLeft + col - mLeft;
        if (mx >= 0 && mx < mw) m = md[(my * mw + mx) * 4];
      }
      if (m !== 255) rgba[i] = (rgba[i] * m + 127) / 255;
    }
  }
}
