import { create } from "zustand";

/**
 * Manual atlas assignment, keyed by PACK directory.
 *
 * Auto-detection genuinely cannot solve this, and it is worth being precise
 * about why rather than trying a fourth heuristic:
 *
 *  - Synty OBJ ship no .mtl at all — no material data exists to read.
 *  - Synty FBX bake an absolute authoring path
 *    (`U:/Dropbox/SyntyStudios/.../PolygonNature.png`) whose basename is not
 *    even in the shipped pack — it ships `PolygonNature_01..04.png`.
 *  - Those four variants share one layout and differ only in colour, so no
 *    amount of pixel sampling distinguishes "the right one": measured against
 *    a real bridge's UVs, all four put 19–28% of samples on the atlas's black
 *    region under either flipY.
 *
 * The information is not in the files. It is in the user's head. So ask once
 * per pack and remember.
 *
 * Keyed by pack directory, not by model: a Synty pack is one-atlas-per-pack by
 * construction, so picking once fixes all 400 models in it.
 */
export interface AtlasChoice {
  /** Absolute path of the texture to use as base color. */
  path: string;
  /**
   * Y-orientation. Exposed rather than inferred because the textbook rule
   * (FBX/OBJ = bottom-left origin = flipY true) does not survive contact with
   * these packs, and on a palette/ramp atlas a wrong flip is not a mirrored
   * image — it is a different colour, which reads as "the app is broken".
   */
  flipY: boolean;
}

interface AtlasState {
  /** packDir (lowercased) -> choice */
  overrides: Record<string, AtlasChoice>;
  setOverride: (packDir: string, choice: AtlasChoice) => void;
  clearOverride: (packDir: string) => void;
  hydrate: (overrides: Record<string, AtlasChoice>) => void;
}

export const useAtlasStore = create<AtlasState>()((set) => ({
  overrides: {},
  setOverride: (packDir, choice) =>
    set((s) => ({ overrides: { ...s.overrides, [packDir.toLowerCase()]: choice } })),
  clearOverride: (packDir) =>
    set((s) => {
      const next = { ...s.overrides };
      delete next[packDir.toLowerCase()];
      return { overrides: next };
    }),
  hydrate: (overrides) => set({ overrides }),
}));

/**
 * The pack directory a model belongs to.
 *
 * Synty's layout is `<Pack>/Source Files/{FBX,OBJ}/model.fbx` with the atlas at
 * `<Pack>/Source Files/Textures/`. Walking up past the format folder to the
 * shared parent is what makes one pick cover both the FBX and the OBJ copies
 * of every model — pick on the FBX, the OBJ is fixed too.
 */
export function packDirOf(modelPath: string): string {
  const parts = modelPath.split(/[\\/]/);
  parts.pop(); // filename
  const last = parts[parts.length - 1]?.toLowerCase();
  // A format-named leaf (FBX/, OBJ/, Models/) is a container, not the pack.
  if (last === "fbx" || last === "obj" || last === "models" || last === "meshes") {
    parts.pop();
  }
  return parts.join("\\");
}

/** The choice for `modelPath`, if the user has made one for its pack. */
export function atlasFor(modelPath: string): AtlasChoice | undefined {
  return useAtlasStore.getState().overrides[packDirOf(modelPath).toLowerCase()];
}
