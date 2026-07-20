import { create } from "zustand";
import {
  playerLoad,
  playerPause,
  playerPlay,
  playerSetLoop,
  playerSetSpeed,
  playerSetVolume,
  playerStop,
} from "../ipc/commands";
import { scrollToIndexRef } from "../hooks/useKeyboardShortcuts";
import { useLibraryStore, type LibFile } from "./libraryStore";
import { useFavoritesStore } from "./favoritesStore";

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

/** One decoded spectrogram image (see SpectrogramReady in types.ts): row 0 is
 *  the top = highest frequency, `data` is width × height u8 magnitudes. */
export interface Spectrogram {
  path: string;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface PlayerState {
  currentPath: string | null;
  playing: boolean;
  /** Seconds; 0 = not yet known. */
  duration: number;
  /** 0..1 */
  volume: number;
  loop: boolean;
  autoplay: boolean;
  /** On track end (loop off): advance to the next visible audio file. Persisted. */
  autoAdvance: boolean;
  /** Hovering an audio row auditions it without selecting. Persisted. */
  hoverPreview: boolean;
  /** Playback rate 0.25–2 (rodio resamples, so pitch shifts too). Session-only:
   *  survives track changes (the engine re-applies it per sink) but resets on
   *  app restart — deliberately not in Settings. */
  speed: number;
  /** Waveform ⇄ spectrogram display in the player bar. Session-only. */
  viz: "wave" | "spec";
  /** Interleaved [min0, max0, min1, max1, ...] peaks for the current track. */
  peaks: Float32Array | null;
  /** Last spectrogram received. May lag `currentPath` — consumers must check
   *  `spectrogram.path === currentPath` (kept stale-but-guarded rather than
   *  nulled on track change, so toggling back to a cached track is instant). */
  spectrogram: Spectrogram | null;

  setVolume: (volume: number) => void;
  toggleLoop: () => void;
  toggleAutoplay: () => void;
  toggleAutoAdvance: () => void;
  toggleHoverPreview: () => void;
  setSpeed: (speed: number) => void;
  setViz: (viz: "wave" | "spec") => void;
  togglePlay: () => void;
}

export const usePlayerStore = create<PlayerState>()((set, get) => ({
  currentPath: null,
  playing: false,
  duration: 0,
  volume: 0.8,
  loop: false,
  autoplay: true,
  autoAdvance: false,
  hoverPreview: false,
  speed: 1,
  viz: "wave",
  peaks: null,
  spectrogram: null,

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

  toggleAutoAdvance: () => set((s) => ({ autoAdvance: !s.autoAdvance })),

  toggleHoverPreview: () => set((s) => ({ hoverPreview: !s.hoverPreview })),

  setSpeed: (speed) => {
    // Mirror the engine's clamp so the button label never disagrees with what
    // is actually playing.
    const clamped = Math.min(2, Math.max(0.25, speed));
    set({ speed: clamped });
    void playerSetSpeed(clamped);
  },

  setViz: (viz) => set({ viz }),

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
 * The audio pane's visible (filtered + sorted) list, published by TabPane —
 * the scrollToIndexRef idiom. Auto-advance reads it when a track ends, which
 * can happen while the user browses another tab; the pane deliberately never
 * clears it on unmount, so the last-rendered audio order keeps serving.
 */
export const audioVisibleRef: { current: readonly LibFile[] } = { current: [] };

/** Path currently playing as a HOVER preview (null = none). Module-level, not
 *  store state: only the hover handlers and the choke points below care, and
 *  it must never re-render anything. */
let hoverPath: string | null = null;

/**
 * Select `file` in the library and load it into the audio engine.
 * `debounceMs > 0` delays only the invoke (trailing) — selection, waveform
 * reset, and playhead reset are applied immediately so the UI keeps up with
 * rapid arrow-key scrubbing without spamming the backend.
 * `forcePlay` starts playback even with autoplay off (the shuffle button —
 * a deliberate "play me something" gesture, unlike passive selection).
 */
export function loadAndSelect(file: LibFile, index: number, debounceMs = 0, forcePlay = false): void {
  const lib = useLibraryStore.getState();
  // Any deliberate load claims the player: if a hover preview was sounding,
  // it is no longer "just a hover" — mouseleave must not stop the track the
  // user explicitly chose (clicking the very row being hovered).
  hoverPath = null;
  // The player is audio-only by construction; other kinds never reach here.
  lib.select("audio", index, file.path);

  // Recents: loading a sample into the player counts as using it. The store
  // throttles per-path (60 s), so arrow-scrub churn stays bounded; recorded
  // before the same-path bail below so a genuine re-listen refreshes its slot.
  useFavoritesStore.getState().recordRecent(file.path);

  // Re-selecting the already-loaded track (clicking the selected row, or a
  // clamped arrow press at the list edge): leave peaks/playhead/playback
  // alone. WaveformCanvas only re-requests peaks when currentPath changes,
  // so nulling them here would strand the flat fallback bar — and Enter is
  // the explicit replay gesture. Any pending debounced load is for this same
  // path, so letting it fire is correct.
  if (usePlayerStore.getState().currentPath === file.path) return;

  const autoplay = forcePlay || usePlayerStore.getState().autoplay;
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
  hoverPath = null; // deliberate gesture — see loadAndSelect
  usePlayerStore.setState({ playing: true });
  positionRef.seconds = 0;
  positionRef.playing = true;
  usePositionStore.setState({ seconds: 0 });
  void playerLoad(currentPath, true);
}

/**
 * Hover preview (FileRow's 350 ms dwell): load + play WITHOUT touching the
 * selection — the row under the cursor sounds, but focus, keyboard position
 * and the recents log (a hover is not a "use") all stay where they were.
 */
export function hoverPlay(file: LibFile): void {
  hoverPath = file.path;
  const lib = useLibraryStore.getState();
  if (usePlayerStore.getState().currentPath === file.path) {
    // Hovering the already-loaded track: restart it, but keep the peaks —
    // WaveformCanvas only re-requests them when currentPath changes, so
    // nulling them here would strand the flat fallback bar (the same reason
    // loadAndSelect bails on a same-path re-select).
    usePlayerStore.setState({ playing: true });
  } else {
    usePlayerStore.setState({
      currentPath: file.path,
      peaks: null,
      duration: lib.durations.get(file.id) ?? 0,
      playing: true,
    });
  }
  positionRef.seconds = 0;
  positionRef.playing = true;
  positionRef.path = file.path;
  usePositionStore.setState({ seconds: 0 });
  void playerLoad(file.path, true);
}

/** Mouseleave after a hover preview fired: stop it. No-op if a deliberate
 *  gesture (click/arrow/Enter) claimed playback in the meantime. */
export function hoverStop(): void {
  if (hoverPath === null) return;
  const path = hoverPath;
  hoverPath = null;
  if (usePlayerStore.getState().currentPath !== path) return;
  usePlayerStore.setState({ playing: false });
  positionRef.playing = false;
  positionRef.seconds = 0;
  usePositionStore.setState({ seconds: 0 });
  void playerStop();
}

/**
 * `playback:state` = "ended" hook (events.ts): with auto-advance on and loop
 * off, move to the NEXT file in the visible audio order and play it — the
 * "just let the pack play" mode. Stops quietly at the end of the list.
 */
export function maybeAutoAdvance(): void {
  const { autoAdvance, loop, currentPath } = usePlayerStore.getState();
  // Loop never emits "ended" (the engine restarts the track itself), but
  // guard anyway; a finished HOVER preview must not hijack the selection.
  if (!autoAdvance || loop || currentPath === null || hoverPath !== null) return;
  const files = audioVisibleRef.current;
  const index = files.findIndex((f) => f.path === currentPath);
  if (index < 0 || index + 1 >= files.length) return; // end of list: stop
  const next = index + 1;
  // forcePlay: advancing exists to keep sound coming, autoplay pref or not.
  loadAndSelect(files[next]!, next, 0, true);
  // The scroll ref belongs to the ACTIVE pane — only aim it on the audio tab
  // (its flat indices match; a texture grid's do not).
  if (useLibraryStore.getState().activeTab === "audio") {
    scrollToIndexRef.current?.(next);
  }
}
