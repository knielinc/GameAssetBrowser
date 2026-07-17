import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import { atlasFor } from "../stores/atlasStore";
import { modelUrl } from "./loadModel";

interface TextureHints {
  declared: string[];
  candidates: string[];
}

const stem = (p: string): string => {
  const base = p.split(/[\\/]/).pop() ?? p;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
};

/** Suffixes that mean "this is NOT the base color". Never auto-assign one as
 *  albedo — a normal map on a diffuse slot looks worse than untextured. */
const NON_ALBEDO = /(_|-)?(normals?|nrm|nor|rough(ness)?|metal(lic|ness)?|ao|occlusion|height|disp(lacement)?|mask|emissive|emission|spec(ular)?|orm|arm|opacity|alpha)$/i;

/**
 * Pick the atlas for a model whose own texture references are broken.
 *
 * Ranked, most-defensible first:
 *  1. A candidate whose stem EXACTLY matches a declared name.
 *  2. A candidate whose stem starts with a declared stem. This is the Synty
 *     case: the FBX declares `PolygonNature.png`, the pack ships
 *     `PolygonNature_01.png`. The artist's working file was unnumbered.
 *  3. A declared stem that starts with a candidate stem (the reverse).
 *  4. Exactly one plausible candidate nearby and nothing declared — the OBJ
 *     case, where the pack ships no .mtl at all. A guess, but a Synty pack is
 *     one-atlas-per-pack by construction, so it is a good one.
 *
 * Returns null rather than guessing badly. Grey is better than wrong.
 */
export function pickAtlas(
  hints: TextureHints,
  modelPath = "",
): { path: string; confident: boolean } | null {
  const albedo = hints.candidates.filter((c) => !NON_ALBEDO.test(stem(c)));
  if (albedo.length === 0) return null;

  const declaredStems = hints.declared.map(stem).filter((s) => !NON_ALBEDO.test(s));

  for (const d of declaredStems) {
    const exact = albedo.find((c) => stem(c) === d);
    if (exact !== undefined) return { path: exact, confident: true };
  }
  for (const d of declaredStems) {
    // Longest match wins, so `PolygonNature` prefers `PolygonNature_01` over
    // a shorter coincidental prefix.
    const pref = albedo
      .filter((c) => stem(c).startsWith(d))
      .sort((a, b) => stem(a).length - stem(b).length)[0];
    if (pref !== undefined) return { path: pref, confident: true };
  }
  for (const d of declaredStems) {
    const rev = albedo.find((c) => d.startsWith(stem(c)));
    if (rev !== undefined) return { path: rev, confident: true };
  }
  // 4. Nothing usable declared — the OBJ case (no .mtl at all), and also most
  //    of the Synty FBX, which name no texture either. Fall back to the PACK
  //    NAME: `POLYGON_Nature_Source_Files_v2` -> `polygonnature` matches
  //    `PolygonNature_01.png`. Synty is one-atlas-per-pack by construction, so
  //    the folder name is a real signal, not a coincidence.
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const ancestors = modelPath.split(/[\\/]/).filter(Boolean).map(norm);
  const scored = albedo
    .map((c) => {
      const cs = norm(stem(c));
      // Longest ancestor that the candidate's stem starts with, or vice versa.
      let best = 0;
      for (const a of ancestors) {
        if (a.length < 5) continue; // "obj", "fbx", "v2" are noise
        if (cs.startsWith(a) || a.startsWith(cs)) best = Math.max(best, Math.min(a.length, cs.length));
      }
      return { path: c, score: best };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (scored.length > 0) return { path: scored[0]!.path, confident: false };

  // 5. Exactly one plausible image nearby — nothing else it could be.
  if (albedo.length === 1) return { path: albedo[0]!, confident: false };

  // 6. Several candidates that are clearly variants of one atlas
  //    (PolygonNature_01..04) — take the first. Distinct names = we cannot
  //    know which, so leave it. Grey beats wrong.
  const stems = albedo.map((c) => norm(stem(c)));
  const shared = stems.every((s) => s.startsWith(stems[0]!.slice(0, 6)));
  if (shared && stems[0]!.length >= 6) {
    return { path: [...albedo].sort()[0]!, confident: false };
  }
  return null;
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
  /** The texture applied, if any. */
  applied: string | null;
  /** False when it was a one-candidate guess rather than a name match. */
  confident: boolean;
  /** Every nearby image, for the manual picker. */
  candidates: string[];
  /** True when the user picked this, rather than the heuristic. */
  manual?: boolean;
}

/**
 * Apply an atlas to every material on `root` that has no base color map.
 *
 * Only fills EMPTY slots — a model whose textures resolved correctly is never
 * touched.
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
  if (empty.length === 0) return { applied: null, confident: true, candidates: [] };

  const hints = await invoke<TextureHints>("model_texture_hints", { path });

  // A manual choice always wins. The heuristic below is a convenience for the
  // first look; the user's pick is ground truth, and re-guessing over it would
  // be infuriating.
  const manual = atlasFor(path);
  const pick: { path: string; confident: boolean } | null =
    manual !== undefined ? { path: manual.path, confident: true } : pickAtlas(hints, path);
  if (pick === null) return { applied: null, confident: true, candidates: hints.candidates };

  const tex = await new THREE.TextureLoader().loadAsync(modelUrl(pick.path));
  tex.colorSpace = THREE.SRGBColorSpace;
  // flipY defaults false, established empirically and NOT from first
  // principles — the textbook rule (FBX/OBJ = bottom-left origin = flipY true)
  // was tried and made the Synty OBJ worse. On a palette/ramp atlas a wrong
  // flip is not a mirrored image, it is a different COLOUR, which is why it is
  // so easy to reason your way into backwards. The user can override it.
  tex.flipY = manual?.flipY ?? false;
  applyTexture(empty, tex);
  return {
    applied: pick.path,
    confident: pick.confident,
    candidates: hints.candidates,
    manual: manual !== undefined,
  };
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
