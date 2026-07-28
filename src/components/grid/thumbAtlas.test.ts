import { describe, expect, it } from "vitest";
import { ThumbAtlas } from "./thumbAtlas";

/** Layers in the atlas — mirrors the constant in thumbAtlas.ts. */
const LAYERS = 512;

/** The handful of WebGL2 calls ThumbAtlas makes, stubbed out. Nothing here is
 *  asserted on: `upload` returns the layer it chose, and that is the behaviour
 *  these tests are about. */
function fakeGL(): WebGL2RenderingContext {
  const noop = (): void => undefined;
  return {
    TEXTURE_2D_ARRAY: 1,
    RGBA8: 2,
    TEXTURE_MIN_FILTER: 3,
    TEXTURE_MAG_FILTER: 4,
    TEXTURE_WRAP_S: 5,
    TEXTURE_WRAP_T: 6,
    LINEAR: 7,
    NEAREST: 8,
    CLAMP_TO_EDGE: 9,
    UNPACK_ALIGNMENT: 10,
    RGBA: 11,
    UNSIGNED_BYTE: 12,
    createTexture: () => ({}) as WebGLTexture,
    bindTexture: noop,
    texStorage3D: noop,
    texParameteri: noop,
    pixelStorei: noop,
    texSubImage3D: noop,
    deleteTexture: noop,
  } as unknown as WebGL2RenderingContext;
}

const px = new Uint8Array(4);
const put = (a: ThumbAtlas, key: string): number => a.upload(key, 256, 256, px).layer;

/**
 * A full atlas plus the layer each key landed in. The layers are captured at
 * fill time on purpose: `slot()` is itself a use, so reading one back later to
 * find out where a key lives would change the very order under test.
 */
function filled(): { atlas: ThumbAtlas; layerOf: Map<string, number> } {
  const atlas = new ThumbAtlas(fakeGL());
  const layerOf = new Map<string, number>();
  for (let i = 0; i < LAYERS; i++) layerOf.set(`k${i}`, put(atlas, `k${i}`));
  return { atlas, layerOf };
}

describe("ThumbAtlas layer recycling", () => {
  it("gives every new key its own layer until the atlas is full", () => {
    const { layerOf } = filled();
    expect(new Set(layerOf.values()).size).toBe(LAYERS);
  });

  it("reuses a key's own layer when it is uploaded again", () => {
    const atlas = new ThumbAtlas(fakeGL());
    const first = put(atlas, "a");
    expect(put(atlas, "a")).toBe(first);
    expect(atlas.slot("a")?.layer).toBe(first);
  });

  it("evicts the least-recently-used key and recycles its layer", () => {
    const { atlas, layerOf } = filled();
    // Nothing touched since the fill, so k0 is the oldest.
    expect(put(atlas, "fresh")).toBe(layerOf.get("k0"));
    expect(atlas.has("k0")).toBe(false);
    expect(atlas.slot("fresh")?.layer).toBe(layerOf.get("k0"));
  });

  it("counts slot() as a use, so a cell still on screen is not evicted", () => {
    const { atlas, layerOf } = filled();
    atlas.slot("k0"); // a visible cell reads its slot every frame
    // k0 moved to the back, so k1 is now the victim.
    expect(put(atlas, "fresh")).toBe(layerOf.get("k1"));
    expect(atlas.has("k1")).toBe(false);
    expect(atlas.has("k0")).toBe(true);
  });

  it("counts re-uploading a key as a use too", () => {
    const { atlas, layerOf } = filled();
    put(atlas, "k0"); // same key, fresh pixels
    expect(put(atlas, "fresh")).toBe(layerOf.get("k1"));
    expect(atlas.has("k0")).toBe(true);
  });

  it("evicts in order across several insertions", () => {
    const { atlas, layerOf } = filled();
    expect(put(atlas, "a")).toBe(layerOf.get("k0"));
    expect(put(atlas, "b")).toBe(layerOf.get("k1"));
    expect(put(atlas, "c")).toBe(layerOf.get("k2"));
    // The newcomers are the most recent, so they survive.
    for (const k of ["a", "b", "c"]) expect(atlas.has(k)).toBe(true);
  });

  it("records the image's extent within its layer for letterboxing", () => {
    const atlas = new ThumbAtlas(fakeGL());
    const slot = atlas.upload("wide", 256, 128, px);
    expect(slot.uw).toBeCloseTo(1);
    expect(slot.uh).toBeCloseTo(0.5);
  });
});
