import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { schemeBase } from "../../platform";
import { docUrl } from "../document/doc";
import { normalizeBlend } from "./blend";
import { celSocket } from "./celSocket";
import type { LayerNode, LayeredDoc, Cel } from "./types";
import { celKey } from "./types";
import type { LayeredReq, LayeredRes } from "./layeredWorker";

/**
 * Load a layered art document (psd/psb/kra/aseprite/ase) and stream its layer
 * pixels in.
 *
 * The load is deliberately two-staged, because the two stages differ by orders
 * of magnitude in cost:
 *
 *  1. **Metadata + the flattened image.** For Krita/Aseprite this is one cheap
 *     Rust call; for Photoshop it is a structure-only ag-psd parse. Either way
 *     the layer panel and a pixel-exact preview are on screen in milliseconds.
 *  2. **Per-layer pixels**, decoded in the worker and delivered in batches.
 *     Until they arrive the flattened image stands in, and the eye toggles are
 *     marked as still loading.
 */

/** kra/aseprite — the formats Rust decodes for us. */
export function isSpriteArt(ext: string | null | undefined): boolean {
  const e = (ext ?? "").toLowerCase();
  return e === "kra" || e === "aseprite" || e === "ase";
}

/** psd/psb — parsed by ag-psd in the worker. */
export function isPsd(ext: string | null | undefined): boolean {
  const e = (ext ?? "").toLowerCase();
  return e === "psd" || e === "psb";
}

export function isLayeredArt(ext: string | null | undefined): boolean {
  return isSpriteArt(ext) || isPsd(ext);
}

/** `\` → `/`, drop the leading slash — mirrors `docUrl`'s path shaping. */
const celsUrl = (path: string, query = ""): string =>
  `${schemeBase("cels")}/${encodeURI(path.replace(/\\/g, "/").replace(/^\//, ""))}${query}`;

/** What Rust's `layer_doc` command returns (blend names still format-native). */
interface RawDoc {
  width: number;
  height: number;
  layered: boolean;
  layers: (Omit<LayerNode, "blend"> & { blend: string })[];
  frames: { durationMs: number }[];
  tags: { name: string; from: number; to: number; direction: string }[];
  merged: boolean;
  mergedExact: boolean;
}

export type LoadStatus = "loading" | "ready" | "error";

export interface LayeredState {
  status: LoadStatus;
  doc: LayeredDoc | null;
  /** The document's own flattened image, when it has one. */
  merged: ImageBitmap | null;
  cels: Map<string, Cel>;
  /** Group mask stencils, by layer index. */
  masks: Map<number, Cel>;
  /** Exterior layer-effect draws (shadows, glows, strokes), by layer index. */
  effects: Map<number, Cel[]>;
  /** False while per-layer pixels are still streaming in. */
  celsReady: boolean;
  /** Bumped whenever `cels` gains entries, so effects can depend on it. */
  version: number;
}

const EMPTY: LayeredState = {
  status: "loading",
  doc: null,
  merged: null,
  cels: new Map(),
  masks: new Map(),
  effects: new Map(),
  celsReady: false,
  version: 0,
};

/**
 * Longest edge of the layer bitmaps the worker ships.
 *
 * Matched to the flattened preview's own cap, so switching from "the file's
 * image" to "our composite" doesn't change apparent sharpness — and so a
 * document far larger than any screen doesn't spend seconds resampling and
 * uploading pixels nobody can resolve.
 */
const displayMaxEdge = (): number =>
  Math.min(
    2560,
    Math.ceil(Math.max(window.screen.width, window.screen.height) * (window.devicePixelRatio || 1)),
  );

/**
 * Load a document, and stream its layer pixels in when they are wanted.
 *
 * `wantCels` exists because of a measured property of the runtime: bytes cross
 * from Rust into the webview at about 60 MB/s, whatever the transport. A Krita
 * file with 300 layers is ~113 MB of cel pixels — 2.6 s of pure transfer — and
 * none of it is needed to SHOW the document, because every format here ships a
 * flattened image that is what the user first sees. So for those formats the
 * cels are deferred until something actually needs them (the first layer
 * toggle), which takes the preview from "2.6 s" to "as soon as the flattened
 * image lands". Aseprite is the exception: its cels ARE the picture, so they
 * load immediately.
 */
