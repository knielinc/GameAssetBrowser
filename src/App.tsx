import type { ReactElement } from "react";
import clsx from "clsx";
import { FolderPlus, Loader2 } from "lucide-react";
import Sidebar from "./components/Sidebar";
import Toolbar from "./components/Toolbar";
import FileList from "./components/FileList";
import StatusBar from "./components/StatusBar";
import PlayerBar from "./components/player/PlayerBar";
import { useVisibleFiles } from "./hooks/useVisibleFiles";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { addFolders, useLibraryStore } from "./stores/libraryStore";

export default function App(): ReactElement {
  const visible = useVisibleFiles();
  useKeyboardShortcuts(visible);
  const { width: sidebarWidth, isDragging, handleProps } = useSidebarWidth();

  const hasRoots = useLibraryStore((s) => s.roots.length > 0);
  const scanning = useLibraryStore((s) => s.scanning);
  const loadedCount = useLibraryStore((s) => s.allFiles.length);

  let mainContent: ReactElement;
  if (!hasRoots) {
    mainContent = (
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <p className="text-sm text-dim">Add a folder to get started</p>
        <button type="button" className="btn-primary" onClick={() => void addFolders()}>
          <FolderPlus size={14} />
          Add Folder
        </button>
      </div>
    );
  } else if (scanning && loadedCount === 0) {
    mainContent = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-dim">
        <Loader2 size={22} className="animate-spin text-accent" />
        <p className="text-xs">Scanning folders…</p>
      </div>
    );
  } else {
    mainContent = <FileList files={visible} />;
  }

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <div className="flex min-h-0 flex-1">
        <Sidebar width={sidebarWidth} />
        {/* Non-focusable separator: mouse-only resizer, so no tabIndex and
            no widget keyboard contract — just structural semantics. */}
        <div
          role="separator"
          aria-orientation="vertical"
          className={clsx("sidebar-resizer", isDragging && "sidebar-resizer-active")}
          {...handleProps}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <Toolbar />
          {mainContent}
          <StatusBar visibleCount={visible.length} />
        </main>
      </div>
      <PlayerBar />
    </div>
  );
}
