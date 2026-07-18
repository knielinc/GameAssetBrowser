import type { ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { basename, useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { useThumbProgress } from "../stores/thumbProgress";
import { useScopeCount } from "../hooks/useVisibleFiles";
import { humanSize } from "./FileRow";
import type { AssetKind } from "../types";

const NOUN: Record<AssetKind, string> = {
  audio: "files",
  texture: "textures",
  model: "models",
};

export interface StatusBarProps {
  kind: AssetKind;
  visibleCount: number;
}

export default function StatusBar({ kind, visibleCount }: StatusBarProps): ReactElement {
  const folderScope = useLibraryStore((s) => s.folderScope);
  const scanning = useLibraryStore((s) => s.scanning);
  const currentPath = usePlayerStore((s) => s.currentPath);
  // Model thumbnails render one at a time in the webview; show how many are
  // still queued so a slow folder reads as "working", not "frozen".
  const buildingThumbs = useThumbProgress((s) => s.modelRemaining);

  // Selected asset readout (bottom-right): its file size, and for an image its
  // real resolution. Subscribing to selectedPath + thumbsVersion re-runs the
  // lookups when the selection changes or a decode lands.
  const selectedPath = useLibraryStore((s) => s.tabs[kind].selectedPath);
  useLibraryStore((s) => s.thumbsVersion);
  const selectedFile =
    selectedPath === null
      ? null
      : (useLibraryStore.getState().allFiles.find((f) => f.path === selectedPath) ?? null);
  const info =
    selectedFile !== null ? useLibraryStore.getState().thumbs.get(selectedFile.id)?.info : undefined;
  const resolution =
    kind === "texture" && info != null && info.sourceWidth > 0
      ? `${info.sourceWidth.toLocaleString()} × ${info.sourceHeight.toLocaleString()}`
      : null;

  // Denominator = files OF THIS KIND in the current scope, so "N / M" reads
  // "visible after filters / total of this kind in what I'm looking at".
  // (Note this is per-kind while validScope in libraryStore stays any-kind —
  // opposite directions on purpose: a scope must survive a tab switch.)
  const scopeCount = useScopeCount(kind);

  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[11px] text-dim">
      <span className="tabular-nums">
        {visibleCount.toLocaleString()} / {scopeCount.toLocaleString()} {NOUN[kind]}
      </span>
      {folderScope !== null && (
        <span className="max-w-[30%] truncate" title={folderScope}>
          in {basename(folderScope)}
        </span>
      )}
      {scanning && (
        <span className="flex items-center gap-1.5 text-accent">
          <Loader2 size={11} className="animate-spin" />
          scanning…
        </span>
      )}
      {kind === "model" && buildingThumbs > 0 && (
        <span className="flex items-center gap-1.5 text-accent">
          <Loader2 size={11} className="animate-spin" />
          <span className="tabular-nums">
            building {buildingThumbs.toLocaleString()} {buildingThumbs === 1 ? "preview" : "previews"}…
          </span>
        </span>
      )}
      <span className="flex-1" />
      {currentPath !== null && (
        <span className="max-w-[35%] truncate" title={currentPath}>
          {basename(currentPath)}
        </span>
      )}
      {selectedFile !== null && (
        <span className="tabular-nums text-dim">
          {humanSize(selectedFile.size)}
          {resolution !== null && <span className="ml-3 text-text">{resolution}</span>}
        </span>
      )}
    </div>
  );
}
