import { memo, type CSSProperties, type MouseEvent, type ReactElement } from "react";
import clsx from "clsx";
import { Layers, Star } from "lucide-react";
import { formatTime } from "./player/TimeDisplay";
import { CHANNEL_CODE } from "../material/table";
import type { Material } from "../material/classify";

/**
 * Shared grid template so the header and rows always line up. The Format and
 * Length columns only exist for audio, so the template has to drop with them —
 * a fixed grid would leave a dead gutter on the texture/model lists. 108px
 * fits the widest format readout ("44.1k · 16-bit · st") at 11px.
 */
export function rowGrid(withDuration: boolean): string {
  return withDuration
    ? "grid grid-cols-[minmax(0,1fr)_50px_74px_84px_108px_64px] items-center gap-x-3 pl-3 pr-4"
    : "grid grid-cols-[minmax(0,1fr)_50px_74px_84px] items-center gap-x-3 pl-3 pr-4";
}

/** Muted, dark-friendly badge tints per format. */
const EXT_COLORS: Record<string, CSSProperties> = {
  // audio
  wav: { color: "#a793ff", background: "rgba(124, 92, 255, 0.14)" },
  mp3: { color: "#d9b06a", background: "rgba(217, 176, 106, 0.12)" },
  flac: { color: "#6fc7bd", background: "rgba(111, 199, 189, 0.12)" },
  ogg: { color: "#d98a9e", background: "rgba(217, 138, 158, 0.12)" },
  aiff: { color: "#7ab3d9", background: "rgba(122, 179, 217, 0.12)" },
  aif: { color: "#7ab3d9", background: "rgba(122, 179, 217, 0.12)" },
  m4a: { color: "#a3c47a", background: "rgba(163, 196, 122, 0.12)" },
  // textures — greens, matching the kind hue
  png: { color: "#5fd8a4", background: "rgba(61, 220, 151, 0.12)" },
  jpg: { color: "#5fd8a4", background: "rgba(61, 220, 151, 0.12)" },
  jpeg: { color: "#5fd8a4", background: "rgba(61, 220, 151, 0.12)" },
  bmp: { color: "#5fd8a4", background: "rgba(61, 220, 151, 0.12)" },
  tga: { color: "#6ec9b8", background: "rgba(110, 201, 184, 0.12)" },
  dds: { color: "#6ec9b8", background: "rgba(110, 201, 184, 0.12)" },
  tif: { color: "#6ec9b8", background: "rgba(110, 201, 184, 0.12)" },
  tiff: { color: "#6ec9b8", background: "rgba(110, 201, 184, 0.12)" },
  exr: { color: "#8fd97a", background: "rgba(143, 217, 122, 0.12)" },
  hdr: { color: "#8fd97a", background: "rgba(143, 217, 122, 0.12)" },
  // models — ambers, matching the kind hue
  fbx: { color: "#ffb454", background: "rgba(255, 180, 84, 0.12)" },
  obj: { color: "#e0a267", background: "rgba(224, 162, 103, 0.12)" },
  gltf: { color: "#ffc978", background: "rgba(255, 201, 120, 0.12)" },
  glb: { color: "#ffc978", background: "rgba(255, 201, 120, 0.12)" },
  dae: { color: "#e0a267", background: "rgba(224, 162, 103, 0.12)" },
  "3ds": { color: "#e0a267", background: "rgba(224, 162, 103, 0.12)" },
  ply: { color: "#e0a267", background: "rgba(224, 162, 103, 0.12)" },
  stl: { color: "#e0a267", background: "rgba(224, 162, 103, 0.12)" },
  blend: { color: "#d97a52", background: "rgba(217, 122, 82, 0.12)" },
};

const DEFAULT_EXT_COLOR: CSSProperties = {
  color: "#9a9aae",
  background: "rgba(154, 154, 174, 0.12)",
};

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface FileRowProps {
  index: number;
  name: string;
  ext: string;
  size: number;
  modified: number;
  durationSeconds: number | undefined;
  /** Audio only — compact `44.1k · 16-bit · st` readout; empty until probed. */
  formatLabel: string | undefined;
  /** Audio only — drives the Format/Length columns and the grid template. */
  showDuration: boolean;
  /** Favorited — the filled amber star; off renders a hover-reveal outline. */
  starred: boolean;
  /** Star-slot click, by row index (the FileList onSelect idiom, so the memo'd
   *  row keeps one stable callback). Omitted → no star slot (material rows). */
  onToggleStar?: (index: number) => void;
  /** Multi-selection membership — the accent tint + left bar. */
  selected: boolean;
  /** Keyboard cursor while a multi-selection exists — the extra inset ring.
   *  Passed as false in single-select so the classic look is untouched. */
  focused: boolean;
  playing: boolean;
  /** Carries the click event so the pane can read Ctrl/Shift modifiers. */
  onSelect: (index: number, e: MouseEvent<HTMLDivElement>) => void;
  onContextMenu: (index: number, e: MouseEvent<HTMLDivElement>) => void;
  /** Hover-preview dwell (audio list, only when the setting is on). The enter
   *  handler gets the event so the pane can ignore hovers mid-drag. */
  onHoverStart?: (index: number, e: MouseEvent<HTMLDivElement>) => void;
  onHoverEnd?: (index: number) => void;
}

