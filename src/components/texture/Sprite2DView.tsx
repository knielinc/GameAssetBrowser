import { useEffect, useRef, useState, type ReactElement } from "react";
import clsx from "clsx";
import { BROWSER_DECODABLE, modelUrl, previewUrl } from "../../model/loadModel";
import { useRenderPrefs } from "../../stores/renderPrefs";
import type { IsoChannel } from "./TexturePreview";

export interface SpriteConfig {
  enabled: boolean;
  cols: number;
  rows: number;
  fps: number;
  playing: boolean;
}

export interface Sprite2DViewProps {
  path: string;
  ext: string;
  sprite: SpriteConfig;
  /** Scale the image to fill the available space (upscaling small textures).
   *  When false, show it at `zoomPct` of native size and scroll if it
   *  overflows. */
  zoomFit: boolean;
  /** Zoom percent of native size when not fitting (100 = 1:1). */
  zoomPct: number;
  /** Show one channel as grayscale ("rgb" = the image untouched). */
  iso: IsoChannel;
  /** n×n tiled repeat in the same box the single image would occupy — a seam
   *  check, mirroring what `texture.repeat` does on the 3D plane. */
  tiles: number;
}

/** src|channel → object-URL of the channel-remapped PNG (kept as the promise
 *  so concurrent requests dedupe). Small LRU: full-res previews are big, and
 *  evicted entries must revoke their blob URL or the memory never returns. */
const ISO_CACHE = new Map<string, Promise<string>>();
const ISO_CACHE_CAP = 8;

/**
 * Remap the image so one channel becomes grayscale (alpha shown opaque).
 * Done ONCE per texture+channel on an offscreen canvas via getImageData, then
 * served as a blob URL — per-frame shader work is pointless for a still image,
 * and this path must also feed CSS-only consumers (the tiled canvas).
 *
 * A GIF collapses to its first frame here (canvas snapshot) — acceptable: you
 * isolate channels to inspect data, not to watch an animation.
 */
function isolate(src: string, iso: Exclude<IsoChannel, "rgb">): Promise<string> {
  const key = `${src}|${iso}`;
  const hit = ISO_CACHE.get(key);
  if (hit !== undefined) {
    // Refresh recency so the working set survives the cap.
    ISO_CACHE.delete(key);
    ISO_CACHE.set(key, hit);
    return hit;
  }
  const p = (async () => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("2d context unavailable");
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = id.data;
    const off = iso === "r" ? 0 : iso === "g" ? 1 : iso === "b" ? 2 : 3;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i + off];
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = 255; // opaque — an isolated channel is data, not a cutout
    }
    ctx.putImageData(id, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b !== null) resolve(b);
        else reject(new Error("toBlob failed"));
      }, "image/png");
    });
    return URL.createObjectURL(blob);
  })();
  ISO_CACHE.set(key, p);
  // A failed remap must not poison the cache — retry on next request.
  p.catch(() => ISO_CACHE.delete(key));
  while (ISO_CACHE.size > ISO_CACHE_CAP) {
    const oldest = ISO_CACHE.entries().next().value;
    if (oldest === undefined) break;
    ISO_CACHE.delete(oldest[0]);
    oldest[1].then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
  }
  return p;
}

/**
 * The 2D (Flat) preview: a plain DOM/canvas view, deliberately NOT WebGL.
 *
 * A 2D artist wants to see the actual pixels — an animated GIF playing, or a
 * sprite sheet stepped frame by frame — and none of that wants a 3D pipeline.
 * The browser animates a GIF for free in an `<img>`; the sheet is a canvas
 * that blits one cell per tick.
 *
 * Browser-decodable formats load the ORIGINAL over model:// (so the GIF
 * animates and the sheet is crisp); DDS/TGA/EXR/HDR are decoded to a full-res
 * PNG in Rust over preview://, the only viewable form the browser can take.
 */
