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
/** Jobs currently rendering across the whole worker pool (0..POOL_SIZE). */
let activeCount = 0;
export function onModelThumbProgress(fn: ProgressListener): () => void {
  progressListeners.add(fn);
  fn(remaining()); // hand the newcomer the current count immediately
  return () => progressListeners.delete(fn);
}
function remaining(): number {
  return queue.length + activeCount;
}
function emitProgress(): void {
  const n = remaining();
  for (const fn of progressListeners) fn(n);
}

// ── Off-main rendering (worker POOL) ────────────────────────────────────────
// Parse + render run in Web Workers on OffscreenCanvases so the grid never
// janks — and there is a POOL of them. Each Worker is a real OS thread, so N
// workers parse+render N models genuinely in parallel; the FBX/glTF parse
// (100-400 ms of single-threaded JS) is the bottleneck, and threads are exactly
// what divides it. Storing the pixels (Tauri invoke) and resolving the atlas
// stay on the main thread. Any worker miss falls back to renderMain — a
// thumbnail must never go blank.

interface WorkerResult {
  w: number;
  h: number;
  buf: ArrayBuffer;
}

/** The bottleneck is the loader PARSE (100-400 ms of single-threaded JS per
 *  FBX), and each worker is a real OS thread, so throughput scales with worker
 *  count up to the core count. The limit is the WebGL context each worker holds:
 *  a ~16-context budget shared with the model viewport (1) and the texture grid
 *  (1). Cap at 8 — even at 8 that's 10 contexts, comfortably under the budget —
 *  and leave one core for the main thread. The render itself is a few ms at
 *  256px, so GPU contention between workers is not the ceiling; CPU cores are. */
const POOL_SIZE = Math.max(1, Math.min(8, (navigator.hardwareConcurrency ?? 4) - 1));

interface Slot {
  worker: Worker;
  /** Monotonic id of the job on this slot; a reply with a stale id is ignored. */
  seq: number;
  resolve: ((r: WorkerResult | null) => void) | null;
  timer: number | undefined;
  /** Retired after a crash or a wedged parse — its jobs go to the main thread. */
  dead: boolean;
}

let pool: Slot[] | null = null;
let poolBroken = false;

function makeSlot(): Slot {
  const worker = new Worker(new URL("./modelThumbWorker.ts", import.meta.url), { type: "module" });
  const slot: Slot = { worker, seq: 0, resolve: null, timer: undefined, dead: false };
  const settle = (r: WorkerResult | null): void => {
    if (slot.resolve === null) return;
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    const res = slot.resolve;
    slot.resolve = null;
    slot.timer = undefined;
    res(r);
  };
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { type: string; id: number; w?: number; h?: number; buf?: ArrayBuffer };
    if (m.id !== slot.seq) return; // a late reply after this slot's timeout
    settle(m.type === "done" && m.buf !== undefined ? { w: m.w!, h: m.h!, buf: m.buf } : null);
  };
  worker.onerror = () => {
    // This worker died (bad chunk, no OffscreenCanvas/WebGL). Retire it; its
    // in-flight job and everything after render on the main thread instead.
    slot.dead = true;
    settle(null);
  };
  return slot;
}

function getPool(): Slot[] | null {
  if (poolBroken) return null;
  if (pool !== null) return pool;
  try {
    pool = Array.from({ length: POOL_SIZE }, makeSlot);
    return pool;
  } catch {
    poolBroken = true; // no Worker/OffscreenCanvas — everything falls to main
    return null;
  }
}

/** The user's chosen atlas for this model's pack, resolved to a model:// URL. */
function resolveAtlas(modelPath: string): { url: string; flipY: boolean } | null {
  const m = atlasFor(modelPath);
  return m === undefined ? null : { url: modelUrl(m.path), flipY: m.flipY };
}

/** Render `file` on `slot`; resolves null (→ main-thread fallback) if the slot
 *  is dead, errors, or hangs. A timeout also retires the slot: the worker is
 *  wedged on that parse, so reusing it would overlap two renders in one GL
 *  context. */
