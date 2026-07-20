import { useEffect, useRef, useState, type ReactElement } from "react";
import clsx from "clsx";
import { BROWSER_DECODABLE, modelUrl, previewUrl } from "../../model/loadModel";
import { useRenderPrefs } from "../../stores/renderPrefs";

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
export default function Sprite2DView({ path, ext, sprite, zoomFit, zoomPct }: Sprite2DViewProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pixelArt = useRenderPrefs((s) => s.pixelArt);
  // Natural pixel size of the loaded image — the base the zoom percent scales.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  const usable = BROWSER_DECODABLE.has(ext.toLowerCase());
  const src = usable ? modelUrl(path) : previewUrl(path);
  const isGif = ext.toLowerCase() === "gif";

  // The image changed — drop the old size until the new one loads.
  useEffect(() => setDims(null), [src]);

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
    img.src = src;

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
  }, [src, sprite.enabled, sprite.cols, sprite.rows, sprite.fps, sprite.playing]);

  // Zoom applies only to the still image — a sprite sheet plays at frame size.
  const fit = zoomFit || sprite.enabled;
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
      ) : fit ? (
        // Fit: scale to fill the available space, upscaling small textures.
        <img
          src={src}
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
            src={src}
            alt=""
            draggable={false}
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            className="max-w-none"
            style={{ width: zoomW, height: "auto", imageRendering: rendering }}
          />
        </div>
      )}
      {isGif && !sprite.enabled && (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-dim">
          GIF · playing
        </div>
      )}
    </div>
  );
}
