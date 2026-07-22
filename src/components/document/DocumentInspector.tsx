import { type ReactElement } from "react";
import { X } from "lucide-react";
import { basename } from "../../stores/libraryStore";
import { humanSize } from "../FileRow";
import DocumentPreview from "./DocumentPreview";
import { docIsPdf, docIsTextual, docSupportsZoom } from "./doc";
import DocViewControls from "./DocViewControls";
import PdfLayoutControls from "./PdfLayoutControls";
import ReadWidthControls from "./ReadWidthControls";

export interface DocumentInspectorProps {
  path: string | null;
  ext: string | null;
  size: number | null;
  onClose: () => void;
  /** Panel width in px; owned by usePanelWidth in TabPane. */
  width: number;
}

/** Right-side drawer that previews the selected document (pdf/md/txt). Same
 *  shell contract as ModelInspector/TextureInspector — drag the handle wider
 *  for a bigger read. */
export default function DocumentInspector({
  path,
  ext,
  size,
  onClose,
  width,
}: DocumentInspectorProps): ReactElement {
  const hasDoc = path !== null && ext !== null;
  return (
    <aside style={{ width }} className="flex shrink-0 flex-col bg-panel">
      <div className="flex h-[34px] shrink-0 items-center justify-between border-b border-bg px-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-dim">Inspector</span>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>

      {!hasDoc ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-3">
          <p className="text-[11px] text-dim">Select a document to preview it.</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Controls strip — layout (PDF only) on the left, zoom on the right.
              A dedicated row keeps the header uncramped in a narrow drawer. */}
          {docSupportsZoom(ext) && (
            <div className="flex shrink-0 items-center gap-2 border-b border-bg px-2.5 py-1.5">
              {docIsPdf(ext) && <PdfLayoutControls />}
              {docIsTextual(ext) && <ReadWidthControls />}
              <DocViewControls className="ml-auto" />
            </div>
          )}
          {/* The preview fills the drawer and scrolls internally. */}
          <div className="flex min-h-0 flex-1 flex-col border-b border-bg">
            <DocumentPreview key={path} path={path} ext={ext} />
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
