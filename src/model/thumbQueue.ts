import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { invoke } from "@tauri-apps/api/core";
import { loadModel, modelUrl } from "./loadModel";
import { disposeModel } from "./dispose";
import { rescueTextures } from "./rescueTextures";
import { atlasFor } from "../stores/atlasStore";
/** Minimal shape this module needs — avoids importing the store, which would
 *  drag `three` into whatever imports the store. */
export interface LibFileLike {
  id: number;
  path: string;
  name: string;
}

const EDGE = 256;
/** Fixed camera for EVERY thumbnail. Consistency is the entire value of a
 *  grid — one framed differently per model is unscannable. */
const AZ = 0.61; // ~35°
const EL = 0.44; // ~25°

/**
 * Model thumbnails: ONE offscreen renderer, one model at a time, result cached
 * to disk. Grid cells are plain <img>, so the grid holds zero WebGL contexts
 * and the ~16-context cap never enters the picture — by construction, not by
 * budgeting.
 *
 * Concurrency is 1 on purpose. The bottleneck is single-threaded JS parse
 * (a Synty FBX is ~100-400 ms), so >1 buys nothing and only widens the jank
 * window. Eager generation is not an option at any concurrency: 500 models
 * would block the UI for a minute or more. Lazy is the only design.
 */

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;

function ensure(): { r: THREE.WebGLRenderer; s: THREE.Scene; c: THREE.PerspectiveCamera } | null {
  if (renderer !== null && scene !== null && camera !== null) {
    return { r: renderer, s: scene, c: camera };
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = EDGE;
  let r: THREE.WebGLRenderer;
  try {
    r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return null; // no WebGL — cells keep their icon, which is honest
  }
  r.setSize(EDGE, EDGE, false);
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;

  const s = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(r);
  // Same environment + light rig as the inspector, so a thumbnail and its
  // detail view are lit identically. That agreement is the polish.
  s.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-4, 6, 5);
  s.add(key);
  s.add(new THREE.HemisphereLight(0x9fb4ff, 0x33302c, 1.2));

  const c = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
  renderer = r;
  scene = s;
  camera = c;
  return { r, s, c };
}

interface Job {
  file: LibFileLike;
  gen: number;
}

let generation = 0;
const queue: Job[] = [];
let draining = false;
/** Paths already rendered or in flight this session — never render twice. */
const done = new Set<string>();

