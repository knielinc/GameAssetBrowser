import { useEffect, useRef, useState, type ReactElement } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Loader2 } from "lucide-react";
import { analyze, loadModel, type ModelStats } from "../../model/loadModel";
import { disposeModel } from "../../model/dispose";

export interface ModelViewportProps {
  path: string | null;
  onStats?: (stats: ModelStats | null) => void;
}

/**
 * The one WebGL context in the app.
 *
 * Imperative three.js inside a useEffect with an rAF loop — structurally the
 * same shape as WaveformCanvas, deliberately. React-three-fiber would add a
 * reconciler and be the largest abstraction in a codebase that hand-rolls its
 * own waveform loop and derives its own folder tree.
 */
export default function ModelViewport({ path, onStats }: ModelViewportProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const currentRef = useRef<THREE.Object3D | null>(null);
  /** Orbit state, outside React so dragging never re-renders. */
  const camRef = useRef({ yaw: 0.7, pitch: 0.35, dist: 5, target: new THREE.Vector3() });
  const dirtyRef = useRef(true);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    // flat and unlit.
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-4, 6, 5);
    scene.add(key);
    scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x33302c, 1.2));

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

    // Render on demand — a static model must not burn a GPU at 60 fps.
    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
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
      if (currentRef.current !== null) disposeModel(currentRef.current);
      pmrem.dispose();
      renderer.dispose();
      // Without forceContextLoss WebView2 keeps the context alive and
      // StrictMode's double-mount burns two of a ~16 budget.
      renderer.forceContextLoss();
      el.remove();
    };
  }, []);

  // --- load on path change -------------------------------------------------
  useEffect(() => {
    const scene = sceneRef.current;
    if (scene === null) return;
    let cancelled = false;

    // Dispose on EVERY change, not just unmount.
    if (currentRef.current !== null) {
      scene.remove(currentRef.current);
      disposeModel(currentRef.current);
      currentRef.current = null;
    }
    onStats?.(null);
    setError(null);
    if (path === null) {
      dirtyRef.current = true;
      return;
    }

    setLoading(true);
    void loadModel(path)
      .then(({ root }) => {
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
          c.dist = 5;
          c.target.set(0, 0, 0);
        }
        c.yaw = 0.7;
        c.pitch = 0.35;

        scene.add(root);
        currentRef.current = root;
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
  }, [path, onStats]);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-border bg-[#0c0c12]">
      <div ref={hostRef} className="h-full w-full" />
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
      {!loading && error === null && path !== null && (
        <div className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-dim backdrop-blur-sm">
          drag orbit · right-drag pan · scroll zoom
        </div>
      )}
    </div>
  );
}
