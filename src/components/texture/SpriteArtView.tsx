import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eye, EyeOff, Folder, FolderOpen, Pause, Play, RotateCcw } from "lucide-react";

/** kra/aseprite get a sprite-art preview (flat, pixelated, animated, with a
 *  layer show/hide panel) instead of the 3D texture surface. */
export function isSpriteArt(ext: string | null | undefined): boolean {
  const e = (ext ?? "").toLowerCase();
  return e === "kra" || e === "aseprite" || e === "ase";
}

interface SpriteLayer {
  name: string;
  opacity: number;
  blend: string;
  visible: boolean;
  depth: number;
  isGroup: boolean;
  parent: number; // index of parent group, or -1
  clip: boolean; // Krita "inherit alpha" — clip to the layers below in its group
  passthrough: boolean; // group that composites straight onto its parent
}

/** A layer is effectively hidden if it or any ancestor group is hidden. */
function hiddenEff(idx: number, layers: SpriteLayer[], hidden: Set<number>): boolean {
  let cur = idx;
  while (cur >= 0 && cur < layers.length) {
    if (hidden.has(cur)) return true;
    cur = layers[cur].parent;
  }
  return false;
}
interface SpriteCel {
  layer: number; // -1 = standalone/merged (always drawn)
  dataUrl: string;
  x: number;
  y: number;
}
interface SpriteFrame {
  durationMs: number;
  cels: SpriteCel[];
}
interface SpriteData {
  width: number;
  height: number;
  layered: boolean;
  layers: SpriteLayer[];
  frames: SpriteFrame[];
  /** Krita's exact flattened image; shown until the user toggles a layer. */
  mergedDataUrl: string | null;
}

type LoadState = "loading" | "ready" | "error";

/** aseprite blend name (Debug, lower-cased) → canvas op. Unmapped → normal. */
const BLEND: Record<string, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  colordodge: "color-dodge",
  colorburn: "color-burn",
  hardlight: "hard-light",
  softlight: "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
  addition: "lighter",
  // Krita compositeop aliases.
  add: "lighter",
  linear_dodge: "lighter",
  dodge: "color-dodge",
  burn: "color-burn",
  diff: "difference",
  hard_light: "hard-light",
  soft_light: "soft-light",
  soft_light_svg: "soft-light",
  hue_hsl: "hue",
  saturation_hsl: "saturation",
  color_hsl: "color",
  luminize_hsl: "luminosity",
};

