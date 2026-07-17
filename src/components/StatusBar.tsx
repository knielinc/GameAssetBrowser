import type { ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { basename, useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { useScopeCount } from "../hooks/useVisibleFiles";
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
      <span className="flex-1" />
      {currentPath !== null && (
        <span className="max-w-[45%] truncate" title={currentPath}>
          {basename(currentPath)}
        </span>
      )}
    </div>
  );
}
