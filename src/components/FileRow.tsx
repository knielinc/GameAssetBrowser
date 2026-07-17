import { memo, type CSSProperties, type MouseEvent, type ReactElement } from "react";
import clsx from "clsx";
import { formatTime } from "./player/TimeDisplay";

/**
 * Shared grid template so the header and rows always line up. The Length
 * column only exists for audio, so the template has to drop with it — a fixed
 * 5-column grid would leave a dead 64px gutter on the texture/model lists.
 */
export function rowGrid(withDuration: boolean): string {
  return withDuration
    ? "grid grid-cols-[minmax(0,1fr)_50px_74px_84px_64px] items-center gap-x-3 pl-3 pr-4"
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
  /** Audio only — drives both the column and the grid template. */
  showDuration: boolean;
  selected: boolean;
  playing: boolean;
  onSelect: (index: number) => void;
  onContextMenu: (index: number, e: MouseEvent<HTMLDivElement>) => void;
}

function FileRowInner({
  index,
  name,
  ext,
  size,
  modified,
  durationSeconds,
  showDuration,
  selected,
  playing,
  onSelect,
  onContextMenu,
}: FileRowProps): ReactElement {
  return (
    <div
      className={clsx("file-row", rowGrid(showDuration), selected && "row-selected")}
      onClick={() => onSelect(index)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(index, e);
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
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
