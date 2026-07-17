import { memo, type CSSProperties, type MouseEvent, type ReactElement } from "react";
import clsx from "clsx";
import { formatTime } from "./player/TimeDisplay";

/** Shared grid template so the header and rows always line up. */
export const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_50px_74px_84px_64px] items-center gap-x-3 pl-3 pr-4";

/** Muted, dark-friendly badge tints per format. */
const EXT_COLORS: Record<string, CSSProperties> = {
  wav: { color: "#a793ff", background: "rgba(124, 92, 255, 0.14)" },
  mp3: { color: "#d9b06a", background: "rgba(217, 176, 106, 0.12)" },
  flac: { color: "#6fc7bd", background: "rgba(111, 199, 189, 0.12)" },
  ogg: { color: "#d98a9e", background: "rgba(217, 138, 158, 0.12)" },
  aiff: { color: "#7ab3d9", background: "rgba(122, 179, 217, 0.12)" },
  aif: { color: "#7ab3d9", background: "rgba(122, 179, 217, 0.12)" },
  m4a: { color: "#a3c47a", background: "rgba(163, 196, 122, 0.12)" },
};

const DEFAULT_EXT_COLOR: CSSProperties = {
  color: "#9a9aae",
  background: "rgba(154, 154, 174, 0.12)",
};

function humanSize(bytes: number): string {
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
  selected,
  playing,
  onSelect,
  onContextMenu,
}: FileRowProps): ReactElement {
  return (
    <div
      className={clsx("file-row", ROW_GRID, selected && "row-selected")}
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
      <span className="text-right text-[11px] tabular-nums text-dim">
        {durationSeconds !== undefined ? formatTime(durationSeconds) : "–"}
      </span>
    </div>
  );
}

/** Memo'd: everything except the callbacks is a primitive, and both callbacks are stable. */
const FileRow = memo(FileRowInner);
export default FileRow;
