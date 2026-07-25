import { describe, expect, it } from "vitest";
import { readCelPack } from "./celPack";
import { applyMask, toRgba8 } from "./psdMask";
import type { Layer } from "ag-psd";

/**
 * Build a pack byte-for-byte the way `layered::pack_cels` does. If this and the
 * Rust writer ever disagree the reader stops finding cels and the preview
 * silently renders nothing, so the layout is pinned from both sides — this
 * mirrors the `pack_layout_is_header_records_payload` test in layered.rs.
 */
function buildPack(
  cels: { layer: number; frame: number; x: number; y: number; w: number; h: number; rgba: number[] }[],
): ArrayBuffer {
  const payload = cels.reduce((n, c) => n + c.rgba.length, 0);
  const buf = new ArrayBuffer(8 + 32 * cels.length + payload);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  view.setUint32(0, 0x3152594c, true); // "LYR1"
  view.setUint32(4, cels.length, true);
  let offset = 0;
  cels.forEach((c, i) => {
    const o = 8 + i * 32;
    view.setInt32(o, c.layer, true);
    view.setUint32(o + 4, c.frame, true);
    view.setInt32(o + 8, c.x, true);
    view.setInt32(o + 12, c.y, true);
    view.setUint32(o + 16, c.w, true);
    view.setUint32(o + 20, c.h, true);
    view.setUint32(o + 24, offset, true);
    view.setUint32(o + 28, c.rgba.length, true);
    bytes.set(c.rgba, 8 + 32 * cels.length + offset);
    offset += c.rgba.length;
  });
  return buf;
}

