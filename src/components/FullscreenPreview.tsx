import { useEffect, type ReactElement } from "react";
import { AudioLines, X } from "lucide-react";
import { useLibraryStore, type LibFile } from "../stores/libraryStore";
import { audioVisibleRef, loadAndSelect, usePlayerStore } from "../stores/playerStore";
import { useThumbSrc } from "../hooks/useThumbSrc";
import { requestThumbs } from "../ipc/commands";
import { humanSize } from "./FileRow";
import TimeDisplay, { formatTime } from "./player/TimeDisplay";
import TransportControls from "./player/TransportControls";
import WaveformCanvas from "./player/WaveformCanvas";
import type { TextureItem } from "../material/classify";
import ModelViewport from "./model/ModelViewport";
import ModelLightControls from "./model/ModelLightControls";
import TexturePreview, { type MeshMode } from "./texture/TexturePreview";
import Sprite2DView from "./texture/Sprite2DView";
import SpriteArtView, { isSpriteArt } from "./texture/SpriteArtView";
import PreviewControls, { type PreviewState } from "./texture/PreviewControls";
import { isFloatPreview } from "../model/loadModel";
import { keysForFile, keysForMaterial } from "./texture/TextureInspector";
import DocumentPreview from "./document/DocumentPreview";
import { docIsEbook, docIsPdf, docIsPsd, docIsTextual, docSupportsZoom } from "./document/doc";
import DocViewControls from "./document/DocViewControls";
import PdfLayoutControls from "./document/PdfLayoutControls";
import ReadWidthControls from "./document/ReadWidthControls";

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
  useLibraryStore((s) => s.durationsVersion);
  useLibraryStore((s) => s.audioMetaVersion);
  const thumbs = useLibraryStore.getState().thumbs;
  const thumb = thumbs.get(file.id);

  const isAudio = file.kind === "audio";
  // The audio overlay follows the PLAYER, not the file it was opened with: the
  // embedded transport's prev/next and auto-advance change the track under it,
  // so the cover, title, and meta must track whatever is actually playing. The
  // next/advance targets always come from audioVisibleRef, so it resolves; fall
  // back to the opened file before the engine has loaded anything.
  const currentPath = usePlayerStore((s) => s.currentPath);
  const audioFile: LibFile =
    isAudio && currentPath !== null && currentPath !== file.path
      ? (audioVisibleRef.current.find((f) => f.path === currentPath) ?? file)
      : file;

  // Audio has no source to render; its fullscreen is the big cover art /
  // waveform (the "a"-keyed thumbnail) plus the probe details. Same optimistic
  // path AudioCell uses; request it here too so it shows even when fullscreen
  // is opened from the list (where no grid drove the request).
  const audioThumb = useThumbSrc(audioFile, "a");
  // A pin (supersede=false): decode this one file without dropping the grid's
  // in-flight window behind the overlay, so its cells aren't stranded.
  useEffect(() => {
    if (isAudio && !useLibraryStore.getState().thumbs.has(audioFile.id)) {
      void requestThumbs([[audioFile.id, audioFile.path]], false).catch(() => {});
    }
  }, [isAudio, audioFile.id, audioFile.path]);
  // Load the track into the engine so the embedded transport (and waveform)
  // control THIS file. Respects the autoplay pref, like selecting an audio row.
  useEffect(() => {
    if (!isAudio) return;
    if (usePlayerStore.getState().currentPath === file.path) return;
    const idx = audioVisibleRef.current.findIndex((f) => f.path === file.path);
    loadAndSelect(file, idx);
  }, [isAudio, file]);
  const audioMetaLine = ((): string => {
    if (!isAudio) return "";
    const parts: string[] = [audioFile.ext.toUpperCase()];
    const secs = useLibraryStore.getState().durations.get(audioFile.id);
    if (secs !== undefined) parts.push(formatTime(secs));
    const m = useLibraryStore.getState().audioMeta.get(audioFile.id);
    if (m !== undefined) {
      const [rate, ch, bits] = m;
      if (rate > 0) parts.push(`${rate / 1000} kHz`);
      if (bits > 0) parts.push(`${bits}-bit`);
      if (ch > 0) parts.push(ch === 1 ? "Mono" : ch === 2 ? "Stereo" : `${ch}ch`);
    }
    parts.push(humanSize(audioFile.size));
    return parts.join(" · ");
  })();

  const keys =
    item === null
      ? file.kind === "texture" && thumb !== undefined
        ? { baseColor: { key: thumb.key, path: file.path, ext: file.ext } }
        : {}
      : item.kind === "material"
        ? keysForMaterial(item.material, thumbs)
        : keysForFile(item.file, item.channel, thumbs);

  // Fullscreen is the inspector blown up, not a separate viewer: it adopts the
  // drawer's CURRENT state wholesale (mesh, lighting, tiling, zoom, sprite),
  // and the controls below write back to the same shared state — leave
  // fullscreen and the drawer is exactly where you left it.
  const mesh: MeshMode = preview3d.mesh;
  // An equirectangular (2:1) image is almost certainly an environment map, so
  // leaving 2D opens it on the env viewer rather than the flat plane.
  const info = thumb?.info;
  const default3d: MeshMode | undefined =
    info != null && info.sourceHeight > 0 && Math.abs(info.sourceWidth / info.sourceHeight - 2) < 0.15
      ? "env"
      : undefined;

  // Flat mode on a texture is the 2D lens — image / GIF / sprite sheet.
  const use2D = file.kind === "texture" && mesh === "flat";

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
      <div className="flex h-11 shrink-0 items-center gap-3 px-4">
        <span className="truncate text-[13px] font-medium" title={audioFile.path}>
          {audioFile.name}
        </span>
        <span className="truncate font-mono text-[10px] text-dim">{audioFile.path}</span>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {file.kind === "document" && docIsPdf(file.ext) && <PdfLayoutControls />}
          {file.kind === "document" && (docIsTextual(file.ext) || docIsEbook(file.ext)) && (
            <ReadWidthControls />
          )}
          {file.kind === "document" && docSupportsZoom(file.ext) && <DocViewControls />}
          <span className="text-[10px] text-dim">Space or Esc to close</span>
          <button type="button" className="icon-btn" title="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="min-h-0 flex-1">
          {file.kind === "document" || (file.kind === "texture" && docIsPsd(file.ext)) ? (
            <div className="flex h-full w-full flex-col overflow-hidden rounded-xl bg-panel shadow-e1">
              <DocumentPreview key={file.path} path={file.path} ext={file.ext} autoFocusPdf />
            </div>
          ) : file.kind === "texture" && isSpriteArt(file.ext) ? (
            <div className="flex h-full w-full flex-col overflow-hidden rounded-xl bg-panel shadow-e1">
              <SpriteArtView key={file.path} path={file.path} />
            </div>
          ) : file.kind === "model" ? (
            <ModelViewport path={file.path} />
          ) : isAudio ? (
            <div className="flex h-full w-full flex-col items-center overflow-hidden rounded-xl bg-panel shadow-e1">
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
                <div className="aspect-square w-[min(52vh,52vw)] overflow-hidden rounded-xl bg-raised shadow-e1">
                  {audioThumb.src !== null ? (
                    <img
                      key={audioThumb.imgKey}
                      src={audioThumb.src}
                      alt=""
                      draggable={false}
                      onError={audioThumb.onError}
                      onLoad={audioThumb.onLoad}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <AudioLines size={56} className="text-kind-audio opacity-30" />
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-center gap-1">
                  <div
                    className="max-w-[70vw] truncate text-center text-[15px] font-semibold tracking-tight"
                    title={audioFile.name}
                  >
                    {audioFile.name}
                  </div>
                  <div className="text-center text-[12px] tabular-nums text-dim">{audioMetaLine}</div>
                </div>
              </div>
              {/* Full transport — the fullscreen overlay covers the docked
                  PlayerBar, so play/seek live here while it's open. Controls the
                  track loaded on open (see the load effect above). */}
              <div className="flex w-full max-w-3xl shrink-0 items-center gap-5 px-4 pb-5">
                <TransportControls />
                <div className="h-12 min-w-0 flex-1">
                  <WaveformCanvas />
                </div>
                <TimeDisplay />
              </div>
            </div>
          ) : use2D ? (
            <div className="relative h-full w-full overflow-hidden rounded-xl bg-[#07070b] shadow-e1">
              <Sprite2DView
                path={file.path}
                ext={file.ext}
                sprite={{
                  enabled: preview3d.spriteOn,
                  cols: preview3d.spriteCols,
                  rows: preview3d.spriteRows,
                  fps: preview3d.spriteFps,
                  playing: preview3d.spritePlaying,
                }}
                zoomFit={preview3d.zoomFit}
                zoomPct={preview3d.zoomPct}
                iso={preview3d.iso}
                tiles={preview3d.flatTiles}
              />
            </div>
          ) : Object.keys(keys).length > 0 ? (
            // Wrapped on a real mesh, same renderer as the drawer — a flat
            // <img> here was the gap: you could not see the material, only
            // one of its files.
            <div className="h-full w-full overflow-hidden rounded-xl bg-[#07070b] shadow-e1">
              <TexturePreview
                keys={keys}
                mesh={mesh}
                light={preview3d.light}
                tiles={preview3d.tiles}
                relief={preview3d.relief}
                channel={preview3d.channel}
                iso={preview3d.iso}
                flatTiles={preview3d.flatTiles}
              />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-dim">
              No preview available yet — the thumbnail is still decoding.
            </div>
          )}
        </div>
        {file.kind === "texture" && !isSpriteArt(file.ext) && !docIsPsd(file.ext) && (Object.keys(keys).length > 0 || use2D) && (
          <div className="shrink-0">
            <PreviewControls
              value={preview3d}
              onChange={onPreviewChange}
              inline
              hasHeight={keys.height !== undefined}
              default3d={default3d}
              hdr={isFloatPreview(file.ext)}
            />
          </div>
        )}
        {/* Same lighting rig as the docked inspector — the choice is global, so
            switching it here is reflected everywhere. */}
        {file.kind === "model" && (
          <div className="flex shrink-0 items-center justify-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-dim">
              Lighting
            </span>
            <ModelLightControls className="w-[280px]" />
          </div>
        )}
      </div>

      {file.kind === "texture" && !isSpriteArt(file.ext) && !docIsPsd(file.ext) && thumb?.info != null && (
        <div className="flex h-8 shrink-0 items-center gap-4 px-4 text-[11px] text-dim">
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
