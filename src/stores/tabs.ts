import type { AssetKind } from "../types";
import { useLibraryStore } from "./libraryStore";

/**
 * Switch the active lens.
 *
 * Deliberately does NOT touch playback. Pausing is driven by the SELECTION, not
 * the tab (see App's useAudioSelected): switching to the 2D tab while its last
 * selected file is still a texture pauses through that path, but merely passing
 * through a tab whose selection is an audio file does not. Kept as the single
 * tab-switch choke point in case per-tab entry/exit logic is needed again.
 */
export function switchTab(kind: AssetKind): void {
  useLibraryStore.getState().setActiveTab(kind);
}