describe("readCelPack", () => {
  it("reads records and their pixels back out", () => {
    const buf = buildPack([
      { layer: 0, frame: 0, x: 5, y: -3, w: 1, h: 1, rgba: [10, 20, 30, 40] },
      { layer: 7, frame: 2, x: 0, y: 0, w: 2, h: 1, rgba: [1, 2, 3, 4, 5, 6, 7, 8] },
    ]);
    const cels = readCelPack(buf);
    expect(cels).toHaveLength(2);
    expect(cels[0]).toMatchObject({ layer: 0, frame: 0, x: 5, y: -3, width: 1, height: 1 });
    expect([...cels[0].pixels]).toEqual([10, 20, 30, 40]);
    expect(cels[1]).toMatchObject({ layer: 7, frame: 2, width: 2, height: 1 });
    expect([...cels[1].pixels]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("keeps the merged sentinel layer index negative", () => {
    const buf = buildPack([{ layer: -1, frame: 0, x: 0, y: 0, w: 1, h: 1, rgba: [0, 0, 0, 255] }]);
    expect(readCelPack(buf)[0].layer).toBe(-1);
  });

  it("rejects a buffer that isn't a pack", () => {
    expect(() => readCelPack(new ArrayBuffer(8))).toThrow(/not a cel pack/);
  });

  it("drops a record whose geometry doesn't add up instead of the whole document", () => {
    const buf = buildPack([
      { layer: 0, frame: 0, x: 0, y: 0, w: 1, h: 1, rgba: [1, 2, 3, 4] },
      { layer: 1, frame: 0, x: 0, y: 0, w: 1, h: 1, rgba: [1, 2, 3, 4] },
    ]);
    // Corrupt the second record's length so it no longer matches w*h*4.
    new DataView(buf).setUint32(8 + 32 + 28, 3, true);
    const cels = readCelPack(buf);
    expect(cels).toHaveLength(1);
    expect(cels[0].layer).toBe(0);
  });
});

// ---------------------------------------------------------------------------

/** A 2x1 opaque white layer at (0,0), plus whatever mask the test supplies. */
function layerWithMask(mask: Layer["mask"]): { layer: Layer; rgba: Uint8ClampedArray } {
  const layer = { left: 0, top: 0, right: 2, bottom: 1, mask } as Layer;
  return { layer, rgba: new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]) };
}

/** A mask image of `values`, one byte per pixel expanded to ag-psd's RGBA. */
function maskData(values: number[], width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  values.forEach((v, i) => {
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  });
  return { data, width, height };
}

describe("applyMask", () => {
  it("multiplies the mask into the layer's alpha", () => {
    const { layer, rgba } = layerWithMask({
      left: 0,
      top: 0,
      right: 2,
      bottom: 1,
      imageData: maskData([0, 128], 2, 1),
    });
    applyMask(layer, rgba, 2, 1);
    expect(rgba[3]).toBe(0); // fully masked out
    expect(rgba[7]).toBe(128); // half hidden
  });

  it("leaves the layer alone when the mask is disabled", () => {
    const { layer, rgba } = layerWithMask({
      left: 0,
      top: 0,
      right: 2,
      bottom: 1,
      disabled: true,
      imageData: maskData([0, 0], 2, 1),
    });
    applyMask(layer, rgba, 2, 1);
    expect([rgba[3], rgba[7]]).toEqual([255, 255]);
  });

  it("hides everything outside a mask rectangle whose default colour is black", () => {
    // The mask only covers the layer's first pixel; the second falls outside.
    const { layer, rgba } = layerWithMask({
      left: 0,
      top: 0,
      right: 1,
      bottom: 1,
      defaultColor: 0,
      imageData: maskData([255], 1, 1),
    });
    applyMask(layer, rgba, 2, 1);
    expect(rgba[3]).toBe(255);
    expect(rgba[7]).toBe(0);
  });

  it("reveals everything outside the rectangle when the default colour is white", () => {
    const { layer, rgba } = layerWithMask({
      left: 0,
      top: 0,
      right: 1,
      bottom: 1,
      defaultColor: 255,
      imageData: maskData([0], 1, 1),
    });
    applyMask(layer, rgba, 2, 1);
    expect(rgba[3]).toBe(0);
    expect(rgba[7]).toBe(255);
  });

  it("offsets the mask by the layer origin when it is layer-relative", () => {
    // Layer sits at x=10. A document-space mask at left=10 lines up with it; the
    // same numbers marked layer-relative would land at x=20 and miss entirely.
    const mask = {
      left: 10,
      top: 0,
      right: 12,
      bottom: 1,
      defaultColor: 255,
      imageData: maskData([0, 0], 2, 1),
    };
    const absolute = {
      layer: { left: 10, top: 0, right: 12, bottom: 1, mask } as Layer,
      rgba: new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]),
    };
    applyMask(absolute.layer, absolute.rgba, 2, 1);
    expect([absolute.rgba[3], absolute.rgba[7]]).toEqual([0, 0]);

    const relative = {
      layer: {
        left: 10,
        top: 0,
        right: 12,
        bottom: 1,
        mask: { ...mask, positionRelativeToLayer: true },
      } as Layer,
      rgba: new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]),
    };
    applyMask(relative.layer, relative.rgba, 2, 1);
    expect([relative.rgba[3], relative.rgba[7]]).toEqual([255, 255]);
  });

  it("prefers the combined vector+user mask when Photoshop saved one", () => {
    const layer = {
      left: 0,
      top: 0,
      right: 2,
      bottom: 1,
      mask: { left: 0, top: 0, right: 2, bottom: 1, imageData: maskData([255, 255], 2, 1) },
      realMask: { left: 0, top: 0, right: 2, bottom: 1, imageData: maskData([0, 0], 2, 1) },
    } as Layer;
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
    applyMask(layer, rgba, 2, 1);
    expect([rgba[3], rgba[7]]).toEqual([0, 0]);
  });
});

describe("toRgba8", () => {
  it("passes 8-bit data straight through", () => {
    const data = new Uint8ClampedArray([1, 2, 3, 4]);
    expect(toRgba8({ data, width: 1, height: 1 })).toBe(data);
  });

  it("takes the high byte of 16-bit channels", () => {
    const data = new Uint16Array([0xffff, 0x8000, 0x0100, 0xffff]);
    const out = toRgba8({ data, width: 1, height: 1 });
    expect([...(out as Uint8ClampedArray)]).toEqual([255, 128, 1, 255]);
  });

  it("gamma-encodes float channels and leaves alpha linear", () => {
    const data = new Float32Array([1, 0, 0.5, 1]);
    const out = toRgba8({ data, width: 1, height: 1 }) as Uint8ClampedArray;
    expect(out[0]).toBe(255);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeGreaterThan(180); // 0.5 ^ (1/2.2) ≈ 0.73
    expect(out[3]).toBe(255);
  });

  it("refuses a CMYK layer's five channels rather than drawing garbage", () => {
    const data = new Uint8ClampedArray(5);
    expect(toRgba8({ data, width: 1, height: 1 })).toBeNull();
  });
});
