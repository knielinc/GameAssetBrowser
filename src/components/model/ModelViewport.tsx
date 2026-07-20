import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Box, Grid3x3, Loader2, Pause, PersonStanding, Play, RotateCw } from "lucide-react";
import clsx from "clsx";
import { analyze, loadModel, type ModelStats } from "../../model/loadModel";
import { disposeModel } from "../../model/dispose";
import { rescueTextures, type RescueResult } from "../../model/rescueTextures";
import { packDirOf, useAtlasStore } from "../../stores/atlasStore";
import { useRenderPrefs, type ModelLight } from "../../stores/renderPrefs";

/**
 * Build a light rig for `mode`. Every rig keeps a hemisphere fill so nothing
 * ever goes fully black; the key/rim placement is what changes the mood.
 * Returned as a flat list so the viewport can swap rigs by removing the old set
 * and adding the new one, with no other scene bookkeeping.
 */
function buildLightRig(mode: ModelLight): THREE.Light[] {
  switch (mode) {
    case "sun": {
      // One hard, warm key from high on one side — strong shad's terminator,
      // the "outdoor at 3pm" look. Low sky fill so the shadow side stays dark.
      const key = new THREE.DirectionalLight(0xfff2d6, 3.4);
      key.position.set(5, 8, 3);
      return [key, new THREE.HemisphereLight(0x9fb4ff, 0x2a2620, 0.55)];
    }
    case "rim": {
      // Dim front key + bright cool back-rim to pop the silhouette against the
      // dark background — good for reading shape on a solid-colour model.
      const key = new THREE.DirectionalLight(0xffffff, 1.0);
      key.position.set(-3, 4, 6);
      const rim = new THREE.DirectionalLight(0xbcd2ff, 3.0);
      rim.position.set(2, 5, -6);
      return [key, rim, new THREE.HemisphereLight(0x8fa4e0, 0x2a2a30, 0.7)];
    }
    case "soft": {
      // Two gentle fills from either side + strong sky — near-shadowless, the
      // flattering "product on a lightbox" look that hides nothing.
      const l = new THREE.DirectionalLight(0xffffff, 1.1);
      l.position.set(-5, 4, 4);
      const r = new THREE.DirectionalLight(0xffffff, 1.1);
      r.position.set(5, 3, 2);
      return [l, r, new THREE.HemisphereLight(0xcfd8ff, 0x40403a, 1.7)];
    }
    case "studio":
    default: {
      // The original balanced rig — also what thumbnails bake with, so the
      // grid and the detail view agree by default.
      const key = new THREE.DirectionalLight(0xffffff, 2.2);
      key.position.set(-4, 6, 5);
      return [key, new THREE.HemisphereLight(0x9fb4ff, 0x33302c, 1.2)];
    }
  }
}

/** Materials whose `wireframe`/`map` slots we can toggle — three's mesh
 *  materials all carry them; guarded by an `in` check before the cast so a
 *  LineBasicMaterial or ShaderMaterial without the slot is skipped. */
type WireframeMaterial = THREE.Material & { wireframe: boolean };
type MappedMaterial = THREE.Material & { map: THREE.Texture | null };

/** Visit every material on every mesh once (array materials flattened). */
function forEachMaterial(root: THREE.Object3D, fn: (m: THREE.Material) => void): void {
  root.traverse((o) => {
    const mesh = o as unknown as { isMesh?: boolean; material?: THREE.Material | THREE.Material[] };
    if (mesh.isMesh !== true || mesh.material === undefined) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) fn(m);
  });
}

/**
 * UV-checker texture: built lazily ONCE per session at module level and shared
 * by every viewport instance — it is never disposed (disposeModel only touches
 * textures reachable from the model, and we restore original maps before
 * dispose runs, so the shared checker never enters that path).
 */
let checkerTexture: THREE.CanvasTexture | null = null;
function getCheckerTexture(): THREE.CanvasTexture {
  if (checkerTexture !== null) return checkerTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    const cell = 512 / 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? "#8c8c8c" : "#b6b6b6";
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    // Thin grid lines on the square borders; the 0.5 offset lands a 1px line
    // on the pixel grid instead of anti-aliasing it across two rows.
    ctx.strokeStyle = "rgba(30, 30, 38, 0.65)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      const p = Math.min(i * cell + 0.5, 511.5);
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, 512);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(512, p);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  checkerTexture = tex;
  return tex;
}

