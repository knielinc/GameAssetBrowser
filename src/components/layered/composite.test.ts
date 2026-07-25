import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { composite, defaultHidden, setScratchFactory } from "./composite";
import { celKey, type Cel, type LayeredDoc, type LayerNode } from "./types";

/**
 * The compositor drives a canvas, so it is tested against a RECORDING canvas:
 * every draw is logged with the target surface, position and the blend state in
 * force. That makes the whole layer walk — z-order, group isolation, clipping
 * runs, what a hidden layer actually suppresses — assertable without a DOM.
 */

interface Draw {
  target: string;
  src: string;
  x: number;
  y: number;
  alpha: number;
  op: string;
}

let log: Draw[] = [];
let surfaces = 0;

class FakeCtx {
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  readonly canvas: { width: number; height: number; __name: string };
  private readonly stack: { a: number; op: string }[] = [];

  constructor(readonly name: string, w: number, h: number) {
    this.canvas = { width: w, height: h, __name: name };
  }

  save(): void {
    this.stack.push({ a: this.globalAlpha, op: this.globalCompositeOperation });
  }
  restore(): void {
    const s = this.stack.pop();
    if (s !== undefined) {
      this.globalAlpha = s.a;
      this.globalCompositeOperation = s.op;
    }
  }
  fillStyle = "#000";
  clearRect(): void {}
  beginPath(): void {}
  rect(x: number, y: number, w: number, h: number): void {
    log.push({ target: this.name, src: `clip(${x},${y},${w},${h})`, x, y, alpha: 1, op: "clip" });
  }
  clip(): void {}
  fillRect(x: number, y: number, w: number, h: number): void {
    log.push({
      target: this.name,
      src: `fillRect(${w}x${h})`,
      x,
      y,
      alpha: this.globalAlpha,
      op: this.globalCompositeOperation,
    });
  }
  drawImage(src: { __name?: string; __id?: string }, x = 0, y = 0): void {
    log.push({
      target: this.name,
      src: src.__name ?? src.__id ?? "?",
      x,
      y,
      alpha: this.globalAlpha,
      op: this.globalCompositeOperation,
    });
  }
  getImageData(_x: number, _y: number, w: number, h: number): ImageData {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h } as ImageData;
  }
  putImageData(): void {}
}

const fakeScratch = (w: number, h: number): CanvasRenderingContext2D =>
  new FakeCtx(`scratch${surfaces++}`, w, h) as unknown as CanvasRenderingContext2D;

beforeEach(() => {
  log = [];
  surfaces = 0;
  setScratchFactory(fakeScratch);
});
afterAll(() => setScratchFactory(null));

// --- builders ---------------------------------------------------------------

function node(over: Partial<LayerNode> & { name: string }): LayerNode {
  return {
    kind: over.isGroup === true ? "group" : "paint",
    opacity: 1,
    blend: "normal",
    visible: true,
    depth: 0,
    isGroup: false,
    parent: -1,
    clip: false,
    passthrough: false,
    masked: false,
    inert: false,
    ...over,
  };
}

function doc(layers: LayerNode[], clipMode: "base" | "below" = "base"): LayeredDoc {
  return {
    width: 100,
    height: 100,
    layered: true,
    layers,
    frames: [{ durationMs: 0 }],
    tags: [],
    clipMode,
    mergedExact: true,
  };
}

/** A cel per non-group layer, named after the layer so the log is readable. */
function celsFor(layers: LayerNode[]): Map<string, Cel> {
  const map = new Map<string, Cel>();
  layers.forEach((l, i) => {
    if (l.isGroup) return;
    map.set(celKey(i, 0), {
      layer: i,
      frame: 0,
      x: i,
      y: 0,
      w: 10,
      h: 10,
      bitmap: { width: 10, height: 10, __id: l.name } as unknown as ImageBitmap,
    });
  });
  return map;
}

