import { describe, expect, it } from "vitest";
import { applyAdjustment, buildAdjustment, curveFn, levelsFn } from "./adjustment";

/** Read one channel out of a 256xRGBA table. */
const at = (lut: Uint8Array, v: number, ch = 0): number => lut[v * 4 + ch];

describe("levelsFn", () => {
  it("is the identity for default settings", () => {
    const f = levelsFn({
      shadowInput: 0,
      highlightInput: 255,
      shadowOutput: 0,
      highlightOutput: 255,
      midtoneInput: 1,
    });
    expect(Math.round(f(0))).toBe(0);
    expect(Math.round(f(128))).toBe(128);
    expect(Math.round(f(255))).toBe(255);
  });

  it("clips to the input range and stretches what's left", () => {
    const f = levelsFn({
      shadowInput: 64,
      highlightInput: 192,
      shadowOutput: 0,
      highlightOutput: 255,
      midtoneInput: 1,
    });
    expect(Math.round(f(64))).toBe(0);
    expect(Math.round(f(192))).toBe(255);
    expect(Math.round(f(128))).toBe(128);
    expect(Math.round(f(0))).toBe(0);
    expect(Math.round(f(255))).toBe(255);
  });

  it("applies the midtone gamma", () => {
    const f = levelsFn({
      shadowInput: 0,
      highlightInput: 255,
      shadowOutput: 0,
      highlightOutput: 255,
      midtoneInput: 2,
    });
    // Gamma > 1 lifts the midtones.
    expect(f(128)).toBeGreaterThan(150);
    expect(Math.round(f(0))).toBe(0);
    expect(Math.round(f(255))).toBe(255);
  });

  it("reads a midtone stored in hundredths", () => {
    const asFloat = levelsFn({
      shadowInput: 0, highlightInput: 255, shadowOutput: 0, highlightOutput: 255, midtoneInput: 2,
    });
    const asHundredths = levelsFn({
      shadowInput: 0, highlightInput: 255, shadowOutput: 0, highlightOutput: 255, midtoneInput: 200,
    });
    expect(Math.round(asHundredths(128))).toBe(Math.round(asFloat(128)));
  });

  it("compresses into a narrowed output range", () => {
    const f = levelsFn({
      shadowInput: 0,
      highlightInput: 255,
      shadowOutput: 50,
      highlightOutput: 200,
      midtoneInput: 1,
    });
    expect(Math.round(f(0))).toBe(50);
    expect(Math.round(f(255))).toBe(200);
  });
});

describe("curveFn", () => {
  it("passes a straight line through unchanged", () => {
    const f = curveFn([
      { input: 0, output: 0 },
      { input: 255, output: 255 },
    ]);
    for (const v of [0, 37, 128, 200, 255]) expect(Math.round(f(v))).toBe(v);
  });

  it("hits every control point exactly", () => {
    const pts = [
      { input: 0, output: 10 },
      { input: 90, output: 40 },
      { input: 180, output: 210 },
      { input: 255, output: 250 },
    ];
    const f = curveFn(pts);
    for (const p of pts) expect(Math.round(f(p.input))).toBe(p.output);
  });

  it("never overshoots between control points", () => {
    // A natural spline would bulge past 200 here; a monotone one cannot.
    const f = curveFn([
      { input: 0, output: 0 },
      { input: 100, output: 200 },
      { input: 200, output: 200 },
      { input: 255, output: 255 },
    ]);
    for (let v = 100; v <= 200; v++) {
      expect(f(v)).toBeLessThanOrEqual(200.001);
      expect(f(v)).toBeGreaterThanOrEqual(199.999 - 0.5);
    }
  });

  it("stays monotone increasing for a monotone curve", () => {
    const f = curveFn([
      { input: 0, output: 0 },
      { input: 60, output: 20 },
      { input: 190, output: 230 },
      { input: 255, output: 255 },
    ]);
    let prev = -1;
    for (let v = 0; v <= 255; v++) {
      const y = f(v);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = y;
    }
  });

  it("clamps outside the control points' range", () => {
    const f = curveFn([
      { input: 50, output: 20 },
      { input: 200, output: 240 },
    ]);
    expect(f(0)).toBe(20);
    expect(f(255)).toBe(240);
  });
});

