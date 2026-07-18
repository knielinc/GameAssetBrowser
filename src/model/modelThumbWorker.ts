/// <reference lib="webworker" />
/**
 * Model-thumbnail renderer, off the main thread.
 *
 * The expensive part of a model thumbnail is the loader parse (a Synty FBX is
 * 100-400 ms of single-threaded JS) plus the GPU render. Doing it on the main
 * thread janks the grid. Here it runs in a Web Worker on an OffscreenCanvas, so
 * scrolling stays smooth while thumbnails fill in.
 *
 * Two things a worker forces (there is no DOM):
 *  - three's ImageLoader uses `Image`, which doesn't exist here — so all image
 *    loading is rerouted through fetch + createImageBitmap.
 *  - a GL context cannot UNPACK_FLIP_Y an ImageBitmap, so a texture's flipY is
 *    baked into the bitmap instead (glTF wants false, FBX/OBJ want true).
 *
 * The worker cannot call Tauri `invoke`, so it only produces pixels; the main
 * thread stores them. It also cannot read the atlas store, so the caller passes
 * the resolved manual atlas in with each job. Any failure here is reported so
 * the caller can fall back to a main-thread render — this must never regress a
 * thumbnail to blank.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { loadModel } from "./loadModel";
import { disposeModel } from "./dispose";

const EDGE = 256;
const AZ = 0.61; // ~35°, matches the main-thread renderer and the inspector
const EL = 0.44; // ~25°

interface AtlasChoice {
  url: string;
  flipY: boolean;
}
interface RenderMsg {
  id: number;
  path: string;
  /** Resolved on the main thread from the atlas store, if the user picked one. */
  atlas: AtlasChoice | null;
}

// Reroute three's image loading: no `Image` in a worker. createImageBitmap
// keeps the loaders (GLTF/FBX/OBJ/...) working for embedded & sibling textures.
(THREE.ImageLoader.prototype as unknown as { load: unknown }).load = function (
  this: THREE.ImageLoader,
  url: string,
  onLoad?: (b: ImageBitmap) => void,
  _onProgress?: unknown,
  onError?: (e: unknown) => void,
): object {
  fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.blob();
    })
    .then((b) => createImageBitmap(b))
    .then((bmp) => onLoad?.(bmp))
    .catch((e) => onError?.(e));
  return {};
};

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let readback: OffscreenCanvas | null = null;

function ensure(): { r: THREE.WebGLRenderer; s: THREE.Scene; c: THREE.PerspectiveCamera } | null {
  if (renderer !== null && scene !== null && camera !== null) {
    return { r: renderer, s: scene, c: camera };
  }
  const canvas = new OffscreenCanvas(EDGE, EDGE);
  let r: THREE.WebGLRenderer;
  try {
    r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return null; // no WebGL in this worker — caller falls back to main thread
  }
  r.setSize(EDGE, EDGE, false);
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;

  const s = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(r);
  s.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-4, 6, 5);
  s.add(key);
  s.add(new THREE.HemisphereLight(0x9fb4ff, 0x33302c, 1.2));

  const c = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
  renderer = r;
  scene = s;
  camera = c;
  readback = new OffscreenCanvas(EDGE, EDGE);
  return { r, s, c };
}

/** Every texture map three might set, so flip normalization catches them all. */
const TEX_KEYS = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "alphaMap"] as const;

/**
 * Bake each texture's flipY into its bitmap and clear the flag, because a GL
 * context can't flip an ImageBitmap at upload. glTF textures come in flipY=false
 * (leave them); FBX/OBJ come in flipY=true (flip the bitmap once). Result: every
 * texture is upright regardless of the source format's convention.
 */
async function normalizeFlip(root: THREE.Object3D): Promise<void> {
  const jobs: Promise<void>[] = [];
  const seen = new Set<THREE.Texture>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if ((mesh as unknown as { isMesh?: boolean }).isMesh !== true) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      const rec = mat as unknown as Record<string, THREE.Texture | undefined>;
      for (const k of TEX_KEYS) {
        const t = rec[k];
        if (t == null || seen.has(t)) continue;
        seen.add(t);
        if (t.flipY && t.image instanceof ImageBitmap) {
          const src = t.image;
          jobs.push(
            createImageBitmap(src, { imageOrientation: "flipY" }).then((flipped) => {
              t.image = flipped;
              t.flipY = false;
              t.needsUpdate = true;
            }),
          );
        }
      }
    }
  });
  await Promise.all(jobs);
}

function isBroken(t: THREE.Texture | null | undefined): boolean {
  if (t == null) return true;
  const img = t.image as { width?: number; height?: number } | null | undefined;
  return img == null || (img.width ?? 0) === 0 || (img.height ?? 0) === 0;
}

/** Neutral grey for an untextured slot — matches STL/PLY defaults and the
 *  main-thread rescue, so every untextured model reads the same tone. */
const NEUTRAL = 0x9a9aae;