export default function SpriteArtView({ path }: { path: string }): ReactElement {
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<SpriteData | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  // Until the user toggles a layer, show Krita's exact merged image instead of
  // our approximate live composite.
  const [touched, setTouched] = useState(false);
  // Krita's per-layer cels are decoded lazily (heavy) — null until they arrive.
  const [lazyCels, setLazyCels] = useState<SpriteCel[] | null>(null);
  const [celsLoading, setCelsLoading] = useState(false);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgs = useRef<Map<string, HTMLImageElement>>(new Map());
  const [imgsReady, setImgsReady] = useState(0); // bumped when images finish loading
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(true);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Width of the side layer panel (wide layout). Drag its edge to resize.
  const [panelW, setPanelW] = useState(224);
  const startResize = (e: ReactPointerEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelW;
    const onMove = (ev: PointerEvent): void =>
      setPanelW(Math.max(150, Math.min(480, startW + (startX - ev.clientX))));
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setData(null);
    setHidden(new Set());
    setCollapsed(new Set());
    setTouched(false);
    setLazyCels(null);
    setCelsLoading(false);
    setFrame(0);
    setPlaying(true);
    imgs.current = new Map();
    // Preload a set of image data-URLs; bump imgsReady once all have settled so
    // the composite re-runs with them available.
    const preload = (urls: Set<string>): void => {
      let left = urls.size;
      if (left === 0) {
        setImgsReady((n) => n + 1);
        return;
      }
      urls.forEach((u) => {
        const im = new Image();
        const done = (): void => {
          imgs.current.set(u, im);
          left -= 1;
          if (!cancelled && left <= 0) setImgsReady((n) => n + 1);
        };
        im.onload = done;
        im.onerror = () => {
          left -= 1;
          if (!cancelled && left <= 0) setImgsReady((n) => n + 1);
        };
        im.src = u;
      });
    };

    void invoke<SpriteData>("sprite_data", { path })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        // Layers hidden by default in the file start hidden.
        setHidden(new Set(d.layers.map((l, i) => (l.visible ? -1 : i)).filter((i) => i >= 0)));
        // Folders start COLLAPSED — these files nest hundreds of layers deep.
        setCollapsed(new Set(d.layers.map((l, i) => (l.isGroup ? i : -1)).filter((i) => i >= 0)));
        setState("ready");
        // Preload the merged default image + any cels shipped up front (aseprite).
        const urls = new Set<string>();
        if (d.mergedDataUrl !== null) urls.add(d.mergedDataUrl);
        d.frames.forEach((f) => f.cels.forEach((c) => urls.add(c.dataUrl)));
        preload(urls);

        // Krita ships no cels up front (they're heavy) — fetch them in the
        // background so the merged image is instant and toggling works soon after.
        const needsCels = d.layered && (d.frames[0]?.cels.length ?? 0) === 0;
        if (needsCels) {
          setCelsLoading(true);
          void invoke<SpriteCel[]>("sprite_cels", { path })
            .then((cels) => {
              if (cancelled) return;
              setLazyCels(cels);
              setCelsLoading(false);
              preload(new Set(cels.map((c) => c.dataUrl)));
            })
            .catch((e) => {
              if (cancelled) return;
              console.error("[sprite] cels load failed", e);
              setCelsLoading(false);
            });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          console.error("[sprite] load failed", e);
          setState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const frames = data?.frames ?? [];
  const animated = frames.length > 1;

  // Composite the current frame. Group-aware so Krita "inherit alpha" layers
  // (clip to the layers below them in their group) and grouped opacity/blend
  // render correctly instead of the layer bleeding across the whole canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || data === null) return;
    const { width: W, height: H, layers } = data;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.clearRect(0, 0, W, H);

    const fr = frames[Math.min(frame, Math.max(frames.length - 1, 0))];
    // Krita cels arrive lazily; use them once here, else what shipped up front.
    const cels = lazyCels ?? fr?.cels ?? [];

    // Show Krita's exact merged image while (a) the user hasn't toggled anything
    // — our composite only approximates its clip/blend stack — or (b) the lazy
    // per-layer cels haven't arrived yet, so a toggle can't be drawn.
    if ((!touched || cels.length === 0) && data.mergedDataUrl !== null) {
      const mim = imgs.current.get(data.mergedDataUrl);
      if (mim !== undefined) {
        ctx.drawImage(mim, 0, 0);
        return;
      }
    }

    if (fr === undefined) return;

    // Cel lookup by layer index for this frame (Krita: one cel per paint layer).
    const celOf = new Map<number, SpriteCel>();
    const standalone: SpriteCel[] = []; // layer === -1 (merged fallback)
    for (const cel of cels) {
      if (cel.layer < 0) standalone.push(cel);
      else celOf.set(cel.layer, cel);
    }
    // Children of a group (or top level = -1), in array order (top-first).
    const kids = new Map<number, number[]>();
    layers.forEach((l, i) => {
      const arr = kids.get(l.parent) ?? [];
      arr.push(i);
      kids.set(l.parent, arr);
    });

    const scratch = (): CanvasRenderingContext2D => {
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      return c.getContext("2d") as CanvasRenderingContext2D;
    };

    // Does this group need its own isolated buffer? Only when it changes how its
    // children combine with the outside: a non-normal blend, reduced opacity, or
    // a clip child (which must clip to just this group's content). Otherwise its
    // children draw straight onto the parent — cheap, and identical in result.
    const needsIsolation = (gi: number): boolean => {
      const g = layers[gi];
      if (g.passthrough) return false;
      if (g.opacity < 1 || (BLEND[g.blend] ?? "source-over") !== "source-over") return true;
      return (kids.get(gi) ?? []).some((c) => layers[c].clip);
    };

    // Draw a group's visible children (bottom-first) onto `dst`.
    const drawGroup = (parent: number, dst: CanvasRenderingContext2D): void => {
      const children = kids.get(parent) ?? [];
      for (let k = children.length - 1; k >= 0; k--) {
        const idx = children[k];
        if (hidden.has(idx)) continue;
        const l = layers[idx];
        if (l.isGroup) {
          if (needsIsolation(idx)) {
            const gctx = scratch();
            drawGroup(idx, gctx);
            dst.save();
            dst.globalAlpha = l.opacity;
            dst.globalCompositeOperation = BLEND[l.blend] ?? "source-over";
            dst.drawImage(gctx.canvas, 0, 0);
            dst.restore();
          } else {
            drawGroup(idx, dst);
          }
          continue;
        }
        const cel = celOf.get(idx);
        if (cel === undefined) continue;
        const im = imgs.current.get(cel.dataUrl);
        if (im === undefined) continue;
        if (l.clip) {
          // Inherit alpha: keep the layer only where the group's content so far
          // is opaque, then composite that with its blend/opacity.
          const cctx = scratch();
          cctx.drawImage(im, cel.x, cel.y);
          cctx.globalCompositeOperation = "destination-in";
          cctx.drawImage(dst.canvas, 0, 0);
          dst.save();
          dst.globalAlpha = l.opacity;
          dst.globalCompositeOperation = BLEND[l.blend] ?? "source-over";
          dst.drawImage(cctx.canvas, 0, 0);
          dst.restore();
        } else {
          dst.save();
          dst.globalAlpha = l.opacity;
          dst.globalCompositeOperation = BLEND[l.blend] ?? "source-over";
          dst.drawImage(im, cel.x, cel.y);
          dst.restore();
        }
      }
    };

    // Standalone/merged cels (Krita fallback) draw straight; otherwise walk tree.
    for (const cel of standalone) {
      const im = imgs.current.get(cel.dataUrl);
      if (im !== undefined) ctx.drawImage(im, cel.x, cel.y);
    }
    drawGroup(-1, ctx);
  }, [data, frame, hidden, frames, imgsReady, touched, lazyCels]);

  // Animate.
  useEffect(() => {
    if (!playing || frames.length <= 1) return;
    const hold = Math.max(20, frames[Math.min(frame, frames.length - 1)]?.durationMs || 100);
    const t = window.setTimeout(() => setFrame((i) => (i + 1) % frames.length), hold);
    return () => window.clearTimeout(t);
  }, [playing, frame, frames]);

  // Responsive panel + fit measurement.
  useEffect(() => {
    if (root === null) return;
    const ro = new ResizeObserver(() => setWide(root.clientWidth >= 560));
    ro.observe(root);
    setWide(root.clientWidth >= 560);
    return () => ro.disconnect();
  }, [root]);
  useEffect(() => {
    if (stage === null) return;
    const measure = (): void => setSize({ w: stage.clientWidth, h: stage.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [stage]);

  // Fit-to-view: integer up-scale for small pixel art, fractional down-scale for
  // large — so a 16×16 sprite fills the fullscreen instead of sitting tiny.
  const scale = useMemo(() => {
    if (data === null || size.w === 0 || size.h === 0) return 1;
    const s = Math.min((size.w - 12) / data.width, (size.h - 12) / data.height);
    return s >= 1 ? Math.max(1, Math.floor(s)) : Math.max(0.02, s);
  }, [data, size]);

  const toggle = (i: number): void => {
    setTouched(true);
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  };

  const toggleCollapse = (i: number): void =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  // Panel lists layers top-first (aseprite stores bottom-first).
  // Layer indices in tree display order (top-first, groups then their children).
  const displayOrder = useMemo(() => {
    const layers = data?.layers ?? [];
    const childrenOf = (parent: number): number[] => {
      const out: number[] = [];
      layers.forEach((l, i) => {
        if (l.parent === parent) out.push(i);
      });
      return out;
    };
    const order: number[] = [];
    const walk = (i: number): void => {
      order.push(i);
      if (layers[i]?.isGroup && !collapsed.has(i)) childrenOf(i).forEach(walk);
    };
    childrenOf(-1).forEach(walk);
    return order;
  }, [data, collapsed]);

  const totalLayers = data?.layers.length ?? 0;
  const groupIdxs = useMemo(
    () => (data?.layers ?? []).map((l, i) => (l.isGroup ? i : -1)).filter((i) => i >= 0),
    [data],
  );
  const allCollapsed = groupIdxs.length > 0 && groupIdxs.every((i) => collapsed.has(i));
  const toggleAll = (): void => setCollapsed(allCollapsed ? new Set() : new Set(groupIdxs));
  // File defaults: the visibility Krita/Aseprite saved (layers with visible=0
  // start hidden); folders back to collapsed. Undoes any show/hide the user did.
  const resetDefaults = (): void => {
    if (data === null) return;
    setHidden(new Set(data.layers.map((l, i) => (l.visible ? -1 : i)).filter((i) => i >= 0)));
    setCollapsed(new Set(groupIdxs));
    setTouched(false); // back to Krita's exact merged image
  };

  return (
    <div ref={setRoot} className={"flex min-h-0 flex-1 " + (wide ? "flex-row" : "flex-col")}>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={setStage} className="doc-checker flex min-h-0 flex-1 items-center justify-center overflow-hidden p-1.5">
          {state === "ready" && data !== null ? (
            <canvas
              ref={canvasRef}
              className="shadow-e1"
              style={{
                width: data.width * scale,
                height: data.height * scale,
                imageRendering: "pixelated",
              }}
            />
          ) : (
            <div className="text-xs text-white/80">
              {state === "error" ? "Couldn’t read this file." : "Reading…"}
            </div>
          )}
        </div>
        {state === "ready" && animated && (
          <div className="flex shrink-0 items-center gap-2 border-t border-bg bg-panel px-2.5 py-1.5">
            <button type="button" className="icon-btn" title={playing ? "Pause" : "Play"} onClick={() => setPlaying((p) => !p)}>
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Previous frame"
              onClick={() => {
                setPlaying(false);
                setFrame((i) => (i - 1 + frames.length) % frames.length);
              }}
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Next frame"
              onClick={() => {
                setPlaying(false);
                setFrame((i) => (i + 1) % frames.length);
              }}
            >
              <ChevronRight size={14} />
            </button>
            <input
              type="range"
              min={0}
              max={frames.length - 1}
              value={frame}
              onChange={(e) => {
                setPlaying(false);
                setFrame(Number(e.currentTarget.value));
              }}
              className="min-w-0 flex-1 accent-accent"
            />
            <span className="shrink-0 text-[11px] tabular-nums text-dim">
              {frame + 1} / {frames.length}
            </span>
          </div>
        )}
      </div>

      {/* Resize handle (wide layout only): a subtle 1px divider (like the old
          border) with a wider invisible grab area so it's easy to drag. */}
      {wide && (
        <div
          onPointerDown={startResize}
          title="Drag to resize"
          className="group relative w-px shrink-0 cursor-col-resize bg-bg transition-colors hover:bg-accent/60"
        >
          <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
        </div>
      )}

      {/* Layer panel. */}
      <div
        className={"flex shrink-0 flex-col bg-panel " + (wide ? "" : "max-h-48 border-t border-bg")}
        style={wide ? { width: panelW } : undefined}
      >
        <div className="flex h-[30px] shrink-0 items-center justify-between px-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-dim">
            Layers{totalLayers > 0 ? ` · ${totalLayers}` : ""}
          </span>
          <div className="flex items-center gap-0.5 text-dim">
            {celsLoading && (
              <span className="mr-1 text-[9px] text-faint" title="Decoding layer pixels for toggling…">
                loading…
              </span>
            )}
            {groupIdxs.length > 0 && (
              <button
                type="button"
                className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-overlay hover:text-text"
                onClick={toggleAll}
                title={allCollapsed ? "Expand all folders" : "Collapse all folders"}
              >
                {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
              </button>
            )}
            {data?.layered === true && (
              <>
                <button
                  type="button"
                  className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-overlay hover:text-text"
                  onClick={() => {
                    setTouched(true);
                    setHidden(new Set());
                  }}
                  title="Show all layers"
                >
                  <Eye size={13} />
                </button>
                <button
                  type="button"
                  className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-overlay hover:text-text"
                  onClick={resetDefaults}
                  title="Reset to the file’s saved visibility"
                >
                  <RotateCcw size={12} />
                </button>
              </>
            )}
          </div>
        </div>
        <div className="facet-scroll min-h-0 flex-1 overflow-y-auto pb-1">
          {displayOrder.length === 0 && state === "ready" && (
            <div className="px-2.5 py-1 text-[11px] text-faint">No layer info</div>
          )}
          {data?.layered === false && displayOrder.length > 0 && (
            <div className="px-2.5 pb-1 text-[10px] leading-snug text-faint">
              Krita layers can’t be toggled (merged image only).
            </div>
          )}
          {data !== null &&
            displayOrder.map((idx) => {
              const l = data.layers[idx];
              const off = hidden.has(idx);
              const dim = hiddenEff(idx, data.layers, hidden);
              const toggleable = data.layered;
              const isCollapsed = collapsed.has(idx);
              return (
                <div
                  key={idx}
                  className="group flex items-center gap-1.5 py-1 pr-1.5 text-[12px] transition-colors hover:bg-overlay"
                  style={{ paddingLeft: 6 + l.depth * 12 }}
                >
                  {l.isGroup ? (
                    <button
                      type="button"
                      title={isCollapsed ? "Expand folder" : "Collapse folder"}
                      onClick={() => toggleCollapse(idx)}
                      className="flex shrink-0 items-center gap-1 text-faint transition-colors hover:text-text"
                    >
                      {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      {isCollapsed ? <Folder size={12} /> : <FolderOpen size={12} />}
                    </button>
                  ) : (
                    <span className="w-3 shrink-0" />
                  )}
                  <span className={"min-w-0 flex-1 truncate " + (dim ? "text-faint" : "text-text")} title={l.name}>
                    {l.name}
                  </span>
                  {toggleable && (
                    <button
                      type="button"
                      title={off ? "Show" : "Hide"}
                      onClick={() => toggle(idx)}
                      className={
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors " +
                        (off ? "text-faint hover:text-text" : "text-dim hover:text-text")
                      }
                    >
                      {off ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
