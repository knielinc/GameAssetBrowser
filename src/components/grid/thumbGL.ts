/**
 * The WebGL2 renderer behind the thumbnail grid.
 *
 * One canvas, one texture atlas (see thumbAtlas.ts), one instanced draw call
 * for every visible thumbnail — that is #2. Pixels come in as raw RGBA over
 * `tex://` and are uploaded straight to the atlas — that is #1, no PNG decode.
 *
 * The canvas paints BEHIND the grid; each cell renders a transparent
 * `[data-thumb-key]` hole. So the canvas must draw everything the cell's `<img>`
 * area used to: the raised letterbox, the alpha checker under cutouts, and the
 * contained image. All three happen in the fragment shader off a single
 * full-cell quad per thumbnail, so the grid looks identical to the DOM version.
 *
 * A frame is: the caller reads the visible holes' screen rects from the DOM and
 * passes them here as instances; we draw. A cell whose thumbnail isn't in the
 * atlas yet is fetched asynchronously and appears on a later frame.
 */

import { ThumbAtlas, type AtlasSlot } from "./thumbAtlas";
import { texUrl } from "../../types";

const VERT = /* glsl */ `#version 300 es
// Unit quad corner in [0,1]^2 (0,0 = bottom-left of the quad).
layout(location=0) in vec2 aCorner;
// Per-instance: full cell rect in clip space (xy = bottom-left, zw = size).
layout(location=1) in vec4 aCell;
// Image sub-rect within the cell, as a fraction (xy = top-left, zw = size).
layout(location=2) in vec4 aInset;
layout(location=3) in vec2 aUvSize;   // image extent within its atlas layer
layout(location=4) in float aLayer;
layout(location=5) in vec2 aRadius;   // corner radius as a fraction of the cell

out vec2 vLocal;      // cell-local coord, (0,0) = TOP-left in screen space
out vec2 vInsetXY;
out vec2 vInsetWH;
out vec2 vUvSize;
flat out float vLayer;
flat out vec2 vRadius;

void main() {
  gl_Position = vec4(aCell.xy + aCorner * aCell.zw, 0.0, 1.0);
  vLocal = vec2(aCorner.x, 1.0 - aCorner.y);   // flip so y=0 is the cell's top
  vInsetXY = aInset.xy;
  vInsetWH = aInset.zw;
  vUvSize = aUvSize;
  vLayer = aLayer;
  vRadius = aRadius;
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vLocal;
in vec2 vInsetXY;
in vec2 vInsetWH;
in vec2 vUvSize;
flat in float vLayer;
flat in vec2 vRadius;
uniform sampler2DArray uAtlas;
out vec4 outColor;

const vec3 LETTERBOX = vec3(0.153, 0.165, 0.208);   // matches bg-raised
const vec3 CHECK_A  = vec3(0.153, 0.165, 0.208);
const vec3 CHECK_B  = vec3(0.118, 0.129, 0.165);
const float HALF_TEXEL = 0.5 / 256.0;   // atlas EDGE; keep in sync with thumbAtlas

void main() {
  vec3 color;
  // Where are we inside the image sub-rect? Outside → letterbox margin.
  vec2 img = (vLocal - vInsetXY) / vInsetWH;
  if (img.x < 0.0 || img.x > 1.0 || img.y < 0.0 || img.y > 1.0) {
    color = LETTERBOX;
  } else {
    // The image occupies the top-left w×h of a 256² cell; the rest is a stale
    // previous tenant. Clamp half a texel inside so LINEAR never samples across
    // the image's right/bottom edge into that stale content (the "overdraw").
    vec2 uv = clamp(img * vUvSize, vec2(HALF_TEXEL), vUvSize - vec2(HALF_TEXEL));
    vec4 tex = texture(uAtlas, vec3(uv, vLayer));
    // Alpha checker so cutouts (foliage, decals) read against the dark panel.
    vec2 c = floor(gl_FragCoord.xy / 8.0);
    vec3 checker = mod(c.x + c.y, 2.0) < 1.0 ? CHECK_A : CHECK_B;
    color = mix(checker, tex.rgb, tex.a);
  }

  // Round the TOP corners so a GL cell matches the DOM frame's rounded-xl — the
  // bottom edge meets the meta strip (its own rounded DOM clip) and stays
  // square. Fade alpha to 0 past the rounded edge so the darker grid shows in
  // the corner. fwidth gives a 1px antialiased edge.
  float alpha = 1.0;
  vec2 q = abs(vLocal - vec2(0.5)) - (vec2(0.5) - vRadius);
  if (q.x > 0.0 && q.y > 0.0 && vLocal.y < 0.5) {
    float dist = length(q / vRadius);
    float aa = max(fwidth(dist), 1e-4);
    alpha = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, dist);
  }
  outColor = vec4(color, alpha);
}`;

let webgl2: boolean | null = null;
/** Whether this WebView can create a WebGL2 context — probed once and cached.
 *  When false, cells fall back to their `<img>` path instead of a GL hole. */
export function hasWebGL2(): boolean {
  if (webgl2 === null) {
    try {
      webgl2 = document.createElement("canvas").getContext("webgl2") !== null;
    } catch {
      webgl2 = false;
    }
  }
  return webgl2;
}

/** One thumbnail to draw this frame: cell screen rect (CSS px) + its slot. */
export interface DrawCell {
  x: number;
  y: number;
  w: number;
  h: number;
  slot: AtlasSlot;
}

