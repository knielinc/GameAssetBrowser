import type { AnimationClip, Group, Object3D } from "three";
import { schemeBase } from "../platform";

/**
 * Local model files, loaded into the webview over our own `model://` scheme.
 *
 * WHY NOT convertFileSrc: it percent-encodes the whole path into ONE URL
 * segment (`http://asset.localhost/C%3A%5CPack%5Cm.gltf`). three.js derives a
 * loader's base URL by slicing to the last `/`, which would yield
 * `http://asset.localhost/` — so every sibling texture and .bin chunk resolves
 * to garbage. OBJ+MTL and glTF would load silently untextured, with no error.
 *
 * Our scheme lets us choose the shape: `.../model.localhost/C:/Pack/m.gltf` is
 * slash-separated, so three's relative join works untouched, and the webview
 * normalizes `../` for us. No vfs prefix, no setURLModifier. The scheme BASE
 * differs per platform (http://model.localhost on Windows, model://localhost
 * elsewhere — see schemeBase).
 */
function schemePath(path: string): string {
  // "\" → "/" (Windows paths), then strip a leading "/" so `base + "/" + path`
  // never double-slashes: Unix absolute paths start with "/", and the Rust
  // handler re-adds that root. encodeURI (not encodeURIComponent) leaves "/"
  // and ":" literal, which is exactly what keeps the path multi-segment.
  return encodeURI(path.replace(/\\/g, "/").replace(/^\//, ""));
}

export function modelUrl(path: string): string {
  return `${schemeBase("model")}/${schemePath(path)}`;
}

/** Full-resolution preview of a texture the browser can't decode (HDR/EXR/DDS/
 *  TGA/RAW/…), decoded + tone-mapped to a PNG in Rust. Same URL shape as
 *  modelUrl; browser-decodable formats should use modelUrl (native res, no
 *  re-encode).
 *
 *  `tm`/`ev` pick the tone-mapper + exposure for float sources (HDR/EXR/RAW);
 *  the query is part of the Rust preview cache key, so changing them re-fetches
 *  a freshly tone-mapped PNG. Omitted (or ev 0) => the default (ACES, 0 EV),
 *  and the query is left off so LDR previews keep a stable, cacheable URL. */
export function previewUrl(path: string, tm?: string, ev?: number): string {
  const base = `${schemeBase("preview")}/${schemePath(path)}`;
  const q: string[] = [];
  if (tm !== undefined && tm !== "aces") q.push(`tm=${tm}`);
  if (ev !== undefined && ev !== 0) q.push(`ev=${ev}`);
  return q.length > 0 ? `${base}?${q.join("&")}` : base;
}

/** Formats the browser decodes natively — served as the ORIGINAL file at full
 *  resolution rather than round-tripped through Rust. */
export const BROWSER_DECODABLE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

/** Float, wider-than-display sources the tone-mapper actually shapes: HDR and
 *  EXR. Camera RAW is deliberately NOT here — its preview is the camera's own
 *  embedded JPEG (already display-referred sRGB, and the manufacturer's tone
 *  rendering is the best default), so a tone-map operator would be a no-op and
 *  the control is hidden for it. Everything else is likewise already sRGB. */
export const FLOAT_PREVIEW_EXTENSIONS = new Set<string>(["hdr", "exr"]);

export function isFloatPreview(ext: string | undefined): boolean {
  return ext !== undefined && FLOAT_PREVIEW_EXTENSIONS.has(ext.toLowerCase());
}

/** Best source-quality URL for a texture: the original for browser-decodable
 *  formats, a Rust-decoded full-res PNG otherwise. `tm`/`ev` tone-map float
 *  sources (ignored by the native path — those are already sRGB). */
export function sourceUrl(path: string, ext: string, tm?: string, ev?: number): string {
  return BROWSER_DECODABLE.has(ext.toLowerCase()) ? modelUrl(path) : previewUrl(path, tm, ev);
}

export interface LoadedModel {
  root: Object3D;
  /** Loader-reported animation clips — FBX/glTF carry them, the rest are
   *  static formats and return an empty list. Typed so the viewport can feed
   *  an AnimationMixer without casts. */
  animations: AnimationClip[];
}

/**
 * Load by extension, importing each loader lazily so a user who only opens
 * GLBs never parses FBXLoader. Vite emits one chunk per dynamic import.
 */
export async function loadModel(path: string): Promise<LoadedModel> {
  const url = modelUrl(path);
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();

  switch (ext) {
    case "gltf":
    case "glb": {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const gltf = await new GLTFLoader().loadAsync(url);
      return { root: gltf.scene, animations: gltf.animations };
    }
    case "fbx": {
      const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
      const g: Group = await new FBXLoader().loadAsync(url);
      return { root: g, animations: g.animations };
    }
    case "obj": {
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      // MTL is resolved by the OBJ's own relative reference through the same
      // scheme — this is the case that proves sibling resolution works.
      const g = await new OBJLoader().loadAsync(url);
      return { root: g, animations: [] };
    }
    case "stl": {
      const [{ STLLoader }, THREE] = await Promise.all([
        import("three/examples/jsm/loaders/STLLoader.js"),
        import("three"),
      ]);
      const geo = await new STLLoader().loadAsync(url);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9a9aae }));
      return { root: mesh, animations: [] };
    }
    case "ply": {
      const [{ PLYLoader }, THREE] = await Promise.all([
        import("three/examples/jsm/loaders/PLYLoader.js"),
        import("three"),
      ]);
      const geo = await new PLYLoader().loadAsync(url);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: 0x9a9aae, vertexColors: geo.hasAttribute("color") }),
      );
      return { root: mesh, animations: [] };
    }
    case "dae": {
      const { ColladaLoader } = await import("three/examples/jsm/loaders/ColladaLoader.js");
      const c = await new ColladaLoader().loadAsync(url);
      return { root: c.scene, animations: [] };
    }
    default:
      throw new Error(`No loader for .${ext}`);
  }
}

export interface ModelStats {
  triangles: number;
  vertices: number;
  meshes: number;
  materials: number;
  /** Bounding box size in source units. */
  size: [number, number, number];
  /** Textures the loader declared but could not resolve. */
  missingTextures: number;
}

export function analyze(root: Object3D): ModelStats {
  let triangles = 0;
  let vertices = 0;
  let meshes = 0;
  const materials = new Set<unknown>();

  root.traverse((o) => {
    const mesh = o as unknown as {
      isMesh?: boolean;
      geometry?: { index?: { count: number } | null; attributes?: { position?: { count: number } } };
      material?: unknown;
    };
    if (mesh.isMesh !== true || mesh.geometry === undefined) return;
    meshes++;
    const pos = mesh.geometry.attributes?.position;
    if (pos !== undefined) vertices += pos.count;
    const idx = mesh.geometry.index;
    triangles += idx != null ? idx.count / 3 : (pos?.count ?? 0) / 3;
    if (Array.isArray(mesh.material)) {
      for (const m of mesh.material) materials.add(m);
    } else if (mesh.material !== undefined) {
      materials.add(mesh.material);
    }
  });

  return {
    triangles: Math.round(triangles),
    vertices,
    meshes,
    materials: materials.size,
    size: [0, 0, 0],
    missingTextures: 0,
  };
}
