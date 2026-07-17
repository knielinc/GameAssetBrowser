import type { ReactElement } from "react";
import clsx from "clsx";
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
  /** Flat (2D) mode is active — show the sprite-sheet / animation controls
   *  instead of the 3D mesh/lighting/relief ones. */
  is2D?: boolean;
}

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
  is2D,
}: PreviewControlsProps): ReactElement {
  const meshRow = (
    <div className="flex min-w-[190px] flex-1 flex-col gap-1">
      <Label>Preview mesh</Label>
      <Row>
        {MESH_MODES.map((m) => (
          <Seg key={m.id} on={value.mesh === m.id} onClick={() => onChange({ mesh: m.id })}>
            {m.label}
          </Seg>
        ))}
      </Row>
    </div>
  );

  // Flat mode is the 2D lens: its sub-settings are animation, not lighting.
  if (is2D === true) {
    return (
      <div className={clsx("flex gap-3", inline ? "flex-row items-end" : "flex-col")}>
        {meshRow}
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
      </div>
    );
  }

  const groups = (
    <>
      {meshRow}
      {/* Flat is an unlit 2D image view — a lighting control there would do
          nothing, and a control that does nothing is worse than no control. */}
      {value.mesh !== "flat" && (
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
      )}
      {/* Parallax depth from the height map — a fragment-shader effect, so it
          adds surface relief on any mesh without moving geometry or seaming
          edges. Hidden without a height map, and on flat/env/unlit. */}
      {hasHeight === true && value.mesh !== "env" && value.mesh !== "flat" && value.light !== "unlit" && (
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
      {/* Tiling is meaningless on a panorama — it must never repeat. */}
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

  return <div className={clsx("flex gap-3", inline ? "flex-row items-end" : "flex-col")}>{groups}</div>;
}
