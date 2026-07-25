/// <reference lib="webworker" />
/**
 * Layered-art reader, entirely off the main thread.
 *
 * Two sources, one output shape ([`LayeredDoc`] + a stream of [`Cel`]s carrying
 * `ImageBitmap`s):
 *
 *  * **Photoshop** — ag-psd parses the file here. The parse runs ONCE with
 *    `useRawData`, which reads the whole layer tree but leaves every layer's
 *    channels compressed, so the tree and the baked composite are ready almost
 *    immediately; each layer's pixels are then decompressed one at a time and
 *    shipped as they finish. The old code parsed the file twice on the main
 *    thread (once for the tree, once for the pixels) and let ag-psd allocate an
 *    HTMLCanvasElement per layer, which is what made opening a big .psd lock the
 *    UI for seconds.
 *  * **Krita / Aseprite** — Rust has already done the decoding; this just
 *    fetches the binary cel pack and turns each record into an ImageBitmap.
 *
 * Bitmaps are TRANSFERRED to the main thread, so nothing is copied and the main
 * thread never touches a pixel until it draws.
 */
import {
  initializeCanvas,
  readPsd,
  decodeLayerPixels,
  getCompositeImageData,
  type Layer,
} from "ag-psd";
import { buildAdjustment } from "./adjustment";
import { normalizeBlend } from "./blend";
import { readCelPack } from "./celPack";
import { applyMask, hasMask, maskDefault, maskStencil, toRgba8 } from "./psdMask";
import { renderEffects, pendingEffectNames } from "./fx";
import type { LayerKind, LayerNode, LayeredDoc } from "./types";

// No `document` in a worker, so ag-psd's default canvas factory throws. We pass
// `useImageData`, which keeps it off the canvas path for pixels, but it still
// allocates ImageData internally — and `new ImageData` exists here, unlike a
// canvas. OffscreenCanvas covers the paths we don't take (embedded JPEG
// thumbnails) so a surprise there degrades instead of throwing.
initializeCanvas(
  (width, height) => new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement,
  (width, height) => new ImageData(width, height),
);

/**
 * Keep bitmaps in STRAIGHT alpha.
 *
 * The default would premultiply, which bakes colour into alpha and loses the RGB
 * of near-transparent pixels — and the compositor's blend formula is written in
 * straight alpha, so it would have to undo the multiplication (with rounding
 * loss) on every sample.
 */
const STRAIGHT: ImageBitmapOptions = { premultiplyAlpha: "none" };

/**
 * Longest edge of the FIRST preview. Small enough to arrive in a blink (a
 * couple of megabytes), large enough that the docked inspector shows it at
 * roughly native size; a sharp one replaces it moments later.
 */
const COARSE_EDGE = 1024;

/** Longest edge of the sharp preview that replaces it. */
const SHARP_EDGE = 2560;

/** A cel on the wire: same as `Cel`, and the bitmap is transferred. */
export interface WireCel {
  layer: number;
  frame: number;
  x: number;
  y: number;
  /** Canvas-space size; the bitmap itself may be a downscaled copy. */
  w: number;
  h: number;
  bitmap: ImageBitmap;
  /** A group's mask STENCIL rather than drawable content — see `maskStencil`. */
  mask?: boolean;
  /** An exterior layer-effect draw — see `Cel.role`. */
  role?: "under" | "over";
  blend?: string;
  opacity?: number;
}

export type LayeredReq =
  /** Krita/Aseprite: Rust has the pixels, we only fetch them. */
  | { id: number; kind: "art"; celsUrl: string; mergedUrl: string | null; withCels: boolean }
  /** Photoshop: parse the whole file here. */
  | {
      id: number;
      kind: "psd";
      url: string;
      mergedUrl: string | null;
      /** Where the layer records end, for the early tree parse. */
      prefixUrl: string | null;
      withCels: boolean;
      maxEdge: number;
    }
  /** Ship the cels of the document already loaded under this id. */
  | { id: number; kind: "resume" };

export type LayeredRes =
  | { id: number; type: "doc"; doc: LayeredDoc }
  | { id: number; type: "merged"; bitmap: ImageBitmap }
  | { id: number; type: "cels"; cels: WireCel[] }
  | { id: number; type: "done" }
  | { id: number; type: "error"; message: string };