export default function Sprite2DView({
  path,
  ext,
  sprite,
  zoomFit,
  zoomPct,
  iso,
  tiles,
}: Sprite2DViewProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tileCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pixelArt = useRenderPrefs((s) => s.pixelArt);
  // Natural pixel size of the loaded image — the base the zoom percent scales.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  const usable = BROWSER_DECODABLE.has(ext.toLowerCase());
  const src = usable ? modelUrl(path) : previewUrl(path);
  const isGif = ext.toLowerCase() === "gif";

  // The image changed — drop the old size until the new one loads.
  useEffect(() => setDims(null), [src]);

  // Channel isolation: swap the source for the cached remap once it's ready;
  // until then (first hit only — cached after) the original shows.
  const [isoSrc, setIsoSrc] = useState<string | null>(null);
  useEffect(() => {
    if (iso === "rgb") {
      setIsoSrc(null);
      return;
    }
    let cancelled = false;
    setIsoSrc(null);
    isolate(src, iso)
      .then((u) => {
        if (!cancelled) setIsoSrc(u);
      })
      .catch((err: unknown) => {
        // Un-remappable (decode failed, tainted canvas) — keep showing RGB.
        console.warn("channel isolation failed — showing RGB", err);
      });
    return () => {
      cancelled = true;
    };
  }, [src, iso]);
  const effSrc = iso !== "rgb" && isoSrc !== null ? isoSrc : src;

  // Sprite-sheet playback: load the sheet once, blit the current cell each
  // frame. Cropping a GIF sheet loses its animation, but a GIF *is* the
  // animation — you would not sheet one — so this only runs on still images.
  useEffect(() => {
    if (!sprite.enabled) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    let raf = 0;
    let frame = 0;
    let lastStep = 0;
    let loaded = false;

    img.onload = () => {
      loaded = true;
    };
    img.src = effSrc;

    const draw = (t: number): void => {
      raf = requestAnimationFrame(draw);
      if (!loaded) return;
      const cols = Math.max(1, Math.floor(sprite.cols));
      const rows = Math.max(1, Math.floor(sprite.rows));
      const fw = img.naturalWidth / cols;
      const fh = img.naturalHeight / rows;
      const total = cols * rows;

      if (canvas.width !== fw || canvas.height !== fh) {
        canvas.width = fw;
        canvas.height = fh;
      }
      if (sprite.playing && t - lastStep >= 1000 / Math.max(1, sprite.fps)) {
        frame = (frame + 1) % total;
        lastStep = t;
      }
      const cx = (frame % cols) * fw;
      const cy = Math.floor(frame / cols) * fh;
      ctx.clearRect(0, 0, fw, fh);
      // Nearest-neighbour: pixel art must not blur.
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, cx, cy, fw, fh, 0, 0, fw, fh);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [effSrc, sprite.enabled, sprite.cols, sprite.rows, sprite.fps, sprite.playing]);

  // Zoom applies only to the still image — a sprite sheet plays at frame size.
  const fit = zoomFit || sprite.enabled;
  // Sprite playback wins over tiling: the sheet IS a grid already.
  const tiled = tiles > 1 && !sprite.enabled;

  // Tiled seam check: composite the image n×n into a canvas once, then let it
  // size exactly like the single <img> would (object-contain / zoom width) —
  // the repeats subdivide the same box, mirroring `texture.repeat` on the
  // 3D plane. A canvas rather than CSS background-repeat because a replaced
  // element gets aspect-correct "contain" sizing for free.
  useEffect(() => {
    if (!tiled) return;
    const canvas = tileCanvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    let cancelled = false;
    img.onload = () => {
      if (cancelled) return;
      setDims({ w: img.naturalWidth, h: img.naturalHeight });
      // Cap the composite: a 4K source tiled 3× would want a 12K canvas. Each
      // tile shrinks instead — this view is a seam check, not a pixel-peep.
      const scale = Math.min(1, 4096 / (Math.max(img.naturalWidth, img.naturalHeight, 1) * tiles));
      const tw = Math.max(1, Math.round(img.naturalWidth * scale));
      const th = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.width = tw * tiles;
      canvas.height = th * tiles;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Only matters when the cap shrank the tiles; nearest keeps pixel art crisp.
      ctx.imageSmoothingEnabled = !pixelArt;
      for (let y = 0; y < tiles; y++) {
        for (let x = 0; x < tiles; x++) ctx.drawImage(img, x * tw, y * th, tw, th);
      }
    };
    img.src = effSrc;
    return () => {
      cancelled = true;
    };
    // `fit` is a dep because toggling it swaps in a DIFFERENT canvas element,
    // which needs its own composite drawn.
  }, [tiled, tiles, effSrc, pixelArt, fit]);

  const rendering = pixelArt ? "pixelated" : "auto";
  // Explicit zoomed size once we know the native dimensions.
  const zoomW = dims !== null ? Math.max(1, Math.round((dims.w * zoomPct) / 100)) : undefined;

  return (
    <div
      className={clsx(
        "alpha-checker relative h-full w-full",
        fit ? "flex items-center justify-center overflow-hidden p-2" : "overflow-auto",
      )}
    >
      {sprite.enabled ? (
        // Fill the available space like the still "fit" image below — the
        // canvas's intrinsic size is one frame (often small), so `max-*` alone
        // would pin it at native size and never scale up. `h-full w-full` gives
        // it the container box; `object-contain` scales the frame to fit,
        // letterboxed, preserving aspect ratio.
        <canvas
          ref={canvasRef}
          className="h-full w-full object-contain"
          style={{ imageRendering: rendering }}
        />
      ) : tiled && fit ? (
        // Tiled fit: the n×n composite sized exactly like the single image.
        <canvas
          ref={tileCanvasRef}
          className="h-full w-full object-contain"
          style={{ imageRendering: rendering }}
        />
      ) : tiled ? (
        // Tiled zoom: same box the untiled zoom would use — the repeats
        // subdivide it, so 2× tiling shows each tile at half the zoom.
        <div className="flex min-h-full min-w-full items-center justify-center p-2">
          <canvas
            ref={tileCanvasRef}
            className="max-w-none"
            style={{ width: zoomW, height: "auto", imageRendering: rendering }}
          />
        </div>
      ) : fit ? (
        // Fit: scale to fill the available space, upscaling small textures.
        <img
          src={effSrc}
          alt=""
          draggable={false}
          onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          className="h-full w-full object-contain"
          style={{ imageRendering: rendering }}
        />
      ) : (
        // Zoom: native size × percent, centered while it fits, scrollable once
        // it overflows (min-full keeps it centered until then).
        <div className="flex min-h-full min-w-full items-center justify-center p-2">
          <img
            src={effSrc}
            alt=""
            draggable={false}
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            className="max-w-none"
            style={{ width: zoomW, height: "auto", imageRendering: rendering }}
          />
        </div>
      )}
      {/* Tiling and isolation both snapshot through a canvas, so the GIF is
          static there — don't claim it's playing. */}
      {isGif && !sprite.enabled && !tiled && iso === "rgb" && (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-dim">
          GIF · playing
        </div>
      )}
    </div>
  );
}
