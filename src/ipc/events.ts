// Backend → frontend event wiring. All listeners write straight into the
// Zustand stores (or the mutable positionRef) — no React involved.

import { listen } from "@tauri-apps/api/event";
import {
  EVT,
  type AudioMetaBatch,
  type DimensionBatch,
  type PositionPayload,
  type ScanBatch,
  type ScanDone,
  type StatePayload,
  type ThumbBatch,
  type WaveformReady,
} from "../types";
import { useLibraryStore, type LibraryState } from "../stores/libraryStore";
import { positionRef, usePlayerStore, usePositionStore } from "../stores/playerStore";

let initialized = false;

// ---- duplicate finder ------------------------------------------------------
// Event names + payload types live HERE rather than in types.ts/EVT because
// nothing global listens for them: the duplicates modal subscribes only while
// mounted (initIpcEvents stays app-lifetime listeners only). Payloads are
// keyed by path, not file id, so no scan-generation guard is needed.

export const DUPES_PROGRESS = "dupes:progress";
export const DUPES_DONE = "dupes:done";

/** `done` of `total` size-collision candidates hashed so far. */
export interface DupeProgress {
  done: number;
  total: number;
}

/** One confirmed duplicate set; `size` is the byte size of EACH member. */
export interface DupeGroup {
  size: number;
  paths: string[];
}

/** Groups sorted by wasted bytes — `size × (n − 1)` — descending. */
export interface DupesDone {
  groups: DupeGroup[];
}

/**
 * Scan generations are monotonic, and events for a brand-new generation can
 * reach the webview BEFORE the `start_scan` invoke promise resolves (event
 * delivery and the invoke response travel on separate channels). So: adopt a
 * newer generation on the spot via `beginScan`; drop only strictly older
 * ones. Returns the library state to apply the payload to, or null if stale.
 */
function adoptScanGen(gen: number): LibraryState | null {
  let lib = useLibraryStore.getState();
  if (gen < lib.scanGen) return null; // stale scan generation
  if (gen > lib.scanGen) {
    lib.beginScan(gen);
    lib = useLibraryStore.getState();
  }
  return lib;
}

/**
 * Subscribe to every backend event. Must be called exactly once, from module
 * scope in main.tsx — NOT inside a React effect, where StrictMode's
 * double-mount would double-subscribe. Listeners live for the app's lifetime.
 */
export function initIpcEvents(): void {
  if (initialized) return;
  initialized = true;

  void listen<ScanBatch>(EVT.SCAN_BATCH, (event) => {
    const { gen, files } = event.payload;
    const lib = adoptScanGen(gen);
    if (lib === null) return;
    lib.appendFiles(files);
  });

  void listen<ScanDone>(EVT.SCAN_DONE, (event) => {
    const lib = adoptScanGen(event.payload.gen);
    if (lib === null) return;
    lib.finishScan(event.payload);
  });

  // Drop-only gen guard, same reasoning as meta:dimensions below: ids restart
  // at 0 each scan, so a late batch from a superseded scan would land on the
  // wrong files.
  void listen<AudioMetaBatch>(EVT.META_AUDIO, (event) => {
    if (event.payload.gen !== useLibraryStore.getState().scanGen) return;
    useLibraryStore.getState().mergeAudioMeta(event.payload.entries);

    // Backfill the player's duration if it was unknown when the track loaded.
    const player = usePlayerStore.getState();
    if (player.currentPath !== null && player.duration <= 0) {
      const lib = useLibraryStore.getState();
      const entry = lib.allFiles.find((f) => f.path === player.currentPath);
      if (entry !== undefined) {
        const duration = lib.durations.get(entry.id);
        if (duration !== undefined) {
          usePlayerStore.setState({ duration });
        }
      }
    }
  });

  // Drop-only, never adopt: ids RESTART AT 0 each scan, so a late batch from
  // a superseded scan would land on the wrong files — and a poisoned dims
  // entry sticks, because the mergeThumbs backfill defers to existing entries.
  // (Adopting a newer gen here would be wrong too: dims must never arrive
  // before the files themselves.)
  void listen<DimensionBatch>(EVT.META_DIMENSIONS, (event) => {
    if (event.payload.gen !== useLibraryStore.getState().scanGen) return;
    useLibraryStore.getState().mergeDims(event.payload.entries);
  });

  // No generation on this payload: the thumb queue is frontend-driven and
  // request_thumbs drains it on every range change, so at most one in-flight
  // decode chunk can outlive a rescan — an accepted race that predates the
  // dims feature (see the no-staleness-gate note in thumbs.rs).
  void listen<ThumbBatch>(EVT.THUMB_READY, (event) => {
    useLibraryStore.getState().mergeThumbs(event.payload.entries);
  });

  void listen<WaveformReady>(EVT.WAVEFORM_READY, (event) => {
    const { path, peaks } = event.payload;
    // Stale guard: selection may have moved on while the decode ran.
    if (path !== useLibraryStore.getState().tabs.audio.selectedPath) return;
    usePlayerStore.setState({ peaks: new Float32Array(peaks) });
  });

  void listen<PositionPayload>(EVT.PLAYBACK_POSITION, (event) => {
    const { path, seconds, playing } = event.payload;
    // Drop ticks from a track that is no longer current — during the
    // debounced load window the engine is still playing the old file, and
    // its positions would overwrite the optimistic playhead reset.
    if (path !== usePlayerStore.getState().currentPath) return;
    // 20 Hz: mutate the ref for the rAF-driven waveform playhead...
    positionRef.path = path;
    positionRef.seconds = seconds;
    positionRef.playing = playing;
    // ...and the tiny slice that only TimeDisplay subscribes to.
    usePositionStore.setState({ seconds });
  });

  void listen<StatePayload>(EVT.PLAYBACK_STATE, (event) => {
    const { state, path, message } = event.payload;
    switch (state) {
      case "playing":
        usePlayerStore.setState({ playing: true });
        positionRef.playing = true;
        break;
      case "paused":
        usePlayerStore.setState({ playing: false });
        positionRef.playing = false;
        break;
      case "ended":
        // Finished: rewind the cursor to the start and pause, so the next play
        // resumes cleanly from 0.
        usePlayerStore.setState({ playing: false });
        positionRef.playing = false;
        positionRef.seconds = 0;
        usePositionStore.setState({ seconds: 0 });
        break;
      case "stopped":
        usePlayerStore.setState({ playing: false });
        positionRef.playing = false;
        positionRef.seconds = 0;
        usePositionStore.setState({ seconds: 0 });
        break;
      case "error":
        usePlayerStore.setState({ playing: false });
        positionRef.playing = false;
        console.error(
          `[playback] ${message ?? "unknown error"}${path !== null ? ` (${path})` : ""}`,
        );
        break;
    }
  });
}
