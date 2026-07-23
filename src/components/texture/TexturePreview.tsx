import { useEffect, useRef, useState, type ReactElement } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { isFloatPreview, sourceUrl } from "../../model/loadModel";
import { gradientBackground } from "../../model/gradientBg";
import { useTonemapPrefs, type TonemapId } from "../../stores/tonemapPrefs";
import { applyParallax } from "./parallax";

/** Tone-map id → the matching three.js constant. Kept exactly parallel to the
 *  Rust `Tonemap` ports (tonemap.rs) so the lit 3D surface and the HDRI
 *  environment tone-map identically to the Rust-decoded 2D preview. */
const THREE_TONE_MAPPING: Record<TonemapId, THREE.ToneMapping> = {
  linear: THREE.LinearToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
};

/** Shared 1×1 white — the parallax shader keys off a base-color map, so a
 *  material with no albedo needs one to exist. */
let _white: THREE.DataTexture | null = null;
function whiteTex(): THREE.DataTexture {
  if (_white === null) {
    _white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    _white.colorSpace = THREE.SRGBColorSpace;
    _white.needsUpdate = true;
  }
  return _white;
}

export type MeshMode = "flat" | "plane" | "sphere" | "cube" | "env";
export type LightMode = "studio" | "sun" | "rim" | "soft" | "unlit";

/** Channel isolation: view one channel of the image as grayscale. "rgb" =
 *  untouched. Alpha renders opaque (the alpha VALUE as brightness). Offered in
 *  flat and plane modes only — the modes where you inspect the image itself. */
export type IsoChannel = "rgb" | "r" | "g" | "b" | "a";
export const ISO_CHANNELS: { id: IsoChannel; label: string }[] = [
  { id: "rgb", label: "RGB" },
  { id: "r", label: "R" },
  { id: "g", label: "G" },
  { id: "b", label: "B" },
  { id: "a", label: "A" },
];

/**
 * Patch a material so the sampled base color collapses to one channel shown as
 * grayscale (alpha shown opaque). A tiny onBeforeCompile swizzle rather than a
 * dedicated ShaderMaterial: the material keeps all of three's map/colorspace
 * plumbing, we only rewrite the one line after the map sample.
 *
 * Composes with a previously-installed onBeforeCompile (parallax): it runs
 * AFTER it, so the `#include <map_fragment>` anchor may already be expanded to
 * raw chunk source — in that case anchor on the sample assignment instead.
 */
function applyIsolation(mat: THREE.Material, iso: IsoChannel): void {
  if (iso === "rgb") return;
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    const swizzle = `\n\tdiffuseColor = vec4( vec3( diffuseColor.${iso} ), 1.0 );`;
    const fs = shader.fragmentShader;
    shader.fragmentShader = fs.includes("#include <map_fragment>")
      ? fs.replace("#include <map_fragment>", `#include <map_fragment>${swizzle}`)
      : fs.replace(
          "diffuseColor *= sampledDiffuseColor;",
          `diffuseColor *= sampledDiffuseColor;${swizzle}`,
        );
  };
  // Closure state is invisible to the default toString()-based cache key, so
  // without this three could hand an isolated material a non-isolated program.
  mat.customProgramCacheKey = () => `${prevKey()}|iso:${iso}`;
}

export const MESH_MODES: { id: MeshMode; label: string }[] = [
  { id: "flat", label: "Flat" },
  { id: "plane", label: "Plane" },
  { id: "sphere", label: "Sphere" },
  { id: "cube", label: "Cube" },
  { id: "env", label: "Env" },
];
export const LIGHT_MODES: { id: LightMode; label: string }[] = [
  { id: "studio", label: "Studio" },
  { id: "sun", label: "Sun" },
  { id: "rim", label: "Rim" },
  { id: "soft", label: "Soft" },
  { id: "unlit", label: "Unlit" },
];

/** One channel's image source: the original path + ext drive the full-res
 *  preview URL; `key` is the 256px thumbnail, kept as a cheap fallback. */