function renderInSlot(slot: Slot, file: LibFileLike): Promise<WorkerResult | null> {
  if (slot.dead) return Promise.resolve(null);
  const id = ++slot.seq;
  return new Promise<WorkerResult | null>((resolve) => {
    slot.resolve = resolve;
    slot.timer = self.setTimeout(() => {
      if (slot.seq === id && slot.resolve !== null) {
        slot.dead = true;
        const res = slot.resolve;
        slot.resolve = null;
        res(null);
      }
    }, 20000);
    slot.worker.postMessage({ id, path: file.path, atlas: resolveAtlas(file.path) });
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
  activeCount = 0;
  emitProgress();
}

async function drain(): Promise<void> {
  draining = true;
  try {
    for (;;) {
      const slots = getPool();
      // One pump per worker slot, all sharing the queue, so the visible window
      // renders on every thread at once. No pool (no Worker/OffscreenCanvas) →
      // a single main-thread pump.
      if (slots === null) await pump(null);
      else await Promise.all(slots.map((slot) => pump(slot)));
      // A request that landed as the pumps were finishing left work behind —
      // go round again rather than stall until the next scroll.
      if (queue.length === 0) break;
    }
  } finally {
    draining = false;
    emitProgress();
  }
}

/**
 * Pull jobs off the shared queue until it is empty, rendering each on `slot`
 * (or the main thread when `slot` is null/dead). Many pumps run concurrently —
 * one per worker — which is what parallelizes the window.
 *
 * FIFO (`shift`): the queue only ever holds the current visible window
 * (requestModelThumbs clears it on each range change), so front-first fills
 * previews top-left → down, the order the eye scans.
 */
async function pump(slot: Slot | null): Promise<void> {
  for (;;) {
    const job = queue.shift();
    if (job === undefined) return;
    if (job.gen !== generation) continue; // stale before it started
    if (done.has(job.file.path)) continue;
    done.add(job.file.path);
    activeCount++;
    emitProgress();

    try {
      // Worker first (off-main). On any miss, render on this thread so the
      // thumbnail still appears — never a regression, only a speedup.
      const r = slot !== null && !slot.dead ? await renderInSlot(slot, job.file) : null;
      const key =
        r !== null
          ? await storePixels(job.file.path, r.w, r.h, new Uint8Array(r.buf))
          : await renderMainExclusive(job.file);
      if (key !== null) for (const fn of listeners) fn(job.file.id, key);
    } catch (err) {
      // A model we cannot load keeps its icon. Expected for .blend and
      // FBX 6100; not worth a user-facing error per cell.
      console.debug("[model-thumb]", job.file.name, err);
    } finally {
      activeCount--;
      emitProgress();
    }
    // Yield so a burst of completions never starves input handling.
    await new Promise((res) => setTimeout(res, 0));
  }
}

/**
 * Hand raw RGBA to the Rust RAM cache as ONE raw octet-stream body.
 *
 * The whole payload must be a single ArrayBuffer/typed array for Tauri to send
 * it as raw bytes — a nested `Uint8Array` in a `{...}` args object is JSON'd
 * back into a ~262k-element number array (~1 MB of text) on the main thread per
 * thumbnail, which is the serialization cost we're eliminating. So pack it:
 * `[u32 width][u32 height][u32 pathLen][path utf8][rgba]` (little-endian), which
 * `model_thumb_store` unpacks on the Rust side.
 */
function storePixels(path: string, width: number, height: number, rgba: Uint8Array): Promise<string> {
  const pathBytes = new TextEncoder().encode(path);
  const out = new Uint8Array(12 + pathBytes.length + rgba.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, pathBytes.length, true);
  out.set(pathBytes, 12);
  out.set(rgba, 12 + pathBytes.length);
  return invoke<string>("model_thumb_store", out);
}

// The main-thread renderer is a SINGLE shared scene/context, so its jobs must
// never overlap — with a worker pool several pumps can hit the fallback at once
// (many unsupported models, or the whole pool dying). Chain them so only one
// runs at a time; the workers stay fully parallel, only this fallback is
// serialized.
let mainChain: Promise<unknown> = Promise.resolve();
function renderMainExclusive(file: LibFileLike): Promise<string | null> {
  const result = mainChain.then(() => renderMain(file));
  mainChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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
    return await storePixels(file.path, w, h, new Uint8Array(rgba.buffer));
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
