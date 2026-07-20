import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { useRenderPrefs } from "../../stores/renderPrefs";
import { basename, useLibraryStore } from "../../stores/libraryStore";
import { useEnvPrefs } from "../../stores/envPrefs";
import {
  ISO_CHANNELS,
  LIGHT_MODES,
  MESH_MODES,
  RELIEF_STEPS,
  type ChannelKeys,
  type IsoChannel,
  type LightMode,
  type MeshMode,
} from "./TexturePreview";

export interface PreviewState {
  mesh: MeshMode;
  light: LightMode;
  tiles: number;
  /** Height displacement in mesh units. 0 = flat. */
  relief: number;
  /** Flat mode: which map to show raw. Set by clicking a row in the Maps list. */
  channel?: keyof ChannelKeys;
  /** Flat (2D) mode: scale the image to fill the available space (upscaling if
   *  needed). When false, show it at `zoomPct` of native size, scroll if it
   *  overflows. */
  zoomFit: boolean;
  /** Flat (2D) mode: zoom percent of native size when not fitting (100 = 1:1). */
  zoomPct: number;
  /** Flat (2D) mode: sprite-sheet playback. */
  spriteOn: boolean;
  spriteCols: number;
  spriteRows: number;
  spriteFps: number;
  spritePlaying: boolean;
  /** Channel isolation (flat + plane modes). Per-image inspection state —
   *  TabPane resets it to "rgb" whenever the selection changes. */
  iso: IsoChannel;
  /** Flat (2D) mode: n×n tiled repeat (seam check), independent of the 3D
   *  `tiles` so leaving 2D never surprises the mesh view. */
  flatTiles: number;
}

export interface PreviewControlsProps {
  value: PreviewState;
  onChange: (patch: Partial<PreviewState>) => void;
  /** Horizontal row (fullscreen) vs stacked (drawer). */
  inline?: boolean;
  /** Whether this material actually has a height map — the Relief control is
   *  hidden without one, since it would do nothing. */
  hasHeight?: boolean;
  /** The mesh to open on when leaving 2D. The parent sets "env" for an
   *  equirectangular map; otherwise it falls back to the flat plane. */
  default3d?: MeshMode;
}

/** The 3D mesh reached for when leaving 2D — a flat plane is the least
 *  surprising for a texture; an equirectangular env map opens on the sphere
 *  instead (the parent detects the 2:1 aspect and passes `default3d`). */
const DEFAULT_3D: MeshMode = "plane";