describe("buildAdjustment", () => {
  it("inverts", () => {
    const a = buildAdjustment({ type: "invert" });
    expect(a?.lut).not.toBeNull();
    expect(at(a!.lut!, 0)).toBe(255);
    expect(at(a!.lut!, 255)).toBe(0);
    expect(at(a!.lut!, 100)).toBe(155);
  });

  it("posterizes to the requested number of levels", () => {
    const a = buildAdjustment({ type: "posterize", levels: 2 });
    const values = new Set<number>();
    for (let v = 0; v < 256; v++) values.add(at(a!.lut!, v));
    expect([...values].sort((x, y) => x - y)).toEqual([0, 255]);
  });

  it("reports threshold separately, since it works on luminance", () => {
    const a = buildAdjustment({ type: "threshold", level: 100 });
    expect(a?.lut).toBeNull();
    expect(a?.threshold).toBe(100);
  });

  it("folds the composite curve on top of the per-channel one", () => {
    // Red is inverted by its own curve, then the composite curve halves it.
    const a = buildAdjustment({
      type: "curves",
      red: [
        { input: 0, output: 255 },
        { input: 255, output: 0 },
      ],
      rgb: [
        { input: 0, output: 0 },
        { input: 255, output: 128 },
      ],
    });
    expect(at(a!.lut!, 0, 0)).toBeCloseTo(128, -1); // inverted to 255, then halved
    expect(at(a!.lut!, 255, 0)).toBe(0);
    // Green only sees the composite curve.
    expect(at(a!.lut!, 255, 1)).toBeCloseTo(128, -1);
  });

  it("keeps the legacy brightness/contrast on the exact 256-LUT path", () => {
    const legacy = buildAdjustment({
      type: "brightness/contrast",
      brightness: 20,
      contrast: 0,
      useLegacy: true,
    });
    expect(legacy?.lut3d).toBeNull();
    expect(at(legacy!.lut!, 100)).toBe(120);
  });

  it("bakes colour-transform adjustments into a 3D cube", () => {
    for (const adj of [
      { type: "hue/saturation", master: { a: 0, b: 0, c: 0, d: 0, hue: 90, saturation: 0, lightness: 0 } },
      { type: "color balance", midtones: { cyanRed: 40, magentaGreen: 0, yellowBlue: 0 } },
      { type: "vibrance", vibrance: 50 },
      { type: "brightness/contrast", brightness: 20, contrast: 10, useLegacy: false },
      { type: "black & white" },
      { type: "channel mixer", monochrome: true, gray: { red: 100, green: 0, blue: 0, constant: 0 } },
    ]) {
      const spec = buildAdjustment(adj as never);
      expect(spec, adj.type).not.toBeNull();
      expect(spec!.lut3d, adj.type).not.toBeNull();
      expect(spec!.lut3d!.length).toBe(spec!.lut3dSize ** 3 * 4);
    }
  });

  it("still declines what it genuinely cannot evaluate", () => {
    expect(buildAdjustment({ type: "color lookup" })).toBeNull();
    expect(buildAdjustment(undefined)).toBeNull();
  });

  it("applies a cube via trilinear interpolation on the CPU", () => {
    // A pure red→green swap: exact at the cube's grid points, near-exact between.
    const spec = buildAdjustment({
      type: "channel mixer",
      red: { red: 0, green: 100, blue: 0, constant: 0 },
      green: { red: 100, green: 0, blue: 0, constant: 0 },
      blue: { red: 0, green: 0, blue: 100, constant: 0 },
    });
    const px = new Uint8ClampedArray([200, 40, 90, 255]);
    applyAdjustment(px, spec!);
    expect(Math.abs(px[0] - 40)).toBeLessThanOrEqual(2);
    expect(Math.abs(px[1] - 200)).toBeLessThanOrEqual(2);
    expect(Math.abs(px[2] - 90)).toBeLessThanOrEqual(2);
    expect(px[3]).toBe(255);
  });

  it("channel-mixer monochrome maps every channel to the mix", () => {
    const spec = buildAdjustment({
      type: "channel mixer",
      monochrome: true,
      gray: { red: 100, green: 0, blue: 0, constant: 0 },
    });
    const px = new Uint8ClampedArray([180, 30, 60, 255]);
    applyAdjustment(px, spec!);
    for (const v of [px[0], px[1], px[2]]) expect(Math.abs(v - 180)).toBeLessThanOrEqual(2);
  });

  it("black & white turns pure red into its slider weight", () => {
    const spec = buildAdjustment({ type: "black & white", reds: 40 });
    const px = new Uint8ClampedArray([255, 0, 0, 255]);
    applyAdjustment(px, spec!);
    // 40% of 255 ≈ 102, within cube-interpolation tolerance.
    expect(Math.abs(px[0] - 102)).toBeLessThanOrEqual(3);
    expect(px[0]).toBe(px[1]);
    expect(px[1]).toBe(px[2]);
  });
});
