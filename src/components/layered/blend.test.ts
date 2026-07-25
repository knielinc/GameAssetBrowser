import { describe, expect, it } from "vitest";
import { blendPixels, canvasOp, needsPixelBlend, normalizeBlend } from "./blend";
import { childrenOf, hiddenEff, type LayerNode } from "./types";

/** One opaque pixel, as the blender wants it. */
const px = (r: number, g: number, b: number, a = 255): Uint8ClampedArray =>
  new Uint8ClampedArray([r, g, b, a]);

describe("normalizeBlend", () => {
  it("folds the three formats' spellings of a mode onto one key", () => {
    // Photoshop / Aseprite / Krita respectively.
    expect(normalizeBlend("color burn")).toBe("colorBurn");
    expect(normalizeBlend("ColorBurn")).toBe("colorBurn");
    expect(normalizeBlend("burn")).toBe("colorBurn");
    expect(normalizeBlend("linear dodge")).toBe("linearDodge");
    expect(normalizeBlend("addition")).toBe("linearDodge");
    expect(normalizeBlend("add")).toBe("linearDodge");
    expect(normalizeBlend("soft_light_svg")).toBe("softLight");
    expect(normalizeBlend("luminize_hsl")).toBe("luminosity");
    expect(normalizeBlend("diff")).toBe("difference");
  });

  it("falls back to normal for anything it doesn't know", () => {
    expect(normalizeBlend("greater")).toBe("normal");
    expect(normalizeBlend(undefined)).toBe("normal");
    expect(normalizeBlend("")).toBe("normal");
  });

  it("keeps pass-through distinguishable so groups can opt out of isolation", () => {
    expect(normalizeBlend("pass through")).toBe("passThrough");
  });
});

describe("canvasOp", () => {
  it("hands the spec modes to canvas and keeps the rest for the pixel path", () => {
    expect(canvasOp("multiply")).toBe("multiply");
    expect(canvasOp("colorDodge")).toBe("color-dodge");
    expect(canvasOp("linearDodge")).toBe("lighter");
    expect(canvasOp("passThrough")).toBe("source-over");
    for (const key of ["linearBurn", "vividLight", "pinLight", "hardMix", "subtract", "divide", "darkerColor", "lighterColor"] as const) {
      expect(needsPixelBlend(key)).toBe(true);
    }
  });
});

describe("blendPixels", () => {
  it("subtracts and divides the way Aseprite does", () => {
    const dst = px(200, 100, 50);
    blendPixels(dst, px(50, 50, 50), "subtract", 1);
    expect([dst[0], dst[1], dst[2]]).toEqual([150, 50, 0]);

    const div = px(128, 255, 0);
    blendPixels(div, px(128, 128, 128), "divide", 1);
    // 128/128 = 1, 255/128 clamps to 1, 0/128 = 0.
    expect(div[0]).toBeGreaterThan(250);
    expect(div[1]).toBe(255);
    expect(div[2]).toBe(0);
  });

  it("divides by zero the way Photoshop does: 0/0 is black, x/0 is white", () => {
    // Checked against Photoshop's own composite for the `psd` crate fixture
    // tests/fixtures/blending/blue-red-1x1-divide.psd, where a channel with
    // both backdrop and source at 0 must come out black. Returning white there
    // put that channel 65/255 out.
    const both = px(0, 255, 0);
    blendPixels(both, px(0, 0, 0), "divide", 1);
    expect(both[0]).toBe(0); // 0 / 0 -> black
    expect(both[1]).toBe(255); // 255 / 0 -> white
  });

  it("implements linear burn as b + s - 1", () => {
    const dst = px(255, 128, 0);
    blendPixels(dst, px(128, 128, 128), "linearBurn", 1);
    expect(dst[0]).toBeGreaterThan(126); // 1.0 + 0.5 - 1 = 0.5
    expect(dst[0]).toBeLessThan(130);
    expect(dst[2]).toBe(0); // clamped at the bottom
  });

  it("picks whole colours by luma for darker/lighter colour", () => {
    // Source is darker overall, so darkerColor takes ALL of it — including the
    // channel where it is the brighter of the two.
    const dst = px(200, 200, 200);
    blendPixels(dst, px(10, 10, 250), "darkerColor", 1);
    expect([dst[0], dst[1], dst[2]]).toEqual([10, 10, 250]);

    const up = px(10, 10, 10);
    blendPixels(up, px(200, 200, 0), "lighterColor", 1);
    expect([up[0], up[1], up[2]]).toEqual([200, 200, 0]);
  });

  it("respects layer opacity", () => {
    const dst = px(0, 0, 0);
    blendPixels(dst, px(255, 255, 255), "subtract", 0.5);
    // Backdrop stays black under subtract, so half-opacity keeps it black.
    expect(dst[0]).toBe(0);

    const half = px(0, 0, 0);
    blendPixels(half, px(255, 255, 255), "divide", 0.5);
    // 0/1 = 0 as well — divide of black by white is black.
    expect(half[0]).toBe(0);
  });

  it("leaves the backdrop alone where the source is transparent", () => {
    const dst = px(12, 34, 56);
    blendPixels(dst, px(255, 255, 255, 0), "subtract", 1);
    expect([dst[0], dst[1], dst[2], dst[3]]).toEqual([12, 34, 56, 255]);
  });

  it("composites onto a transparent backdrop without darkening it", () => {
    // Ab = 0, so the result must be the plain source, not the blend.
    const dst = px(0, 0, 0, 0);
    blendPixels(dst, px(200, 100, 50), "subtract", 1);
    expect([dst[0], dst[1], dst[2], dst[3]]).toEqual([200, 100, 50, 255]);
  });
});

describe("layer tree helpers", () => {
  const layer = (parent: number, isGroup = false): LayerNode => ({
    name: "l",
    kind: isGroup ? "group" : "paint",
    opacity: 1,
    blend: "normal",
    visible: true,
    depth: 0,
    isGroup,
    parent,
    clip: false,
    passthrough: false,
    masked: false,
    inert: false,
  });

  //  0 group
  //  ├ 1 group
  //  │ └ 2 paint
  //  └ 3 paint
  const layers = [layer(-1, true), layer(0, true), layer(1), layer(0)];

  it("lists a group's direct children in tree order", () => {
    expect(childrenOf(layers, -1)).toEqual([0]);
    expect(childrenOf(layers, 0)).toEqual([1, 3]);
    expect(childrenOf(layers, 1)).toEqual([2]);
  });

  it("treats a layer under a hidden ancestor as hidden", () => {
    expect(hiddenEff(2, layers, new Set([1]))).toBe(true);
    expect(hiddenEff(2, layers, new Set([0]))).toBe(true);
    expect(hiddenEff(2, layers, new Set([3]))).toBe(false);
  });

  it("does not hang on a malformed parent cycle", () => {
    const cyclic = [layer(1), layer(0)];
    expect(hiddenEff(0, cyclic, new Set())).toBe(false);
  });
});
