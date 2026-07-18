/// <reference lib="webworker" />
/**
 * Model-thumbnail renderer, fully off the main thread.
 *
 * A pool of these renders models in parallel: parse + render + pixel readback
 * all happen here, and only the finished RGBA bytes cross back to the main
 * thread (which just hands them to the Rust RAM cache). The FBX/glTF parse is
 * 100-400 ms of single-threaded JS — the real bottleneck — and N worker threads
 * divide it across cores.
 *
 * THE READBACK MUST BE ASYNC. A worker OffscreenCanvas's SYNCHRONOUS pixel pull
 * (gl.readPixels, drawImage→getImageData, transferToImageBitmap) HANGS FOREVER
 * in the release WebView2 GPU process — the worker blocks on the GPU while the
 * GPU process needs the worker to service a message, a self-deadlock. So we
 * render into a WebGLRenderTarget and read it with
 * `readRenderTargetPixelsAsync`, which copies into a PBO and polls a fenceSync
 * with setTimeout between checks — pumping the worker message loop, so no
 * deadlock. Confirmed working (~6 ms/read) in release WebView2 150.
 *
 * Two other worker constraints (no DOM):
 *  - three's ImageLoader uses `Image`, absent here — reroute to fetch +
 *    createImageBitmap.
 *  - a GL context can't UNPACK_FLIP_Y an ImageBitmap, so a texture's flipY is
 *    baked into the bitmap (glTF wants false, FBX/OBJ want true).
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
let target: THREE.WebGLRenderTarget | null = null;

function ensure(): {
  r: THREE.WebGLRenderer;
  s: THREE.Scene;
  c: THREE.PerspectiveCamera;
  rt: THREE.WebGLRenderTarget;
} | null {
  if (renderer !== null && scene !== null && camera !== null && target !== null) {
    return { r: renderer, s: scene, c: camera, rt: target };
  }
  const canvas = new OffscreenCanvas(EDGE, EDGE);
  let r: THREE.WebGLRenderer;
  try {
    r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    return null; // no WebGL in this worker — caller falls back to main thread
  }
  r.setSize(EDGE, EDGE, false);
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;

  // Render into an sRGB target so the read-back bytes match the main-thread
  // canvas path (tone mapping + sRGB encoding). Plain (non-MSAA) target — the
  // async readback is proven on a plain target; MSAA needs a resolve step.
  const rt = new THREE.WebGLRenderTarget(EDGE, EDGE);
  rt.texture.colorSpace = THREE.SRGBColorSpace;

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
  target = rt;
  return { r, s, c, rt };
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
 * bitmap when the user asked for flipY) since we load it ourselves.
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
  const { r, s, c, rt } = ctx;

  const { root } = await loadModel(msg.path);
  await normalizeFlip(root);
  if (msg.atlas !== null) {
    try {
      await applyAtlas(root, msg.atlas);
    } catch {
      /* untextured is still a usable thumbnail */
    }
  }
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

    // Render into the target, then read it back ASYNCHRONOUSLY (the sync paths
    // hang in a worker — see the file header).
    r.setRenderTarget(rt);
    r.render(s, c);
    const raw = new Uint8Array(EDGE * EDGE * 4);
    await r.readRenderTargetPixelsAsync(rt, 0, 0, EDGE, EDGE, raw);
    r.setRenderTarget(null);

    // readRenderTargetPixels returns rows bottom-to-top; the store (and the grid
    // <img>) expect top-down, so flip vertically.
    const out = new Uint8Array(EDGE * EDGE * 4);
    const stride = EDGE * 4;
    for (let y = 0; y < EDGE; y++) {
      out.set(raw.subarray(y * stride, y * stride + stride), (EDGE - 1 - y) * stride);
    }
    return { w: EDGE, h: EDGE, buf: out.buffer };
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