type Listener = (id: number, key: string) => void;
const listeners = new Set<Listener>();
export function onModelThumb(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Progress ────────────────────────────────────────────────────────────────
// How many thumbnails are still to render (queued + the one in flight). Model
// renders are single-threaded and slow, so surfacing "N left" is the difference
// between "the app froze" and "it's working through the folder".
type ProgressListener = (remaining: number) => void;
const progressListeners = new Set<ProgressListener>();
let activeJob = false;
export function onModelThumbProgress(fn: ProgressListener): () => void {
  progressListeners.add(fn);
  fn(remaining()); // hand the newcomer the current count immediately
  return () => progressListeners.delete(fn);
}
function remaining(): number {
  return queue.length + (activeJob ? 1 : 0);
}
function emitProgress(): void {
  const n = remaining();
  for (const fn of progressListeners) fn(n);
}

// ── Off-main rendering ────────────────────────────────────────────────────
// The parse + render happen in a Web Worker on an OffscreenCanvas so the grid
// doesn't jank. The worker returns raw pixels; storing them (Tauri invoke) and
// resolving the manual atlas (the store) stay here on the main thread. Any
// worker failure falls back to renderMain — a thumbnail must never go blank.

interface WorkerResult {
  w: number;
  h: number;
  buf: ArrayBuffer;
}
let worker: Worker | null = null;
let workerBroken = false;
let msgSeq = 0;
let pending: { id: number; resolve: (r: WorkerResult | null) => void; timer: number } | null = null;

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL("./modelThumbWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; id: number; w?: number; h?: number; buf?: ArrayBuffer };
      if (pending === null || pending.id !== m.id) return;
      clearTimeout(pending.timer);
      const p = pending;
      pending = null;
      if (m.type === "done" && m.buf !== undefined) p.resolve({ w: m.w!, h: m.h!, buf: m.buf });
      else p.resolve(null); // worker-reported error → fall back to main thread
    };
    worker.onerror = () => {
      // The worker itself died (bad chunk, no OffscreenCanvas/WebGL). Give up on
      // it entirely and let every job render on the main thread instead.
      workerBroken = true;
      if (pending !== null) {
        clearTimeout(pending.timer);
        pending.resolve(null);
        pending = null;
      }
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

/** The user's chosen atlas for this model's pack, resolved to a model:// URL. */
function resolveAtlas(modelPath: string): { url: string; flipY: boolean } | null {
  const m = atlasFor(modelPath);
  return m === undefined ? null : { url: modelUrl(m.path), flipY: m.flipY };
}

/** Render `file` in the worker; resolves null (→ main-thread fallback) if the
 *  worker is unavailable, errors, or hangs. */
function renderViaWorker(file: LibFileLike): Promise<WorkerResult | null> {
  const wk = ensureWorker();
  if (wk === null) return Promise.resolve(null);
  const id = ++msgSeq;
  return new Promise<WorkerResult | null>((resolve) => {
    const timer = self.setTimeout(() => {
      if (pending?.id === id) {
        pending = null;
        resolve(null); // a wedged parse must not stall the whole queue
      }
    }, 20000);
    pending = { id, resolve, timer };
    wk.postMessage({ id, path: file.path, atlas: resolveAtlas(file.path) });
  });
}

/**
 * Queue thumbnails for the currently visible models, superseding any earlier
 * request: the queue is rebuilt to exactly the current window, so a fast scroll
 * drops the fly-over rows before they ever start. The drain then works the
 * window front-to-back (top-left downward).
 */
export function requestModelThumbs(files: readonly LibFileLike[]): void {
  generation++;
  queue.length = 0;
  for (const f of files) {
    if (done.has(f.path)) continue;
    queue.push({ file: f, gen: generation });
  }
  emitProgress();
  if (!draining) void drain();
}

export function resetModelThumbs(): void {
  generation++;
  queue.length = 0;
  done.clear();
  activeJob = false;
  emitProgress();
}

async function drain(): Promise<void> {
  draining = true;
  try {
    for (;;) {
      // FIFO: the queue only ever holds the current visible window
      // (requestModelThumbs clears it on each range change), so taking from the
      // front fills previews in top-left → down, the order the eye scans — not
      // bottom-up.
      const job = queue.shift();
      if (job === undefined) {
        emitProgress(); // drained to empty → count is 0
        return;
      }
      if (job.gen !== generation) continue; // stale before it started
      if (done.has(job.file.path)) continue;
      done.add(job.file.path);
      activeJob = true;
      emitProgress();

      try {
        // Worker first (off-main). On any worker miss, render on this thread so
        // the thumbnail still appears — never a regression, only a speedup.
        const r = await renderViaWorker(job.file);
        let key: string | null;
        if (r !== null) {
          key = await invoke<string>("model_thumb_store", {
            path: job.file.path,
            width: r.w,
            height: r.h,
            rgba: Array.from(new Uint8Array(r.buf)),
          });
        } else {
          key = await renderMain(job.file);
        }
        if (key !== null) for (const fn of listeners) fn(job.file.id, key);
      } catch (err) {
        // A model we cannot load keeps its icon. Expected for .blend and
        // FBX 6100; not worth a user-facing error per cell.
        console.debug("[model-thumb]", job.file.name, err);
      }
      activeJob = false;
      emitProgress();
      // Yield so a 400 ms parse chain never starves input.
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    draining = false;
  }
}

/** Main-thread render — the fallback when the worker can't handle a model. */
async function renderMain(file: LibFileLike): Promise<string | null> {
  const ctx = ensure();
  if (ctx === null) return null;
  const { r, s, c } = ctx;

  const { root } = await loadModel(file.path);
  // Same rescue as the inspector — otherwise the grid shows black FBX and
  // white OBJ while the detail view shows them textured, which reads as a bug.
  try {
    await rescueTextures(root, file.path);
  } catch {
    /* untextured is still a usable thumbnail */
  }
  s.add(root);
  try {
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty() || !Number.isFinite(box.min.x)) return null;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    if (sphere.radius <= 0 || !Number.isFinite(sphere.radius)) return null;

    const dist = (sphere.radius / Math.sin((45 / 2) * (Math.PI / 180))) * 1.35;
    c.position.set(
      sphere.center.x + dist * Math.cos(EL) * Math.sin(AZ),
      sphere.center.y + dist * Math.sin(EL),
      sphere.center.z + dist * Math.cos(EL) * Math.cos(AZ),
    );
    c.lookAt(sphere.center);
    // Near/far from the framing distance, or a 0.01-unit prop and a
    // 59,000-unit skybox both z-fight into mush.
    c.near = Math.max(0.001, dist / 1000);
    c.far = dist * 100;
    c.updateProjectionMatrix();

    r.render(s, c);
    // Read the rendered pixels back as RGBA and store them raw — same no-PNG
    // path as textures. readRenderTargetPixels isn't needed; the 2D context of
    // a copy canvas gives us straight RGBA via getImageData.
    const w = r.domElement.width;
    const h = r.domElement.height;
    const copy = document.createElement("canvas");
    copy.width = w;
    copy.height = h;
    const ctx = copy.getContext("2d");
    if (ctx === null) return null;
    ctx.drawImage(r.domElement, 0, 0);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    return await invoke<string>("model_thumb_store", {
      path: file.path,
      width: w,
      height: h,
      rgba: Array.from(rgba),
    });
  } finally {
    // Dispose on EVERY model, not just unmount — 500 undisposed Synty scenes
    // is how you reach multi-GB.
    s.remove(root);
    disposeModel(root);
    r.renderLists.dispose();
  }
}

/** Cached keys for `files`, straight from the Rust disk cache. */
export async function lookupModelThumbs(
  files: readonly LibFileLike[],
): Promise<[number, string][]> {
  if (files.length === 0) return [];
  const items = files.map((f) => [f.id, f.path] as [number, string]);
  const hits = await invoke<[number, string][]>("model_thumb_lookup", { items });
  const byId = new Map(hits);
  // A disk hit counts as done — never re-render what we already have.
  for (const f of files) if (byId.has(f.id)) done.add(f.path);
  return hits;
}