/**
 * Normalize any still-broken base-color slot to a plain neutral surface. This
 * is what keeps FBX thumbnails from rendering black: FBXLoader leaves a Texture
 * whose declared image 404'd AND a dark baked diffuse, so the mesh samples an
 * empty map (black). Clearing the dead map and resetting the colour makes an
 * untextured FBX render the same grey an untextured OBJ already does. Runs after
 * the atlas step, so a slot that got a real texture (isBroken=false) is skipped.
 */
function neutralize(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if ((mesh as unknown as { isMesh?: boolean }).isMesh !== true) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      const s = mat as THREE.MeshStandardMaterial;
      if (!isBroken(s.map)) continue;
      if (s.map != null) {
        s.map.dispose();
        s.map = null;
      }
      if (s.color !== undefined) s.color.set(NEUTRAL);
      s.needsUpdate = true;
    }
  });
}

/**
 * Worker-local texture rescue: fill broken base-color slots with the caller's
 * chosen atlas. The atlas orientation is handled here directly (pre-flip the
 * bitmap when the user asked for flipY) since we load it ourselves. No hints /
 * candidates — those are a main-thread picker concern, irrelevant to rendering.
 */
async function applyAtlas(root: THREE.Object3D, atlas: AtlasChoice): Promise<void> {
  const broken: THREE.MeshStandardMaterial[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if ((mesh as unknown as { isMesh?: boolean }).isMesh !== true) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      const s = mat as THREE.MeshStandardMaterial;
      if (isBroken(s.map)) broken.push(s);
    }
  });
  if (broken.length === 0) return;

  const res = await fetch(atlas.url);
  if (!res.ok) return;
  const bmp = await createImageBitmap(await res.blob(), atlas.flipY ? { imageOrientation: "flipY" } : {});
  const tex = new THREE.Texture(bmp as unknown as HTMLImageElement);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false; // orientation already baked into the bitmap
  tex.needsUpdate = true;
  for (const m of broken) {
    if (m.map != null && m.map !== tex) m.map.dispose();
    m.map = tex;
    if (m.color !== undefined) m.color.set(0xffffff);
    m.needsUpdate = true;
  }
}

async function renderOne(msg: RenderMsg): Promise<{ w: number; h: number; buf: ArrayBuffer }> {
  const ctx = ensure();
  if (ctx === null) throw new Error("no-webgl");
  const { r, s, c } = ctx;

  const { root } = await loadModel(msg.path);
  await normalizeFlip(root);
  if (msg.atlas !== null) {
    try {
      await applyAtlas(root, msg.atlas);
    } catch {
      /* untextured is still a usable thumbnail */
    }
  }
  // Anything still lacking a working base-color map (untextured FBX/OBJ, or an
  // atlas that failed to load) becomes neutral grey rather than sampling an
  // empty map as black.
  neutralize(root);
  s.add(root);
  try {
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty() || !Number.isFinite(box.min.x)) throw new Error("empty-bounds");
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    if (sphere.radius <= 0 || !Number.isFinite(sphere.radius)) throw new Error("bad-bounds");

    const dist = (sphere.radius / Math.sin((45 / 2) * (Math.PI / 180))) * 1.35;
    c.position.set(
      sphere.center.x + dist * Math.cos(EL) * Math.sin(AZ),
      sphere.center.y + dist * Math.sin(EL),
      sphere.center.z + dist * Math.cos(EL) * Math.cos(AZ),
    );
    c.lookAt(sphere.center);
    c.near = Math.max(0.001, dist / 1000);
    c.far = dist * 100;
    c.updateProjectionMatrix();

    r.render(s, c);
    // Read the rendered pixels back as RGBA via a 2D OffscreenCanvas — same
    // shape as the main-thread path, worker-safe.
    const w = r.domElement.width;
    const h = r.domElement.height;
    const rb = readback!;
    if (rb.width !== w || rb.height !== h) {
      rb.width = w;
      rb.height = h;
    }
    const g = rb.getContext("2d");
    if (g === null) throw new Error("no-2d");
    g.clearRect(0, 0, w, h);
    g.drawImage(r.domElement, 0, 0);
    const data = g.getImageData(0, 0, w, h).data;
    // Transfer the buffer to the main thread (zero-copy).
    const out = new Uint8Array(data).buffer;
    return { w, h, buf: out };
  } finally {
    s.remove(root);
    disposeModel(root);
    r.renderLists.dispose();
  }
}

self.onmessage = (e: MessageEvent<RenderMsg>): void => {
  const msg = e.data;
  void (async () => {
    try {
      const { w, h, buf } = await renderOne(msg);
      (self as unknown as Worker).postMessage({ type: "done", id: msg.id, path: msg.path, w, h, buf }, [buf]);
    } catch (err) {
      (self as unknown as Worker).postMessage({ type: "error", id: msg.id, path: msg.path, message: String(err) });
    }
  })();
};
