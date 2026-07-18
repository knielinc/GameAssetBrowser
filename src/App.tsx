import type { ReactElement } from "react";
import clsx from "clsx";
import { FolderPlus } from "lucide-react";
import Sidebar from "./components/Sidebar";
import TitleBar from "./components/TitleBar";
import TabBar from "./components/TabBar";
import TabPane from "./components/TabPane";
import PlayerBar from "./components/player/PlayerBar";
import { useSidebarWidth } from "./hooks/useSidebarWidth";
import { useWindowFullscreen } from "./hooks/useWindowFullscreen";
import { addFolders, useLibraryStore } from "./stores/libraryStore";
import { usePanelPrefs } from "./stores/panelPrefs";

export default function App(): ReactElement {
  const { width: sidebarWidth, isDragging, handleProps } = useSidebarWidth();
  // F11 = OS window fullscreen for the whole app. Distinct from Space, which
  // opens an in-app overlay for one asset; the two compose.
  useWindowFullscreen();
  const hasRoots = useLibraryStore((s) => s.roots.length > 0);
  const activeTab = useLibraryStore((s) => s.activeTab);
  const leftOpen = usePanelPrefs((s) => s.left);

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <TitleBar />
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
          <TabBar />
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
      {/* Audio tab only. The Rust engine owns its own thread, so a hidden bar
          would mean audible-but-uncontrollable playback — switchTab() pauses
          on the way out to keep that honest. */}
      {activeTab === "audio" && <PlayerBar />}
    </div>
  );
}
