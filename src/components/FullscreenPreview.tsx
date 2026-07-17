import { useEffect, type ReactElement } from "react";
import { X } from "lucide-react";
import { useLibraryStore, type LibFile } from "../stores/libraryStore";
import type { TextureItem } from "../material/classify";
import ModelViewport from "./model/ModelViewport";
import TexturePreview from "./texture/TexturePreview";
import Sprite2DView from "./texture/Sprite2DView";
import PreviewControls, { type PreviewState } from "./texture/PreviewControls";
import { keysForFile, keysForMaterial } from "./texture/TextureInspector";

export interface FullscreenPreviewProps {
  file: LibFile;
  /** The grid item, so a material previews as a material and not one file. */
  item: TextureItem | null;
  preview3d: PreviewState;
  onPreviewChange: (patch: Partial<PreviewState>) => void;
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
export default function FullscreenPreview({
  file,
  item,
  preview3d,
  onPreviewChange,
  onClose,
}: FullscreenPreviewProps): ReactElement {
  useLibraryStore((s) => s.thumbsVersion);
  const thumbs = useLibraryStore.getState().thumbs;
  const thumb = thumbs.get(file.id);

  const keys =
    item === null
      ? file.kind === "texture" && thumb !== undefined
        ? { baseColor: thumb.key }
        : {}
      : item.kind === "material"
        ? keysForMaterial(item.material, thumbs)
        : keysForFile(item.file, item.channel, thumbs);

  // Flat mode on a texture is the 2D lens — image / GIF / sprite sheet.
  const use2D = file.kind === "texture" && preview3d.mesh === "flat";

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

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="min-h-0 flex-1">
          {file.kind === "model" ? (
            <ModelViewport path={file.path} />
          ) : use2D ? (
            <div className="relative h-full w-full overflow-hidden rounded-lg border border-border bg-[#07070b]">
              <Sprite2DView
                path={file.path}
                ext={file.ext}
                thumbKey={thumb?.key}
                sprite={{
                  enabled: preview3d.spriteOn,
                  cols: preview3d.spriteCols,
                  rows: preview3d.spriteRows,
                  fps: preview3d.spriteFps,
                  playing: preview3d.spritePlaying,
                }}
              />
            </div>
          ) : Object.keys(keys).length > 0 ? (
            // Wrapped on a real mesh, same renderer as the drawer — a flat
            // <img> here was the gap: you could not see the material, only
            // one of its files.
            <div className="h-full w-full overflow-hidden rounded-lg border border-border bg-[#07070b]">
              <TexturePreview
                keys={keys}
                mesh={preview3d.mesh}
                light={preview3d.light}
                tiles={preview3d.tiles}
                relief={preview3d.relief}
                channel={preview3d.channel}
              />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-dim">
              No preview available yet — the thumbnail is still decoding.
            </div>
          )}
        </div>
        {file.kind === "texture" && (Object.keys(keys).length > 0 || use2D) && (
          <div className="shrink-0">
            <PreviewControls
              value={preview3d}
              onChange={onPreviewChange}
              inline
              hasHeight={keys.height !== undefined}
              is2D={use2D}
            />
          </div>
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
