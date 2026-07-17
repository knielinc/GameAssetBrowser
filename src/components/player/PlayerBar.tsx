import type { ReactElement } from "react";
import { basename, useLibraryStore } from "../../stores/libraryStore";
import { usePlayerStore } from "../../stores/playerStore";
import TimeDisplay from "./TimeDisplay";
import TransportControls from "./TransportControls";
import VolumeSlider from "./VolumeSlider";
import WaveformCanvas from "./WaveformCanvas";

export default function PlayerBar(): ReactElement {
  const currentPath = usePlayerStore((s) => s.currentPath);
  const selectedExt = useLibraryStore((s) => {
    if (s.selectedPath === null) return null;
    const dot = s.selectedPath.lastIndexOf(".");
    return dot >= 0 ? s.selectedPath.slice(dot + 1).toLowerCase() : null;
  });

  return (
    <footer className="flex h-24 shrink-0 items-center gap-5 border-t border-border bg-panel px-4">
      <TransportControls />

      <div className="flex h-full min-w-0 flex-1 flex-col justify-center gap-1.5 py-3">
        <div className="flex items-baseline justify-between gap-4">
          <span
            className="min-w-0 truncate text-xs font-medium text-text"
            title={currentPath ?? undefined}
          >
            {currentPath !== null ? basename(currentPath) : (
              <span className="font-normal text-dim">No file loaded</span>
            )}
            {currentPath !== null && selectedExt !== null && (
              <span className="ml-2 text-[10px] font-normal uppercase tracking-wider text-dim">
                {selectedExt}
              </span>
            )}
          </span>
          <TimeDisplay />
        </div>
        <div className="min-h-0 flex-1">
          <WaveformCanvas />
        </div>
      </div>

      <VolumeSlider />
    </footer>
  );
}