function run(
  d: LayeredDoc,
  hidden: Set<number> = new Set(),
  masks?: Map<number, Cel>,
): Draw[] {
  // Each run starts from a clean log so a test can composite more than once.
  log = [];
  surfaces = 0;
  setScratchFactory(fakeScratch);
  const target = new FakeCtx("out", d.width, d.height);
  composite(target as unknown as CanvasRenderingContext2D, {
    doc: d,
    cels: celsFor(d.layers),
    masks,
    hidden,
    frame: 0,
  });
  return log;
}

/** Just the names drawn onto the final canvas, in order. */
const onOut = (drawn: Draw[]): string[] =>
  drawn.filter((dr) => dr.target === "out").map((dr) => dr.src);

// --- tests ------------------------------------------------------------------

describe("composite", () => {
  it("draws a flat stack bottom-first", () => {
    // Index 0 is the TOPMOST layer, so it must be painted last.
    const layers = [node({ name: "top" }), node({ name: "mid" }), node({ name: "bottom" })];
    expect(onOut(run(doc(layers)))).toEqual(["bottom", "mid", "top"]);
  });

  it("places each cel at its own canvas offset", () => {
    const layers = [node({ name: "a" }), node({ name: "b" })];
    const drawn = run(doc(layers)).filter((d) => d.target === "out");
    expect(drawn.map((d) => [d.src, d.x, d.y])).toEqual([
      ["b", 1, 0],
      ["a", 0, 0],
    ]);
  });

  it("omits a hidden layer and nothing else", () => {
    const layers = [node({ name: "top" }), node({ name: "mid" }), node({ name: "bottom" })];
    expect(onOut(run(doc(layers), new Set([1])))).toEqual(["bottom", "top"]);
  });

  it("hides a group's whole subtree when the group is switched off", () => {
    //  0 group
    //  ├ 1 inner-top
    //  └ 2 inner-bottom
    //  3 backdrop
    const layers = [
      node({ name: "group", isGroup: true }),
      node({ name: "inner-top", parent: 0, depth: 1 }),
      node({ name: "inner-bottom", parent: 0, depth: 1 }),
      node({ name: "backdrop" }),
    ];
    expect(onOut(run(doc(layers)))).toEqual(["backdrop", "inner-bottom", "inner-top"]);
    expect(onOut(run(doc(layers), new Set([0])))).toEqual(["backdrop"]);
    expect(onOut(run(doc(layers), new Set([2])))).toEqual(["backdrop", "inner-top"]);
  });

  it("draws a plain group straight onto its parent, with no scratch canvas", () => {
    const layers = [
      node({ name: "group", isGroup: true, passthrough: true }),
      node({ name: "inner", parent: 0, depth: 1 }),
    ];
    const drawn = run(doc(layers));
    expect(drawn.every((d) => d.target === "out")).toBe(true);
  });

  it("isolates a group that has its own opacity, then composites it once", () => {
    const layers = [
      node({ name: "group", isGroup: true, opacity: 0.5 }),
      node({ name: "a", parent: 0, depth: 1 }),
      node({ name: "b", parent: 0, depth: 1 }),
    ];
    const drawn = run(doc(layers));
    // Children land on a scratch surface...
    const inner = drawn.filter((d) => d.target.startsWith("scratch"));
    expect(inner.map((d) => d.src)).toEqual(["b", "a"]);
    // ...and the scratch is composited onto the output exactly once, at 50%.
    const outer = drawn.filter((d) => d.target === "out");
    expect(outer).toHaveLength(1);
    expect(outer[0].alpha).toBe(0.5);
  });

  it("passes a layer's blend mode through to the canvas op", () => {
    const layers = [node({ name: "x", blend: "multiply", opacity: 0.25 })];
    const drawn = run(doc(layers));
    expect(drawn[0].op).toBe("multiply");
    expect(drawn[0].alpha).toBe(0.25);
  });

  it("skips inert layers entirely", () => {
    const layers = [node({ name: "adj", inert: true, kind: "filter" }), node({ name: "art" })];
    expect(onOut(run(doc(layers)))).toEqual(["art"]);
  });

  describe("Photoshop clipping masks", () => {
    //  0 clipped   (clipping: true)
    //  1 base
    //  2 backdrop
    const layers = [
      node({ name: "clipped", clip: true }),
      node({ name: "base" }),
      node({ name: "backdrop" }),
    ];

    it("renders the clipping layer with its base, not on its own", () => {
      const drawn = run(doc(layers));
      // The backdrop goes straight out; base + clipped are built on a scratch
      // and composited as one unit.
      expect(onOut(drawn)).toEqual(["backdrop", "scratch0"]);
      const scratchDraws = drawn.filter((d) => d.target === "scratch0");
      expect(scratchDraws.map((d) => d.src)).toEqual(["base", "scratch1"]);
      // The clipped layer is masked to the base's alpha before being blended in.
      const clipDraws = drawn.filter((d) => d.target === "scratch1");
      expect(clipDraws.map((d) => [d.src, d.op])).toEqual([
        ["clipped", "source-over"],
        ["scratch0", "destination-in"],
      ]);
    });

    it("takes the clipped layer with it when the base is hidden", () => {
      expect(onOut(run(doc(layers), new Set([1])))).toEqual(["backdrop"]);
    });

    it("keeps the base when only the clipped layer is hidden", () => {
      const drawn = run(doc(layers), new Set([0]));
      expect(onOut(drawn)).toEqual(["backdrop", "scratch0"]);
      expect(drawn.filter((d) => d.target === "scratch0").map((d) => d.src)).toEqual(["base"]);
    });
  });

  describe("artboards", () => {
    // Regression: a Photoshop artboard crops its subtree to its own rectangle.
    // Without this, a template document (an oversized image per artboard,
    // cropped down to a capsule) renders as overlapping full-size images —
    // measured at 22% of pixels wrong on a real Steam capsule template.
    const layers = [
      // The cel `celsFor` builds for layer 1 sits at (1,0) and is 10x10, so this
      // rect crops it rather than missing it.
      node({ name: "artboard", isGroup: true, clipRect: { x: 0, y: 0, w: 5, h: 5 } }),
      node({ name: "oversized", parent: 0, depth: 1 }),
    ];

    it("renders the group in isolation and crops it to the artboard rect", () => {
      const drawn = run(doc(layers));
      // The child lands on a scratch, never straight on the output.
      expect(drawn.filter((d) => d.target === "scratch0").map((d) => d.src)).toEqual([
        "oversized",
        "fillRect(5x5)",
      ]);
      const crop = drawn.find((d) => d.src === "fillRect(5x5)");
      expect(crop?.op).toBe("destination-in");
      expect([crop?.x, crop?.y]).toEqual([0, 0]);
      expect(onOut(drawn)).toEqual(["scratch0"]);
    });

    it("drops a group whose content falls entirely outside its artboard", () => {
      const away = [
        node({ ...layers[0], clipRect: { x: 500, y: 500, w: 10, h: 10 } } as LayerNode),
        node({ name: "oversized", parent: 0, depth: 1 }),
      ];
      expect(onOut(run(doc(away)))).toEqual([]);
    });

    it("still isolates an artboard that would otherwise pass straight through", () => {
      const pt = [
        node({ ...layers[0], passthrough: true } as LayerNode),
        node({ name: "oversized", parent: 0, depth: 1 }),
      ];
      expect(onOut(run(doc(pt)))).toEqual(["scratch0"]);
    });
  });

  describe("group masks", () => {
    const layers = [
      node({ name: "masked group", isGroup: true }),
      node({ name: "inner", parent: 0, depth: 1 }),
    ];
    const stencil = (): Map<number, Cel> =>
      new Map([
        [
          0,
          {
            layer: 0,
            frame: 0,
            x: 5,
            y: 6,
            w: 20,
            h: 20,
            bitmap: { width: 20, height: 20, __id: "stencil" } as unknown as ImageBitmap,
          },
        ],
      ]);

    it("isolates the group and intersects it with the stencil", () => {
      const drawn = run(doc(layers), new Set(), stencil());
      const inner = drawn.filter((d) => d.target === "scratch0");
      expect(inner.map((d) => [d.src, d.op])).toEqual([
        ["inner", "source-over"],
        ["stencil", "destination-in"],
      ]);
      expect(onOut(drawn)).toEqual(["scratch0"]);
    });

    it("only touches the stencil's own rect when the mask reveals the outside", () => {
      const reveal = [node({ ...layers[0], maskDefault: 255 } as LayerNode), layers[1]];
      const drawn = run(doc(reveal), new Set(), stencil());
      // A clip to the mask rect is set up before the destination-in, so nothing
      // outside the rectangle gets erased.
      expect(drawn.some((d) => d.op === "clip" && d.src === "clip(5,6,20,20)")).toBe(true);
    });
  });

  describe("adjustment layers", () => {
    const invert = { kind: "invert", lut: null, threshold: 200, lut3d: null, lut3dSize: 0 };

    it("reprocesses what is below it in its group, then composites that back", () => {
      const layers = [
        node({ name: "adj", kind: "filter", adjustment: invert }),
        node({ name: "art" }),
      ];
      const drawn = run(doc(layers));
      // The art draws, then a scratch holding the adjusted copy is painted back.
      expect(onOut(drawn)).toEqual(["art", "scratch0"]);
    });

    it("does nothing when there is nothing beneath it", () => {
      const layers = [node({ name: "adj", kind: "filter", adjustment: invert })];
      expect(onOut(run(doc(layers)))).toEqual([]);
    });

    it("is skipped entirely when its type is unsupported", () => {
      // `inert` is what the reader sets for an adjustment it cannot evaluate.
      const layers = [
        node({ name: "adj", kind: "filter", inert: true }),
        node({ name: "art" }),
      ];
      expect(onOut(run(doc(layers)))).toEqual(["art"]);
    });

    it("adjusts only its base when clipped, not the rest of the group", () => {
      const layers = [
        node({ name: "adj", kind: "filter", clip: true, adjustment: invert }),
        node({ name: "base" }),
        node({ name: "under" }),
      ];
      const drawn = run(doc(layers));
      // `under` goes straight out; base + its clipped adjustment are built on a
      // scratch and composited as one unit.
      expect(onOut(drawn)).toEqual(["under", "scratch0"]);
      const onBase = drawn.filter((d) => d.target === "scratch0").map((d) => [d.src, d.op]);
      expect(onBase[0]).toEqual(["base", "source-over"]);
      // The adjusted copy is clipped to the base's own alpha before blending in.
      expect(onBase.some(([, op]) => op === "destination-in")).toBe(false);
      expect(drawn.some((d) => d.target === "scratch1" && d.op === "destination-in")).toBe(true);
    });
  });

  describe("Krita inherit-alpha", () => {
    it("clips to everything already drawn below it in the group", () => {
      const layers = [node({ name: "inherit", clip: true }), node({ name: "under" })];
      const drawn = run(doc(layers, "below"));
      expect(drawn.filter((d) => d.target === "out").map((d) => d.src)).toEqual([
        "under",
        "scratch0",
      ]);
      expect(drawn.filter((d) => d.target === "scratch0").map((d) => [d.src, d.op])).toEqual([
        ["inherit", "source-over"],
        ["out", "destination-in"],
      ]);
    });
  });
});

describe("defaultHidden", () => {
  it("starts the layers the file saved as hidden switched off", () => {
    const layers = [node({ name: "a" }), node({ name: "b", visible: false })];
    expect([...defaultHidden(layers)]).toEqual([1]);
  });
});