export function useLayeredDoc(path: string, ext: string, wantCels = true): LayeredState {
  const [state, setState] = useState<LayeredState>(EMPTY);
  const workerRef = useRef<Worker | null>(null);
  const reqId = useRef(0);

  // One worker for the life of the view; a new path just supersedes the old
  // request inside it (the worker drops any in-flight loop whose id is stale),
  // which is cheaper and less racy than tearing a worker down mid-decode.
  useEffect(() => {
    const worker = new Worker(new URL("./layeredWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    return () => {
      workerRef.current = null;
      worker.terminate();
    };
  }, []);

  const psd = isPsd(ext);

  useEffect(() => {
    const worker = workerRef.current;
    if (worker === null) return;
    const id = ++reqId.current;
    let cancelled = false;
    setState({ ...EMPTY, cels: new Map() });

    // Cels accumulate outside React state; only the version counter is state, so
    // a 500-layer document doesn't rebuild a Map 500 times. Both these and the
    // flattened image hold GPU-side surfaces that the GC will not free promptly,
    // so the cleanup below closes every one of them by hand.
    const cels = new Map<string, Cel>();
    const masks = new Map<number, Cel>();
    const effects = new Map<number, Cel[]>();
    let mergedBitmap: ImageBitmap | null = null;

    worker.onmessage = (e: MessageEvent<LayeredRes>): void => {
      const msg = e.data;
      if (cancelled || msg.id !== id) return;
      switch (msg.type) {
        case "doc":
          setState((s) => ({ ...s, status: "ready", doc: msg.doc }));
          break;
        case "merged":
          mergedBitmap?.close();
          mergedBitmap = msg.bitmap;
          setState((s) => ({ ...s, merged: msg.bitmap }));
          break;
        case "cels":
          for (const c of msg.cels) {
            if (c.mask === true) masks.set(c.layer, c);
            else if (c.role !== undefined) {
              const list = effects.get(c.layer);
              if (list === undefined) effects.set(c.layer, [c]);
              else list.push(c);
            } else cels.set(celKey(c.layer, c.frame), c);
          }
          setState((s) => ({ ...s, cels, masks, effects, version: s.version + 1 }));
          break;
        case "done":
          setState((s) => ({ ...s, celsReady: true }));
          break;
        case "error":
          console.error("[layered] worker", msg.message);
          setState((s) => (s.doc === null ? { ...s, status: "error" } : { ...s, celsReady: true }));
          break;
      }
    };

    if (psd) {
      // The socket's coordinates have to be resolved HERE: `invoke` only exists
      // on the main thread, and the worker cannot ask for them itself. Memoized
      // after the first call, so this costs one IPC round-trip per session; a
      // null result just leaves the worker on `cels://`.
      void celSocket().then((sock) => {
        if (cancelled || id !== reqId.current) return;
        const req: LayeredReq = {
          id,
          kind: "psd",
          path,
          sock,
          url: docUrl(path),
          // Rust decodes just the composite section, downscaled — the preview
          // shows long before the full file has even crossed into the webview.
          mergedUrl: celsUrl(path, "?what=merged"),
          // Lets the worker Range-fetch just the layer records for the panel.
          prefixUrl: celsUrl(path, "?what=prefix"),
          withCels: wantCels,
          maxEdge: displayMaxEdge(),
        };
        worker.postMessage(req);
      });
    } else {
      // Krita/Aseprite metadata comes over IPC (small JSON); the pixels come
      // over the `cels` scheme, which the worker fetches on its own thread.
      void Promise.all([invoke<RawDoc>("layer_doc", { path }), celSocket()])
        .then(([raw, sock]) => {
          if (cancelled || id !== reqId.current) return;
          const doc: LayeredDoc = {
            width: raw.width,
            height: raw.height,
            layered: raw.layered,
            layers: raw.layers.map((l) => ({ ...l, blend: normalizeBlend(l.blend) })),
            frames: raw.frames.length > 0 ? raw.frames : [{ durationMs: 0 }],
            tags: raw.tags,
            // Krita's "inherit alpha" clips to everything below it in its group,
            // not to one base layer the way Photoshop's clipping mask does.
            clipMode: "below",
            mergedExact: raw.mergedExact,
          };
          setState((s) => ({ ...s, status: "ready", doc }));
          const req: LayeredReq = {
            id,
            kind: "art",
            path,
            sock,
            celsUrl: celsUrl(path),
            mergedUrl: raw.merged ? celsUrl(path, "?what=merged") : null,
            // No usable flattened image means the cels ARE the picture.
            withCels: wantCels || !raw.merged || !raw.mergedExact,
          };
          worker.postMessage(req);
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("[layered] layer_doc failed", err);
          setState((s) => ({ ...s, status: "error" }));
        });
    }

    return () => {
      cancelled = true;
      for (const c of cels.values()) c.bitmap.close();
      for (const m of masks.values()) m.bitmap.close();
      for (const list of effects.values()) for (const e of list) e.bitmap.close();
      mergedBitmap?.close();
    };
    // `wantCels` deliberately absent: flipping it must not restart the load.
    // The follow-up effect below asks the worker to resume instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, psd]);

  // The view decided it needs the pixels after all — tell the worker to ship
  // the half it parked, without re-reading or re-parsing anything.
  const asked = useRef(0);
  useEffect(() => {
    const worker = workerRef.current;
    const id = reqId.current;
    if (!wantCels || worker === null || id === 0 || asked.current === id) return;
    if (state.doc === null || state.celsReady === false) return;
    if (state.cels.size > 0) return;
    asked.current = id;
    setState((s) => ({ ...s, celsReady: false }));
    const req: LayeredReq = { id, kind: "resume" };
    worker.postMessage(req);
  }, [wantCels, state.doc, state.celsReady, state.cels]);

  return state;
}

/** Layer indices in tree display order (top-first), skipping collapsed folders. */
export function useDisplayOrder(
  layers: LayerNode[] | undefined,
  collapsed: Set<number>,
): number[] {
  return useMemo(() => {
    const ls = layers ?? [];
    const kids = new Map<number, number[]>();
    ls.forEach((l, i) => {
      const arr = kids.get(l.parent);
      if (arr === undefined) kids.set(l.parent, [i]);
      else arr.push(i);
    });
    const order: number[] = [];
    const walk = (i: number): void => {
      order.push(i);
      if (ls[i]?.isGroup && !collapsed.has(i)) (kids.get(i) ?? []).forEach(walk);
    };
    (kids.get(-1) ?? []).forEach(walk);
    return order;
  }, [layers, collapsed]);
}
