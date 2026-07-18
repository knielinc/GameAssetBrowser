import type { ReactElement } from "react";
import clsx from "clsx";
import { FolderPlus, RefreshCw, Download, Upload } from "lucide-react";
import { addFolders, rescanRoots, useLibraryStore } from "../stores/libraryStore";
import { exportSettings, importSettings } from "../stores/settings";
import FolderTree from "./FolderTree";

export interface SidebarProps {
  /** Panel width in px; owned by useSidebarWidth up in App. */
  width: number;
}

export default function Sidebar({ width }: SidebarProps): ReactElement {
  const rootCount = useLibraryStore((s) => s.roots.length);
  const scanning = useLibraryStore((s) => s.scanning);

  const onExport = (): void => {
    void exportSettings().catch((err: unknown) => {
      console.error("export settings failed", err);
    });
  };
  const onImport = (): void => {
    void importSettings().catch((err: unknown) => {
      console.error("import settings failed", err);
      window.alert(err instanceof Error ? err.message : "Could not import that settings file.");
    });
  };

  return (
    // Width is set inline with NO transition, so dragging tracks 1:1.
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-r border-border bg-panel"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <img src="/GAB.png" alt="" draggable={false} className="h-5 w-5 rounded-[4px] object-contain" />
        <span className="text-[13px] font-semibold tracking-tight">Game Asset Browser</span>
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

      {/* One bordered footer: folder actions on top, settings import/export
          below, with uniform padding and a single divider so the two rows read
          as one group instead of two stacked strips. */}
      <div className="flex shrink-0 flex-col gap-2 border-t border-border p-3">
        <div className="flex gap-2">
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

        {/* Settings live in a fixed file, but the user can keep a copy anywhere
            (backup, move between machines) and load one back. */}
        <div className="flex gap-2">
          <button
            type="button"
            title="Load settings from a file you choose"
            className="flex h-[28px] flex-1 items-center justify-center gap-1.5 rounded-md border border-border text-[11px] text-dim transition-colors duration-[120ms] hover:bg-raised hover:text-text"
            onClick={onImport}
          >
            <Upload size={12} />
            Import
          </button>
          <button
            type="button"
            title="Save the current settings to a file you choose"
            className="flex h-[28px] flex-1 items-center justify-center gap-1.5 rounded-md border border-border text-[11px] text-dim transition-colors duration-[120ms] hover:bg-raised hover:text-text"
            onClick={onExport}
          >
            <Download size={12} />
            Export
          </button>
        </div>
      </div>
    </aside>
  );
}
