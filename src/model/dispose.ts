import type { Object3D } from "three";

/**
 * Deep-dispose a loaded model.
 *
 * three.js leaks aggressively and none of this is optional. Call it on EVERY
 * model change, not just unmount — clicking through 50 models without it is
 * how you reach multi-GB resident.
 *
 * The blob-URL revocation is the one people miss: FBXLoader materializes
 * embedded textures as object URLs and never revokes them. The leak is
 * invisible to renderer.info because it isn't GPU memory — the blob keeps the
 * decoded image alive on the JS heap forever.
 */
export function disposeModel(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as unknown as { isMesh?: boolean; geometry?: { dispose(): void }; material?: unknown };
    if (mesh.isMesh !== true) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (m === undefined || m === null) continue;
      const mat = m as Record<string, unknown> & { dispose?: () => void };
      for (const v of Object.values(mat)) {
        const tex = v as { isTexture?: boolean; image?: { src?: string }; dispose?: () => void } | null;
        if (tex === null || typeof tex !== "object" || tex.isTexture !== true) continue;
        const src = tex.image?.src;
        if (typeof src === "string" && src.startsWith("blob:")) URL.revokeObjectURL(src);
        tex.dispose?.();
      }
      mat.dispose?.();
    }
  });
}
