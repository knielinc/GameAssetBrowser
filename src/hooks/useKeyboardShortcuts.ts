import { useEffect, useRef } from "react";
import { playerSeek } from "../ipc/commands";
import { useLibraryStore, type LibFile } from "../stores/libraryStore";
import { toggleFavoriteSmart } from "../stores/favoritesStore";
import { switchTab } from "../stores/tabs";
import {
  loadAndSelect,
  positionRef,
  replayCurrent,
  usePlayerStore,
  usePositionStore,
} from "../stores/playerStore";
import { ASSET_KINDS, type AssetKind } from "../types";

/**
 * The active pane registers its virtualizer's scrollToIndex here so the
 * window-level keyboard handler (which lives above it) can keep the selection
 * in view. Always a FLAT item index — the grid converts to rows internally.
 */
export const scrollToIndexRef: { current: ((index: number) => void) | null } = {
  current: null,
};

/**
 * The grid publishes its live column count here. Same module-ref idiom as
 * scrollToIndexRef rather than inventing a second mechanism. null = a list is
 * mounted, so vertical nav steps by 1.
 */
export const gridNavRef: { current: { columns: number } | null } = { current: null };

const SEEK_STEP_SECONDS = 2;
/** Trailing debounce on the player_load invoke while arrow-scrubbing. */
const AUTOPLAY_DEBOUNCE_MS = 60;

/**
 * Global keyboard shortcuts. Install once per pane; the listener reads the
 * latest visible list and kind through refs.
 *
 *   ↑/↓        move selection — by 1 in a list, by one row in a grid
 *   ←/→        seek ±2 s (audio list) · move ∓1 cell (grid)
 *   Space      play/pause · Enter replay · L loop
 *   F          toggle favorite (whole selection when the focused item is in it)
 *   Ctrl+1/2/3 switch tab
 *   Ctrl+A     select all visible · Escape collapse multi-selection
 */
export function useKeyboardShortcuts(
  kind: AssetKind,
  visible: LibFile[],
  onPreview?: (file: LibFile) => void,
  /** Key order of what is actually rendered — in the grouped texture view the
   *  items are materials whose keys are no file paths, so Ctrl+A cannot derive
   *  them from `visible`. Falls back to the flat paths when omitted. */
  visibleKeys?: readonly string[],
): void {
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  const keysRef = useRef(visibleKeys);
  keysRef.current = visibleKeys;

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

      if (e.ctrlKey && ["Digit1", "Digit2", "Digit3"].includes(e.code)) {
        e.preventDefault();
        const next = ASSET_KINDS[Number(e.code.slice(-1)) - 1];
        if (next !== undefined) switchTab(next);
        return;
      }
      // Ctrl+A — select every visible item. Checked before the generic
      // modifier bail; input/textarea targets already returned above, so
      // native select-all in the search box keeps working.
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyA") {
        e.preventDefault();
        const keys = keysRef.current ?? visibleRef.current.map((f) => f.path);
        useLibraryStore.getState().selectAll(kindRef.current, keys);
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const activeKind = kindRef.current;
      const isAudio = activeKind === "audio";
      const grid = gridNavRef.current;

      /** Move the selection by `delta` in the flat visible order. */
      const move = (delta: number): void => {
        const files = visibleRef.current;
        if (files.length === 0) return;
        const tab = useLibraryStore.getState().tabs[activeKind];
        let base = tab.selectedIndex;
        if (tab.selectedPath !== null && files[base]?.path !== tab.selectedPath) {
          // Reconcile the index if filtering/sorting shifted the selection.
          const located = files.findIndex((f) => f.path === tab.selectedPath);
          if (located >= 0) base = located;
        }
        // A fresh pane has no selection (-1); the first press should land on
        // the first item, not skip it.
        if (base < 0) base = delta > 0 ? -1 : 0;
        const next = Math.min(files.length - 1, Math.max(0, base + delta));
        const file = files[next];
        if (!file) return;
        if (isAudio) {
          loadAndSelect(file, next, AUTOPLAY_DEBOUNCE_MS);
        } else {
          useLibraryStore.getState().select(activeKind, next, file.path);
        }
        scrollToIndexRef.current?.(next);
      };

      switch (e.code) {
        case "ArrowDown":
        case "ArrowUp": {
          e.preventDefault();
          const step = grid?.columns ?? 1;
          move(e.code === "ArrowDown" ? step : -step);
          break;
        }

        case "ArrowLeft":
        case "ArrowRight": {
          // In a grid, horizontal is navigation. In the audio list it is a
          // seek — the one genuine conflict between the two modes.
          if (grid !== null) {
            e.preventDefault();
            move(e.code === "ArrowRight" ? 1 : -1);
            break;
          }
          if (!isAudio) return;
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

        case "Space": {
          e.preventDefault();
          // On Audio, Space is play/pause and always has been. On the visual
          // tabs it is free, so it opens the fullscreen preview — the same
          // "show me this thing" gesture, adapted to what the thing is.
          if (isAudio) {
            usePlayerStore.getState().togglePlay();
            break;
          }
          const files = visibleRef.current;
          const tab = useLibraryStore.getState().tabs[activeKind];
          const file =
            files.find((f) => f.path === tab.selectedPath) ?? files[tab.selectedIndex] ?? files[0];
          if (file !== undefined) previewRef.current?.(file);
          break;
        }

        case "Enter": {
          if (!isAudio) return;
          e.preventDefault();
          replayCurrent();
          break;
        }

        case "KeyL": {
          if (!isAudio) return;
          usePlayerStore.getState().toggleLoop();
          break;
        }

        case "KeyF": {
          // Toggle favorite on the focused item — or the whole selection when
          // the focused item is a member of it (toggleFavoriteSmart's rule).
          // Typing targets already returned at the top of the handler.
          const t = useLibraryStore.getState().tabs[activeKind];
          if (t.selectedPath === null) return;
          toggleFavoriteSmart(t.selectedPath);
          break;
        }

        case "Escape": {
          // Collapse the multi-selection to the focused item. Guarded on a
          // real multi-selection and no preventDefault — Escape also closes
          // previews/menus via their own listeners, and those must keep
          // working unchanged.
          const t = useLibraryStore.getState().tabs[activeKind];
          if (t.selectedPaths.size > 1) {
            useLibraryStore.getState().collapseSelection(activeKind);
          }
          break;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
