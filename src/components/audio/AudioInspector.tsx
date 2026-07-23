import { useEffect, type ReactElement } from "react";
import { AudioLines, X } from "lucide-react";
import { useLibraryStore, type LibFile } from "../../stores/libraryStore";
import { useThumbSrc } from "../../hooks/useThumbSrc";
import { requestThumbs } from "../../ipc/commands";
import { humanSize } from "../FileRow";
import { formatTime } from "../player/TimeDisplay";

export interface AudioInspectorProps {
  file: LibFile | null;
  onClose: () => void;
  /** Panel width in px; owned by usePanelWidth in TabPane. */
  width: number;
}

/** Human channel-layout name; the surround layouts get their familiar names. */
function channelLabel(n: number): string {
  if (n === 1) return "Mono";
  if (n === 2) return "Stereo";
  if (n === 6) return "5.1 surround";
  if (n === 8) return "7.1 surround";
  return `${n} channels`;
}

/**
 * Right-side drawer for an audio file: the cover art / waveform preview plus
 * the probe's details (length, sample rate, channels, bit depth). Same shell
 * contract as the other inspectors. Unlike them it needs the file's id and
 * mtime (to read the probe maps and the "a"-keyed thumbnail), so it takes the
 * whole LibFile rather than loose path/ext/size props.
 */
export default function AudioInspector({ file, onClose, width }: AudioInspectorProps): ReactElement {
  return (
    <aside style={{ width }} className="flex shrink-0 flex-col bg-panel">
      <div className="flex h-[34px] shrink-0 items-center justify-between border-b border-bg px-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-dim">Inspector</span>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      {file === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-3">
          <p className="text-[11px] text-dim">Select an audio file to inspect it.</p>
        </div>
      ) : (
        // Keyed on the path so the hooks reset cleanly between selections.
        <AudioInspectorBody key={file.path} file={file} />
      )}
    </aside>
  );
}

function AudioInspectorBody({ file }: { file: LibFile }): ReactElement {
  // The "a"-keyed cover art / waveform, same optimistic path as AudioCell.
  const { src, imgKey, onError, onLoad } = useThumbSrc(file, "a");
  // Probe results land asynchronously — re-render as each batch merges.
  useLibraryStore((s) => s.durationsVersion);
  useLibraryStore((s) => s.audioMetaVersion);
  useLibraryStore((s) => s.thumbsVersion);
  const seconds = useLibraryStore.getState().durations.get(file.id);
  const meta = useLibraryStore.getState().audioMeta.get(file.id);
  const hasThumb = useLibraryStore.getState().thumbs.has(file.id);

  // In list mode there's no grid to request the thumbnail, so decode it here
  // for the selected file. Guarded on `hasThumb` so we don't fight the grid's
  // own request queue when a grid IS mounted.
  useEffect(() => {
    if (!hasThumb) void requestThumbs([[file.id, file.path]]).catch(() => {});
  }, [file.id, file.path, hasThumb]);

  const [rate, channels, bits] = meta ?? [0, 0, 0];
  const unprobed = rate === 0 && channels === 0 && bits === 0 && seconds === undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div className="aspect-square w-full shrink-0 overflow-hidden rounded-lg bg-raised">
        {src !== null ? (
          <img
            key={imgKey}
            src={src}
            alt=""
            draggable={false}
            onError={onError}
            onLoad={onLoad}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <AudioLines size={28} className="text-kind-audio opacity-30" />
          </div>
        )}
      </div>

      <div>
        <div className="break-words text-[14px] font-semibold tracking-tight">{file.name}</div>
        <div className="break-all font-mono text-[10px] text-dim">{file.path}</div>
      </div>

      <section className="flex flex-col gap-1.5">
        <h4 className="text-[10px] font-semibold uppercase tracking-widest text-dim">Details</h4>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
          <dt className="text-dim">Format</dt>
          <dd className="m-0 text-right uppercase">{file.ext}</dd>
          {seconds !== undefined && (
            <>
              <dt className="text-dim">Length</dt>
              <dd className="m-0 text-right tabular-nums">{formatTime(seconds)}</dd>
            </>
          )}
          {rate > 0 && (
            <>
              <dt className="text-dim">Sample rate</dt>
              <dd className="m-0 text-right tabular-nums">{rate / 1000} kHz</dd>
            </>
          )}
          {channels > 0 && (
            <>
              <dt className="text-dim">Channels</dt>
              <dd className="m-0 text-right">{channelLabel(channels)}</dd>
            </>
          )}
          {bits > 0 && (
            <>
              <dt className="text-dim">Bit depth</dt>
              <dd className="m-0 text-right tabular-nums">{bits}-bit</dd>
            </>
          )}
          <dt className="text-dim">File size</dt>
          <dd className="m-0 text-right tabular-nums">{humanSize(file.size)}</dd>
        </dl>
        {unprobed && <p className="text-[10.5px] text-dim">Reading audio properties…</p>}
      </section>
    </div>
  );
}
