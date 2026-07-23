import type { ReactElement } from "react";
import clsx from "clsx";
import { FolderPlus } from "lucide-react";
import Sidebar from "./components/Sidebar";
import TitleBar from "./components/TitleBar";
import Toolbar from "./components/Toolbar";
import TabPane from "./components/TabPane";
import PlayerBar from "./components/player/PlayerBar";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { useWindowFullscreen } from "./hooks/useWindowFullscreen";
import { useExternalDrop } from "./hooks/useExternalDrop";
import { addFolders, useLibraryStore } from "./stores/libraryStore";
import { usePlayerStore } from "./stores/playerStore";
import { usePanelPrefs } from "./stores/panelPrefs";

export default function App(): ReactElement {
  const { width: sidebarWidth, isDragging, handleProps } = useSidebarWidth();
  // F11 = OS window fullscreen for the whole app. Distinct from Space, which
  // opens an in-app overlay for one asset; the two compose.
  useWindowFullscreen();
  // External drag hovering the window → the drop-to-add-root overlay below.
  const dropHover = useExternalDrop();
  const hasRoots = useLibraryStore((s) => s.roots.length > 0);
  const activeTab = useLibraryStore((s) => s.activeTab);
  // The player bar is persistent: shown on the Audio tab (even empty), and on
  // any other tab whenever a track is loaded — so audio started from the All
  // tab or a fullscreen preview stays controllable instead of playing blind.
  const playerLoaded = usePlayerStore((s) => s.currentPath !== null);
  const leftOpen = usePanelPrefs((s) => s.left);

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <TitleBar />
      {/* The filtering/options header spans the FULL width, above the sidebar
          and content both — so its toggles flank the whole workspace. */}
      {hasRoots && <Toolbar kind={activeTab} />}
      <div className="flex min-h-0 flex-1">
        {leftOpen && (
          <>
            <Sidebar width={sidebarWidth} />
            {/* Non-focusable separator: mouse-only resizer, so no tabIndex and
                no widget keyboard contract — just structural semantics. */}
            <div
              role="separator"
              aria-orientation="vertical"
              className={clsx("sidebar-resizer", isDragging && "sidebar-resizer-active")}
              {...handleProps}
            />
          </>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          {hasRoots ? (
            // key: remounting per tab resets the query debounce, scroll offset,
            // and nav refs together. See TabPane's note.
            <TabPane key={activeTab} kind={activeTab} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-4">
              <p className="text-sm text-dim">Add a folder to get started</p>
              <button type="button" className="btn-primary" onClick={() => void addFolders()}>
                <FolderPlus size={14} />
                Add Folder
              </button>
            </div>
          )}
        </main>
      </div>
      {/* Persistent transport: always on the Audio tab, and on any other tab
          while a track is loaded, so playback is never audible-but-hidden. */}
      {(activeTab === "audio" || playerLoaded) && <PlayerBar />}
      {/* Drop-to-add-root. pointer-events-none: the OS drives the drag, and
          the native drop event carries the paths — the overlay is pure
          feedback and must not swallow anything. */}
      {dropHover && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-bg/75 p-8">
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-accent">
            <FolderPlus size={28} className="text-accent" />
            <p className="text-sm text-text">Drop to add folder to library</p>
            <p className="text-xs text-dim">Files are ignored — folders become library roots</p>
          </div>
        </div>
      )}
    </div>
  );
}
