import { useEffect, type ReactElement } from "react";
import { X } from "lucide-react";
import { useLibraryStore, type LibFile } from "../stores/libraryStore";
import { thumbUrl } from "../types";
import ModelViewport from "./model/ModelViewport";

export interface FullscreenPreviewProps {
  file: LibFile;
  onClose: () => void;
}

/**
 * In-app fullscreen preview: an overlay filling the window, NOT the OS
 * fullscreen (that's F11 and is a separate concern — see useWindowFullscreen).
 * Space toggles it, Escape closes.
 *
 * Textures show the cached thumbnail rather than the source file: the source
 * may be a DDS/TGA/EXR the webview cannot decode at all, and a 4K PNG at
 * screen size is a pointless decode. 256px upscaled is honest for a "does this
 * look right" glance; a true full-res view would need its own decode path.
 */
export default function FullscreenPreview({ file, onClose }: FullscreenPreviewProps): ReactElement {
  useLibraryStore((s) => s.thumbsVersion);
  const thumb = useLibraryStore.getState().thumbs.get(file.id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === "Escape" || e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    // Capture phase: beat the global shortcut handler, which would otherwise
    // also see this Space and immediately re-open what we just closed.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg/97 backdrop-blur-sm">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4">
        <span className="truncate text-[13px] font-medium" title={file.path}>
          {file.name}
        </span>
        <span className="truncate font-mono text-[10px] text-dim">{file.path}</span>
        <span className="ml-auto shrink-0 text-[10px] text-dim">Space or Esc to close</span>
        <button type="button" className="icon-btn shrink-0" title="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        {file.kind === "model" ? (
          <div className="h-full w-full">
            <ModelViewport path={file.path} />
          </div>
        ) : thumb !== undefined ? (
          <img
            src={thumbUrl(thumb.key)}
            alt={file.name}
            draggable={false}
            className="alpha-checker max-h-full max-w-full rounded-lg object-contain"
            style={{ imageRendering: "auto" }}
          />
        ) : (
          <p className="text-xs text-dim">No preview available yet.</p>
        )}
      </div>

      {file.kind === "texture" && thumb?.info != null && (
        <div className="flex h-8 shrink-0 items-center gap-4 border-t border-border px-4 text-[11px] text-dim">
          <span className="tabular-nums">
            thumbnail {thumb.info.width}×{thumb.info.height}
          </span>
          {thumb.info.normalLike && <span>looks like a normal map</span>}
          {thumb.info.grayscale && <span>single-channel</span>}
          {thumb.info.bimodal && <span>bimodal — likely a mask</span>}
          {thumb.info.hasAlpha && <span>has alpha</span>}
        </div>
      )}
    </div>
  );
}