/** Newest request wins; older loops notice and bail at their next await. */
let current = 0;

/**
 * The cel-shipping half of the document currently loaded, held back until
 * something asks for it.
 *
 * Bytes reach the webview at roughly 60 MB/s, and a big document's cels run to
 * hundreds of megabytes — none of which is needed to display it, because the
 * flattened image arrives first and is what the user sees. So the expensive
 * half is parked here and only runs when the view asks (`kind: "resume"`).
 */
let deferred: (() => Promise<void>) | null = null;

const post =(msg: LayeredRes, transfer: Transferable[] = []): void =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

/** Ship cels in small batches — one message per layer would be all overhead. */
const BATCH = 8;

class CelSink {
  private buf: WireCel[] = [];
  constructor(private readonly id: number) {}

  push(cel: WireCel): void {
    this.buf.push(cel);
    if (this.buf.length >= BATCH) this.flush();
  }

  flush(): void {
    if (this.buf.length === 0) return;
    const cels = this.buf;
    this.buf = [];
    post({ id: this.id, type: "cels", cels }, cels.map((c) => c.bitmap));
  }
}

// ---------------------------------------------------------------------------
// Krita / Aseprite — unpack what Rust sent
// ---------------------------------------------------------------------------

async function unpackCels(buf: ArrayBuffer, id: number, sink: CelSink): Promise<void> {
  for (const rec of readCelPack(buf)) {
    if (id !== current) return;
    const bitmap = await createImageBitmap(new ImageData(rec.pixels, rec.width, rec.height), STRAIGHT);
    sink.push({ layer: rec.layer, frame: rec.frame, x: rec.x, y: rec.y, w: rec.width, h: rec.height, bitmap });
  }
}

async function handleArt(req: Extract<LayeredReq, { kind: "art" }>): Promise<void> {
  const { id } = req;
  // The flattened image first: it is one already-encoded PNG sitting in the
  // archive, so it lands far sooner than the per-layer decode and gives the
  // view something pixel-exact to show meanwhile.
  if (req.mergedUrl !== null) {
    try {
      const res = await fetch(req.mergedUrl);
      if (res.ok && id === current) {
        const bitmap = await createImageBitmap(await res.blob(), STRAIGHT);
        if (id === current) post({ id, type: "merged", bitmap }, [bitmap]);
      }
    } catch {
      // No flattened image — the per-layer composite is the only preview.
    }
  }
  if (id !== current) return;
  const ship = async (): Promise<void> => {
    const res = await fetch(req.celsUrl);
    if (!res.ok) throw new Error(`cels ${res.status}`);
    const buf = await res.arrayBuffer();
    if (id !== current) return;
    const sink = new CelSink(id);
    await unpackCels(buf, id, sink);
    sink.flush();
  };
  if (req.withCels) await ship();
  else deferred = ship;
}

// ---------------------------------------------------------------------------
// Photoshop
// ---------------------------------------------------------------------------

/** What sort of layer this is, for the panel's icon. */
function psdKind(layer: Layer): LayerKind {
  if (Array.isArray(layer.children)) return "group";
  if (layer.adjustment !== undefined) return "filter";
  if (layer.text !== undefined) return "text";
  if (layer.placedLayer !== undefined) return "smart";
  if (layer.vectorFill !== undefined || layer.vectorStroke !== undefined) return "vector";
  return "paint";
}

/** The parts of a parsed document this module reads. */
interface PsdLike {
  width: number;
  height: number;
  children?: Layer[];
}