/** FBX packs are commonly authored in centimetres — a bbox this large is far
 *  more likely a unit mismatch than a 50-metre prop. Shared with the
 *  inspector's size hint so the capsule and the text agree. */
export const CM_HEURISTIC_MIN = 50;

export interface ModelViewportProps {
  path: string | null;
  onStats?: (stats: ModelStats | null) => void;
  /** Surfaced so the inspector can offer the manual atlas picker. */
  onRescue?: (r: RescueResult | null) => void;
}

/**
 * The one WebGL context in the app.
 *
 * Imperative three.js inside a useEffect with an rAF loop — structurally the
 * same shape as WaveformCanvas, deliberately. React-three-fiber would add a
 * reconciler and be the largest abstraction in a codebase that hand-rolls its
 * own waveform loop and derives its own folder tree.
 */
export default function ModelViewport({ path, onStats, onRescue }: ModelViewportProps): ReactElement {
  // Re-run the load when the user picks a different atlas for this pack.
  const atlasChoice = useAtlasStore((s) => (path === null ? undefined : s.overrides[packDirOf(path).toLowerCase()]));
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const currentRef = useRef<THREE.Object3D | null>(null);
  /** The active light rig, so a lighting change can remove exactly these. */
  const lightsRef = useRef<THREE.Light[]>([]);
  /** Orbit state, outside React so dragging never re-renders. */
  const camRef = useRef({ yaw: 0.7, pitch: 0.35, dist: 5, target: new THREE.Vector3() });
  const dirtyRef = useRef(true);

  // --- animation playback (refs read by the rAF loop, state for the UI) ----
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actionRef = useRef<THREE.AnimationAction | null>(null);
  const playingRef = useRef(false);
  /** Last time pushed into React state — throttles slider updates to ~20 Hz
   *  so a playing clip doesn't re-render the component at display rate. */
  const shownTimeRef = useRef(0);
  const [clips, setClips] = useState<THREE.AnimationClip[]>([]);
  const [clipIndex, setClipIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [animTime, setAnimTime] = useState(0);

  // --- viewport toggles ----------------------------------------------------
  /** Original `wireframe`/`map` values, restored on toggle-off AND before the
   *  model is disposed (cleared then — the materials are dead). */
  const wireOrigRef = useRef(new Map<WireframeMaterial, boolean>());
  const mapOrigRef = useRef(new Map<MappedMaterial, THREE.Texture | null>());
  /** Scale-reference capsule — added to the SCENE, never to the model, so it
   *  is excluded from bbox framing, stats, and disposeModel. */
  const silhouetteRef = useRef<THREE.Mesh | null>(null);
  /** Load-time bbox + cm-heuristic verdict, for silhouette placement. */
  const modelBoxRef = useRef<{ box: THREE.Box3; cm: boolean } | null>(null);
  const turntableRef = useRef(false);
  /** True while a pointer drag is orbiting — the turntable yields to the user
   *  and resumes on pointerup. */
  const orbitingRef = useRef(false);
  /** Bumped after each successful load so the toggle effects re-apply to the
   *  NEW model's materials (their dep arrays can't see currentRef change). */
  const [modelGen, setModelGen] = useState(0);

  const modelLight = useRenderPrefs((s) => s.modelLight);
  const wireframe = useRenderPrefs((s) => s.modelWireframe);
  const checker = useRenderPrefs((s) => s.modelChecker);
  const silhouette = useRenderPrefs((s) => s.modelSilhouette);
  const turntable = useRenderPrefs((s) => s.modelTurntable);
  const setWireframe = useRenderPrefs((s) => s.setModelWireframe);
  const setChecker = useRenderPrefs((s) => s.setModelChecker);
  const setSilhouette = useRenderPrefs((s) => s.setModelSilhouette);
  const setTurntable = useRenderPrefs((s) => s.setModelTurntable);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rescued, setRescued] = useState<RescueResult | null>(null);

  // --- one-time init -------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.cssText = "width:100%;height:100%;display:block;cursor:grab;touch-action:none";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c0c12);

    // RoomEnvironment is procedural — a few hundred lines of code, ZERO asset
    // bytes, no HDRI to ship and no license question. It is what three's own
    // editor uses.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    // FBXLoader downgrades materials to Phong/Lambert, which largely ignore
    // scene.environment — so ship a light rig too, or every Synty FBX renders
    // flat and unlit. The rig honours the user's chosen mode and is swapped in
    // place by the effect below when they change it.
    const rig = buildLightRig(useRenderPrefs.getState().modelLight);
    for (const l of rig) scene.add(l);
    lightsRef.current = rig;

    const grid = new THREE.GridHelper(20, 20, 0x2a2a38, 0x1c1c26);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    scene.add(grid);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
    sceneRef.current = scene;
    rendererRef.current = renderer;
    cameraRef.current = camera;

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      dirtyRef.current = true;
    });
    ro.observe(host);

    // --- trackball: drag orbit, right/shift-drag pan, wheel zoom ---
    let mode: "orbit" | "pan" | null = null;
    let lx = 0;
    let ly = 0;
    const el = renderer.domElement;
    const onDown = (e: PointerEvent): void => {
      mode = e.button === 2 || e.button === 1 || e.shiftKey ? "pan" : "orbit";
      // Any drag (orbit or pan) pauses the turntable — the user has the wheel.
      orbitingRef.current = true;
      lx = e.clientX;
      ly = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent): void => {
      if (mode === null) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      const c = camRef.current;
      if (mode === "orbit") {
        c.yaw -= dx * 0.008;
        c.pitch = Math.min(1.5, Math.max(-1.5, c.pitch + dy * 0.008));
      } else {
        const k = c.dist / 600;
        const right = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2, c.yaw + Math.PI / 2);
        c.target.addScaledVector(right, -dx * k);
        c.target.y += dy * k;
      }
      dirtyRef.current = true;
    };
    const onUp = (e: PointerEvent): void => {
      mode = null;
      orbitingRef.current = false;
      el.style.cursor = "grab";
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const c = camRef.current;
      c.dist = Math.min(2000, Math.max(0.05, c.dist * Math.exp(e.deltaY * 0.0012)));
      dirtyRef.current = true;
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    // Render on demand — a static model must not burn a GPU at 60 fps. A
    // playing clip or turntable marks the frame dirty itself, so animation
    // still goes through the same single render call.
    const clock = new THREE.Clock();
    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      // getDelta every frame even when idle, or the first animated frame after
      // a pause would jump by the whole idle duration.
      const dt = clock.getDelta();
      const mixer = mixerRef.current;
      if (mixer !== null && playingRef.current) {
        mixer.update(dt);
        const action = actionRef.current;
        if (action !== null && Math.abs(action.time - shownTimeRef.current) > 0.05) {
          shownTimeRef.current = action.time;
          setAnimTime(action.time);
        }
        dirtyRef.current = true;
      }
      if (turntableRef.current && !orbitingRef.current && currentRef.current !== null) {
        currentRef.current.rotation.y += 0.4 * dt;
        dirtyRef.current = true;
      }
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      const c = camRef.current;
      camera.position.set(
        c.target.x + c.dist * Math.cos(c.pitch) * Math.sin(c.yaw),
        c.target.y + c.dist * Math.sin(c.pitch),
        c.target.z + c.dist * Math.cos(c.pitch) * Math.cos(c.yaw),
      );
      camera.lookAt(c.target);
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      // Restore swapped maps/flags BEFORE disposeModel, exactly like the
      // load-on-change effect: mapOrigRef may point `.map` at the module-level
      // shared checker, which disposeModel would otherwise walk and destroy
      // (poisoning getCheckerTexture forever) while leaking the swapped-out
      // originals. Unmount is the checker-on path the load effect never covers.
      for (const [m, was] of wireOrigRef.current) m.wireframe = was;
      wireOrigRef.current.clear();
      for (const [m, was] of mapOrigRef.current) m.map = was;
      mapOrigRef.current.clear();
      if (currentRef.current !== null) disposeModel(currentRef.current);
      const sil = silhouetteRef.current;
      if (sil !== null) {
        sil.geometry.dispose();
        (sil.material as THREE.Material).dispose();
        silhouetteRef.current = null;
      }
      pmrem.dispose();
      renderer.dispose();
      // Without forceContextLoss WebView2 keeps the context alive and
      // StrictMode's double-mount burns two of a ~16 budget.
      renderer.forceContextLoss();
      el.remove();
    };
  }, []);

  // --- swap the light rig when the user changes it -------------------------
  useEffect(() => {
    const scene = sceneRef.current;
    if (scene === null) return;
    for (const l of lightsRef.current) scene.remove(l);
    const rig = buildLightRig(modelLight);
    for (const l of rig) scene.add(l);
    lightsRef.current = rig;
    dirtyRef.current = true;
  }, [modelLight]);

  // --- keep the rAF loop's turntable flag in sync with the pref ------------
  useEffect(() => {
    turntableRef.current = turntable;
    dirtyRef.current = true;
  }, [turntable]);

  // --- wireframe toggle: flip every material, remember what it was ---------
  // modelGen dep: re-apply to a freshly loaded model (its materials are new).
  useEffect(() => {
    const root = currentRef.current;
    const orig = wireOrigRef.current;
    if (wireframe && root !== null) {
      forEachMaterial(root, (m) => {
        if (!("wireframe" in m)) return;
        const wm = m as WireframeMaterial;
        if (!orig.has(wm)) orig.set(wm, wm.wireframe);
        wm.wireframe = true;
      });
    } else {
      // Restore rather than blanket-false: a material could be authored
      // wireframe on purpose.
      for (const [m, was] of orig) m.wireframe = was;
      orig.clear();
    }
    dirtyRef.current = true;
  }, [wireframe, modelGen]);

  // --- UV checker toggle: swap base maps for the shared checker ------------
  useEffect(() => {
    const root = currentRef.current;
    const orig = mapOrigRef.current;
    if (checker && root !== null) {
      const tex = getCheckerTexture();
      forEachMaterial(root, (m) => {
        if (!("map" in m)) return;
        const mm = m as MappedMaterial;
        if (!orig.has(mm)) orig.set(mm, mm.map);
        mm.map = tex;
        // null→texture flips a shader define, so the program must rebuild.
        mm.needsUpdate = true;
      });
    } else {
      for (const [m, was] of orig) {
        m.map = was;
        m.needsUpdate = true;
      }
      orig.clear();
    }
    dirtyRef.current = true;
  }, [checker, modelGen]);

  // --- human silhouette: 1.8-unit capsule standing beside the bbox ---------
  useEffect(() => {
    const scene = sceneRef.current;
    if (scene === null) return;
    // Always rebuild: the model (and with it the cm scale + placement) moved.
    const prev = silhouetteRef.current;
    if (prev !== null) {
      scene.remove(prev);
      prev.geometry.dispose();
      (prev.material as THREE.Material).dispose();
      silhouetteRef.current = null;
    }
    const info = modelBoxRef.current;
    if (silhouette && info !== null) {
      const s = info.cm ? 100 : 1;
      // r=0.25, total height 1.8 → cylinder section 1.8 − 2·0.25 = 1.3.
      const geo = new THREE.CapsuleGeometry(0.25, 1.3, 4, 16);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x8fa4e0,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      });
      const capsule = new THREE.Mesh(geo, mat);
      capsule.scale.setScalar(s);
      // Feet on the ground plane (y=0, where the grid lives), standing just
      // outside the bbox's +x face at the model's z centre.
      capsule.position.set(info.box.max.x + 0.55 * s, 0.9 * s, (info.box.min.z + info.box.max.z) / 2);
      scene.add(capsule);
      silhouetteRef.current = capsule;
    }
    dirtyRef.current = true;
  }, [silhouette, modelGen]);

  // --- bind the picked clip to the mixer -----------------------------------
  useEffect(() => {
    const mixer = mixerRef.current;
    if (mixer === null || clips.length === 0) return;
    const clip = clips[Math.min(clipIndex, clips.length - 1)];
    mixer.stopAllAction();
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    actionRef.current = action;
    mixer.update(0);
    shownTimeRef.current = 0;
    setAnimTime(0);
    dirtyRef.current = true;
  }, [clips, clipIndex]);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  /** Scrub: jump the action to `t` and evaluate one zero-delta update so a
   *  PAUSED pose refreshes too (mixer.update(0) re-samples without advancing). */
  const scrub = useCallback((t: number): void => {
    const mixer = mixerRef.current;
    const action = actionRef.current;
    if (mixer === null || action === null) return;
    action.time = t;
    mixer.update(0);
    shownTimeRef.current = t;
    setAnimTime(t);
    dirtyRef.current = true;
  }, []);

  // --- load on path change -------------------------------------------------
  useEffect(() => {
    const scene = sceneRef.current;
    if (scene === null) return;
    let cancelled = false;

    // Dispose on EVERY change, not just unmount. Restore swapped maps/flags
    // FIRST: the orig maps hold materials about to be disposed, and the shared
    // checker texture must not be reachable when disposeModel walks textures.
    if (currentRef.current !== null) {
      for (const [m, was] of wireOrigRef.current) m.wireframe = was;
      wireOrigRef.current.clear();
      for (const [m, was] of mapOrigRef.current) m.map = was;
      mapOrigRef.current.clear();
      mixerRef.current?.stopAllAction();
      mixerRef.current = null;
      actionRef.current = null;
      scene.remove(currentRef.current);
      disposeModel(currentRef.current);
      currentRef.current = null;
    }
    setClips([]);
    setClipIndex(0);
    setPlaying(false);
    setAnimTime(0);
    onStats?.(null);
    setError(null);
    if (path === null) {
      modelBoxRef.current = null;
      setModelGen((g) => g + 1);
      dirtyRef.current = true;
      return;
    }

    setLoading(true);
    void loadModel(path)
      .then(async ({ root, animations }) => {
        if (cancelled) {
          disposeModel(root);
          return;
        }
        // Synty FBX bake absolute authoring paths and their OBJ ship no .mtl,
        // so materials arrive untextured. Apply the user's chosen atlas if they
        // have picked one for this pack; otherwise leave it grey — no guessing.
        try {
          const r = await rescueTextures(root, path);
          if (!cancelled) {
            setRescued(r);
            onRescue?.(r);
          }
        } catch (e) {
          console.debug("[rescue]", e);
        }
        if (cancelled) {
          disposeModel(root);
          return;
        }
        const stats = analyze(root);

        // Auto-frame. A degenerate/NaN bbox yields NaN camera positions and a
        // silently black canvas, which reads as "the loader is broken".
        const box = new THREE.Box3().setFromObject(root);
        const c = camRef.current;
        if (!box.isEmpty() && Number.isFinite(box.min.x)) {
          const sphere = box.getBoundingSphere(new THREE.Sphere());
          const size = box.getSize(new THREE.Vector3());
          stats.size = [size.x, size.y, size.z];
          modelBoxRef.current = { box, cm: Math.max(size.x, size.y, size.z) >= CM_HEURISTIC_MIN };
          c.target.copy(sphere.center);
          c.dist = (sphere.radius / Math.sin((45 / 2) * (Math.PI / 180))) * 1.4;
          const cam = cameraRef.current;
          if (cam !== null) {
            // Recompute near/far from the framing distance, or a 0.01 m prop
            // and a 5000 m terrain both z-fight into mush.
            cam.near = Math.max(0.001, c.dist / 1000);
            cam.far = c.dist * 100;
            cam.updateProjectionMatrix();
          }
        } else {
          modelBoxRef.current = null;
          c.dist = 5;
          c.target.set(0, 0, 0);
        }
        c.yaw = 0.7;
        c.pitch = 0.35;

        scene.add(root);
        currentRef.current = root;

        // Animation: bind a mixer when the file carries clips; the first clip
        // starts playing immediately — an idle skinned mesh in bind pose reads
        // as "animation didn't load".
        if (animations.length > 0) {
          mixerRef.current = new THREE.AnimationMixer(root);
          setClips(animations);
          setPlaying(true);
        }

        setModelGen((g) => g + 1);
        onStats?.(stats);
        dirtyRef.current = true;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // atlasChoice: re-load so a manual atlas pick takes effect immediately.
  }, [path, onStats, onRescue, atlasChoice]);

  const activeClip = clips.length > 0 ? clips[Math.min(clipIndex, clips.length - 1)] : null;
  const clipDur = activeClip !== null && activeClip.duration > 0 ? activeClip.duration : 1;

  const toggles: { on: boolean; set: (v: boolean) => void; title: string; icon: ReactElement }[] = [
    { on: wireframe, set: setWireframe, title: "Wireframe", icon: <Box size={13} /> },
    { on: checker, set: setChecker, title: "UV checker", icon: <Grid3x3 size={13} /> },
    { on: silhouette, set: setSilhouette, title: "Human silhouette (1.8 units) for scale", icon: <PersonStanding size={13} /> },
    { on: turntable, set: setTurntable, title: "Turntable — pauses while you orbit", icon: <RotateCw size={13} /> },
  ];

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl bg-[#0c0c12] shadow-e1">
      <div ref={hostRef} className="h-full w-full" />
      {/* Viewport toggles — global renderPrefs, so the drawer and fullscreen
          viewports always agree, like the light rig. */}
      {path !== null && error === null && (
        <div className="absolute left-1.5 top-1.5 flex gap-0.5 rounded-lg bg-black/55 p-0.5">
          {toggles.map((t) => (
            <button
              key={t.title}
              type="button"
              title={t.title}
              className={clsx("icon-btn", t.on && "icon-btn-active")}
              onClick={() => t.set(!t.on)}
            >
              {t.icon}
            </button>
          ))}
        </div>
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <Loader2 size={20} className="animate-spin text-accent" />
        </div>
      )}
      {error !== null && (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-[11px] text-dim">
          {error}
        </div>
      )}
      {/* Animation transport — only when the file actually carries clips. It
          claims the bottom edge, so the orbit hint yields to it. */}
      {!loading && error === null && activeClip !== null && (
        <div className="absolute inset-x-1.5 bottom-1.5 flex items-center gap-1.5 rounded-lg bg-black/55 px-1.5 py-1">
          <button
            type="button"
            className="icon-btn shrink-0"
            title={playing ? "Pause" : "Play"}
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </button>
          {clips.length > 1 && (
            <select
              value={Math.min(clipIndex, clips.length - 1)}
              title="Animation clip"
              className="max-w-[110px] shrink-0 truncate rounded bg-transparent text-[10px] text-text outline-none [color-scheme:dark]"
              onChange={(e) => setClipIndex(Number(e.currentTarget.value))}
            >
              {clips.map((c, i) => (
                <option key={`${i}-${c.name}`} value={i}>
                  {c.name !== "" ? c.name : `Clip ${i + 1}`}
                </option>
              ))}
            </select>
          )}
          <input
            type="range"
            min={0}
            max={clipDur}
            step={clipDur / 500}
            value={Math.min(animTime, clipDur)}
            aria-label="Animation time"
            className="volume min-w-0 flex-1"
            style={{ "--fill": `${(Math.min(animTime, clipDur) / clipDur) * 100}%` } as CSSProperties}
            onChange={(e) => scrub(Number(e.currentTarget.value))}
          />
          <span className="shrink-0 text-[9px] tabular-nums text-dim">
            {Math.min(animTime, clipDur).toFixed(1)} / {activeClip.duration.toFixed(1)}s
          </span>
        </div>
      )}
      {!loading && error === null && path !== null && activeClip === null && (
        <div className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-dim">
          drag orbit · right-drag pan · scroll zoom
        </div>
      )}
      {/* Say when a texture was found rather than declared — the model is not
          showing what the file asked for, and that is worth admitting. */}
      {rescued !== null && rescued.brokenSlots > 0 && (
        <div
          className="pointer-events-none absolute right-1.5 top-1.5 max-w-[70%] truncate rounded bg-kind-model/85 px-1.5 py-0.5 text-[9px] font-medium text-[#1a1208]"
          title={
            rescued.applied !== null
              ? `Textures assigned from your pick:\n${rescued.applied}`
              : "This model's textures aren't embedded. Pick one below."
          }
        >
          {rescued.applied !== null ? "atlas assigned" : "no texture — pick one"}
        </div>
      )}
    </div>
  );
}
