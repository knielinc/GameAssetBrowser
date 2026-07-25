/**
 * One shape for every layered art document we can open — Photoshop (.psd/.psb),
 * Krita (.kra) and Aseprite (.aseprite/.ase).
 *
 * The three formats disagree about almost everything except "a tree of layers,
 * each with pixels somewhere on the canvas", so that is what this models. The
 * per-format readers (ag-psd in the worker, Rust for kra/aseprite) each flatten
 * their own tree into this, and from there a single compositor and a single
 * panel serve all three.
 */

import type { AdjustmentSpec } from "./adjustment";

export type LayerKind =
  | "paint"
  | "group"
  | "mask"
  | "filter"
  | "vector"
  | "clone"
  | "file"
  | "text"
  | "smart"
  | "other";

export interface LayerNode {
  name: string;
  kind: LayerKind;
  /** 0..1. */
  opacity: number;
  /** Canonical blend key — see `normalizeBlend`. */
  blend: string;
  /** This layer's OWN eye state (not inherited from parent groups). */
  visible: boolean;
  /** Nesting depth for the tree (0 = top level). */
  depth: number;
  isGroup: boolean;
  /** Index of the parent group in `layers`, or -1 for a top-level layer. */
  parent: number;
  /** Clipped to the layer(s) below it — see `LayeredDoc.clipMode`. */
  clip: boolean;
  /** Group that composites straight onto its parent (no isolation). */
  passthrough: boolean;
  /** A mask is already baked into this layer's cel alpha. */
  masked: boolean;
  /** Listed in the tree but never composited (selection masks, filter layers). */
  inert: boolean;
  /**
   * A rectangle this layer's content is clipped to, in canvas space.
   *
   * Photoshop ARTBOARDS are groups with one of these: everything inside is
   * cropped to the artboard's bounds. Miss it and a template document — where
   * each artboard holds an oversized image cropped down to a capsule/banner —
   * renders as a pile of overlapping full-size images instead of the layout.
   */
  clipRect?: { x: number; y: number; w: number; h: number };
  /**
   * For a GROUP with a mask: what the mask means outside its own rectangle —
   * 0 hides, 255 reveals. A leaf layer's mask is baked into its pixels and
   * needs none of this; a group's can't be, because it applies to whatever its
   * subtree composites to. The stencil itself arrives as a mask cel.
   */
  maskDefault?: number;
  /**
   * An adjustment layer's transfer function. Present only for the adjustment
   * types we can actually evaluate — the rest stay `inert`, so the panel can
   * say "listed, not rendered" instead of quietly dropping them.
   */
  adjustment?: AdjustmentSpec;
  /**
   * Layer effects that are switched on in the file but which we do not render
   * (everything except Color Overlay). Surfaced in the panel so a preview that
   * is missing a drop shadow says so rather than looking subtly wrong.
   */
  missingEffects?: string[];
}

/** One layer's pixels on one frame, positioned on the canvas. */
export interface Cel {
  /** Index into `LayeredDoc.layers`, or -1 for a standalone/merged image. */
  layer: number;
  frame: number;
  x: number;
  y: number;
  /**
   * Size ON THE CANVAS. The bitmap may hold fewer pixels than this — big
   * documents ship their layers downscaled to display resolution, because the
   * webview ingests bytes at ~60 MB/s and nobody can see more pixels than the
   * screen has. The compositor stretches bitmap → w×h when drawing.
   */
  w: number;
  h: number;
  bitmap: ImageBitmap;
  /**
   * An exterior layer-effect's pixels (drop shadow, outer glow, stroke) rather
   * than layer content: drawn beneath (`under`) or above (`over`) the fill
   * with its own blend mode and opacity.
   */
  role?: "under" | "over";
  blend?: string;
  opacity?: number;
}

export interface FrameMeta {
  durationMs: number;
}

export interface TagMeta {
  name: string;
  from: number;
  to: number;
  direction: string;
}

export interface LayeredDoc {
  width: number;
  height: number;
  /** False when nothing can be composited per-layer — only the flattened image. */
  layered: boolean;
  layers: LayerNode[];
  frames: FrameMeta[];
  tags: TagMeta[];
  /**
   * What a `clip` layer clips to.
   *  - `base`: the nearest non-clipping layer below it, and only that one
   *    (Photoshop clipping masks).
   *  - `below`: everything accumulated below it in its group (Krita's
   *    "inherit alpha").
   */
  clipMode: "base" | "below";
  /**
   * Whether the document's own flattened image is the AUTHORITY on how it looks.
   *
   * True for Photoshop and Krita, whose baked composite was rendered by the app
   * itself — filters, adjustment layers and all — so it beats anything we can
   * recompute and stays on screen until the user toggles a layer. False for
   * Aseprite, where our per-cel composite is exact and the flattened image is
   * only a first-frame placeholder: keeping it up would freeze the animation.
   */
  mergedExact: boolean;
}

/** Key for the cel lookup — a layer can hold one cel per frame. */
export const celKey = (layer: number, frame: number): string => `${layer}:${frame}`;

/** A layer is effectively hidden if it or any ancestor group is hidden. */
export function hiddenEff(idx: number, layers: LayerNode[], hidden: Set<number>): boolean {
  let cur = idx;
  // The parent chain is strictly decreasing (a parent is always pushed before
  // its children), so this cannot loop even on a malformed file.
  let guard = layers.length + 1;
  while (cur >= 0 && cur < layers.length && guard-- > 0) {
    if (hidden.has(cur)) return true;
    cur = layers[cur].parent;
  }
  return false;
}

/** Child indices of `parent` (-1 = top level), in tree order (top-first). */
export function childrenOf(layers: LayerNode[], parent: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].parent === parent) out.push(i);
  }
  return out;
}