function FileRowInner({
  index,
  name,
  ext,
  size,
  modified,
  durationSeconds,
  formatLabel,
  showDuration,
  starred,
  onToggleStar,
  selected,
  focused,
  playing,
  onSelect,
  onContextMenu,
  onHoverStart,
  onHoverEnd,
}: FileRowProps): ReactElement {
  return (
    <div
      className={clsx(
        "group file-row",
        rowGrid(showDuration),
        selected && "row-selected",
        focused && "row-focused",
      )}
      onClick={(e) => onSelect(index, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(index, e);
      }}
      onMouseEnter={onHoverStart === undefined ? undefined : (e) => onHoverStart(index, e)}
      onMouseLeave={onHoverEnd === undefined ? undefined : () => onHoverEnd(index)}
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* Fixed slot (not hover-inserted) so names never shift; invisible
            until hover unless favorited. stopPropagation: a star click must
            not select — or on the audio list, play — the row. */}
        {onToggleStar !== undefined && (
          <button
            type="button"
            title={starred ? "Remove from favorites" : "Add to favorites (F)"}
            className={clsx(
              "shrink-0 rounded p-0.5 transition-opacity duration-[120ms]",
              starred
                ? "text-kind-model opacity-100"
                : "text-dim opacity-0 hover:text-text group-hover:opacity-100",
            )}
            onClick={(e) => {
              e.stopPropagation();
              onToggleStar(index);
            }}
          >
            <Star size={12} fill={starred ? "currentColor" : "none"} />
          </button>
        )}
        {playing && (
          <span className="eq shrink-0">
            <span />
            <span />
            <span />
          </span>
        )}
        <span className="truncate" title={name}>
          {name}
        </span>
      </div>

      <span
        className="justify-self-start rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
        style={EXT_COLORS[ext] ?? DEFAULT_EXT_COLOR}
      >
        {ext}
      </span>

      <span className="text-right text-[11px] tabular-nums text-dim">{humanSize(size)}</span>
      <span className="text-right text-[11px] tabular-nums text-dim">{formatDate(modified)}</span>
      {showDuration && (
        // Blank (not "–") until probed: unknown parts inside the label are
        // simply omitted, so a dash would read as "measured: nothing".
        <span className="text-right text-[11px] tabular-nums text-dim">{formatLabel ?? ""}</span>
      )}
      {showDuration && (
        <span className="text-right text-[11px] tabular-nums text-dim">
          {durationSeconds !== undefined ? formatTime(durationSeconds) : "–"}
        </span>
      )}
    </div>
  );
}

/** Memo'd: everything except the callbacks is a primitive, and both callbacks are stable. */
const FileRow = memo(FileRowInner);
export default FileRow;

export interface MaterialRowProps {
  index: number;
  material: Material;
  selected: boolean;
  /** See FileRowProps.focused. */
  focused: boolean;
  onSelect: (index: number, e: MouseEvent<HTMLDivElement>) => void;
  onContextMenu: (index: number, e: MouseEvent<HTMLDivElement>) => void;
}

/** A grouped material as a single list row: the name column carries a layers
 *  glyph + the channel codes, and the "type" slot shows the member count. Size
 *  and modified aggregate over the members. Shares rowGrid so it lines up with
 *  the file rows and the header. */
function MaterialRowInner({
  index,
  material,
  selected,
  focused,
  onSelect,
  onContextMenu,
}: MaterialRowProps): ReactElement {
  let size = 0;
  let modified = 0;
  for (const m of material.members) {
    size += m.file.size;
    if (m.file.modified > modified) modified = m.file.modified;
  }
  const codes = [...material.channels.keys()].map((c) => CHANNEL_CODE[c]).join(" · ");
  return (
    <div
      className={clsx(
        "file-row",
        rowGrid(false),
        selected && "row-selected",
        focused && "row-focused",
      )}
      onClick={(e) => onSelect(index, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(index, e);
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Layers size={13} className="shrink-0 text-accent" />
        <span className="truncate" title={`${material.display}\n${material.dir}`}>
          {material.display}
        </span>
        <span className="shrink-0 truncate font-mono text-[9px] text-faint">{codes}</span>
      </div>

      <span
        className="justify-self-start rounded px-1.5 py-px text-[10px] font-medium tabular-nums"
        style={{ color: "var(--color-accent-fg)", background: "var(--color-accent-fill)" }}
      >
        ×{material.members.length}
      </span>

      <span className="text-right text-[11px] tabular-nums text-dim">{humanSize(size)}</span>
      <span className="text-right text-[11px] tabular-nums text-dim">{formatDate(modified)}</span>
    </div>
  );
}

export const MaterialRow = memo(MaterialRowInner);
