import type { AssetKind } from "../types";
import { useLibraryStore } from "./libraryStore";

/**
 * Switch the active lens.
 *
 * Playback is NOT paused on leaving the Audio tab: the player bar is now
 * persistent (App renders it whenever a track is loaded, on any tab), so audio
 * stays controllable everywhere and there's no "audible-but-uncontrollable"
 * window to guard against. Kept as the single tab-switch choke point in case
 * per-tab entry/exit logic is needed again.
 */
export function switchTab(kind: AssetKind): void {
  useLibraryStore.getState().setActiveTab(kind);
}