export interface ChannelSrc {
  key: string;
  path: string;
  ext: string;
}

/** The channels this material has. Missing = slot unused. */
export interface ChannelKeys {
  baseColor?: ChannelSrc;
  normal?: ChannelSrc;
  roughness?: ChannelSrc;
  metallic?: ChannelSrc;
  ao?: ChannelSrc;
  height?: ChannelSrc;
  emissive?: ChannelSrc;
  opacity?: ChannelSrc;
}

/** Parallax depth presets, in UV units (the shader marches the height field in
 *  texture space, so these are fractions of a tile, not mesh units). */
export const RELIEF_STEPS: { id: string; label: string; value: number }[] = [
  { id: "off", label: "Off", value: 0 },
  { id: "low", label: "Low", value: 0.02 },
  { id: "med", label: "Med", value: 0.05 },
  { id: "high", label: "High", value: 0.1 },
];

export interface TexturePreviewProps {
  keys: ChannelKeys;
  mesh: MeshMode;
  light: LightMode;
  tiles: number;
  /** Displacement amount in mesh units. 0 = flat surface. */
  relief: number;
  /** Flat mode only: which channel's raw image to show. Lets you inspect the
   *  normal / roughness / AO / height maps themselves, not just their effect
   *  on the composed surface. */
  channel?: keyof ChannelKeys;
  /** Channel isolation, applied in flat and plane modes. */
  iso: IsoChannel;
  /** Flat mode: n×n tiled repeat of the shown image (seam check). The 3D
   *  modes keep their own `tiles`. */
  flatTiles: number;
}

interface Rig {
  lights: { dir: [number, number, number]; color: number; intensity: number }[];
  sky: number;
  ground: number;
  ambient: number;
}

const RIGS: Record<LightMode, Rig> = {
  studio: {
    lights: [
      { dir: [-0.55, 0.72, 0.62], color: 0xfff8ee, intensity: 2.6 },
      { dir: [0.85, 0.1, 0.42], color: 0x94b3ff, intensity: 0.9 },
      { dir: [0.1, 0.34, -0.92], color: 0xffeadb, intensity: 1.4 },
    ],
    sky: 0x4c5166,
    ground: 0x17161a,
    ambient: 1,
  },
  sun: {
    lights: [{ dir: [-0.62, 0.74, 0.3], color: 0xffedc2, intensity: 4.2 }],
    sky: 0x5779b8,
    ground: 0x36291f,
    ambient: 1,
  },
  rim: {
    lights: [
      { dir: [0.34, 0.46, -0.86], color: 0xbcd8ff, intensity: 5 },
      { dir: [-0.72, 0.22, 0.3], color: 0xff7a52, intensity: 0.8 },
    ],
    sky: 0x0b0c12,
    ground: 0x050506,
    ambient: 1,
  },
  soft: {
    lights: [{ dir: [-0.3, 0.85, 0.5], color: 0xffffff, intensity: 0.6 }],
    sky: 0x9a9aa8,
    ground: 0x565452,
    ambient: 1,
  },
  unlit: { lights: [], sky: 0xffffff, ground: 0xffffff, ambient: 1 },
};

/**
 * Live PBR preview of a material, wrapped on a real mesh.
 *
 * This is the payoff for grouping: the channels stop being a file list and
 * become a surface. Normal bends the shading, roughness drives the highlight,
 * AO sits in the crevices.
 *
 * COLORSPACE IS NOT OPTIONAL: base color is sRGB, every other map is linear
 * data. Get it backwards and the material reads washed out — the most common
 * way a preview silently lies.
 *
 * Textures come from the 256px `thumb://` cache, not the source file. That is
 * deliberate: the source may be a DDS/TGA/EXR the webview cannot decode at
 * all, and the cache is the one representation that exists for every format.
 * It is a "does this look right" view, not a pixel-peeping one.
 */
