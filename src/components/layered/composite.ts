/**
 * The layered-art compositor: turn a layer tree + a bag of cels into one image.
 *
 * Shared by Photoshop, Krita and Aseprite documents, which is the whole point —
 * masks, clipping, group isolation and the exotic blend modes are hard enough to
 * get right once. What each format's reader has to guarantee is only:
 *
 *  * a cel's pixels are FINAL — any layer mask is already multiplied into its
 *    alpha (Rust does it for Krita, the worker for Photoshop), so nothing here
 *    has to know a mask exists;
 *  * `blend` is a canonical [`BlendKey`];
 *  * `opacity` has not already been folded into the pixels.
 *
 * Everything is drawn at document resolution into scratch canvases pulled from
 * a pool, because a 100-layer file with a dozen isolated groups would otherwise
 * allocate (and garbage) a hundred full-size canvases on every toggle.
 */

import { applyAdjustment } from "./adjustment";
import { canvasOp, blendPixels, type BlendKey } from "./blend";
import { celKey, childrenOf, type Cel, type LayeredDoc, type LayerNode } from "./types";

export interface CompositeInput {
  doc: LayeredDoc;
  /** Cels by `celKey(layer, frame)`. */
  cels: Map<string, Cel>;
  /** Group mask stencils by layer index — alpha-only, see `maskStencil`. */
  masks?: Map<number, Cel>;
  /** Exterior layer-effect draws (shadows, glows, strokes) by layer index. */
  effects?: Map<number, Cel[]>;
  /** Layer indices the user (or the file) has switched off. */
  hidden: Set<number>;
  frame: number;
}

/** Canvas-space dirty rectangle, or null for "nothing was drawn". */
type Rect = { x: number; y: number; w: number; h: number } | null;

