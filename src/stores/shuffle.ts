import { create } from "zustand";
import { scrollToIndexRef } from "../hooks/useKeyboardShortcuts";
import { useLibraryStore, type LibFile } from "./libraryStore";
import { loadAndSelect } from "./playerStore";
import type { AssetKind } from "../types";

/**
 * The active pane's rendered order, published for the toolbar's shuffle
 * button — the same module-ref idiom as scrollToIndexRef, because only
 * TabPane knows the filtered/sorted (and possibly grouped) list. `keys` is
 * the selection-key order (group keys in the grouped texture view); `files`
 * is the FLAT visible list, index-aligned with `keys` only in ungrouped
 * views — which is all shuffle needs it for (audio is never grouped).
 */
export const shuffleSourceRef: {
  current: { keys: readonly string[]; files: readonly LibFile[] };
} = { current: { keys: [], files: [] } };

/** Tiny reactive twin of the ref: the toolbar disables the dice on an empty
 *  list, and a plain ref can't re-render it. */
interface ShuffleState {
  count: number;
}

export const useShuffleStore = create<ShuffleState>()(() => ({ count: 0 }));

export function publishShuffleSource(
  keys: readonly string[],
  files: readonly LibFile[],
): void {
  shuffleSourceRef.current = { keys, files };
  if (useShuffleStore.getState().count !== keys.length) {
    useShuffleStore.setState({ count: keys.length });
  }
}

/**
 * The toolbar dice: jump to a uniformly random item in the current visible
 * list — select it, scroll it into view, and on the audio tab play it (the
 * whole point of shuffling samples is hearing one).
 */
export function shuffleVisible(kind: AssetKind): void {
  const { keys, files } = shuffleSourceRef.current;
  if (keys.length === 0) return;
  const index = Math.floor(Math.random() * keys.length);
  const key = keys[index]!;
  if (kind === "audio") {
    const file = files[index];
    if (file === undefined) return;
    // forcePlay: a deliberate "surprise me" should sound even with autoplay off.
    loadAndSelect(file, index, 0, true);
  } else {
    useLibraryStore.getState().select(kind, index, key);
  }
  scrollToIndexRef.current?.(index);
}