/** Flatten ag-psd's tree into our top-first array, collecting the source layers. */
function flattenPsd(
  children: Layer[],
  parent: number,
  depth: number,
  out: LayerNode[],
  src: (Layer | null)[],
): void {
  // Photoshop stores layers bottom-first; the panel shows them top-first.
  for (let i = children.length - 1; i >= 0; i--) {
    const layer = children[i];
    const isGroup = Array.isArray(layer.children);
    const kind = psdKind(layer);
    const blend = normalizeBlend(layer.blendMode);
    const idx = out.length;
    // An artboard crops everything inside it to its own bounds.
    const ab = layer.artboard?.rect;
    const adjustment = buildAdjustment(layer.adjustment as never);
    const missing = pendingEffectNames(layer.effects);
    out.push({
      name: layer.name ?? (isGroup ? "Group" : "Layer"),
      kind,
      // `fillOpacity` fades only the layer's own pixels, never its effects —
      // it is baked into the fill cel's alpha where the cels are decoded, so
      // the node's opacity here is purely the layer-wide knob.
      opacity: layer.opacity ?? 1,
      blend: blend === "passThrough" ? "normal" : blend,
      visible: layer.hidden !== true,
      depth,
      isGroup,
      parent,
      clip: layer.clipping === true,
      passthrough: isGroup && blend === "passThrough",
      masked: hasMask(layer),
      // An adjustment's own mask scopes where it applies, exactly like a group's
      // does, so it travels the same way.
      maskDefault: (isGroup || adjustment !== null) && hasMask(layer) ? maskDefault(layer) : undefined,
      adjustment: adjustment ?? undefined,
      missingEffects: missing.length > 0 ? missing : undefined,
      // An adjustment layer has no pixels of its own: either we can evaluate its
      // transfer function or we can't. When we can't, it is listed and skipped
      // rather than silently dropped.
      inert: kind === "filter" && adjustment === null,
      clipRect:
        ab === undefined
          ? undefined
          : { x: ab.left, y: ab.top, w: ab.right - ab.left, h: ab.bottom - ab.top },
    });
    src.push(layer);
    if (isGroup) flattenPsd(layer.children as Layer[], idx, depth + 1, out, src);
  }
}