function Stepper({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (v: number) => void;
}): ReactElement {
  // Local text so the field can be cleared and retyped; it re-syncs whenever the
  // value changes from the outside (the +/- buttons, a new selection's default).
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (raw: string): void => {
    const n = parseInt(raw, 10);
    const next = Number.isFinite(n) ? Math.max(min, n) : value;
    onChange(next);
    setText(String(next));
  };
  return (
    <div className="flex items-center justify-between rounded-full bg-bg px-2.5 py-1">
      <span className="text-[10px] text-dim">{label}</span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="text-dim transition-colors duration-[120ms] hover:text-text"
          onClick={() => onChange(Math.max(min, value - 1))}
        >
          −
        </button>
        <input
          type="text"
          inputMode="numeric"
          className="w-6 bg-transparent text-center text-[11px] tabular-nums text-text outline-none"
          value={text}
          onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          }}
        />
        <button
          type="button"
          className="text-dim transition-colors duration-[120ms] hover:text-text"
          onClick={() => onChange(value + 1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

function Row({ children }: { children: ReactElement[] }): ReactElement {
  return <div className="flex gap-0.5 rounded-full bg-bg p-0.5">{children}</div>;
}

function Seg({
  on,
  onClick,
  children,
  title,
}: {
  on: boolean;
  onClick: () => void;
  children: string;
  title?: string;
}): ReactElement {
  return (
    <button
      type="button"
      title={title}
      className={clsx(
        "h-[23px] flex-1 rounded-full px-2 text-[10px] transition-colors duration-[120ms]",
        on
          ? "bg-accent-fill font-medium text-accent-fg shadow-e1"
          : "text-dim hover:bg-overlay hover:text-text",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const Label = ({ children }: { children: string }): ReactElement => (
  <div className="text-[9px] font-semibold uppercase tracking-widest text-dim opacity-75">
    {children}
  </div>
);

/** How many library HDRIs the environment dropdown lists. A library can hold
 *  thousands of .hdr files; past a couple hundred the popup helps no one. */
const ENV_LIST_CAP = 200;

/**
 * Library-HDRI environment picker: any .hdr/.exr in the library can light the
 * 3D preview (and back the env view). A custom dropdown, not <select> — the
 * native popup can't be themed in WebView2 (same reason as the Toolbar sort
 * menu). The choice lives in envPrefs: session-global, shared drawer ↔
 * fullscreen.
 */
function EnvPicker({ up }: { up: boolean }): ReactElement {
  const allFiles = useLibraryStore((s) => s.allFiles);
  const envPath = useEnvPrefs((s) => s.envPath);
  const setEnvPath = useEnvPrefs((s) => s.setEnvPath);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Capture + stop so closing the picker doesn't also collapse a selection.
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const hdris = useMemo(
    () =>
      allFiles
        .filter((f) => {
          const e = f.ext.toLowerCase();
          return e === "hdr" || e === "exr";
        })
        .slice(0, ENV_LIST_CAP),
    [allFiles],
  );

  return (
    <div ref={ref} className="relative flex min-w-[150px] flex-col gap-1">
      <Label>Environment</Label>
      <button
        type="button"
        aria-expanded={open}
        title={envPath ?? "Lighting environment — Default is the built-in studio room"}
        className="flex h-[23px] items-center justify-between gap-1 rounded-full bg-bg px-2.5 text-[10px] text-text transition-colors duration-[120ms] hover:bg-overlay"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="truncate">{envPath === null ? "Default" : basename(envPath)}</span>
        <ChevronDown
          size={11}
          className={clsx("shrink-0 text-faint transition-transform duration-[120ms]", open && "rotate-180")}
        />
      </button>
      {open && (
        <div
          className={clsx(
            "absolute left-0 z-50 max-h-56 w-60 overflow-y-auto rounded-xl bg-raised p-1 shadow-e2",
            // Fullscreen puts the controls at the window's bottom edge — open
            // upward there; the drawer has room below.
            up ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]",
          )}
        >
          <button
            type="button"
            className={clsx(
              "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors duration-[120ms]",
              envPath === null
                ? "bg-accent-fill text-accent-fg"
                : "text-dim hover:bg-overlay hover:text-text",
            )}
            onClick={() => {
              setEnvPath(null);
              setOpen(false);
            }}
          >
            Default
            {envPath === null && <Check size={13} className="shrink-0" />}
          </button>
          {hdris.map((f) => (
            <button
              key={f.path}
              type="button"
              title={f.path}
              className={clsx(
                "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors duration-[120ms]",
                f.path === envPath
                  ? "bg-accent-fill text-accent-fg"
                  : "text-dim hover:bg-overlay hover:text-text",
              )}
              onClick={() => {
                setEnvPath(f.path);
                setOpen(false);
              }}
            >
              <span className="truncate">{f.name}</span>
              {f.path === envPath && <Check size={13} className="shrink-0" />}
            </button>
          ))}
          {hdris.length === 0 && (
            <div className="px-2.5 py-1.5 text-[11px] text-dim">No .hdr / .exr in the library</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Mesh / lighting / tiling selectors. Shared by the drawer and the
 *  fullscreen overlay so the two never drift apart. */
export default function PreviewControls({
  value,
  onChange,
  inline,
  hasHeight,
  default3d,
}: PreviewControlsProps): ReactElement {
  const pixelArt = useRenderPrefs((s) => s.pixelArt);
  const togglePixelArt = useRenderPrefs((s) => s.toggle);
  const is2D = value.mesh === "flat";
  const meshes3D = MESH_MODES.filter((m) => m.id !== "flat");
  const zoomStep = (delta: number): void =>
    onChange({ zoomFit: false, zoomPct: Math.min(1600, Math.max(10, (value.zoomFit ? 100 : value.zoomPct) + delta)) });
  // Local text while the zoom field is focused, so a half-typed value isn't
  // clamped out from under the cursor; committed on blur / Enter.
  const [zoomEdit, setZoomEdit] = useState<string | null>(null);
  const commitZoom = (raw: string): void => {
    const n = parseInt(raw.replace(/[^0-9]/g, ""), 10);
    if (!Number.isNaN(n)) onChange({ zoomFit: false, zoomPct: Math.min(1600, Math.max(1, n)) });
    setZoomEdit(null);
  };

  // Preview kind: 2D (the flat image) vs 3D (wrapped on a mesh). The mesh
  // choices are 3D sub-options, shown only once you're in 3D.
  const previewGroup = (
    <div className="flex min-w-[150px] flex-col gap-1">
      <Label>Preview</Label>
      <Row>
        <Seg on={is2D} onClick={() => onChange({ mesh: "flat" })} title="Flat 2D image">
          2D
        </Seg>
        <Seg
          on={!is2D}
          onClick={() => { if (is2D) onChange({ mesh: default3d ?? DEFAULT_3D }); }}
          title="Wrap the texture on a 3D mesh"
        >
          3D
        </Seg>
      </Row>
      {!is2D && (
        <div className="mt-0.5 flex flex-col gap-1 pl-2">
          <Label>Mesh</Label>
          <Row>
            {meshes3D.map((m) => (
              <Seg key={m.id} on={value.mesh === m.id} onClick={() => onChange({ mesh: m.id })}>
                {m.label}
              </Seg>
            ))}
          </Row>
        </div>
      )}
    </div>
  );

  // Channel isolation — flat and plane only, the two "look at the image"
  // modes; on sphere/cube/env the composed surface is the point.
  const channelsGroup = (
    <div className="flex min-w-[150px] flex-col gap-1">
      <Label>Channels</Label>
      <Row>
        {ISO_CHANNELS.map((c) => (
          <Seg
            key={c.id}
            on={value.iso === c.id}
            onClick={() => onChange({ iso: c.id })}
            title={
              c.id === "rgb"
                ? "Full image"
                : c.id === "a"
                  ? "Alpha channel as grayscale (opaque)"
                  : `${c.label} channel as grayscale`
            }
          >
            {c.label}
          </Seg>
        ))}
      </Row>
    </div>
  );

  // 2D lens: rendering (smooth/pixel), scale/zoom, sprite-sheet animation.
  const controls2D = (
    <>
      <div className="flex flex-col gap-1">
        <Label>Rendering</Label>
        <button
          type="button"
          className={clsx(
            "h-[23px] rounded-full px-3 text-[10px] transition-colors duration-[120ms]",
            pixelArt
              ? "bg-accent-fill font-medium text-accent-fg shadow-e1"
              : "bg-bg text-dim hover:bg-overlay hover:text-text",
          )}
          onClick={togglePixelArt}
          title="Nearest-neighbour scaling — applies to every thumbnail and preview at once"
        >
          {pixelArt ? "Pixel" : "Smooth"}
        </button>
      </div>
      <div className="flex min-w-[132px] flex-col gap-1">
        <Label>Scale</Label>
        <Row>
          <Seg on={value.zoomFit} onClick={() => onChange({ zoomFit: true })} title="Fit to the available space">
            Fit
          </Seg>
          <Seg
            on={!value.zoomFit && value.zoomPct === 100}
            onClick={() => onChange({ zoomFit: false, zoomPct: 100 })}
            title="Actual pixels (100%)"
          >
            100%
          </Seg>
        </Row>
        <div className="flex items-center justify-between rounded-full bg-bg px-2.5 py-1">
          <button
            type="button"
            className="text-dim transition-colors duration-[120ms] hover:text-text"
            onClick={() => zoomStep(-10)}
            title="Zoom out 10%"
          >
            −
          </button>
          <input
            type="text"
            inputMode="numeric"
            value={zoomEdit ?? (value.zoomFit ? "Fit" : `${value.zoomPct}%`)}
            onFocus={(e) => {
              setZoomEdit(value.zoomFit ? "" : String(value.zoomPct));
              requestAnimationFrame(() => e.target.select());
            }}
            onChange={(e) => setZoomEdit(e.target.value)}
            onBlur={(e) => commitZoom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") {
                setZoomEdit(null);
                e.currentTarget.blur();
              }
            }}
            className="w-12 bg-transparent text-center text-[11px] tabular-nums text-text outline-none"
            title="Type a zoom percentage"
          />
          <button
            type="button"
            className="text-dim transition-colors duration-[120ms] hover:text-text"
            onClick={() => zoomStep(10)}
            title="Zoom in 10%"
          >
            +
          </button>
        </div>
      </div>
      {channelsGroup}
      <div className="flex w-[110px] flex-col gap-1">
        <Label>Tiling</Label>
        <Row>
          {[1, 2, 3].map((n) => (
            <Seg
              key={n}
              on={value.flatTiles === n}
              onClick={() => onChange({ flatTiles: n })}
              title={`${n}×${n} repeat — check the seam`}
            >
              {`${n}×`}
            </Seg>
          ))}
        </Row>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Sprite sheet</Label>
        <button
          type="button"
          className={clsx(
            "h-[23px] rounded-full text-[10px] transition-colors duration-[120ms]",
            value.spriteOn
              ? "bg-accent-fill font-medium text-accent-fg shadow-e1"
              : "bg-bg text-dim hover:bg-overlay hover:text-text",
          )}
          onClick={() => onChange({ spriteOn: !value.spriteOn })}
          title="Slice the image into a grid and play it as an animation"
        >
          {value.spriteOn ? "On" : "Off"}
        </button>
        {value.spriteOn && (
          <div className="flex flex-col gap-1.5">
            <Stepper label="Cols" value={value.spriteCols} min={1} onChange={(v) => onChange({ spriteCols: v })} />
            <Stepper label="Rows" value={value.spriteRows} min={1} onChange={(v) => onChange({ spriteRows: v })} />
            <Stepper label="FPS" value={value.spriteFps} min={1} onChange={(v) => onChange({ spriteFps: v })} />
            <button
              type="button"
              className={clsx(
                "h-[23px] rounded-full text-[10px] transition-colors duration-[120ms]",
                value.spritePlaying
                  ? "bg-accent-fill font-medium text-accent-fg shadow-e1"
                  : "bg-bg text-dim hover:bg-overlay hover:text-text",
              )}
              onClick={() => onChange({ spritePlaying: !value.spritePlaying })}
            >
              {value.spritePlaying ? "⏸ Pause" : "▶ Play"}
            </button>
          </div>
        )}
      </div>
    </>
  );

  // 3D lens: lighting, parallax relief, tiling.
  const controls3D = (
    <>
      <div className="flex min-w-[190px] flex-1 flex-col gap-1">
        <Label>Lighting</Label>
        <Row>
          {LIGHT_MODES.map((l) => (
            <Seg key={l.id} on={value.light === l.id} onClick={() => onChange({ light: l.id })}>
              {l.label}
            </Seg>
          ))}
        </Row>
      </div>
      {/* Env-relevant everywhere in 3D: it's the IBL for plane/sphere/cube and
          the backdrop in env mode. Fullscreen (inline) opens the list upward. */}
      <EnvPicker up={inline === true} />
      {value.mesh === "plane" && channelsGroup}
      {hasHeight === true && value.mesh !== "env" && value.light !== "unlit" && (
        <div className="flex w-[160px] flex-col gap-1">
          <Label>Relief</Label>
          <Row>
            {RELIEF_STEPS.map((r) => (
              <Seg
                key={r.id}
                on={value.relief === r.value}
                onClick={() => onChange({ relief: r.value })}
                title="Parallax depth from the height map — surface relief without changing the silhouette or seaming edges"
              >
                {r.label}
              </Seg>
            ))}
          </Row>
        </div>
      )}
      {value.mesh !== "env" && (
        <div className="flex w-[132px] flex-col gap-1">
          <Label>Tiling</Label>
          <Row>
            {[1, 2, 4, 8].map((n) => (
              <Seg
                key={n}
                on={value.tiles === n}
                onClick={() => onChange({ tiles: n })}
                title={`${n}×${n} repeat — check the seam`}
              >
                {`${n}×`}
              </Seg>
            ))}
          </Row>
        </div>
      )}
    </>
  );

  return (
    <div className={clsx("flex gap-3", inline ? "flex-row items-end" : "flex-col")}>
      {previewGroup}
      {is2D ? controls2D : controls3D}
    </div>
  );
}
