/**
 * The GPU compositor.
 *
 * Same layer walk as the canvas-2D fallback, but every blend is the exact
 * formula from `shader.ts` rather than whatever `globalCompositeOperation`
 * happens to support — so linear burn, vivid light, pin light, hard mix,
 * subtract, divide and darker/lighter colour stop needing a per-pixel JS path
 * that cost ~700 ms on a 15-megapixel document.
 *
 * Two things make it affordable on big files:
 *
 *  * **Framebuffers are sized to content, not to the canvas.** A group's bounds
 *    are known before it renders (union of its descendants' cel rects), so an
 *    artboard holding a 600x350 capsule gets a 600x350 buffer instead of an
 *    8080x3840 one. On the Steam template that is the difference between ~30 MB
 *    and ~750 MB of GPU memory.
 *  * **Every draw is scissored to the layer's own rect.** Compositing a small
 *    layer onto a huge canvas touches only the pixels it covers.
 *
 * The backdrop is read as a texture (`uBackdrop`) rather than blended by the
 * fixed-function unit, which means each layer is a read-modify-write against
 * the accumulator. That is done by rendering into a scratch buffer and blitting
 * the layer's rect back, so a fragment never samples the buffer it writes to.
 */

import {
  ADJUST_FRAGMENT_SRC,
  blendIndex,
  FLAG_CLIP_BACKDROP,
  FLAG_CLIP_TEX,
  FLAG_MASK,
  FLAG_SRC_IS_FBO,
  FRAGMENT_SRC,
  VERTEX_SRC,
} from "./shader";
import { celKey, childrenOf, type Cel, type LayerNode } from "../types";
import type { CompositeInput } from "../composite";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const intersect = (a: Rect | null, b: Rect | null): Rect | null => {
  if (a === null || b === null) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 <= x || y2 <= y ? null : { x, y, w: x2 - x, h: y2 - y };
};

const union = (a: Rect | null, b: Rect | null): Rect | null => {
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
};

/** Round out to whole pixels — framebuffers and blits are integer-addressed. */
const snap = (r: Rect | null): Rect | null => {
  if (r === null) return null;
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  const w = Math.ceil(r.x + r.w) - x;
  const h = Math.ceil(r.y + r.h) - y;
  return w <= 0 || h <= 0 ? null : { x, y, w, h };
};

/** An offscreen colour buffer, plus where it sits in canvas space. */
interface Fbo {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  rect: Rect;
}

/** Total offscreen pixels we are willing to hold at once (~4 buffers at 4K). */
const PIXEL_BUDGET = 160_000_000;

export class GlCompositor {
  readonly kind = "gl";
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly u: Record<string, WebGLUniformLocation | null>;
  private readonly adjustProgram: WebGLProgram;
  private readonly au: Record<string, WebGLUniformLocation | null>;
  /** Transfer tables uploaded as 256x1 textures, keyed by the table itself. */
  private readonly lutCache = new Map<Uint8Array, WebGLTexture>();
  private readonly vao: WebGLVertexArrayObject;
  /** Textures for cel bitmaps, kept until the bitmap leaves the document. */
  private readonly texCache = new Map<ImageBitmap, WebGLTexture>();
  /** Free buffers, keyed by `${w}x${h}` so same-shaped groups reuse one. */
  private readonly free = new Map<string, Fbo[]>();
  private live = 0;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      // Straight alpha out, matching what the shader writes, so the checkerboard
      // shows through transparent areas correctly.
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      // Keep the drawing buffer readable after the frame is presented. Without
      // it the canvas cannot be drawn into another canvas or exported — it reads
      // back as opaque black — which would silently break "copy image" and any
      // thumbnail that snapshots the preview. `desynchronized` is off for the
      // same reason: a low-latency surface is not reliably readable.
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    if (gl === null) throw new Error("webgl2 unavailable");
    this.gl = gl;

    this.program = link(gl, VERTEX_SRC, FRAGMENT_SRC);
    gl.useProgram(this.program);
    this.u = {};
    for (const name of [
      "uQuad", "uDstRect", "uSrcRect", "uMaskRect", "uClipRect",
      "uMaskDefault", "uOpacity", "uBlend", "uFlags",
      "uBackdrop", "uSrc", "uMask", "uClip",
    ]) {
      this.u[name] = gl.getUniformLocation(this.program, name);
    }
    gl.uniform1i(this.u.uBackdrop, 0);
    gl.uniform1i(this.u.uSrc, 1);
    gl.uniform1i(this.u.uMask, 2);
    gl.uniform1i(this.u.uClip, 3);

