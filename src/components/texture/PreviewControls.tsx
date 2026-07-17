import type { ReactElement } from "react";
import clsx from "clsx";
import {
  LIGHT_MODES,
  MESH_MODES,
  type LightMode,
  type MeshMode,
} from "./TexturePreview";

export interface PreviewState {
  mesh: MeshMode;
  light: LightMode;
  tiles: number;
}

export interface PreviewControlsProps {
  value: PreviewState;
  onChange: (patch: Partial<PreviewState>) => void;
  /** Horizontal row (fullscreen) vs stacked (drawer). */
  inline?: boolean;
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
export default function PreviewControls({ value, onChange, inline }: PreviewControlsProps): ReactElement {
  const groups = (
    <>
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
