import { useEffect, type ReactElement } from "react";
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
import { pausePlayback, useAudioSelected, usePlayerStore } from "./stores/playerStore";
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
  const playerLoaded = usePlayerStore((s) => s.currentPath !== null);
  const playing = usePlayerStore((s) => s.playing);
  // The transport follows the SELECTION, not the tab: picking a texture (or any
  // non-audio file) means the user is done listening, so playback pauses and
  // the bar goes away. The track stays loaded, so re-selecting it brings the bar
  // back where it left off.
  const audioSelected = useAudioSelected();
  useEffect(() => {
    if (!audioSelected) pausePlayback();
  }, [audioSelected]);
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
      {/* Shown while an audio file is selected — and, regardless of selection,
          whenever sound is actually coming out. That second clause is what keeps
          playback from ever being audible-but-hidden: the duplicates modal can
          start a track while a texture is selected, and it must stay
          controllable. The pause above then drops `playing`, which is what
          actually retires the bar on a non-audio pick. */}
      {playerLoaded && (audioSelected || playing) && <PlayerBar />}
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
