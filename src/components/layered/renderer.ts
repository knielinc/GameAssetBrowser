/**
 * Picks and owns the compositing backend for one preview canvas.
 *
 * The GPU compositor is the real one — exact blend modes, and a 15-megapixel
 * document re-composites in milliseconds instead of the ~700 ms the canvas-2D
 * path needed once a file used linear burn. Canvas 2D stays as a fallback for
 * the two cases the GPU can't take: no WebGL2 context (very old webviews, a
 * lost context), and documents too large to hold offscreen buffers for.
 *
 * A canvas can only ever have ONE context type, so the choice is made on first
 * use — when the document's size is known — and never revisited for that canvas.
 */

import { composite, type CompositeInput } from "./composite";
import { GlCompositor } from "./gl/glCompositor";

export type Backend = "gl" | "2d";

export class LayerRenderer {
  private gl: GlCompositor | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private mode: Backend | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** Which backend ended up in use, or null before the first draw. */
  get backend(): Backend | null {
    return this.mode;
  }

  private ensure(width: number, height: number): void {
    if (this.mode !== null) return;
    if (GlCompositor.affordable(width, height)) {
      try {
        this.gl = new GlCompositor(this.canvas);
        this.mode = "gl";
        return;
      } catch (e) {
        console.warn("[layered] no GPU compositor, falling back to canvas 2D", e);
      }
    }
    this.ctx2d = this.canvas.getContext("2d");
    this.mode = "2d";
  }

  /** Show the document's own flattened image, stretched to the document. */
  present(bitmap: ImageBitmap, width: number, height: number): void {
    this.ensure(width, height);
    if (this.gl !== null) {
      this.gl.present(bitmap, width, height);
      return;
    }
    const ctx = this.ctx2d;
    if (ctx === null) return;
    this.resize2d(width, height);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
  }

  /** Warm the GPU texture cache for cels that will be drawn soon. */
  prime(bitmaps: Iterable<ImageBitmap>): void {
    this.gl?.prime(bitmaps);
  }

  /** Composite the layer tree. */
  render(input: CompositeInput): void {
    const { width, height } = input.doc;
    this.ensure(width, height);
    if (this.gl !== null) {
      this.gl.render(input);
      return;
    }
    const ctx = this.ctx2d;
    if (ctx === null) return;
    this.resize2d(width, height);
    composite(ctx, input);
  }

  private resize2d(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  dispose(): void {
    this.gl?.dispose();
    this.gl = null;
    this.ctx2d = null;
    this.mode = null;
  }
}
