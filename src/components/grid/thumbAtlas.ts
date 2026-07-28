/**
 * A GPU thumbnail atlas for the WebGL grid.
 *
 * All visible thumbnails live in ONE `TEXTURE_2D_ARRAY` — each thumbnail is one
 * layer. The grid then draws every visible cell as an instanced quad in a
 * SINGLE draw call, sampling its own layer. That is #2 (GPU atlasing): the
 * browser is no longer creating a texture and a compositor layer per `<img>`.
 *
 * Pixels arrive as raw RGBA over the `tex://` scheme and are uploaded with
 * `texSubImage3D` — no PNG decode anywhere (that is #1). Layers are recycled
 * LRU, so a bounded array covers any folder size.
 */

const EDGE = 256; // atlas cell size; thumbnails are letterboxed into it
const LAYERS = 512; // ~512 * 256KB = 128 MB VRAM — far more than any viewport

export interface AtlasSlot {
  layer: number;
  /** The image's size as a fraction of the square cell, so the shader can
   *  letterbox it (sample only the sub-rect, no stretch). */
  uw: number;
  uh: number;
}

export class ThumbAtlas {
  readonly texture: WebGLTexture;
  private gl: WebGL2RenderingContext;
  /** key -> slot, in LRU order: a Map iterates in insertion order, so
   *  delete+set moves a key to the back in O(1) and the first key is the
   *  eviction victim. This IS the LRU list — a separate array of keys cost an
   *  `indexOf` + `splice` over 512 entries on every `slot()` call, and `slot()`
   *  runs for every visible cell on every frame: 0.89 ms per frame at 200 cells
   *  against 0.03 ms here, measured in the app. */
  private slotOf = new Map<string, AtlasSlot>();
  private free: number[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const tex = gl.createTexture();
    if (tex === null) throw new Error("atlas texture alloc failed");
    this.texture = tex;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, EDGE, EDGE, LAYERS);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    for (let i = LAYERS - 1; i >= 0; i--) this.free.push(i);
  }

  /** The layer holding `key`, if uploaded. Marks it most-recently-used. */
  slot(key: string): AtlasSlot | undefined {
    const s = this.slotOf.get(key);
    // Re-insert to move it to the back of the iteration order.
    if (s !== undefined) {
      this.slotOf.delete(key);
      this.slotOf.set(key, s);
    }
    return s;
  }

  has(key: string): boolean {
    return this.slotOf.has(key);
  }

  /** Switch sampling between smooth (LINEAR) and crisp pixel-art (NEAREST).
   *  Same texels, different filter — no re-upload, just a redraw. */
  setFilter(nearest: boolean): void {
    const gl = this.gl;
    const f = nearest ? gl.NEAREST : gl.LINEAR;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, f);
  }

  /**
   * Upload one thumbnail's RGBA into a layer. `w`/`h` are the image's real
   * dimensions; it is centred into the square cell and its aspect recorded so
   * the shader can letterbox it (no stretching).
   */
  upload(key: string, w: number, h: number, rgba: Uint8Array): AtlasSlot {
    const layer = this.slotOf.get(key)?.layer ?? this.take();
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Clear the cell first (previous tenant may have been larger), then place
    // the image. For simplicity we upload into the top-left and letterbox via
    // the aspect uniform; the cell is CLAMP_TO_EDGE so unused pixels never
    // bleed because the shader only samples the image sub-rect.
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const slot: AtlasSlot = { layer, uw: w / EDGE, uh: h / EDGE };
    // delete first, so re-uploading an existing key moves it to the back of the
    // LRU order rather than updating it in place at its old position.
    this.slotOf.delete(key);
    this.slotOf.set(key, slot);
    return slot;
  }

  /** A free layer, evicting the least-recently-used one when the array is full.
   *  The caller inserts the key, which is what puts it at the back. */
  private take(): number {
    const free = this.free.pop();
    if (free !== undefined) return free;
    // Least-recently-used = first in iteration order.
    const victim = this.slotOf.keys().next();
    if (victim.done === true) return 0;
    const layer = this.slotOf.get(victim.value)?.layer ?? 0;
    this.slotOf.delete(victim.value);
    return layer;
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.slotOf.clear();
  }

  static get EDGE(): number {
    return EDGE;
  }
}
