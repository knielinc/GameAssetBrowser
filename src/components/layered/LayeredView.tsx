import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import {
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Contrast,
  Droplet,
  Eye,
  EyeOff,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  Link2,
  Pause,
  Play,
  RotateCcw,
  Shapes,
  Type,
} from "lucide-react";
import { defaultHidden } from "./composite";
import { LayerRenderer } from "./renderer";
import { useLibraryStore } from "../../stores/libraryStore";
import { thumbKeyFor } from "../../thumbKey";
import { thumbUrl } from "../../types";
import { useCallback } from "react";
import { hiddenEff, type LayerKind, type LayerNode } from "./types";
import { isSpriteArt, useDisplayOrder, useLayeredDoc } from "./useLayeredDoc";

/**
 * One preview for every layered art format — Photoshop, Krita and Aseprite.
 *
 * A canvas showing the composite, a layer tree you can fold and switch layers
 * off in, and (Aseprite) animation transport with tag selection. The document
 * itself is loaded and decoded by `useLayeredDoc`; everything here is UI plus
 * the call into the shared compositor.
 */

const KIND_ICON: Record<LayerKind, typeof ImageIcon> = {
  paint: ImageIcon,
  group: Folder,
  mask: Droplet,
  filter: Contrast,
  vector: Shapes,
  clone: Link2,
  file: FileText,
  text: Type,
  smart: Box,
  other: Layers,
};

