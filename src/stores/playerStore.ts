import { create } from "zustand";
import {
  playerLoad,
  playerPause,
  playerPlay,
  playerSetLoop,
  playerSetVolume,
} from "../ipc/commands";
import { useLibraryStore, type LibFile } from "./libraryStore";

/**
 * Mutable playhead written by the 20 Hz `playback:position` listener and read
 * by WaveformCanvas's rAF loop — deliberately outside React so position ticks
 * never re-render the tree.
 */
export interface PositionRef {
  seconds: number;
  playing: boolean;
  path: string;
}

export const positionRef: PositionRef = { seconds: 0, playing: false, path: "" };

/** Tiny slice consumed ONLY by TimeDisplay, so 20 Hz ticks re-render one leaf. */
interface PositionState {
  seconds: number;
}

export const usePositionStore = create<PositionState>()(() => ({ seconds: 0 }));

export interface PlayerState {
  currentPath: string | null;
  playing: boolean;
  /** Seconds; 0 = not yet known. */
  duration: number;
  /** 0..1 */
  volume: number;
  loop: boolean;
  autoplay: boolean;
  /** Interleaved [min0, max0, min1, max1, ...] peaks for the current track. */
  peaks: Float32Array | null;

  setVolume: (volume: number) => void;
  toggleLoop: () => void;
  toggleAutoplay: () => void;
  togglePlay: () => void;
}

export const usePlayerStore = create<PlayerState>()((set, get) => ({
  currentPath: null,
  playing: false,
  duration: 0,
  volume: 0.8,
  loop: false,
  autoplay: true,
  peaks: null,

  setVolume: (volume) => {
    const clamped = Math.min(1, Math.max(0, volume));
    set({ volume: clamped });
    void playerSetVolume(clamped);
  },

  toggleLoop: () => {
    const next = !get().loop;
    set({ loop: next });
    void playerSetLoop(next);
  },

  toggleAutoplay: () => set((s) => ({ autoplay: !s.autoplay })),

  togglePlay: () => {
    const { currentPath, playing } = get();
    if (currentPath === null) return;
    set({ playing: !playing });
    positionRef.playing = !playing;
    if (playing) {
      void playerPause();
    } else {
      void playerPlay();
    }
  },
}));

let loadTimer: number | undefined;

/**
 * Select `file` in the library and load it into the audio engine.
 * `debounceMs > 0` delays only the invoke (trailing) — selection, waveform
 * reset, and playhead reset are applied immediately so the UI keeps up with
 * rapid arrow-key scrubbing without spamming the backend.
 */
export function loadAndSelect(file: LibFile, index: number, debounceMs = 0): void {
  const lib = useLibraryStore.getState();
  lib.select(index, file.path);

  // Re-selecting the already-loaded track (clicking the selected row, or a
  // clamped arrow press at the list edge): leave peaks/playhead/playback
  // alone. WaveformCanvas only re-requests peaks when currentPath changes,
  // so nulling them here would strand the flat fallback bar — and Enter is
  // the explicit replay gesture. Any pending debounced load is for this same
  // path, so letting it fire is correct.
  if (usePlayerStore.getState().currentPath === file.path) return;

  const autoplay = usePlayerStore.getState().autoplay;
  usePlayerStore.setState({
    currentPath: file.path,
    peaks: null,
    duration: lib.durations.get(file.id) ?? 0,
    playing: autoplay,
  });
  positionRef.seconds = 0;
  positionRef.playing = autoplay;
  positionRef.path = file.path;
  usePositionStore.setState({ seconds: 0 });

  if (loadTimer !== undefined) {
    window.clearTimeout(loadTimer);
    loadTimer = undefined;
  }
  if (debounceMs > 0) {
    loadTimer = window.setTimeout(() => {
      loadTimer = undefined;
      void playerLoad(file.path, autoplay);
    }, debounceMs);
  } else {
    void playerLoad(file.path, autoplay);
  }
}

/** Replay the currently loaded track from the start (Enter key). */
export function replayCurrent(): void {
  const { currentPath } = usePlayerStore.getState();
  if (currentPath === null) return;
  usePlayerStore.setState({ playing: true });
  positionRef.seconds = 0;
  positionRef.playing = true;
  usePositionStore.setState({ seconds: 0 });
  void playerLoad(currentPath, true);
}
