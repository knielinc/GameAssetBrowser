import { describe, expect, it } from "vitest";
import type { Layer } from "ag-psd";
import { blurPlane, edtSq, gradientTable, renderEffects, toRgb } from "./fx";

describe("edtSq", () => {
  it("measures squared distance to the nearest inside pixel", () => {
    // 5x1 with the middle pixel inside.
    const inside = new Uint8Array([0, 0, 1, 0, 0]);
    const d = edtSq(inside, 5, 1);
    expect([...d]).toEqual([4, 1, 0, 1, 4]);
  });

  it("works in two dimensions", () => {
    const inside = new Uint8Array(9);
    inside[4] = 1; // centre of 3x3
    const d = edtSq(inside, 3, 3);
    expect(d[0]).toBe(2); // corner: 1² + 1²
    expect(d[1]).toBe(1);
    expect(d[4]).toBe(0);
  });
});

describe("blurPlane", () => {
  it("preserves total mass away from edges", () => {
    const w = 41;
    const h = 41;
    const p = new Float32Array(w * h);
    p[20 * w + 20] = 1;
    blurPlane(p, w, h, 8);
    let sum = 0;
    for (const v of p) sum += v;
    expect(sum).toBeGreaterThan(0.98);
    expect(sum).toBeLessThan(1.02);
    // And it actually spread out.
    expect(p[20 * w + 20]).toBeLessThan(0.05);
    expect(p[20 * w + 24]).toBeGreaterThan(0);
  });
});

describe("gradientTable", () => {
  const g = {
    name: "",
    type: "solid" as const,
    colorStops: [
      { color: { r: 0, g: 0, b: 0 }, location: 0, midpoint: 50 },
      { color: { r: 255, g: 255, b: 255 }, location: 4096, midpoint: 50 },
    ],
    opacityStops: [
      { opacity: 1, location: 0, midpoint: 50 },
      { opacity: 0, location: 4096, midpoint: 50 },
    ],
  };

  it("hits the endpoint colours and opacities exactly", () => {
    const t = gradientTable(g, false);
    expect(t.rgb[0]).toBe(0);
    expect(t.rgb[255 * 3]).toBe(255);
    expect(t.alpha[0]).toBe(1);
    expect(t.alpha[255]).toBe(0);
  });

  it("reverses", () => {
    const t = gradientTable(g, true);
    expect(t.rgb[0]).toBe(255);
    expect(t.rgb[255 * 3]).toBe(0);
  });

  it("skews interpolation by the midpoint", () => {
    const skewed = gradientTable(
      { ...g, colorStops: [{ ...g.colorStops[0], midpoint: 25 }, g.colorStops[1]] },
      false,
    );
    // Midpoint 25% → the 50% grey arrives already at a quarter of the way.
    expect(skewed.rgb[64 * 3]).toBeGreaterThan(115);
    expect(skewed.rgb[64 * 3]).toBeLessThan(140);
  });
});

describe("toRgb", () => {
  it("reads descriptor floats and grayscale black-percent", () => {
    expect(toRgb({ r: 129.0019, g: 10, b: 0 })[0]).toBeCloseTo(129.0019);
    expect(toRgb({ k: 100 })).toEqual([0, 0, 0]);
    expect(toRgb({ k: 0 })).toEqual([255, 255, 255]);
    expect(toRgb(undefined)).toEqual([0, 0, 0]);
  });
});

