import { create } from "zustand";

/**
 * How many model thumbnails are still rendering (queued + in flight). Fed by
 * the thumbQueue's progress listener via useModelThumbs, read by the StatusBar.
 *
 * A separate one-field store rather than a field on libraryStore: it's a pure
 * frontend render-progress signal with no Rust side and no place on the mirrored
 * IPC contract, and it changes rapidly during a scroll — keeping it isolated
 * means those updates don't wake every libraryStore subscriber.
 */
export interface ThumbProgressState {
  /** Remaining model thumbnails to render; 0 when idle. */
  modelRemaining: number;
  setModelRemaining: (n: number) => void;
}

export const useThumbProgress = create<ThumbProgressState>((set) => ({
  modelRemaining: 0,
  setModelRemaining: (n) => set({ modelRemaining: n }),
}));
