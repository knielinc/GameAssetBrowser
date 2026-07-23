import type { ReactElement } from "react";
import { X } from "lucide-react";
import type { AssetKind } from "../types";
import type { LibFile } from "../stores/libraryStore";
import type { TextureItem } from "../material/classify";
import ModelInspector from "./model/ModelInspector";
import TextureInspector from "./texture/TextureInspector";
import SpriteArtInspector from "./texture/SpriteArtInspector";
import { isSpriteArt } from "./texture/SpriteArtView";
import DocumentInspector from "./document/DocumentInspector";
import AudioInspector from "./audio/AudioInspector";
import { docIsPsd } from "./document/doc";
import type { PreviewState } from "./texture/PreviewControls";

export interface InspectorPanelProps {
  /** The tab's kind; on "all" the inspector follows the selected file instead. */
  kind: AssetKind;
  selectedFile: LibFile | null;
  /** Texture grid item (material or lone file) for the texture inspector. */
  selectedItem: TextureItem | null;
  preview3d: PreviewState;
  onPreviewChange: (patch: Partial<PreviewState>) => void;
  onClose: () => void;
  width: number;
}

/**
 * The right-side inspector, dispatched to the right panel for the selected
 * file's kind. Pulled out of TabPane so that god-component isn't also the
 * per-kind inspector router. On the "all" tab it follows the SELECTED file's
 * own kind (null → a placeholder, so the resizer is never orphaned).
 */
export default function InspectorPanel({
  kind,
  selectedFile,
  selectedItem,
  preview3d,
  onPreviewChange,
  onClose,
  width,
}: InspectorPanelProps): ReactElement {
  const inspectorKind = kind === "all" ? (selectedFile?.kind ?? null) : kind;
  switch (inspectorKind) {
    case "audio":
      return <AudioInspector file={selectedFile} onClose={onClose} width={width} />;
    case "model":
      return (
        <ModelInspector
          path={selectedFile?.path ?? null}
          size={selectedFile?.size ?? null}
          onClose={onClose}
          width={width}
        />
      );
    case "texture":
      // Sprite sheets and PSDs get their bespoke inspectors; everything else is
      // the standard texture preview.
      return isSpriteArt(selectedFile?.ext) ? (
        <SpriteArtInspector
          path={selectedFile?.path ?? null}
          ext={selectedFile?.ext ?? null}
          size={selectedFile?.size ?? null}
          onClose={onClose}
          width={width}
        />
      ) : docIsPsd(selectedFile?.ext ?? "") ? (
        <DocumentInspector
          path={selectedFile?.path ?? null}
          ext={selectedFile?.ext ?? null}
          size={selectedFile?.size ?? null}
          onClose={onClose}
          width={width}
        />
      ) : (
        <TextureInspector
          item={selectedItem}
          preview={preview3d}
          onPreviewChange={onPreviewChange}
          onClose={onClose}
          width={width}
        />
      );
    case "document":
      return (
        <DocumentInspector
          path={selectedFile?.path ?? null}
          ext={selectedFile?.ext ?? null}
          size={selectedFile?.size ?? null}
          onClose={onClose}
          width={width}
        />
      );
    default:
      // "all" tab with nothing selected — keep the panel (and its resizer)
      // present rather than orphaning the handle.
      return (
        <aside style={{ width }} className="flex shrink-0 flex-col bg-panel">
          <div className="flex h-[34px] shrink-0 items-center justify-between border-b border-bg px-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-dim">Inspector</span>
            <button type="button" className="icon-btn" title="Close" onClick={onClose}>
              <X size={13} />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-3">
            <p className="text-[11px] text-dim">Select a file to inspect it.</p>
          </div>
        </aside>
      );
  }
}