function union(a: Rect, b: Rect): Rect {
  if (a === null) return b;
  if (b === null) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

function intersect(a: Rect, b: Rect): Rect {
  if (a === null || b === null) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 <= x || y2 <= y ? null : { x, y, w: x2 - x, h: y2 - y };
}

function clipRect(r: Rect, w: number, h: number): Rect {
  if (r === null) return null;
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const x2 = Math.min(w, Math.ceil(r.x + r.w));
  const y2 = Math.min(h, Math.ceil(r.y + r.h));
  return x2 <= x || y2 <= y ? null : { x, y, w: x2 - x, h: y2 - y };
}

/**
 * Reusable full-size scratch canvases.
 *
 * Kept alive BETWEEN composites, not just within one: toggling a layer
 * re-composites the whole document, and a file with a dozen isolated groups
 * would otherwise allocate and discard a dozen document-sized canvases on every
 * click. The pool is dropped whole when the document size changes, which is the
 * only time its canvases are the wrong shape.
 */
class ScratchPool {
  private readonly free: CanvasRenderingContext2D[] = [];
  constructor(
    readonly w: number,
    readonly h: number,
  ) {}

  take(): CanvasRenderingContext2D {
    const ctx = this.free.pop();
    if (ctx !== undefined) {
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      return ctx;
    }
    return makeScratch(this.w, this.h);
  }

  give(ctx: CanvasRenderingContext2D): void {
    this.free.push(ctx);
  }
}

function domScratch(w: number, h: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  // No `willReadFrequently`: only the hand-blended modes ever read these back,
  // and the hint would push every scratch onto the CPU raster path — a much
  // bigger loss across the common case than the occasional readback it saves.
  return canvas.getContext("2d") as CanvasRenderingContext2D;
}

let makeScratch: (w: number, h: number) => CanvasRenderingContext2D = domScratch;

/**
 * Test seam: swap the scratch-canvas factory, so the compositor's layer walk can
 * be exercised against a recording context with no DOM in sight. Pass null to
 * restore the real one.
 */
export function setScratchFactory(
  fn: ((w: number, h: number) => CanvasRenderingContext2D) | null,
): void {
  makeScratch = fn ?? domScratch;
  pooled = null;
}

let pooled: ScratchPool | null = null;
function poolFor(w: number, h: number): ScratchPool {
  if (pooled === null || pooled.w !== w || pooled.h !== h) pooled = new ScratchPool(w, h);
  return pooled;
}

/**
 * Composite `input` into `ctx`, which must already be sized to the document.
 * Clears first, so it is safe to call on every toggle.
 */
export function composite(ctx: CanvasRenderingContext2D, input: CompositeInput): void {
  const { doc, cels, hidden, frame } = input;
  const masks = input.masks ?? new Map<number, Cel>();
  const effects = input.effects ?? new Map<number, Cel[]>();
  const { width: W, height: H, layers } = doc;
  const pool = poolFor(W, H);
  ctx.clearRect(0, 0, W, H);

  // Child lists are walked once per group per composite; cache them.
  const kidsOf = new Map<number, number[]>();
  const kids = (parent: number): number[] => {
    let k = kidsOf.get(parent);
    if (k === undefined) {
      k = childrenOf(layers, parent);
      kidsOf.set(parent, k);
    }
    return k;
  };

  /**
   * Draw the full-canvas content of `src` onto `dst` with a blend mode and
   * opacity. `src` is a context rather than an image so the hand-blended path
   * can read its pixels back directly instead of copying it somewhere first.
   */
  const paint = (
    dst: CanvasRenderingContext2D,
    src: CanvasRenderingContext2D,
    key: BlendKey,
    opacity: number,
    rect: Rect,
  ): void => {
    const op = canvasOp(key);
    if (op !== null) {
      dst.save();
      dst.globalAlpha = opacity;
      dst.globalCompositeOperation = op;
      dst.drawImage(src.canvas, 0, 0);
      dst.restore();
      return;
    }
    // Hand-blended mode: read back both sides over the source's bounding box
    // only, blend in JS, write back.
    const r = clipRect(rect, W, H);
    if (r === null) return;
    const back = dst.getImageData(r.x, r.y, r.w, r.h);
    const fore = src.getImageData(r.x, r.y, r.w, r.h);
    blendPixels(back.data, fore.data, key, opacity);
    dst.putImageData(back, r.x, r.y);
  };

  /**
   * Draw a leaf's full stack: under-effects (drop shadow, outer glow), the
   * fill, over-effects (stroke) — each effect with its own blend/opacity, all
   * scaled by `opacityMul`. Bitmaps stretch to their canvas-space w/h (big
   * documents ship them downscaled).
   */
  const drawLeafStack = (
    idx: number,
    dst: CanvasRenderingContext2D,
    fillBlend: BlendKey,
    opacityMul: number,
  ): Rect => {
    const fx = effects.get(idx) ?? [];
    let dirty: Rect = null;
    const one = (bitmap: ImageBitmap, r: NonNullable<Rect>, blend: BlendKey, opacity: number): void => {
      const op = canvasOp(blend);
      if (op !== null) {
        dst.save();
        dst.globalAlpha = opacity;
        dst.globalCompositeOperation = op;
        dst.drawImage(bitmap, r.x, r.y, r.w, r.h);
        dst.restore();
      } else {
        const tmp = pool.take();
        tmp.drawImage(bitmap, r.x, r.y, r.w, r.h);
        paint(dst, tmp, blend, opacity, r);
        pool.give(tmp);
      }
      dirty = union(dirty, r);
    };
    for (const e of fx) {
      if (e.role === "under") one(e.bitmap, { x: e.x, y: e.y, w: e.w, h: e.h }, (e.blend ?? "normal") as BlendKey, (e.opacity ?? 1) * opacityMul);
    }
    const cel = cels.get(celKey(idx, frame));
    if (cel !== undefined) {
      one(cel.bitmap, { x: cel.x, y: cel.y, w: cel.w, h: cel.h }, fillBlend, opacityMul);
    }
    for (const e of fx) {
      if (e.role === "over") one(e.bitmap, { x: e.x, y: e.y, w: e.w, h: e.h }, (e.blend ?? "normal") as BlendKey, (e.opacity ?? 1) * opacityMul);
    }
    return dirty;
  };

  /**
   * Draw one node's own content into `dst` at full opacity in normal mode — its
   * blend and opacity are applied by whoever composites it onto its parent.
   */
  const drawContent = (idx: number, dst: CanvasRenderingContext2D): Rect => {
    const l = layers[idx];
    if (l.isGroup) return drawGroup(idx, dst);
    return drawLeafStack(idx, dst, "normal", 1);
  };

  /**
   * Does this group need its own buffer? Only when it changes how its children
   * combine with what is outside it: a non-normal blend, reduced opacity, or a
   * clip child that must clip to just this group's content. Otherwise the
   * children draw straight onto the parent — cheaper, and identical in result.
   */
  const needsIsolation = (gi: number): boolean => {
    const g = layers[gi];
    // An artboard's crop has to happen before its content reaches the parent,
    // so it needs a buffer even when it would otherwise composite straight
    // through — this check comes before the pass-through shortcut on purpose.
    if (g.clipRect !== undefined) return true;
    // A group mask applies to whatever the subtree composites to, so the
    // subtree has to exist as an image before the mask can bite.
    if (masks.has(gi)) return true;
    if (g.passthrough) return false;
    if (g.opacity < 1) return true;
    if (canvasOp(g.blend as BlendKey) !== "source-over") return true;
    return doc.clipMode === "below" && kids(gi).some((c) => layers[c].clip);
  };

  /** Draw a group's visible children (bottom-first) onto `dst`. */
  function drawGroup(parent: number, dst: CanvasRenderingContext2D): Rect {
    const children = kids(parent);
    let dirty: Rect = null;
    for (let i = children.length - 1; i >= 0; i--) {
      const idx = children[i];
      const l = layers[idx];
      if (l.inert) continue;
      // Photoshop clipping layers are drawn as part of their base, below.
      if (doc.clipMode === "base" && l.clip) continue;
      if (hidden.has(idx)) continue;

      // --- Photoshop: this layer plus the clipping run stacked on top of it ---
      if (doc.clipMode === "base") {
        const run: number[] = [];
        for (let j = i - 1; j >= 0 && layers[children[j]].clip; j--) run.push(children[j]);
        if (run.length > 0) {
          const base = pool.take();
          let rect = drawContent(idx, base);
          for (const c of run) {
            const cl = layers[c];
            if (cl.inert || hidden.has(c)) continue;
            // A CLIPPED adjustment layer adjusts only its base, not the rest of
            // the group — that is what clipping one is for.
            if (cl.adjustment !== undefined) {
              const region = clipRect(rect, W, H);
              if (region === null) continue;
              const img = base.getImageData(region.x, region.y, region.w, region.h);
              applyAdjustment(img.data, cl.adjustment);
              const at = pool.take();
              at.putImageData(img, region.x, region.y);
              at.globalCompositeOperation = "destination-in";
              at.drawImage(base.canvas, 0, 0);
              at.globalCompositeOperation = "source-over";
              paint(base, at, cl.blend as BlendKey, cl.opacity, region);
              pool.give(at);
              continue;
            }
            const tmp = pool.take();
            const cr = drawContent(c, tmp);
            if (cr !== null) {
              // Clip to the base's alpha, then blend into it.
              tmp.globalCompositeOperation = "destination-in";
              tmp.drawImage(base.canvas, 0, 0);
              tmp.globalCompositeOperation = "source-over";
              paint(base, tmp, cl.blend as BlendKey, cl.opacity, cr);
              rect = union(rect, cr);
            }
            pool.give(tmp);
          }
          if (rect !== null) {
            paint(dst, base, l.blend as BlendKey, l.opacity, rect);
            dirty = union(dirty, rect);
          }
          pool.give(base);
          continue;
        }
      }

      // --- an adjustment layer ----------------------------------------------
      // Reprocesses everything drawn below it in its group. The fallback path
      // ignores an adjustment's own mask; the GPU compositor honours it.
      if (l.adjustment !== undefined) {
        const region = clipRect(dirty, W, H);
        if (region === null) continue;
        const img = dst.getImageData(region.x, region.y, region.w, region.h);
        applyAdjustment(img.data, l.adjustment);
        const tmp = pool.take();
        tmp.putImageData(img, region.x, region.y);
        paint(dst, tmp, l.blend as BlendKey, l.opacity, region);
        pool.give(tmp);
        continue;
      }

      // --- a group that has to render in isolation --------------------------
      if (l.isGroup && needsIsolation(idx)) {
        const g = pool.take();
        let r = drawGroup(idx, g);
        if (r !== null && l.clipRect !== undefined) {
          // Crop the group to its artboard: keep only what the rect covers.
          g.globalCompositeOperation = "destination-in";
          g.fillStyle = "#000";
          g.fillRect(l.clipRect.x, l.clipRect.y, l.clipRect.w, l.clipRect.h);
          g.globalCompositeOperation = "source-over";
          r = intersect(r, l.clipRect);
        }
        const stencil = masks.get(idx);
        if (r !== null && stencil !== undefined) {
          const mr = {
            x: stencil.x,
            y: stencil.y,
            w: stencil.w,
            h: stencil.h,
          };
          // `destination-in` clears everything the stencil doesn't cover, which
          // is right when the mask hides what falls outside its rectangle. When
          // it REVEALS the outside instead, clip to the rectangle first so only
          // that part is touched.
          if ((l.maskDefault ?? 0) === 255) {
            g.save();
            g.beginPath();
            g.rect(mr.x, mr.y, mr.w, mr.h);
            g.clip();
            g.globalCompositeOperation = "destination-in";
            g.drawImage(stencil.bitmap, mr.x, mr.y);
            g.restore();
          } else {
            g.globalCompositeOperation = "destination-in";
            g.drawImage(stencil.bitmap, mr.x, mr.y);
            g.globalCompositeOperation = "source-over";
            r = intersect(r, mr);
          }
        }
        if (r !== null) {
          paint(dst, g, l.blend as BlendKey, l.opacity, r);
          dirty = union(dirty, r);
        }
        pool.give(g);
        continue;
      }
      if (l.isGroup) {
        dirty = union(dirty, drawGroup(idx, dst));
        continue;
      }

      // --- Krita "inherit alpha": clip to everything drawn below in the group -
      if (l.clip && doc.clipMode === "below") {
        const tmp = pool.take();
        const r = drawContent(idx, tmp);
        if (r !== null) {
          tmp.globalCompositeOperation = "destination-in";
          tmp.drawImage(dst.canvas, 0, 0);
          tmp.globalCompositeOperation = "source-over";
          paint(dst, tmp, l.blend as BlendKey, l.opacity, r);
          dirty = union(dirty, r);
        }
        pool.give(tmp);
        continue;
      }

      // --- an ordinary layer: effects + fill --------------------------------
      dirty = union(dirty, drawLeafStack(idx, dst, l.blend as BlendKey, l.opacity));
    }
    return dirty;
  }

  // Standalone cels (a flattened fallback with no layer of its own) draw first,
  // underneath the tree.
  for (const cel of cels.values()) {
    if (cel.layer < 0 && cel.frame === frame) ctx.drawImage(cel.bitmap, cel.x, cel.y, cel.w, cel.h);
  }
  drawGroup(-1, ctx);
}

/** The layer indices a file wants hidden on open. */
export function defaultHidden(layers: LayerNode[]): Set<number> {
  const out = new Set<number>();
  layers.forEach((l, i) => {
    if (!l.visible) out.add(i);
  });
  return out;
}