    this.adjustProgram = link(gl, VERTEX_SRC, ADJUST_FRAGMENT_SRC);
    gl.useProgram(this.adjustProgram);
    this.au = {};
    for (const name of ["uQuad", "uDstRect", "uSrcRect", "uMode", "uThreshold", "uSrc", "uLut", "uLut3d", "uLutN"]) {
      this.au[name] = gl.getUniformLocation(this.adjustProgram, name);
    }
    gl.uniform1i(this.au.uSrc, 0);
    gl.uniform1i(this.au.uLut, 1);
    // Unit 4 on purpose: the MAIN program's uMask/uClip are sampler2Ds on
    // units 2/3, and leaving a TEXTURE_3D bound on a unit one of them
    // references makes the next main-program draw fail INVALID_OPERATION
    // (ANGLE enforces sampler/texture-target consistency per unit). Unit 4 is
    // referenced by no other program, so the cube can stay bound.
    gl.uniform1i(this.au.uLut3d, 4);

    // One unit quad; every draw stretches it over a rect via uQuad.
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error("no vao");
    this.vao = vao;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
  }

  /** True when a document this size is small enough to composite on the GPU. */
  static affordable(width: number, height: number): boolean {
    return width * height <= PIXEL_BUDGET / 4;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const { gl } = this;
    for (const t of this.texCache.values()) gl.deleteTexture(t);
    this.texCache.clear();
    for (const t of this.lutCache.values()) gl.deleteTexture(t);
    this.lutCache.clear();
    for (const t of this.lut3dCache.values()) gl.deleteTexture(t);
    this.lut3dCache.clear();
    gl.deleteProgram(this.adjustProgram);
    for (const list of this.free.values()) {
      for (const f of list) {
        gl.deleteFramebuffer(f.fb);
        gl.deleteTexture(f.tex);
      }
    }
    this.free.clear();
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  // --- resources -----------------------------------------------------------

  private texture(bitmap: ImageBitmap): WebGLTexture {
    const hit = this.texCache.get(bitmap);
    if (hit !== undefined) return hit;
    const { gl } = this;
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // The worker hands us straight-alpha bitmaps; keep them that way.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    // CLAMP + LINEAR: a layer is sampled 1:1, and clamping keeps the edge pixel
    // from wrapping when a rect lands a hair outside the texture.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.texCache.set(bitmap, tex);
    return tex;
  }

  /** Drop textures for bitmaps the document no longer holds. */
  private pruneTextures(keep: Set<ImageBitmap>): void {
    for (const [bmp, tex] of this.texCache) {
      if (!keep.has(bmp) && bmp !== this.presented) {
        this.gl.deleteTexture(tex);
        this.texCache.delete(bmp);
      }
    }
  }

  /** The flattened image last shown, kept so its texture survives a prune. */
  private presented: ImageBitmap | null = null;

  /** Show one bitmap full-canvas — the document's own flattened image. */
  present(bitmap: ImageBitmap, w: number, h: number): void {
    if (this.disposed) return;
    this.resize(w, h);
    this.presented = bitmap;
    const acc = this.take({ x: 0, y: 0, w, h }, true);
    // Stretch to the whole document — the flattened image may arrive
    // downscaled (Rust caps it at display resolution).
    const rect = { x: 0, y: 0, w, h };
    this.paint(acc, rect, { tex: this.texture(bitmap), rect, isFbo: false }, {
      blend: "normal",
      opacity: 1,
    });
    this.toCanvas(acc, w, h);
    this.give(acc);
  }

  private resize(w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /**
   * Blit the accumulator to the visible canvas.
   *
   * NOT flipped, despite appearances. The vertex shader maps canvas-y-down onto
   * clip space, so a buffer already holds the top of the image at its HIGHEST
   * framebuffer y — the same convention as the default framebuffer, whose origin
   * is the bottom-left of the canvas as displayed. Flipping here would turn the
   * whole preview upside down.
   */
  private toCanvas(acc: Fbo, w: number, h: number): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, acc.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private take(rect: Rect, clear: boolean): Fbo {
    const { gl } = this;
    const key = `${rect.w}x${rect.h}`;
    const pool = this.free.get(key);
    const reused = pool?.pop();
    const fbo = reused ?? this.allocate(rect);
    fbo.rect = rect;
    this.live++;
    if (clear) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    return fbo;
  }

  private allocate(rect: Rect): Fbo {
    const { gl } = this;
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, rect.w, rect.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fb = gl.createFramebuffer() as WebGLFramebuffer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex, rect };
  }

  /** Colour cubes as TEXTURE_3D, trilinear-filtered by the sampler. */
  private readonly lut3dCache = new Map<Uint8Array, WebGLTexture>();
  private lut3dTexture(cube: Uint8Array, n: number): WebGLTexture {
    const hit = this.lut3dCache.get(cube);
    if (hit !== undefined) return hit;
    const { gl } = this;
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, n, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, cube);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.lut3dCache.set(cube, tex);
    return tex;
  }

  private lutTexture(lut: Uint8Array): WebGLTexture {
    const hit = this.lutCache.get(lut);
    if (hit !== undefined) return hit;
    const { gl } = this;
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // NEAREST: a transfer table is 256 discrete entries, not a gradient.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.lutCache.set(lut, tex);
    return tex;
  }

  /**
   * Run an adjustment layer's transfer function over `src` into a new buffer.
   * The caller composites the result back with the layer's blend and opacity.
   */
  private adjust(src: Fbo, quad: Rect, spec: NonNullable<LayerNode["adjustment"]>): Fbo {
    const { gl, au } = this;
    const out = this.take(src.rect, false);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
    gl.viewport(0, 0, src.rect.w, src.rect.h);
    gl.useProgram(this.adjustProgram);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, spec.lut === null ? this.blankLut() : this.lutTexture(spec.lut));
    if (spec.lut3d !== null) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_3D, this.lut3dTexture(spec.lut3d, spec.lut3dSize));
      gl.uniform1f(au.uLutN, spec.lut3dSize);
    }
    gl.uniform4f(au.uQuad, quad.x, quad.y, quad.w, quad.h);
    gl.uniform4f(au.uDstRect, src.rect.x, src.rect.y, src.rect.w, src.rect.h);
    gl.uniform4f(au.uSrcRect, src.rect.x, src.rect.y, src.rect.w, src.rect.h);
    gl.uniform1i(au.uMode, spec.threshold !== null ? 1 : spec.lut3d !== null ? 2 : 0);
    gl.uniform1f(au.uThreshold, spec.threshold ?? 128);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }


  private blank: WebGLTexture | null = null;
  /** A stand-in table for threshold, which ignores it. */
  private blankLut(): WebGLTexture {
    if (this.blank === null) {
      const lut = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        lut[i * 4] = lut[i * 4 + 1] = lut[i * 4 + 2] = i;
        lut[i * 4 + 3] = 255;
      }
      this.blank = this.lutTexture(lut);
    }
    return this.blank;
  }

  private give(fbo: Fbo): void {
    this.live--;
    const key = `${fbo.rect.w}x${fbo.rect.h}`;
    const pool = this.free.get(key);
    if (pool === undefined) this.free.set(key, [fbo]);
    else pool.push(fbo);
  }

  // --- drawing -------------------------------------------------------------

  /**
   * Composite `src` onto `dst` over `quad`, then fold the result back in.
   *
   * The shader samples `dst` while writing, so it writes into a scratch buffer
   * of the same shape and the scratch's `quad` region is blitted back — the only
   * way to do a read-modify-write in one pass without undefined behaviour.
   */
  private paint(
    dst: Fbo,
    quad: Rect,
    src: { tex: WebGLTexture; rect: Rect; isFbo: boolean },
    opts: {
      blend: string;
      opacity: number;
      mask?: { tex: WebGLTexture; rect: Rect; def: number };
      clip?: Fbo;
      clipBackdrop?: boolean;
    },
  ): void {
    const { gl, u } = this;
    const area = intersect(quad, dst.rect);
    if (area === null) return;
    const scratch = this.take(dst.rect, false);

    gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.fb);
    gl.viewport(0, 0, dst.rect.w, dst.rect.h);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dst.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);

    let flags = src.isFbo ? FLAG_SRC_IS_FBO : 0;
    if (opts.mask !== undefined) {
      flags |= FLAG_MASK;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, opts.mask.tex);
      const m = opts.mask.rect;
      gl.uniform4f(u.uMaskRect, m.x, m.y, m.w, m.h);
      gl.uniform1f(u.uMaskDefault, opts.mask.def);
    }
    if (opts.clip !== undefined) {
      flags |= FLAG_CLIP_TEX;
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, opts.clip.tex);
      const c = opts.clip.rect;
      gl.uniform4f(u.uClipRect, c.x, c.y, c.w, c.h);
    }
    if (opts.clipBackdrop === true) flags |= FLAG_CLIP_BACKDROP;

    gl.uniform4f(u.uQuad, area.x, area.y, area.w, area.h);
    gl.uniform4f(u.uDstRect, dst.rect.x, dst.rect.y, dst.rect.w, dst.rect.h);
    gl.uniform4f(u.uSrcRect, src.rect.x, src.rect.y, src.rect.w, src.rect.h);
    gl.uniform1f(u.uOpacity, opts.opacity);
    gl.uniform1i(u.uBlend, blendIndex(opts.blend));
    gl.uniform1i(u.uFlags, flags);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Fold the touched region back into the accumulator.
    const x0 = area.x - dst.rect.x;
    const x1 = x0 + area.w;
    const yTop = area.y - dst.rect.y;
    const y0 = dst.rect.h - (yTop + area.h);
    const y1 = dst.rect.h - yTop;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, scratch.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fb);
    gl.blitFramebuffer(x0, y0, x1, y1, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.give(scratch);
  }

  // --- the layer walk ------------------------------------------------------

  render(input: CompositeInput): void {
    if (this.disposed) return;
    const { doc, cels, hidden, frame } = input;
    const masks = input.masks ?? new Map<number, Cel>();
    const effects = input.effects ?? new Map<number, Cel[]>();
    const { gl } = this;
    const { width: W, height: H, layers } = doc;

    this.resize(W, H);

    const keep = new Set<ImageBitmap>();
    for (const c of cels.values()) keep.add(c.bitmap);
    for (const m of masks.values()) keep.add(m.bitmap);
    for (const list of effects.values()) for (const e of list) keep.add(e.bitmap);
    this.pruneTextures(keep);

    const kidsOf = new Map<number, number[]>();
    const kids = (p: number): number[] => {
      let k = kidsOf.get(p);
      if (k === undefined) {
        k = childrenOf(layers, p);
        kidsOf.set(p, k);
      }
      return k;
    };

    const celRect = (idx: number): Rect | null => {
      const cel = cels.get(celKey(idx, frame));
      return cel === undefined
        ? null
        : { x: cel.x, y: cel.y, w: cel.w, h: cel.h };
    };

    /**
     * What a node can possibly cover, computed BEFORE rendering so a group's
     * buffer can be sized to its content instead of to the canvas.
     */
    const boundsCache = new Map<number, Rect | null>();
    const bounds = (idx: number): Rect | null => {
      const hit = boundsCache.get(idx);
      if (hit !== undefined) return hit;
      const l = layers[idx];
      let r: Rect | null;
      if (!l.isGroup) {
        // An adjustment layer contributes no bounds of its own — it only
        // reprocesses what is already beneath it.
        r = l.inert || l.adjustment !== undefined ? null : celRect(idx);
        // A drop shadow or stroke reaches beyond the fill's rectangle.
        for (const e of effects.get(idx) ?? []) {
          r = union(r, { x: e.x, y: e.y, w: e.w, h: e.h });
        }
      } else {
        r = null;
        for (const c of kids(idx)) {
          if (hidden.has(c) || layers[c].inert) continue;
          r = union(r, bounds(c));
        }
        if (l.clipRect !== undefined) r = intersect(r, l.clipRect);
        const stencil = masks.get(idx);
        if (stencil !== undefined && (l.maskDefault ?? 0) !== 255) {
          r = intersect(r, {
            x: stencil.x,
            y: stencil.y,
            w: stencil.w,
            h: stencil.h,
          });
        }
      }
      r = snap(r);
      boundsCache.set(idx, r);
      return r;
    };

    const srcOf = (cel: Cel): { tex: WebGLTexture; rect: Rect; isFbo: boolean } => ({
      tex: this.texture(cel.bitmap),
      rect: { x: cel.x, y: cel.y, w: cel.w, h: cel.h },
      isFbo: false,
    });

    /**
     * Draw a leaf's full stack — under-effects (drop shadow, outer glow), the
     * fill, then over-effects (stroke) — each effect with its own blend and
     * opacity, all scaled by `opacityMul` (the layer's own opacity fades its
     * effects with it).
     */
    const drawLeafStack = (
      idx: number,
      dst: Fbo,
      fillBlend: string,
      opacityMul: number,
      clipBackdrop: boolean,
    ): Rect | null => {
      const fx = effects.get(idx) ?? [];
      let dirty: Rect | null = null;
      for (const e of fx) {
        if (e.role !== "under") continue;
        const rect = { x: e.x, y: e.y, w: e.w, h: e.h };
        this.paint(dst, rect, { tex: this.texture(e.bitmap), rect, isFbo: false }, {
          blend: e.blend ?? "normal",
          opacity: (e.opacity ?? 1) * opacityMul,
        });
        dirty = union(dirty, rect);
      }
      const cel = cels.get(celKey(idx, frame));
      if (cel !== undefined) {
        const r = srcOf(cel).rect;
        this.paint(dst, r, srcOf(cel), { blend: fillBlend, opacity: opacityMul, clipBackdrop });
        dirty = union(dirty, r);
      }
      for (const e of fx) {
        if (e.role !== "over") continue;
        const rect = { x: e.x, y: e.y, w: e.w, h: e.h };
        this.paint(dst, rect, { tex: this.texture(e.bitmap), rect, isFbo: false }, {
          blend: e.blend ?? "normal",
          opacity: (e.opacity ?? 1) * opacityMul,
        });
        dirty = union(dirty, rect);
      }
      return dirty;
    };

    /** Draw a node's own content into `dst` at full opacity, normal blend. */
    const drawContent = (idx: number, dst: Fbo): Rect | null => {
      const l = layers[idx];
      if (l.isGroup) return drawGroup(idx, dst);
      return drawLeafStack(idx, dst, "normal", 1, false);
    };

    const needsIsolation = (gi: number): boolean => {
      const g = layers[gi];
      if (g.clipRect !== undefined || masks.has(gi)) return true;
      if (g.passthrough) return false;
      if (g.opacity < 1) return true;
      if (g.blend !== "normal") return true;
      return doc.clipMode === "below" && kids(gi).some((c) => layers[c].clip);
    };

    /** A layer's mask stencil, in the form `paint` wants. */
    const stencilFor = (
      idx: number,
      l: LayerNode,
    ): { tex: WebGLTexture; rect: Rect; def: number } | undefined => {
      const stencil = masks.get(idx);
      if (stencil === undefined) return undefined;
      return {
        tex: this.texture(stencil.bitmap),
        rect: { x: stencil.x, y: stencil.y, w: stencil.w, h: stencil.h },
        def: (l.maskDefault ?? 0) / 255,
      };
    };

    /** Composite an isolated group's buffer onto its parent. */
    const compositeGroup = (idx: number, g: Fbo, dst: Fbo, r: Rect): void => {
      const l = layers[idx];
      this.paint(dst, r, { tex: g.tex, rect: g.rect, isFbo: true }, {
        blend: l.blend,
        opacity: l.opacity,
        mask: stencilFor(idx, l),
      });
    };

    const drawGroup = (parent: number, dst: Fbo): Rect | null => {
      const children = kids(parent);
      let dirty: Rect | null = null;
      for (let i = children.length - 1; i >= 0; i--) {
        const idx = children[i];
        const l = layers[idx];
        if (l.inert) continue;
        if (doc.clipMode === "base" && l.clip) continue;
        if (hidden.has(idx)) continue;

        // --- Photoshop: a layer plus the clipping run stacked on it ----------
        if (doc.clipMode === "base") {
          const run: number[] = [];
          for (let j = i - 1; j >= 0 && layers[children[j]].clip; j--) run.push(children[j]);
          if (run.length > 0) {
            const baseRect = snap(bounds(idx));
            if (baseRect === null) continue;
            const base = this.take(baseRect, true);
            drawContent(idx, base);
            // Snapshot the base's alpha: clipped layers all clip to the ORIGINAL
            // base, not to whatever the run has accumulated so far.
            const snapshot = this.take(baseRect, true);
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, base.fb);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, snapshot.fb);
            gl.blitFramebuffer(
              0, 0, baseRect.w, baseRect.h,
              0, 0, baseRect.w, baseRect.h,
              gl.COLOR_BUFFER_BIT, gl.NEAREST,
            );
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            for (const c of run) {
              const cl = layers[c];
              if (cl.inert || hidden.has(c)) continue;
              // A CLIPPED adjustment layer adjusts only its base, not the rest
              // of the group — that is the whole point of clipping one.
              if (cl.adjustment !== undefined) {
                const adjusted = this.adjust(base, baseRect, cl.adjustment);
                this.paint(base, baseRect, { tex: adjusted.tex, rect: adjusted.rect, isFbo: true }, {
                  blend: cl.blend,
                  opacity: cl.opacity,
                  mask: stencilFor(c, cl),
                  clip: snapshot,
                });
                this.give(adjusted);
                continue;
              }
              const cel = cels.get(celKey(c, frame));
              if (cel === undefined) continue;
              this.paint(base, srcOf(cel).rect, srcOf(cel), {
                blend: cl.blend,
                opacity: cl.opacity,
                clip: snapshot,
              });
            }
            this.paint(dst, baseRect, { tex: base.tex, rect: base.rect, isFbo: true }, {
              blend: l.blend,
              opacity: l.opacity,
            });
            this.give(snapshot);
            this.give(base);
            dirty = union(dirty, baseRect);
            continue;
          }
        }

        // --- an adjustment layer ---------------------------------------------
        // It re-processes everything drawn below it IN ITS GROUP, then blends
        // that back with its own opacity/mask. `dirty` is exactly that content.
        if (l.adjustment !== undefined) {
          const region = intersect(dirty, dst.rect);
          if (region === null) continue;
          const adjusted = this.adjust(dst, region, l.adjustment);
          this.paint(dst, region, { tex: adjusted.tex, rect: adjusted.rect, isFbo: true }, {
            blend: l.blend,
            opacity: l.opacity,
            mask: stencilFor(idx, l),
          });
          this.give(adjusted);
          continue;
        }

        // --- an isolated group ----------------------------------------------
        if (l.isGroup && needsIsolation(idx)) {
          const r = bounds(idx);
          if (r === null) continue;
          const g = this.take(r, true);
          drawGroup(idx, g);
          compositeGroup(idx, g, dst, r);
          this.give(g);
          dirty = union(dirty, r);
          continue;
        }
        if (l.isGroup) {
          dirty = union(dirty, drawGroup(idx, dst));
          continue;
        }

        // --- an ordinary leaf: effects + fill (+ Krita inherit-alpha) --------
        dirty = union(
          dirty,
          drawLeafStack(idx, dst, l.blend, l.opacity, l.clip && doc.clipMode === "below"),
        );
      }
      return dirty;
    };

    const acc = this.take({ x: 0, y: 0, w: W, h: H }, true);
    // A standalone flattened cel (Krita's fallback) sits under the tree.
    for (const cel of cels.values()) {
      if (cel.layer < 0 && cel.frame === frame) {
        this.paint(acc, srcOf(cel).rect, srcOf(cel), { blend: "normal", opacity: 1 });
      }
    }
    drawGroup(-1, acc);
    this.toCanvas(acc, W, H);
    this.give(acc);
  }

  /**
   * Upload textures for cels that will be drawn soon, without compositing.
   * Called as cel batches stream in while the flattened image is still on
   * screen, so the FIRST toggle hits a warm texture cache instead of paying
   * every upload at once.
   */
  prime(bitmaps: Iterable<ImageBitmap>): void {
    if (this.disposed) return;
    for (const b of bitmaps) this.texture(b);
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type) as WebGLShader;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`shader: ${gl.getShaderInfoLog(sh) ?? "?"}`);
    }
    return sh;
  };
  const p = gl.createProgram() as WebGLProgram;
  const v = compile(gl.VERTEX_SHADER, vs);
  const f = compile(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(p) ?? "?"}`);
  }
  gl.deleteShader(v);
  gl.deleteShader(f);
  return p;
}
