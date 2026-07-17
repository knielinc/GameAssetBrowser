import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { invoke } from "@tauri-apps/api/core";
import { loadModel } from "./loadModel";
import { disposeModel } from "./dispose";
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

/**
 * Queue thumbnails for the currently visible models, superseding any earlier
 * request. LIFO drain: during a fast scroll the cells under the cursor win and
 * the fly-over rows are dropped before they ever start.
 */
export function requestModelThumbs(files: readonly LibFileLike[]): void {
  generation++;
  queue.length = 0;
  for (const f of files) {
    if (done.has(f.path)) continue;
    queue.push({ file: f, gen: generation });
  }
  if (!draining) void drain();
}

export function resetModelThumbs(): void {
  generation++;
  queue.length = 0;
  done.clear();
}

async function drain(): Promise<void> {
  draining = true;
  try {
    for (;;) {
      const job = queue.pop(); // LIFO
      if (job === undefined) return;
      if (job.gen !== generation) continue; // stale before it started
      if (done.has(job.file.path)) continue;
      done.add(job.file.path);

      try {
        const key = await render(job.file);
        if (key !== null) for (const fn of listeners) fn(job.file.id, key);
      } catch (err) {
        // A model we cannot load keeps its icon. Expected for .blend and
        // FBX 6100; not worth a user-facing error per cell.
        console.debug("[model-thumb]", job.file.name, err);
      }
      // Yield so a 400 ms parse chain never starves input.
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    draining = false;
  }
}

async function render(file: LibFileLike): Promise<string | null> {
  const ctx = ensure();
  if (ctx === null) return null;
  const { r, s, c } = ctx;

  const { root } = await loadModel(file.path);
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
    const blob = await new Promise<Blob | null>((res) => r.domElement.toBlob(res, "image/png"));
    if (blob === null) return null;
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    return await invoke<string>("model_thumb_store", { path: file.path, bytes });
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
