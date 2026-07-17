import { useEffect, useRef } from "react";
import { playerSeek } from "../ipc/commands";
import { useLibraryStore, type LibFile } from "../stores/libraryStore";
import {
  loadAndSelect,
  positionRef,
  replayCurrent,
  usePlayerStore,
  usePositionStore,
} from "../stores/playerStore";

/**
 * FileList registers its virtualizer's scrollToIndex here so the window-level
 * keyboard handler (which lives in App) can keep the selection in view.
 */
export const scrollToIndexRef: { current: ((index: number) => void) | null } = {
  current: null,
};

const SEEK_STEP_SECONDS = 2;
/** Trailing debounce on the player_load invoke while arrow-scrubbing. */
const AUTOPLAY_DEBOUNCE_MS = 60;

/**
 * Global keyboard shortcuts. Install once in App; the listener stays mounted
 * for the app's lifetime and reads the latest visible list through a ref.
 *
 *   ArrowUp/Down  move selection (clamped) + autoplay
 *   Space         play/pause · Enter replay · L loop · ←/→ seek ±2 s
 */
export function useKeyboardShortcuts(visible: LibFile[]): void {
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing) return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }

      switch (e.code) {
        case "ArrowDown":
        case "ArrowUp": {
          e.preventDefault();
          const files = visibleRef.current;
          if (files.length === 0) return;

          const { selectedIndex, selectedPath } = useLibraryStore.getState();
          let base = selectedIndex;
          if (selectedPath !== null) {
            // Reconcile the index if filtering/sorting shifted the selection.
            if (files[base]?.path !== selectedPath) {
              const located = files.findIndex((f) => f.path === selectedPath);
              if (located >= 0) base = located;
            }
          }

          const delta = e.code === "ArrowDown" ? 1 : -1;
          const next = Math.min(files.length - 1, Math.max(0, base + delta));
          const file = files[next];
          if (!file) return;
          loadAndSelect(file, next, AUTOPLAY_DEBOUNCE_MS);
          scrollToIndexRef.current?.(next);
          break;
        }

        case "Space": {
          e.preventDefault();
          usePlayerStore.getState().togglePlay();
          break;
        }

        case "Enter": {
          e.preventDefault();
          replayCurrent();
          break;
        }

        case "KeyL": {
          usePlayerStore.getState().toggleLoop();
          break;
        }

        case "ArrowLeft":
        case "ArrowRight": {
          const { currentPath, duration } = usePlayerStore.getState();
          if (currentPath === null) return;
          e.preventDefault();
          const delta = e.code === "ArrowRight" ? SEEK_STEP_SECONDS : -SEEK_STEP_SECONDS;
          const max = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
          const next = Math.min(max, Math.max(0, positionRef.seconds + delta));
          positionRef.seconds = next;
          usePositionStore.setState({ seconds: next });
          void playerSeek(next);
          break;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
