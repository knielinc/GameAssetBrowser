import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eye, EyeOff, Folder, FolderOpen, Image as ImageIcon, RotateCcw } from "lucide-react";
import type { Layer, Psd } from "ag-psd";
import { docUrl } from "./doc";

/**
 * Photoshop (.psd/.psb) preview with a live layer show/hide panel. The file is
 * parsed entirely in the webview (ag-psd, dynamic-imported), which hands us a
 * canvas per layer; we composite the visible ones ourselves so toggling a layer
 * (or a group) re-renders instantly. Normal + the common blend modes are
 * supported; masks, adjustment layers and clipping are ignored — this is a
 * faithful-enough preview, not a Photoshop renderer.
 */

type LoadState = "loading" | "ready" | "error";

interface FlatLayer {
  /** Stable index-path id, e.g. "0/2/1". */
  id: string;
  name: string;
  depth: number;
  group: boolean;
}

/** ag-psd blend-mode name → canvas compositing op. Unmapped → normal. */
const BLEND: Partial<Record<string, GlobalCompositeOperation>> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color dodge": "color-dodge",
  "color burn": "color-burn",
  "hard light": "hard-light",
  "soft light": "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
  "linear dodge": "lighter",
};

/** Depth-first, TOP layer first (PSD stores bottom-first, so iterate reversed) —
 *  the order a Photoshop layer panel shows. Also seeds the initially-hidden set. */
function walk(
  children: Layer[],
  parent: string,
  depth: number,
  out: FlatLayer[],
  hidden: Set<string>,
): void {
  for (let i = children.length - 1; i >= 0; i--) {
    const layer = children[i];
    const id = parent === "" ? `${i}` : `${parent}/${i}`;
    const group = Array.isArray(layer.children);
    out.push({ id, name: layer.name || (group ? "Group" : "Layer"), depth, group });
    if (layer.hidden === true) hidden.add(id);
    if (group) walk(layer.children as Layer[], id, depth + 1, out, hidden);
  }
}

/** Draw children bottom-first (file order) onto ctx, skipping hidden ids (a
 *  hidden group skips its whole subtree). */
function composite(
  ctx: CanvasRenderingContext2D,
  children: Layer[],
  parent: string,
  hidden: Set<string>,
): void {
  children.forEach((layer, i) => {
    const id = parent === "" ? `${i}` : `${parent}/${i}`;
    if (hidden.has(id)) return;
    if (Array.isArray(layer.children)) {
      // Group: approximate pass-through (masks/isolation ignored).
      composite(ctx, layer.children, id, hidden);
    } else if (layer.canvas != null) {
      ctx.save();
      ctx.globalAlpha = layer.opacity ?? 1;
      ctx.globalCompositeOperation = BLEND[layer.blendMode ?? "normal"] ?? "source-over";
      ctx.drawImage(layer.canvas, layer.left ?? 0, layer.top ?? 0);
      ctx.restore();
    }
  });
}

