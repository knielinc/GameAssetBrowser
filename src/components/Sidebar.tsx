import type { ReactElement } from "react";
import clsx from "clsx";
import { Box, FolderPlus, RefreshCw } from "lucide-react";
import { addFolders, rescanRoots, useLibraryStore } from "../stores/libraryStore";
import FolderTree from "./FolderTree";

export interface SidebarProps {
  /** Panel width in px; owned by useSidebarWidth up in App. */
  width: number;
}

export default function Sidebar({ width }: SidebarProps): ReactElement {
  const rootCount = useLibraryStore((s) => s.roots.length);
  const scanning = useLibraryStore((s) => s.scanning);

  return (
    // Width is set inline with NO transition, so dragging tracks 1:1.
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-r border-border bg-panel"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Box size={16} className="text-accent" />
        <span className="text-[13px] font-semibold tracking-tight">Game File Browser</span>
      </div>

      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="text-[10px] font-medium uppercase tracking-widest text-dim">
          Folders
        </span>
        {rootCount > 0 && (
          <span className="text-[10px] tabular-nums text-dim">{rootCount}</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <FolderTree />
      </div>

      <div className="flex shrink-0 gap-2 border-t border-border p-3">
        <button type="button" className="btn-primary flex-1" onClick={() => void addFolders()}>
          <FolderPlus size={14} />
          Add Folder
        </button>
        <button
          type="button"
          title="Rescan folders"
          disabled={scanning || rootCount === 0}
          className="icon-btn h-[30px] w-[30px] border border-border"
          onClick={() => void rescanRoots()}
        >
          <RefreshCw size={13} className={clsx(scanning && "animate-spin")} />
        </button>
      </div>
    </aside>
  );
}
