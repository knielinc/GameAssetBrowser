import { type ReactElement } from "react";
import { X } from "lucide-react";
import { basename } from "../../stores/libraryStore";
import { humanSize } from "../FileRow";
import SpriteArtView from "./SpriteArtView";

export interface SpriteArtInspectorProps {
  path: string | null;
  ext: string | null;
  size: number | null;
  onClose: () => void;
  width: number;
}

/** Right-side drawer for kra/aseprite — the sprite-art preview (flat + animated)
 *  plus file facts, instead of the 3D texture surface. */
export default function SpriteArtInspector({
  path,
  ext,
  size,
  onClose,
  width,
}: SpriteArtInspectorProps): ReactElement {
  return (
    <aside style={{ width }} className="flex shrink-0 flex-col bg-panel">
      <div className="flex h-[34px] shrink-0 items-center justify-between border-b border-bg px-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-dim">Inspector</span>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>

      {path === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-3">
          <p className="text-[11px] text-dim">Select a file to preview it.</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col border-b border-bg">
            <SpriteArtView key={path} path={path} />
          </div>
          <div className="shrink-0 p-3">
            <div className="break-words text-[14px] font-semibold tracking-tight">{basename(path)}</div>
            <div className="mb-2 break-all font-mono text-[10px] text-dim">{path}</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
              <dt className="text-dim">Format</dt>
              <dd className="m-0 text-right uppercase">{ext}</dd>
              {size !== null && (
                <>
                  <dt className="text-dim">File size</dt>
                  <dd className="m-0 text-right tabular-nums">{humanSize(size)}</dd>
                </>
              )}
            </dl>
          </div>
        </div>
      )}
    </aside>
  );
}