export default function PsdView({ path }: { path: string }): ReactElement {
  const [state, setState] = useState<LoadState>("loading");
  const [psd, setPsd] = useState<Psd | null>(null);
  const [flat, setFlat] = useState<FlatLayer[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [layersReady, setLayersReady] = useState(false);
  /** The file's saved hidden set, for "reset to file defaults". */
  const defaultHidden = useRef<Set<string>>(new Set());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(true);
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

  // Two-stage load. Stage 1 skips the (slow) per-layer pixel decode: it gives us
  // the baked composite + the full layer TREE almost instantly, so the image and
  // panel show right away. Stage 2 then decodes the layer pixels in the
  // background, which is what lets toggling actually re-composite.
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setPsd(null);
    setFlat([]);
    setCollapsed(new Set());
    setLayersReady(false);
    void (async () => {
      try {
        const buf = await (await fetch(docUrl(path))).arrayBuffer();
        if (cancelled) return;
        const { readPsd } = await import("ag-psd");

        const preview = readPsd(buf, { skipLayerImageData: true }); // fast
        if (cancelled) return;
        const out: FlatLayer[] = [];
        const hid = new Set<string>();
        walk(preview.children ?? [], "", 0, out, hid);
        setPsd(preview);
        setFlat(out);
        setHidden(hid);
        defaultHidden.current = new Set(hid);
        // Folders start collapsed — PSDs from game art are deeply nested.
        setCollapsed(new Set(out.filter((l) => l.group).map((l) => l.id)));
        setState("ready");

        // Yield so the composite + panel paint before the heavy decode blocks.
        await new Promise<void>((r) => window.setTimeout(r, 0));
        if (cancelled) return;
        const full = readPsd(buf, { skipCompositeImageData: true }); // layer pixels
        if (cancelled) return;
        setPsd(full);
        setLayersReady(true);
      } catch (e) {
        if (!cancelled) {
          console.error("[doc] psd parse failed", e);
          setState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Draw the composite. Until layer pixels arrive, show the baked composite;
  // after, composite the visible layers ourselves (so toggling works).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || psd === null) return;
    canvas.width = psd.width;
    canvas.height = psd.height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (layersReady) composite(ctx, psd.children ?? [], "", hidden);
    else if (psd.canvas != null) ctx.drawImage(psd.canvas, 0, 0);
  }, [psd, hidden, layersReady]);

  // Panel on the side when there's room, stacked below when narrow.
  useEffect(() => {
    if (root === null) return;
    const measure = (): void => setWide(root.clientWidth >= 560);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [root]);

  const toggle = (id: string): void =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const toggleCollapse = (id: string): void =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Rows to show: drop any layer nested under a collapsed group (ids are
  // slash-paths, so a descendant's id starts with "<group id>/").
  const collapsedList = [...collapsed];
  const shown = flat.filter((l) => !collapsedList.some((cid) => l.id.startsWith(cid + "/")));
  const groupIds = flat.filter((l) => l.group).map((l) => l.id);
  const allCollapsed = groupIds.length > 0 && groupIds.every((id) => collapsed.has(id));
  const toggleAll = (): void => setCollapsed(allCollapsed ? new Set() : new Set(groupIds));
  const resetDefaults = (): void => {
    setHidden(new Set(defaultHidden.current));
    setCollapsed(new Set(groupIds));
  };

  return (
    <div ref={setRoot} className={"flex min-h-0 flex-1 " + (wide ? "flex-row" : "flex-col")}>
      {/* Composite preview on a checkerboard so transparency reads. */}
      <div className="doc-checker relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-2">
        {state === "ready" && psd !== null ? (
          <canvas ref={canvasRef} className="max-h-full max-w-full shadow-e1" />
        ) : (
          <div className="text-xs text-white/80">
            {state === "error" ? "Couldn’t read this PSD." : "Reading PSD…"}
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
        className={"flex shrink-0 flex-col bg-panel " + (wide ? "" : "max-h-52 border-t border-bg")}
        style={wide ? { width: panelW } : undefined}
      >
        <div className="flex h-[30px] shrink-0 items-center justify-between px-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-dim">
            Layers{flat.length > 0 ? ` · ${flat.length}` : ""}
          </span>
          <div className="flex items-center gap-0.5 text-dim">
            {!layersReady && state === "ready" && (
              <span className="mr-1 text-[9px] text-faint" title="Decoding layer pixels…">
                loading…
              </span>
            )}
            {groupIds.length > 0 && (
              <button
                type="button"
                className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-overlay hover:text-text"
                onClick={toggleAll}
                title={allCollapsed ? "Expand all folders" : "Collapse all folders"}
              >
                {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
              </button>
            )}
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-overlay hover:text-text"
              onClick={() => setHidden(new Set())}
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
          </div>
        </div>
        <div className="facet-scroll min-h-0 flex-1 overflow-y-auto pb-1">
          {state === "ready" && flat.length === 0 && (
            <div className="px-2.5 py-1.5 text-[11px] text-faint">No layers</div>
          )}
          {shown.map((l) => {
            const off = hidden.has(l.id);
            const isCollapsed = collapsed.has(l.id);
            return (
              <div
                key={l.id}
                className="group flex items-center gap-1.5 py-1 pr-1.5 text-[12px] transition-colors hover:bg-overlay"
                style={{ paddingLeft: 6 + l.depth * 12 }}
              >
                {l.group ? (
                  <button
                    type="button"
                    title={isCollapsed ? "Expand folder" : "Collapse folder"}
                    onClick={() => toggleCollapse(l.id)}
                    className="flex shrink-0 items-center gap-1 text-faint transition-colors hover:text-text"
                  >
                    {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    {isCollapsed ? <Folder size={12} /> : <FolderOpen size={12} />}
                  </button>
                ) : (
                  <ImageIcon size={12} className="ml-3 shrink-0 text-faint" />
                )}
                <span className={"min-w-0 flex-1 truncate " + (off ? "text-faint" : "text-text")}>
                  {l.name}
                </span>
                <button
                  type="button"
                  title={off ? "Show" : "Hide"}
                  onClick={() => toggle(l.id)}
                  className={
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors " +
                    (off ? "text-faint hover:text-text" : "text-dim hover:text-text")
                  }
                >
                  {off ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