export default function TexturePreview({
  keys,
  mesh,
  light,
  tiles,
  relief,
  channel,
  iso,
  flatTiles,
}: TexturePreviewProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const refs = useRef<{
    renderer?: THREE.WebGLRenderer;
    scene?: THREE.Scene;
    camera?: THREE.PerspectiveCamera;
    obj?: THREE.Mesh;
    mat?: THREE.MeshStandardMaterial;
    lights: THREE.Object3D[];
    /** url|colorspace → loaded texture, kept across material rebuilds. A
     *  lighting/relief/channel change rebuilds the MATERIAL, and handing it
     *  already-loaded textures is what keeps that rebuild flicker-free —
     *  reloading async painted the mesh untextured for a few frames. */
    texCache: Map<string, THREE.Texture>;
  }>({ lights: [], texCache: new Map() });
  const cam = useRef({ yaw: 0.6, pitch: 0.3, dist: 3.2, panX: 0, panY: 0 });
  const dirty = useRef(true);
  const [ready, setReady] = useState(false);
  // Tone-map operator + exposure for HDR/EXR/RAW sources. Drives BOTH the
  // Rust-decoded preview PNG (through the sourceUrl query) and the live three
  // renderer (lit surfaces + the HDRI env), so the two never disagree.
  const toneOp = useTonemapPrefs((s) => s.tonemap);
  const toneEv = useTonemapPrefs((s) => s.exposure);
  // The pointer handler is installed once, so it reads the live mesh mode
  // through a ref rather than closing over a stale value.
  const meshRef = useRef(mesh);
  meshRef.current = mesh;

  // --- init once ---
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.cssText =
      "width:100%;height:100%;display:block;cursor:grab;touch-action:none";

    const scene = new THREE.Scene();
    // Backdrop matches the chosen light rig (swapped in the lights effect).
    scene.background = gradientBackground(light);
    // RoomEnvironment gives the lit meshes a neutral IBL fill — procedural, so
    // no HDRI to ship. environmentIntensity is zeroed for unlit in the rig effect.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    refs.current.renderer = renderer;
    refs.current.scene = scene;
    refs.current.camera = camera;
    setReady(true);

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      dirty.current = true;
    });
    ro.observe(host);

    let mode: "orbit" | "pan" | null = null;
    let lx = 0;
    let ly = 0;
    const el = renderer.domElement;
    const down = (e: PointerEvent): void => {
      // Flat is 2D — there is nothing to tumble. Every drag pans.
      mode =
        meshRef.current === "flat" || e.button === 2 || e.button === 1 || e.shiftKey
          ? "pan"
          : "orbit";
      lx = e.clientX;
      ly = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    };
    const move = (e: PointerEvent): void => {
      if (mode === null) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      const c = cam.current;
      if (mode === "orbit") {
        c.yaw -= dx * 0.008;
        c.pitch = Math.min(1.5, Math.max(-1.5, c.pitch + dy * 0.008));
      } else {
        const k = c.dist / 600;
        c.panX -= dx * k;
        c.panY += dy * k;
      }
      dirty.current = true;
    };
    const up = (e: PointerEvent): void => {
      mode = null;
      el.style.cursor = "grab";
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* gone */
      }
    };
    const wheel = (e: WheelEvent): void => {
      e.preventDefault();
      const c = cam.current;
      c.dist = Math.min(20, Math.max(0.6, c.dist * Math.exp(e.deltaY * 0.0012)));
      dirty.current = true;
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      if (!dirty.current) return;
      dirty.current = false;
      const c = cam.current;
      camera.position.set(
        c.panX + c.dist * Math.cos(c.pitch) * Math.sin(c.yaw),
        c.panY + c.dist * Math.sin(c.pitch),
        c.dist * Math.cos(c.pitch) * Math.cos(c.yaw),
      );
      camera.lookAt(c.panX, c.panY, 0);
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      for (const t of refs.current.texCache.values()) t.dispose();
      refs.current.texCache.clear();
      refs.current.obj?.geometry.dispose();
      refs.current.mat?.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      el.remove();
    };
  }, []);

  // --- tone-map follows the preference ---
  // Lit surfaces and the live HDRI env are tone-mapped by three; the flat/env
  // preview PNGs are tone-mapped in Rust (shown toneMapped:false). Driving both
  // from the same operator+exposure keeps a texture looking identical whichever
  // path renders it.
  useEffect(() => {
    const { renderer } = refs.current;
    if (renderer === undefined) return;
    renderer.toneMapping = THREE_TONE_MAPPING[toneOp];
    renderer.toneMappingExposure = Math.pow(2, toneEv);
    dirty.current = true;
  }, [toneOp, toneEv, ready]);

  // --- lights follow the rig ---
  useEffect(() => {
    const { scene } = refs.current;
    if (scene === undefined) return;
    for (const l of refs.current.lights) scene.remove(l);
    refs.current.lights = [];
    const rig = RIGS[light];
    for (const l of rig.lights) {
      const d = new THREE.DirectionalLight(l.color, l.intensity);
      d.position.set(...l.dir).multiplyScalar(10);
      scene.add(d);
      refs.current.lights.push(d);
    }
    const hemi = new THREE.HemisphereLight(rig.sky, rig.ground, light === "unlit" ? 0 : 0.9);
    scene.add(hemi);
    refs.current.lights.push(hemi);
    // Unlit means "show me the albedo honestly" — kill the IBL too, or the
    // environment keeps tinting what is supposed to be raw.
    scene.environmentIntensity = light === "unlit" ? 0 : 1;
    // Backdrop echoes the rig. Set unconditionally: env mode hides it behind the
    // panorama sphere, but leaving env mode must reveal the right gradient.
    scene.background = gradientBackground(light);
    dirty.current = true;
  }, [light, ready]);

  // The camera belongs to the USER: a rebuild triggered by lighting, tiling,
  // relief, or channel changes must not touch it. Only an actual geometry
  // switch re-frames (a sphere's framing is meaningless on a flat image).
  const framedMesh = useRef<MeshMode | null>(null);

  // --- mesh + material ---
  useEffect(() => {
    const { scene, renderer } = refs.current;
    if (scene === undefined || renderer === undefined) return;
    const reframe = framedMesh.current !== mesh;
    framedMesh.current = mesh;

    if (refs.current.obj !== undefined) {
      scene.remove(refs.current.obj);
      refs.current.obj.geometry.dispose();
    }
    refs.current.mat?.dispose();

    const loader = new THREE.TextureLoader();
    const cache = refs.current.texCache;
    const used = new Set<string>();
    const load = (src: ChannelSrc | undefined, srgb: boolean): THREE.Texture | null => {
      if (src === undefined) return null;
      // Source quality, not the 256px grid thumb — the preview is where you look
      // closely, and a 5K HDRI on the env sphere must not read as a blurry blob.
      // Tone-map only float sources; an LDR map (DDS/TGA/TIFF) keeps a stable,
      // cacheable URL so auditioning an operator never churns its preview.
      const float = isFloatPreview(src.ext);
      const url = sourceUrl(src.path, src.ext, float ? toneOp : undefined, float ? toneEv : undefined);
      const cacheKey = `${url}|${srgb ? "s" : "l"}`;
      used.add(cacheKey);
      let t = cache.get(cacheKey);
      if (t === undefined) {
        t = loader.load(url, () => {
          dirty.current = true;
        });
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        cache.set(cacheKey, t);
      }
      // Re-asserted on every build, not only on load: flat mode retags linear
      // maps sRGB for display (below), and a cache hit must undo that.
      // THE colorspace rule: base color is sRGB; normal/roughness/AO/height
      // are linear DATA. Backwards = washed out and subtly wrong.
      const cs = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      if (t.colorSpace !== cs) {
        t.colorSpace = cs;
        t.needsUpdate = true;
      }
      t.repeat.set(tiles, tiles);
      return t;
    };

    const map = load(keys.baseColor, true);
    const normalMap = load(keys.normal, false);
    const roughnessMap = load(keys.roughness, false);
    const metalnessMap = load(keys.metallic, false);
    const aoMap = load(keys.ao, false);
    const heightMap = load(keys.height, false);
    const emissiveMap = load(keys.emissive, true);
    const opacityMap = load(keys.opacity, false);

    // Evict what this build no longer references — a different file's maps —
    // so switching selections doesn't accumulate GPU textures forever.
    for (const [k, t] of cache) {
      if (!used.has(k)) {
        t.dispose();
        cache.delete(k);
      }
    }

    if (mesh === "env") {
      // Equirect panorama seen from inside — the view HDRIs and skyboxes want.
      const geo = new THREE.SphereGeometry(50, 64, 32);
      geo.scale(-1, 1, 1); // flip inward
      // toneMapped:false — the thumbnail is already tone-mapped by the Rust
      // decoder (an .hdr/.exr has to be, to become a PNG at all). Running ACES
      // over it a second time crushes it.
      const mat = new THREE.MeshBasicMaterial({ map, toneMapped: false });
      const m = new THREE.Mesh(geo, mat);
      scene.add(m);
      refs.current.obj = m;
      refs.current.mat = mat as unknown as THREE.MeshStandardMaterial;
      if (map !== null) map.repeat.set(1, 1); // never tile a panorama
      if (reframe) cam.current.dist = 0.01;
      dirty.current = true;
      return;
    }

    if (mesh === "flat") {
      // Flat is an IMAGE VIEWER, not a material preview. Show the actual
      // pixels: unlit, un-tone-mapped, sRGB — what Windows Photos would show.
      //
      // Lighting it is a lie for any texture, and obviously wrong for the ones
      // that aren't game assets at all (a pack's readme PNG, a screenshot):
      // MeshStandardMaterial + ACES rendered those darkened and washed out.
      //
      // `channel` picks WHICH map to look at: the point of flat mode on a
      // material is to inspect the height/normal/roughness images themselves,
      // not only their effect on the composed surface. Falls back to whatever
      // the item actually has.
      const byChannel: Record<string, THREE.Texture | null> = {
        baseColor: map,
        normal: normalMap,
        roughness: roughnessMap,
        metallic: metalnessMap,
        ao: aoMap,
        height: heightMap,
        emissive: emissiveMap,
        opacity: opacityMap,
      };
      const raw =
        (channel !== undefined ? byChannel[channel] : null) ??
        map ??
        normalMap ??
        roughnessMap ??
        aoMap ??
        heightMap;
      if (raw !== null) {
        // Every map but base color was uploaded as linear DATA; to display it
        // verbatim it has to be tagged sRGB like any other image file.
        raw.colorSpace = THREE.SRGBColorSpace;
        raw.needsUpdate = true;
        // Flat tiling is its own control (1–3), independent of the 3D `tiles`:
        // RepeatWrapping is already set at load, so repeat alone tiles the
        // quad n×n. Re-asserted per build, so leaving flat restores `tiles`.
        raw.repeat.set(flatTiles, flatTiles);
      }
      const geo = new THREE.PlaneGeometry(2, 2);
      const mat = new THREE.MeshBasicMaterial({
        map: raw,
        toneMapped: false,
        transparent: true,
        side: THREE.DoubleSide,
      });
      applyIsolation(mat, iso);
      const m = new THREE.Mesh(geo, mat);
      scene.add(m);
      refs.current.obj = m;
      refs.current.mat = mat as unknown as THREE.MeshStandardMaterial;
      if (reframe) {
        const c = cam.current;
        c.yaw = 0;
        c.pitch = 0;
        c.dist = 2.42;
        c.panX = 0;
        c.panY = 0;
      }
      dirty.current = true;
      return;
    }

    // Height is applied as PARALLAX, not displacement — see parallax.ts. So the
    // geometry never moves and needs no special tessellation: a 1-segment cube
    // keeps clean edges (displacement seamed them), and parallax gives the
    // depth. Moderate density only for smooth base shading.
    const useParallax = relief > 0 && heightMap !== null && light !== "unlit";
    let geo: THREE.BufferGeometry;
    switch (mesh) {
      case "sphere":
        geo = new THREE.SphereGeometry(1, 128, 96);
        break;
      case "cube":
        geo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
        break;
      default:
        geo = new THREE.PlaneGeometry(2, 2, 1, 1);
    }
    // aoMap samples uv2 in three; without this the AO channel silently does
    // nothing on geometry that only has uv.
    if ((aoMap !== null || opacityMap !== null) && geo.attributes.uv !== undefined) {
      geo.setAttribute("uv1", geo.attributes.uv);
    }

    const side = mesh === "plane" ? THREE.DoubleSide : THREE.FrontSide;
    // "Unlit" means SHOW THE ALBEDO, not "a PBR material with the lights off"
    // — that is just black, which is what this used to render. A basic
    // material is what unlit actually means.
    // Parallax needs a base-color map to exist (its shader keys off vMapUv),
    // so fall back to solid white when the asset has none.
    const baseMap = useParallax && map === null ? whiteTex() : map;
    const mat: THREE.Material =
      light === "unlit"
        ? new THREE.MeshBasicMaterial({
            map,
            side,
            toneMapped: false,
            alphaMap: opacityMap,
            transparent: opacityMap !== null,
          })
        : new THREE.MeshStandardMaterial({
            map: baseMap,
            normalMap,
            roughnessMap,
            metalnessMap,
            aoMap,
            emissiveMap,
            // emissive multiplies emissiveMap and defaults to black, so an
            // emissive map with the default colour contributes exactly nothing.
            emissive: new THREE.Color(emissiveMap !== null ? 0xffffff : 0x000000),
            alphaMap: opacityMap,
            transparent: opacityMap !== null,
            // With no normal map, still drive shading from the height field so
            // the surface isn't suspiciously smooth under the parallax.
            bumpMap: normalMap === null ? heightMap : null,
            bumpScale: normalMap === null && heightMap !== null ? 1 : 0,
            // A roughnessMap/metalnessMap multiplies these scalars, so they
            // must be 1 for the map to have full range.
            roughness: roughnessMap !== null ? 1 : 0.75,
            metalness: metalnessMap !== null ? 1 : 0,
            side,
          });
    if (useParallax && heightMap !== null && mat instanceof THREE.MeshStandardMaterial) {
      applyParallax(mat, heightMap, relief);
    }
    // Isolation is a plane-mode affordance (like flat, it's for inspecting the
    // image); on sphere/cube the control is hidden and iso stays "rgb".
    // Applied AFTER parallax — applyIsolation composes with its shader patch.
    if (mesh === "plane") applyIsolation(mat, iso);
    const m = new THREE.Mesh(geo, mat);
    scene.add(m);
    refs.current.obj = m;
    refs.current.mat = mat as THREE.MeshStandardMaterial;

    // Flat is handled above and returns early — only the 3D meshes reach here.
    if (reframe) {
      const c = cam.current;
      c.yaw = 0.6;
      c.pitch = 0.3;
      c.dist = mesh === "cube" ? 4 : 3.2;
      c.panX = 0;
      c.panY = 0;
    }
    dirty.current = true;
  }, [
    keys.baseColor, keys.normal, keys.roughness, keys.metallic,
    keys.ao, keys.height, keys.emissive, keys.opacity,
    mesh, light, tiles, relief, channel, iso, flatTiles, ready,
    // A tone-map/exposure change re-URLs float textures (new query) so the
    // preview PNG is re-fetched freshly tone-mapped.
    toneOp, toneEv,
  ]);

  return <div ref={hostRef} className="h-full w-full" />;
}