const FLOATS = 13; // aCell(4) + aInset(4) + aUvSize(2) + aLayer(1) + aRadius(2)
/** Corner radius in CSS px — matches the cells' Tailwind `rounded-lg`. */
const CORNER_PX = 8;

export class ThumbGL {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private atlas: ThumbAtlas;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private instBuf: WebGLBuffer;
  private uAtlas: WebGLUniformLocation | null;
  private inst = new Float32Array(0);
  private inFlight = new Set<string>();
  /** Keys that 404'd, so we don't hammer tex:// — cleared when a decode lands. */
  private failed = new Set<string>();

  constructor() {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, antialias: false });
    if (gl === null) throw new Error("WebGL2 unavailable");
    this.canvas = canvas;
    this.gl = gl;
    this.atlas = new ThumbAtlas(gl);
    this.prog = link(gl, VERT, FRAG);
    this.uAtlas = gl.getUniformLocation(this.prog, "uAtlas");

    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error("vao");
    this.vao = vao;
    gl.bindVertexArray(vao);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const ib = gl.createBuffer();
    if (ib === null) throw new Error("instance buffer");
    this.instBuf = ib;
    gl.bindBuffer(gl.ARRAY_BUFFER, ib);
    const stride = FLOATS * 4;
    // aCell (loc 1), aInset (loc 2), aUvSize (loc 3), aLayer (loc 4).
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 4 * 4);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 8 * 4);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 10 * 4);
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 2, gl.FLOAT, false, stride, 11 * 4);
    gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);

    gl.clearColor(0, 0, 0, 0);
  }

  /** The atlas slot for `key`, if already uploaded (marks it recently-used). */
  slot(key: string): AtlasSlot | undefined {
    return this.atlas.slot(key);
  }

  /** Crisp pixel-art (NEAREST) vs smooth (LINEAR) sampling for the whole grid. */
  setPixelArt(on: boolean): void {
    this.atlas.setFilter(on);
  }

  /** Let a 404'd key be retried — call when a fresh decode may have landed. */
  clearFailed(): void {
    this.failed.clear();
  }

  /** Fetch `key`'s RGBA over tex:// and upload it, unless it's already here or
   *  in flight. Returns immediately; the thumbnail appears on a later frame. */
  request(key: string): void {
    if (this.atlas.has(key) || this.inFlight.has(key) || this.failed.has(key)) return;
    this.inFlight.add(key);
    void (async () => {
      try {
        const res = await fetch(texUrl(key));
        if (!res.ok) {
          this.failed.add(key);
          return;
        }
        const buf = await res.arrayBuffer();
        const dv = new DataView(buf);
        const w = dv.getUint32(0, true);
        const h = dv.getUint32(4, true);
        if (w === 0 || h === 0 || buf.byteLength < 8 + w * h * 4) {
          this.failed.add(key);
          return;
        }
        this.atlas.upload(key, w, h, new Uint8Array(buf, 8));
      } catch {
        this.failed.add(key);
      } finally {
        this.inFlight.delete(key);
      }
    })();
  }

  /** Draw `cells` into a `cssW x cssH` viewport (device pixels via `dpr`). */
  draw(cells: DrawCell[], cssW: number, cssH: number, dpr: number): void {
    const gl = this.gl;
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    gl.viewport(0, 0, pw, ph);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (cells.length === 0) return;

    if (this.inst.length < cells.length * FLOATS) {
      this.inst = new Float32Array(cells.length * FLOATS);
    }
    const data = this.inst;
    let n = 0;
    for (const c of cells) {
      const s = c.slot;
      const aspect = s.uw / s.uh;
      // Contain-fit the image inside the square cell.
      let dw = c.w;
      let dh = c.h;
      if (aspect >= 1) dh = c.h / aspect;
      else dw = c.w * aspect;
      // Full cell rect → clip space (top-left origin, y-down → y-up).
      const clipX = (c.x / cssW) * 2 - 1;
      const clipYtop = 1 - (c.y / cssH) * 2;
      const clipW = (c.w / cssW) * 2;
      const clipH = (c.h / cssH) * 2;
      const o = n * FLOATS;
      data[o] = clipX;
      data[o + 1] = clipYtop - clipH; // bottom-left y
      data[o + 2] = clipW;
      data[o + 3] = clipH;
      // Image inset within the cell, as fractions from the top-left.
      data[o + 4] = (c.w - dw) / 2 / c.w;
      data[o + 5] = (c.h - dh) / 2 / c.h;
      data[o + 6] = dw / c.w;
      data[o + 7] = dh / c.h;
      data[o + 8] = s.uw;
      data[o + 9] = s.uh;
      data[o + 10] = s.layer;
      // Corner radius as a fraction of the (square) cell, for the shader mask.
      data[o + 11] = CORNER_PX / c.w;
      data[o + 12] = CORNER_PX / c.h;
      n++;
    }

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * FLOATS), gl.DYNAMIC_DRAW);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas.texture);
    gl.uniform1i(this.uAtlas, 0);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.atlas.dispose();
    this.gl.deleteProgram(this.prog);
    this.gl.deleteBuffer(this.instBuf);
    this.gl.deleteVertexArray(this.vao);
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type);
    if (sh === null) throw new Error("shader alloc");
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error("thumb shader: " + (gl.getShaderInfoLog(sh) ?? ""));
    }
    return sh;
  };
  const prog = gl.createProgram();
  if (prog === null) throw new Error("program alloc");
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error("thumb program: " + (gl.getProgramInfoLog(prog) ?? ""));
  }
  return prog;
}
