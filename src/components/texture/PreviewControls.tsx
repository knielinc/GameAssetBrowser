import { useState, type ReactElement } from "react";
import clsx from "clsx";
import { useRenderPrefs } from "../../stores/renderPrefs";
import {
  LIGHT_MODES,
  MESH_MODES,
  RELIEF_STEPS,
  type ChannelKeys,
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
}

export interface PreviewControlsProps {
  value: PreviewState;
  onChange: (patch: Partial<PreviewState>) => void;
  /** Horizontal row (fullscreen) vs stacked (drawer). */
  inline?: boolean;
  /** Whether this material actually has a height map — the Relief control is
   *  hidden without one, since it would do nothing. */
  hasHeight?: boolean;
}

/** The 3D mesh reached for when leaving 2D — plane is the least surprising. */
const DEFAULT_3D: MeshMode = "sphere";

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
  return (
    <div className="flex items-center justify-between rounded-md border border-border px-2 py-1">
      <span className="text-[10px] text-dim">{label}</span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="text-dim transition-colors duration-[120ms] hover:text-text"
          onClick={() => onChange(Math.max(min, value - 1))}
        >
          −
        </button>
        <span className="w-5 text-center text-[11px] tabular-nums">{value}</span>
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
  return <div className="flex gap-[3px]">{children}</div>;
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
        "h-[23px] flex-1 rounded-md border px-1.5 text-[10px] transition-colors duration-[120ms]",
        on
          ? "border-accent/45 bg-accent/12 text-accent"
          : "border-border text-dim hover:bg-raised hover:text-text",
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

/** Mesh / lighting / tiling selectors. Shared by the drawer and the
 *  fullscreen overlay so the two never drift apart. */
export default function PreviewControls({
  value,
  onChange,
  inline,
  hasHeight,
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
          onClick={() => { if (is2D) onChange({ mesh: DEFAULT_3D }); }}
          title="Wrap the texture on a 3D mesh"
        >
          3D
        </Seg>
      </Row>
      {!is2D && (
        <div className="mt-0.5 flex flex-col gap-1 border-l border-border pl-2">
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

  // 2D lens: rendering (smooth/pixel), scale/zoom, sprite-sheet animation.
  const controls2D = (
    <>
      <div className="flex flex-col gap-1">
        <Label>Rendering</Label>
        <button
          type="button"
          className={clsx(
            "h-[23px] rounded-md border px-2 text-[10px] transition-colors duration-[120ms]",
            pixelArt
              ? "border-accent/45 bg-accent/12 text-accent"
              : "border-border text-dim hover:bg-raised hover:text-text",
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
        <div className="flex items-center justify-between rounded-md border border-border px-2 py-1">
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
      <div className="flex flex-col gap-1.5">
        <Label>Sprite sheet</Label>
        <button
          type="button"
          className={clsx(
            "h-[23px] rounded-md border text-[10px] transition-colors duration-[120ms]",
            value.spriteOn
              ? "border-accent/45 bg-accent/12 text-accent"
              : "border-border text-dim hover:bg-raised hover:text-text",
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
                "h-[23px] rounded-md border text-[10px] transition-colors duration-[120ms]",
                value.spritePlaying
                  ? "border-accent/45 bg-accent/12 text-accent"
                  : "border-border text-dim hover:bg-raised hover:text-text",
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