export default function LayeredView({ path, ext }: { path: string; ext: string }): ReactElement {
  // Layer pixels are the expensive half of a load and are not needed to SHOW
  // the document — the file's own flattened image covers that. They are fetched
  // the moment anything actually needs them: a layer toggle, or hovering the
  // panel (which hides the latency behind the reach for the mouse).
  const [wantCels, setWantCels] = useState(false);
  const { status, doc, merged, cels, masks, effects, celsReady, version } = useLayeredDoc(
    path,
    ext,
    wantCels,
  );
  /** True once the canvas has real pixels — the thumb placeholder then leaves. */
  const [painted, setPainted] = useState(false);
  // The grid thumbnail this file already has in the RAM cache: an instant
  // stand-in for the first few hundred milliseconds. A cache miss just 404s
  // and the <img> hides itself.
  const placeholder = useLibraryStore(
    useCallback(
      (s: { allFiles: { path: string; size: number; modified: number }[] }) => {
        const f = s.allFiles.find((x) => x.path === path);
        return f === undefined ? null : thumbUrl(thumbKeyFor(f.path, f.size, f.modified));
      },
      [path],
    ),
  );
  const [placeholderOk, setPlaceholderOk] = useState(true);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  /** Until the user touches a layer, show the file's own flattened image. */
  const [touched, setTouched] = useState(false);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [tag, setTag] = useState<string>("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<LayerRenderer | null>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(true);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Width of the side layer panel (wide layout). Drag its edge to resize.
  const [panelW, setPanelW] = useState(224);
  // Aseprite is pixel art and wants nearest-neighbour at integer scales; a
  // Photoshop or Krita document is not, and looks wrong that way.
  const pixelArt = isSpriteArt(ext);

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

  const layers = doc?.layers;
  const frames = doc?.frames ?? [];
  const tags = doc?.tags ?? [];
  const animated = frames.length > 1;

  // A fresh document resets the panel to whatever the file itself saved.
  useEffect(() => {
    if (doc === null) return;
    setHidden(defaultHidden(doc.layers));
    // Folders start COLLAPSED — these files nest hundreds of layers deep.
    setCollapsed(new Set(doc.layers.map((l, i) => (l.isGroup ? i : -1)).filter((i) => i >= 0)));
    setTouched(false);
    // Without an exact flattened image the live composite is the only preview,
    // so the pixels are needed straight away (this is Aseprite's case). Also
    // resets the flag for a newly opened document.
    setWantCels(!doc.mergedExact);
    setFrame(0);
    setTag("");
    setPlaying(true);
  }, [doc]);

  const groupIdxs = useMemo(
    () => (layers ?? []).map((l, i) => (l.isGroup ? i : -1)).filter((i) => i >= 0),
    [layers],
  );
  const displayOrder = useDisplayOrder(layers, collapsed);

  // The frame range the transport plays: the whole timeline, or a tag's slice.
  const range = useMemo(() => {
    const t = tags.find((x) => x.name === tag);
    if (t === undefined) return { from: 0, to: Math.max(frames.length - 1, 0) };
    return { from: t.from, to: Math.min(t.to, Math.max(frames.length - 1, 0)) };
  }, [tag, tags, frames.length]);

  useEffect(() => {
    setFrame((f) => (f < range.from || f > range.to ? range.from : f));
  }, [range]);

  // The renderer owns the canvas's graphics context for the life of the view —
  // a canvas can't switch between webgl2 and 2d once one is handed out.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const r = new LayerRenderer(canvas);
    rendererRef.current = r;
    return () => {
      rendererRef.current = null;
      r.dispose();
    };
  }, [status === "ready" && doc !== null]);

  // Draw. Until the user toggles something we show the file's own flattened
  // image, which is pixel-exact; our live composite only approximates the parts
  // of each format's stack we can't evaluate (layer effects, adjustments).
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer === null || doc === null) return;
    // Nothing to composite yet (or ever), or the file's own flattened image is
    // the better picture and the user hasn't started switching layers off.
    const usable = doc.layered && cels.size > 0;
    if (merged !== null && (!usable || (!touched && doc.mergedExact))) {
      renderer.present(merged, doc.width, doc.height);
      return;
    }
    renderer.render({ doc, cels, masks, effects, hidden, frame });
  }, [doc, merged, cels, masks, effects, hidden, frame, touched, version]);

  // Mark the first real paint (drops the thumbnail placeholder), and reset the
  // flag when a new document starts loading.
  useEffect(() => {
    if (merged !== null || (doc !== null && cels.size > 0)) setPainted(true);
  }, [merged, doc, cels]);
  useEffect(() => {
    setPainted(false);
    setPlaceholderOk(true);
  }, [path]);

  // Once the preview is up, quietly pull the layer pixels in the background and
  // pre-upload them as GPU textures, so the FIRST toggle is as instant as every
  // later one. The short delay keeps the preview's own transfer uncontended.
  useEffect(() => {
    if (doc === null || wantCels || !doc.layered) return;
    const t = window.setTimeout(() => setWantCels(true), 250);
    return () => window.clearTimeout(t);
  }, [doc, wantCels]);
  useEffect(() => {
    if (cels.size === 0) return;
    const bitmaps: ImageBitmap[] = [];
    for (const c of cels.values()) bitmaps.push(c.bitmap);
    for (const m of masks.values()) bitmaps.push(m.bitmap);
    for (const list of effects.values()) for (const e of list) bitmaps.push(e.bitmap);
    rendererRef.current?.prime(bitmaps);
  }, [version, cels, masks, effects]);

  // Advance the animation.
  useEffect(() => {
    if (!playing || range.to <= range.from) return;
    const hold = Math.max(20, frames[Math.min(frame, frames.length - 1)]?.durationMs || 100);
    const t = window.setTimeout(
      () => setFrame((i) => (i >= range.to ? range.from : i + 1)),
      hold,
    );
    return () => window.clearTimeout(t);
  }, [playing, frame, frames, range]);

  // Panel on the side when there's room, stacked below when narrow.
  useEffect(() => {
    if (root === null) return;
    const measure = (): void => setWide(root.clientWidth >= 560);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
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

  // Fit-to-view. Pixel art snaps to integer up-scales so a 16x16 sprite fills
  // the frame crisply; everything else scales freely.
  const scale = useMemo(() => {
    if (doc === null || size.w === 0 || size.h === 0) return 1;
    const s = Math.min((size.w - 12) / doc.width, (size.h - 12) / doc.height);
    if (!pixelArt) return Math.max(0.02, Math.min(s, 1));
    return s >= 1 ? Math.max(1, Math.floor(s)) : Math.max(0.02, s);
  }, [doc, size, pixelArt]);

  const toggle = (i: number): void => {
    setTouched(true);
    setWantCels(true);
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

  const allCollapsed = groupIdxs.length > 0 && groupIdxs.every((i) => collapsed.has(i));
  const toggleAll = (): void => setCollapsed(allCollapsed ? new Set() : new Set(groupIdxs));
  const resetDefaults = (): void => {
    if (doc === null) return;
    setHidden(defaultHidden(doc.layers));
    setCollapsed(new Set(groupIdxs));
    setTouched(false); // back to the file's own flattened image
  };

  const toggleable = doc?.layered === true;
  const total = layers?.length ?? 0;

  return (
    <div ref={setRoot} className={"flex min-h-0 flex-1 " + (wide ? "flex-row" : "flex-col")}>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Composite preview on a checkerboard so transparency reads. */}
        <div
          ref={setStage}
          className="doc-checker flex min-h-0 flex-1 items-center justify-center overflow-hidden p-1.5"
        >
          {status === "ready" && doc !== null ? (
            <div
              className="relative"
              style={{ width: doc.width * scale, height: doc.height * scale }}
            >
              {/* The cached grid thumbnail stands in until the first real
                  paint — instant, if blurry, beats a blank rectangle. */}
              {!painted && placeholder !== null && placeholderOk && (
                <img
                  src={placeholder}
                  alt=""
                  onError={() => setPlaceholderOk(false)}
                  className="absolute inset-0 h-full w-full"
                  style={{ imageRendering: pixelArt ? "pixelated" : "auto" }}
                />
              )}
              <canvas
                ref={canvasRef}
                className="h-full w-full shadow-e1"
                style={{ imageRendering: pixelArt ? "pixelated" : "auto" }}
              />
            </div>
          ) : placeholder !== null && placeholderOk && status === "loading" ? (
            <img
              src={placeholder}
              alt=""
              onError={() => setPlaceholderOk(false)}
              className="max-h-full max-w-full opacity-90 shadow-e1"
              style={{ imageRendering: pixelArt ? "pixelated" : "auto" }}
            />
          ) : (
            <div className="text-xs text-white/80">
              {status === "error" ? "Couldn’t read this file." : "Reading…"}
            </div>
          )}
        </div>
        {status === "ready" && animated && (
          <div className="flex shrink-0 items-center gap-2 border-t border-bg bg-panel px-2.5 py-1.5">
            <button
              type="button"
              className="icon-btn"
              title={playing ? "Pause" : "Play"}
              onClick={() => setPlaying((p) => !p)}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Previous frame"
              onClick={() => {
                setPlaying(false);
                setFrame((i) => (i <= range.from ? range.to : i - 1));
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
                setFrame((i) => (i >= range.to ? range.from : i + 1));
              }}
            >
              <ChevronRight size={14} />
            </button>
            {tags.length > 0 && (
              <select
                className="min-w-0 max-w-[9rem] shrink rounded bg-overlay px-1 py-0.5 text-[11px] text-text"
                value={tag}
                onChange={(e) => {
                  setTag(e.currentTarget.value);
                  setPlaying(true);
                }}
                title="Animation tag"
              >
                <option value="">All frames</option>
                {tags.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <input
              type="range"
              min={range.from}
              max={range.to}
              value={Math.min(Math.max(frame, range.from), range.to)}
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

      {/* Resize handle (wide layout only): a subtle 1px divider with a wider
          invisible grab area so it's easy to drag. */}
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
        className={"flex shrink-0 flex-col bg-panel " + (wide ? "" : "max-h-52 border-t border-bg")}
        style={wide ? { width: panelW } : undefined}
        // Reaching for the panel is the earliest reliable sign the layer pixels
        // are about to be wanted; starting the fetch here hides most of its
        // latency behind the mouse travel.
        onPointerEnter={() => setWantCels(true)}
      >
        <div className="flex h-[30px] shrink-0 items-center justify-between px-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-dim">
            Layers{total > 0 ? ` · ${total}` : ""}
          </span>
          <div className="flex items-center gap-0.5 text-dim">
            {!celsReady && status === "ready" && (
              <span className="mr-1 text-[9px] text-faint" title="Decoding layer pixels…">
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
            {toggleable && (
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
          {status === "ready" && displayOrder.length === 0 && (
            <div className="px-2.5 py-1.5 text-[11px] text-faint">No layers</div>
          )}
          {status === "ready" && !toggleable && displayOrder.length > 0 && (
            <div className="px-2.5 pb-1 text-[10px] leading-snug text-faint">
              These layers can’t be toggled (flattened image only).
            </div>
          )}
          {layers !== undefined &&
            displayOrder.map((idx) => (
              <LayerRow
                key={idx}
                idx={idx}
                layer={layers[idx]}
                off={hidden.has(idx)}
                dim={hiddenEff(idx, layers, hidden)}
                collapsed={collapsed.has(idx)}
                toggleable={toggleable}
                onToggle={toggle}
                onCollapse={toggleCollapse}
              />
            ))}
        </div>
      </div>
    </div>
  );
}

function LayerRow({
  idx,
  layer,
  off,
  dim,
  collapsed,
  toggleable,
  onToggle,
  onCollapse,
}: {
  idx: number;
  layer: LayerNode;
  off: boolean;
  dim: boolean;
  collapsed: boolean;
  toggleable: boolean;
  onToggle: (i: number) => void;
  onCollapse: (i: number) => void;
}): ReactElement {
  const Icon = KIND_ICON[layer.kind] ?? ImageIcon;
  const notes = [
    layer.adjustment !== undefined ? layer.adjustment.kind : null,
    layer.missingEffects !== undefined
      ? `${layer.missingEffects.join(", ")} not rendered`
      : null,
    layer.masked ? "masked" : null,
    layer.clip ? "clipped to the layer below" : null,
    layer.passthrough ? "pass-through group" : null,
    layer.inert
      ? layer.kind === "filter"
        ? "this adjustment type isn’t rendered"
        : "shown for reference — not rendered"
      : null,
    layer.blend !== "normal" ? layer.blend : null,
    layer.opacity < 1 ? `${Math.round(layer.opacity * 100)}%` : null,
  ].filter((s): s is string => s !== null);
  return (
    <div
      className="group flex items-center gap-1.5 py-1 pr-1.5 text-[12px] transition-colors hover:bg-overlay"
      style={{ paddingLeft: 6 + layer.depth * 12 }}
    >
      {layer.isGroup ? (
        <button
          type="button"
          title={collapsed ? "Expand folder" : "Collapse folder"}
          onClick={() => onCollapse(idx)}
          className="flex shrink-0 items-center gap-1 text-faint transition-colors hover:text-text"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          {collapsed ? <Folder size={12} /> : <FolderOpen size={12} />}
        </button>
      ) : (
        <Icon size={12} className={"ml-3 shrink-0 " + (layer.inert ? "text-faint/60" : "text-faint")} />
      )}
      <span
        className={
          "min-w-0 flex-1 truncate " +
          (dim ? "text-faint" : layer.inert ? "text-dim italic" : "text-text")
        }
        title={notes.length > 0 ? `${layer.name} — ${notes.join(", ")}` : layer.name}
      >
        {layer.name}
      </span>
      {layer.clip && (
        <span className="shrink-0 text-[9px] text-faint" title="Clipped to the layer below">
          ⌐
        </span>
      )}
      {layer.masked && (
        <Droplet size={10} className="shrink-0 text-faint" aria-label="Has a layer mask" />
      )}
      {toggleable && !layer.inert && (
        <button
          type="button"
          title={off ? "Show" : "Hide"}
          onClick={() => onToggle(idx)}
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
}
