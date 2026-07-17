import { playerPause } from "../ipc/commands";
import type { AssetKind } from "../types";
import { useLibraryStore } from "./libraryStore";
import { positionRef, usePlayerStore } from "./playerStore";

/**
 * Switch the active lens.
 *
 * Leaving the Audio tab PAUSES. The player bar only exists on Audio, but the
 * Rust engine owns its own thread — unmounting the React bar does not stop
 * playback, it only removes the transport. Without this, switching tabs mid-
 * playback would leave audible, uncontrollable audio. Pausing is the honest
 * reading of "the player lives on the Audio tab".
 */
export function switchTab(kind: AssetKind): void {
  const lib = useLibraryStore.getState();
  if (lib.activeTab === kind) return;

  if (lib.activeTab === "audio" && usePlayerStore.getState().playing) {
    usePlayerStore.setState({ playing: false });
    positionRef.playing = false;
    void playerPause();
  }

  lib.setActiveTab(kind);
}