describe("renderEffects", () => {
  /** A 10x10 opaque white square at canvas (50, 50). */
  const square = (): { data: Uint8ClampedArray; w: number; h: number; x: number; y: number } => {
    const data = new Uint8ClampedArray(10 * 10 * 4).fill(255);
    return { data, w: 10, h: 10, x: 50, y: 50 };
  };
  const layerWith = (effects: Record<string, unknown>): Layer => ({ effects }) as unknown as Layer;

  it("offsets a drop shadow along the light angle", () => {
    // Angle 90 = light from above → shadow displaced DOWN.
    const fill = square();
    const { draws } = renderEffects(
      layerWith({
        dropShadow: [
          {
            enabled: true,
            present: true,
            color: { r: 0, g: 0, b: 0 },
            blendMode: "multiply",
            opacity: 0.5,
            angle: 90,
            useGlobalLight: false,
            distance: { value: 6, units: "Pixels" },
            size: { value: 0, units: "Pixels" },
            layerConceals: false,
          },
        ],
      }),
      fill,
      120,
    );
    expect(draws).toHaveLength(1);
    const d = draws[0];
    expect(d.under).toBe(true);
    expect(d.blend).toBe("multiply");
    // The shadow body sits 6px below the fill's own rect.
    expect(d.y).toBeGreaterThanOrEqual(55);
    expect(d.x).toBeCloseTo(50, 0);
  });

  it("draws an outside stroke as a band around the shape, on top", () => {
    const fill = square();
    const { draws } = renderEffects(
      layerWith({
        stroke: [
          {
            enabled: true,
            present: true,
            color: { r: 255, g: 0, b: 0 },
            blendMode: "normal",
            opacity: 1,
            position: "outside",
            fillType: "color",
            size: { value: 3, units: "Pixels" },
          },
        ],
      }),
      fill,
      120,
    );
    expect(draws).toHaveLength(1);
    const s = draws[0];
    expect(s.under).toBe(false);
    // Band surrounds the 10x10 shape: roughly 16x16 around (47, 47).
    expect(s.w).toBeGreaterThanOrEqual(14);
    expect(s.x).toBeLessThan(50);
    // The band is hollow: its centre (over the shape) is transparent.
    const cx = 50 + 5 - s.x;
    const cy = 50 + 5 - s.y;
    expect(s.rgba[(cy * s.w + cx) * 4 + 3]).toBe(0);
  });

  it("bakes a colour overlay into the fill without touching alpha", () => {
    const fill = square();
    fill.data[3] = 128; // one semi-transparent pixel
    renderEffects(
      layerWith({
        solidFill: [
          {
            enabled: true,
            present: true,
            color: { r: 0, g: 51, b: 153 },
            blendMode: "normal",
            opacity: 1,
          },
        ],
      }),
      fill,
      120,
    );
    expect(fill.data[0]).toBe(0);
    expect(fill.data[1]).toBe(51);
    expect(fill.data[2]).toBe(153);
    expect(fill.data[3]).toBe(128); // coverage untouched
  });

  /** An outside stroke of `size`, under a style carrying `scale`. */
  const strokeWidth = (size: { value: number; units: string }, scale: number): number => {
    const fill = square();
    const { draws } = renderEffects(
      layerWith({
        scale,
        stroke: [
          {
            enabled: true,
            present: true,
            color: { r: 255, g: 0, b: 0 },
            blendMode: "normal",
            opacity: 1,
            position: "outside",
            fillType: "color",
            size,
          },
        ],
      }),
      fill,
      120,
    );
    // The band's box is the 10px shape plus `width` on each side.
    return (draws[0].w - 10) / 2;
  };

  it("does not rescale a size that is already in pixels", () => {
    // `effects.scale` is documentResolution/72, not a style scale: a 3px stroke
    // is 3px whether the document is 72 or 150 dpi. Treating it as a blanket
    // multiplier doubled every effect on a 150 dpi file.
    const at72 = strokeWidth({ value: 3, units: "Pixels" }, 1);
    const at150 = strokeWidth({ value: 3, units: "Pixels" }, 150 / 72);
    expect(at150).toBe(at72);
    expect(at72).toBeGreaterThanOrEqual(3);
    expect(at72).toBeLessThanOrEqual(4);
  });

  it("converts a size that is not in pixels using the document scale", () => {
    const pts = strokeWidth({ value: 3, units: "Points" }, 2);
    const px = strokeWidth({ value: 3, units: "Pixels" }, 2);
    expect(pts).toBeGreaterThan(px);
    expect(pts).toBeCloseTo(px * 2, 0);
  });

  it("reports pattern overlays as skipped instead of guessing", () => {
    const fill = square();
    const { draws, skipped } = renderEffects(
      layerWith({ patternOverlay: { enabled: true, present: true } }),
      fill,
      120,
    );
    expect(draws).toHaveLength(0);
    expect(skipped).toContain("patternOverlay");
  });

  it("does nothing when the whole style is disabled", () => {
    const fill = square();
    const before = [...fill.data.slice(0, 8)];
    const { draws } = renderEffects(
      layerWith({ disabled: true, solidFill: [{ enabled: true, color: { r: 1, g: 2, b: 3 } }] }),
      fill,
      120,
    );
    expect(draws).toHaveLength(0);
    expect([...fill.data.slice(0, 8)]).toEqual(before);
  });
});
