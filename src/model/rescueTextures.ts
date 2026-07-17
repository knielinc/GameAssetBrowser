import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import { atlasFor } from "../stores/atlasStore";
import { modelUrl } from "./loadModel";

interface TextureHints {
  declared: string[];
  candidates: string[];
}
/**
 * A slot needs rescuing if it is empty OR holds a texture that never loaded.
 *
 * Checking `map == null` is not enough, and this is why Synty FBX stayed black
 * while OBJ got fixed: FBXLoader DOES build a Texture from the declared path
 * (`U:/Dropbox/SyntyStudios/.../PolygonNature.png`). The fetch 404s, so the
 * texture has no image — but `material.map` is still a Texture object, so a
 * null check sees a perfectly good map and skips it. The mesh then samples an
 * empty texture and renders black.
 */
function isBroken(t: THREE.Texture | null | undefined): boolean {
  if (t == null) return true;
  const img = t.image as { width?: number; height?: number } | undefined | null;
  if (img == null) return true;
  return (img.width ?? 0) === 0 || (img.height ?? 0) === 0;
}

export interface RescueResult {
  /** The material slots that have no working texture, so callers know whether
   *  to prompt for one. Empty when the model is fully textured. */
  brokenSlots: number;
  /** The texture applied, if any (only ever a user's manual choice). */
  applied: string | null;
  /** Every nearby image, offered in the picker alongside Browse. */
  candidates: string[];
}

/**
 * Fill a model's broken texture slots with the user's chosen atlas, if they
 * have picked one for this pack.
 *
 * There is NO automatic guessing. Synty OBJ ship no .mtl and Synty FBX bake
 * absolute authoring paths whose file isn't even in the pack, so any auto-pick
 * is a guess — and a wrong texture (the wrong colourway, a normal map as
 * albedo) looks worse than an honest grey model. So we only apply what the
 * user explicitly chose in the picker (a nearby candidate or a browsed file),
 * and otherwise leave the model untextured and report the candidates so the UI
 * can offer them.
 */
export async function rescueTextures(root: THREE.Object3D, path: string): Promise<RescueResult> {
  const empty: THREE.MeshStandardMaterial[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if ((m as unknown as { isMesh?: boolean }).isMesh !== true) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      const s = mat as THREE.MeshStandardMaterial;
      if (isBroken(s.map)) empty.push(s);
    }
  });
  if (empty.length === 0) return { brokenSlots: 0, applied: null, candidates: [] };

  const hints = await invoke<TextureHints>("model_texture_hints", { path });
  const manual = atlasFor(path);
  if (manual === undefined) {
    // No choice yet — leave it grey and hand the candidates to the picker.
    return { brokenSlots: empty.length, applied: null, candidates: hints.candidates };
  }

  const tex = await new THREE.TextureLoader().loadAsync(modelUrl(manual.path));
  tex.colorSpace = THREE.SRGBColorSpace;
  // flipY is exposed in the picker rather than inferred: on a palette/ramp
  // atlas a wrong flip is not a mirrored image, it samples a different COLOUR,
  // so the textbook FBX/OBJ rule is not reliable. Default false, user overrides.
  tex.flipY = manual.flipY;
  applyTexture(empty, tex);
  return { brokenSlots: empty.length, applied: manual.path, candidates: hints.candidates };
}

/** Assign `tex` as base color on `mats`, unlit-safe. Exported so the manual
 *  picker can reuse it without re-running the search. */
export function applyTexture(mats: THREE.MeshStandardMaterial[], tex: THREE.Texture): void {
  for (const m of mats) {
    // Dispose the dead texture we are replacing, or its blob/image lingers.
    if (m.map != null && m.map !== tex) m.map.dispose();
    m.map = tex;
    // FBXLoader hands back Phong/Lambert with a dark diffuse baked in, which
    // multiplies the atlas to near-black — the "FBX renders black" symptom.
    // Reset it to white so the texture shows as authored.
    if (m.color !== undefined) m.color.set(0xffffff);
    m.needsUpdate = true;
  }
}