async function handlePsd(req: Extract<LayeredReq, { kind: "psd" }>): Promise<void> {
  const { id } = req;

  /**
   * Ask Rust for the flattened image at a given size. It seeks past the layer
   * section and decodes only the rows that size samples, so the cost — on both
   * ends — scales with what is asked for, not with the file.
   */
  const fetchMerged = async (maxEdge: number): Promise<boolean> => {
    if (req.mergedUrl === null) return false;
    try {
      const r = await fetch(`${req.mergedUrl}&max=${maxEdge}`);
      if (!r.ok) return false;
      const rec = readCelPack(await r.arrayBuffer())[0];
      if (rec === undefined || id !== current) return false;
      const bitmap = await createImageBitmap(
        new ImageData(rec.pixels, rec.width, rec.height),
        STRAIGHT,
      );
      if (id !== current) {
        bitmap.close();
        return false;
      }
      post({ id, type: "merged", bitmap }, [bitmap]);
      return true;
    } catch {
      // Unsupported colour mode etc. — the ag-psd decode below covers it.
      return false;
    }
  };

  // Stage one: a small preview, first and alone. Bytes enter the webview at a
  // fixed ~60 MB/s, so this must not share the pipe with the 89 MB structure
  // fetch or they simply arrive together. A megabyte or two lands in well under
  // a tenth of a second, which is the whole point.
  const rustMerged = await fetchMerged(COARSE_EDGE);
  if (id !== current) return;

  // Stage two: the sharp preview, still BEFORE the structure fetch. Everything
  // shares one ~60 MB/s pipe, so this is purely a question of order — and a few
  // hundred milliseconds spent here buys a finished-looking image at half a
  // second instead of two, at the cost of the layer panel appearing that much
  // later. The image is what the user is looking at.
  if (rustMerged && req.maxEdge > COARSE_EDGE) {
    await fetchMerged(Math.min(req.maxEdge, SHARP_EDGE));
    if (id !== current) return;
  }

  /** Build the doc that goes to the panel from an already-parsed tree. */
  const docFrom = (parsed: PsdLike, exact: boolean): { doc: LayeredDoc; layers: LayerNode[]; src: (Layer | null)[] } => {
    const layers: LayerNode[] = [];
    const src: (Layer | null)[] = [];
    flattenPsd(parsed.children ?? [], -1, 0, layers, src);
    return {
      layers,
      src,
      doc: {
        width: parsed.width,
        height: parsed.height,
        layered: layers.some((l) => !l.isGroup && !l.inert),
        layers,
        frames: [{ durationMs: 0 }],
        tags: [],
        clipMode: "base",
        mergedExact: exact,
      },
    };
  };

  // The layer TREE lives in a prefix of the file — every layer's record comes
  // before any layer's pixels. Rust reports where that prefix ends, so the panel
  // can be built from a Range request of a few megabytes instead of waiting for
  // the whole document. The prefix is padded back to full length with zeros so
  // the reader's internal offsets still line up; it never reads past the records
  // with layer image data skipped.
  let early: ReturnType<typeof docFrom> | null = null;
  if (req.prefixUrl !== null) {
    try {
      const pr = await fetch(req.prefixUrl);
      if (pr.ok) {
        const [prefixLen, totalLen] = (await pr.text()).split(" ").map(Number);
        if (Number.isFinite(prefixLen) && prefixLen > 0 && prefixLen < totalLen) {
          const head = await fetch(req.url, { headers: { Range: `bytes=0-${prefixLen - 1}` } });
          const headBuf = await head.arrayBuffer();
          if (id !== current) return;
          if (headBuf.byteLength >= prefixLen) {
            const padded = new Uint8Array(totalLen);
            padded.set(new Uint8Array(headBuf, 0, prefixLen));
            const tree = readPsd(padded.buffer, {
              skipLayerImageData: true,
              skipCompositeImageData: true,
              skipThumbnail: true,
              skipLinkedFilesData: true,
              useImageData: true,
            });
            early = docFrom(tree as PsdLike, rustMerged);
            post({ id, type: "doc", doc: early.doc });
          }
        }
      }
    } catch {
      // Server ignored the Range, or the tree needs more than the prefix —
      // the full parse below produces the same doc a moment later.
    }
  }
  if (id !== current) return;

  const res = await fetch(req.url);
  if (!res.ok) throw new Error(`psd ${res.status}`);
  const buf = await res.arrayBuffer();
  if (id !== current) return;

  const psd = readPsd(buf, {
    // Read structure only; every bitmap stays compressed until asked for.
    useRawData: true,
    useImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
  });
  if (id !== current) return;

  const full = docFrom(psd as PsdLike, rustMerged);
  const layers = full.layers;
  const src = full.src;

  // The slow in-worker composite decode only runs when Rust couldn't serve one.
  let mergedBitmap: ImageBitmap | null = null;
  if (!rustMerged) {
    try {
      const comp = getCompositeImageData(psd);
      const cd = comp !== undefined ? toRgba8(comp) : null;
      if (cd !== null && comp !== undefined && id === current) {
        mergedBitmap = await createImageBitmap(new ImageData(cd, comp.width, comp.height), STRAIGHT);
      }
    } catch {
      // No composite saved (rare) — the live composite is the only preview.
    }
  }
  if (id !== current) return;

  // Photoshop's baked composite includes whatever we can't evaluate, so it
  // stays on screen until the user starts switching layers off. Without one
  // there is nothing to show but the live composite.
  const doc: LayeredDoc = { ...full.doc, mergedExact: rustMerged || mergedBitmap !== null };
  // Only announce the tree if the early prefix parse didn't already, or
  // disagreed with it — re-posting an identical doc would reset the panel's
  // expand/hide state under the user's hands. Layer INDICES must match either
  // way, since the cels below are keyed by them.
  const sameAsEarly =
    early !== null &&
    early.layers.length === layers.length &&
    early.doc.mergedExact === doc.mergedExact &&
    early.layers.every((l, i) => l.name === layers[i].name && l.parent === layers[i].parent);
  if (!sameAsEarly) post({ id, type: "doc", doc });
  if (mergedBitmap !== null) post({ id, type: "merged", bitmap: mergedBitmap }, [mergedBitmap]);

  // Downscale factor for shipped bitmaps: nobody can see more pixels than the
  // display has, and a 90-megapixel layer stack at full resolution is pure
  // transfer and memory cost. Geometry stays in document space — only the
  // bitmaps shrink, and the compositor stretches them back.
  const docEdge = Math.max(psd.width, psd.height);
  const shrink = req.maxEdge > 0 && docEdge > req.maxEdge ? req.maxEdge / docEdge : 1;
  const globalAngle = psd.imageResources?.globalAngle ?? 120;

  const toBitmap = (rgba: Uint8ClampedArray, w: number, h: number): Promise<ImageBitmap> => {
    // Resampling is only worth it when it removes real work downstream. A
    // near-1 shrink costs a full high-quality resample of every layer and saves
    // almost nothing: at 0.91 on a 90-megapixel stack that was 1.9 s of the
    // 2.7 s cel budget, to make the bitmaps 9% smaller. Below the threshold,
    // `medium` is used — this is a preview, and `high` roughly doubles the cost
    // for a difference that does not survive being drawn at fit-to-window size.
    if (shrink > 0.8 || w * h < 65536) {
      return createImageBitmap(new ImageData(rgba, w, h), STRAIGHT);
    }
    return createImageBitmap(new ImageData(rgba, w, h), {
      ...STRAIGHT,
      resizeWidth: Math.max(1, Math.round(w * shrink)),
      resizeHeight: Math.max(1, Math.round(h * shrink)),
      resizeQuality: "medium",
    });
  };

  const shipCels = async (): Promise<void> => {
    const sink = new CelSink(id);
    for (let i = 0; i < src.length; i++) {
      if (id !== current) return;
      const layer = src[i];
      if (layer === null || layers[i].inert) continue;

      // Groups and adjustment layers have no pixels of their own, but either
      // may carry a MASK scoping what it affects. That travels as a stencil.
      if (layers[i].isGroup || layers[i].adjustment !== undefined) {
        if (!hasMask(layer)) continue;
        try {
          decodeLayerPixels(layer, true);
          const st = maskStencil(layer);
          if (st !== null) {
            const bitmap = await toBitmap(st.rgba, st.w, st.h);
            sink.push({ layer: i, frame: 0, x: st.x, y: st.y, w: st.w, h: st.h, bitmap, mask: true });
          }
        } catch (e) {
          console.warn("[layered] psd group mask failed", layers[i].name, e);
        } finally {
          if (layer.mask !== undefined) delete layer.mask.imageData;
          if (layer.realMask !== undefined) delete layer.realMask.imageData;
        }
        continue;
      }

      const w = (layer.right ?? 0) - (layer.left ?? 0);
      const h = (layer.bottom ?? 0) - (layer.top ?? 0);
      if (w <= 0 || h <= 0) continue;
      try {
        decodeLayerPixels(layer, true);
        const pd = layer.imageData;
        if (pd === undefined) continue;
        const rgba = toRgba8(pd);
        if (rgba === null) continue;
        applyMask(layer, rgba, pd.width, pd.height);
        // `fillOpacity` fades the layer's own pixels but NOT its effects, so it
        // is baked into alpha before the effects render from this shape.
        const fillOpacity = layer.fillOpacity ?? 1;
        if (fillOpacity < 1) {
          for (let p = 3; p < rgba.length; p += 4) rgba[p] *= fillOpacity;
        }
        const fill = { data: rgba, w: pd.width, h: pd.height, x: layer.left ?? 0, y: layer.top ?? 0 };
        const fx = renderEffects(layer, fill, globalAngle);
        for (const d of fx.draws) {
          const bitmap = await toBitmap(d.rgba, d.w, d.h);
          sink.push({
            layer: i, frame: 0, x: d.x, y: d.y, w: d.w, h: d.h, bitmap,
            role: d.under ? "under" : "over", blend: d.blend, opacity: d.opacity,
          });
        }
        const bitmap = await toBitmap(rgba, pd.width, pd.height);
        sink.push({ layer: i, frame: 0, x: fill.x, y: fill.y, w: pd.width, h: pd.height, bitmap });
      } catch (e) {
        console.warn("[layered] psd layer decode failed", layers[i].name, e);
      } finally {
        // Drop the decoded pixels — a 200-layer document would otherwise hold
        // every layer's full RGBA alive at once.
        delete layer.imageData;
        if (layer.mask !== undefined) delete layer.mask.imageData;
        if (layer.realMask !== undefined) delete layer.realMask.imageData;
      }
    }
    sink.flush();
  };
  if (req.withCels) await shipCels();
  else deferred = shipCels;
}

self.onmessage = (e: MessageEvent<LayeredReq>): void => {
  const req = e.data;
  if (req.kind !== "resume") {
    current = req.id;
    deferred = null;
  }
  void (async () => {
    try {
      if (req.kind === "resume") {
        const run = deferred;
        deferred = null;
        if (req.id === current && run !== null) await run();
      } else if (req.kind === "art") {
        await handleArt(req);
      } else {
        await handlePsd(req);
      }
      if (req.id === current) post({ id: req.id, type: "done" });
    } catch (err) {
      if (req.id === current) {
        post({ id: req.id, type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  })();
};
