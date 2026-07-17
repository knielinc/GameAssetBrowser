import { useMemo, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { basename, folderMatcher, useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";

export interface StatusBarProps {
  visibleCount: number;
}

export default function StatusBar({ visibleCount }: StatusBarProps): ReactElement {
  const allFiles = useLibraryStore((s) => s.allFiles);
  const folderScope = useLibraryStore((s) => s.folderScope);
  const scanning = useLibraryStore((s) => s.scanning);
  const currentPath = usePlayerStore((s) => s.currentPath);

  // Denominator = files in the current scope (whole library when unscoped),
  // so "N / M" always reads "visible after filters / total in what I'm
  // looking at". One O(n) pass, re-run only when the library or scope change.
  const scopeCount = useMemo(() => {
    if (folderScope === null) return allFiles.length;
    const inScope = folderMatcher(folderScope);
    let count = 0;
    for (const f of allFiles) {
      if (inScope(f.path)) count++;
    }
    return count;
  }, [allFiles, folderScope]);

  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[11px] text-dim">
      <span className="tabular-nums">
        {visibleCount.toLocaleString()} / {scopeCount.toLocaleString()} files
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
