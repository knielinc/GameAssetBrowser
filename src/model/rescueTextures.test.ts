/**
 * Atlas matching for models whose own texture references are broken.
 * Every case here is taken from the real Synty POLYGON_Nature pack.
 */
import { describe, expect, it } from "vitest";
import { pickAtlas } from "./rescueTextures";

const TEX = "C:\\Downloads\\POLYGON_Nature_Source_Files_v2\\Source Files\\Textures";
const FBX = "C:\\Downloads\\POLYGON_Nature_Source_Files_v2\\Source Files\\FBX\\SM_Plant_01.fbx";
const OBJ = "C:\\Downloads\\POLYGON_Nature_Source_Files_v2\\Source Files\\OBJ\\SM_Plant_01.obj";
const ATLASES = [1, 2, 3, 4].map((n) => `${TEX}\\PolygonNature_0${n}.png`);

describe("pickAtlas", () => {
  it("matches a declared name exactly", () => {
    const p = pickAtlas({ declared: ["PolygonNature_02.png"], candidates: ATLASES }, FBX);
    expect(p?.path).toBe(`${TEX}\\PolygonNature_02.png`);
    expect(p?.confident).toBe(true);
  });

  it("THE Synty FBX case: declared name does not exist, stem-prefix does", () => {
    // MountainSkybox.fbx bakes U:/Dropbox/SyntyStudios/.../PolygonNature.png —
    // a file the shipped pack does not contain. It ships _01.._04.
    const p = pickAtlas({ declared: ["PolygonNature.png"], candidates: ATLASES }, FBX);
    expect(p?.path).toBe(`${TEX}\\PolygonNature_01.png`);
    expect(p?.confident).toBe(true);
  });

  it("THE Synty OBJ case: nothing declared at all, pack name resolves it", () => {
    // The pack ships no .mtl, so the OBJ names no texture. The folder
    // POLYGON_Nature_Source_Files_v2 is the only signal — and it is a good one.
    const p = pickAtlas({ declared: [], candidates: ATLASES }, OBJ);
    expect(p?.path).toBe(`${TEX}\\PolygonNature_01.png`);
    expect(p?.confident).toBe(false); // a guess, and labelled as one
  });

  it("never auto-assigns a normal map as base color", () => {
    const p = pickAtlas(
      { declared: [], candidates: [`${TEX}\\Cliffwall_normals.png`] },
      FBX,
    );
    expect(p).toBeNull();
  });

  it("takes the only candidate when there is exactly one", () => {
    const p = pickAtlas({ declared: [], candidates: [`${TEX}\\Atlas.png`] }, FBX);
    expect(p?.path).toBe(`${TEX}\\Atlas.png`);
    expect(p?.confident).toBe(false);
  });

  it("refuses to guess between unrelated candidates — grey beats wrong", () => {
    const p = pickAtlas(
      { declared: [], candidates: [`${TEX}\\Rock.png`, `${TEX}\\Wood.png`, `${TEX}\\Sand.png`] },
      "C:\\Some\\Unrelated\\model.fbx",
    );
    expect(p).toBeNull();
  });

  it("ignores short path segments like OBJ / FBX / v2 as pack-name evidence", () => {
    // `obj` must not match an atlas called `obj_something`.
    const p = pickAtlas({ declared: [], candidates: [`${TEX}\\Objects.png`, `${TEX}\\Zebra.png`] }, OBJ);
    expect(p).toBeNull();
  });

  it("returns null when nothing is nearby", () => {
    expect(pickAtlas({ declared: ["x.png"], candidates: [] }, FBX)).toBeNull();
  });
});
