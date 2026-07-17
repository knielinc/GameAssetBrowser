import { useEffect, useRef, useState, type ReactElement } from "react";
import { modelUrl } from "../../model/loadModel";
import { thumbUrl } from "../../types";

/** Formats the browser decodes natively — served as the ORIGINAL file so a
 *  GIF animates and a sprite sheet is full-resolution, not the 256px thumb. */
const BROWSER_DECODABLE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

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
  /** Thumbnail cache key — the only viewable form for DDS/TGA/EXR. */
  thumbKey?: string;
  sprite: SpriteConfig;
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
 * animates and the sheet is crisp); DDS/TGA/EXR fall back to the decoded
 * thumbnail, which is the only thing that exists for them.
 */
export default function Sprite2DView({ path, ext, thumbKey, sprite }: Sprite2DViewProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  const usable = BROWSER_DECODABLE.has(ext.toLowerCase());
  const src = usable ? modelUrl(path) : thumbKey !== undefined ? thumbUrl(thumbKey) : null;
  const isGif = ext.toLowerCase() === "gif";

  // Sprite-sheet playback: load the sheet once, blit the current cell each
  // frame. Cropping a GIF sheet loses its animation, but a GIF *is* the
  // animation — you would not sheet one — so this only runs on still images.
  useEffect(() => {
    if (!sprite.enabled || src === null) return;
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
      setDims({ w: img.naturalWidth, h: img.naturalHeight });
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

  if (src === null) {
    return (
      <div className="flex h-full w-full items-center justify-center text-[11px] text-dim">
        No preview available.
      </div>
    );
  }

  return (
    <div className="alpha-checker flex h-full w-full items-center justify-center overflow-hidden p-2">
      {sprite.enabled ? (
        <canvas
          ref={canvasRef}
          className="max-h-full max-w-full object-contain"
          style={{ imageRendering: "pixelated" }}
        />
      ) : (
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) =>
            setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
          className="max-h-full max-w-full object-contain"
          // Pixel art (small sources) crisp; large textures smooth.
          style={{ imageRendering: dims !== null && Math.max(dims.w, dims.h) <= 256 ? "pixelated" : "auto" }}
        />
      )}
      {isGif && !sprite.enabled && (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-dim">
          GIF · playing
        </div>
      )}
    </div>
  );
}
