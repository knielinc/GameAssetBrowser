import { create } from "zustand";
import {
  playerLoad,
  playerPause,
  playerPlay,
  playerSetLoop,
  playerSetSpeed,
  playerSetVolume,
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

/** Reactive length of the visible audio list (published by TabPane alongside
 *  audioVisibleRef), so the transport's prev/next/shuffle buttons disable when
 *  there is nothing to step through. A plain ref can't re-render them. */
interface AudioListState {
  count: number;
}
export const useAudioListStore = create<AudioListState>()(() => ({ count: 0 }));

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
  /** Auto-advance in a random (Spotify-style) order instead of list order: a
   *  frozen permutation plays each visible track once before any repeat.
   *  Persisted. */
  shuffle: boolean;
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
  toggleShuffle: () => void;
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
  shuffle: false,
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

  // Drop any frozen chain so the mode change takes effect on the very next
  // "ended" rather than trailing the rest of the current order.
  toggleShuffle: () => {
    clearAdvanceOrder();
    set((s) => ({ shuffle: !s.shuffle }));
  },

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

/**
 * A frozen running order (paths) for the current auto-advance chain. The
 * Recent scope sorts the visible list by recency, and playing a track bumps it
 * to the top — so advancing by "current index + 1" in the LIVE list would
 * revisit already-heard tracks and never reach the end. Freezing the order
 * when a chain begins makes "let the pack play" walk the list once, top to
 * bottom, in every scope. Any deliberate gesture clears it, so the next chain
 * re-freezes from wherever the user landed. With shuffle on it is frozen as a
 * random permutation instead of list order (see shuffledOrder).
 */
let advanceOrder: readonly string[] | null = null;

/** Drop the frozen auto-advance order so the next "ended" re-freezes fresh. */
function clearAdvanceOrder(): void {
  advanceOrder = null;
}

/**
 * A Fisher–Yates permutation of `paths` with `first` pulled to the front, so a
 * shuffled auto-advance chain never repeats the just-ended track and plays every
 * visible sample once before the order is exhausted (Spotify-style shuffle).
 */
function shuffledOrder(paths: readonly string[], first: string): string[] {
  const arr = paths.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i]!, arr[j]!] = [arr[j]!, arr[i]!];
  }
  const at = arr.indexOf(first);
  if (at > 0) [arr[0]!, arr[at]!] = [arr[at]!, arr[0]!];
  return arr;
}

/**
 * Select `file` in the library and load it into the audio engine.
 * `debounceMs > 0` delays only the invoke (trailing) — selection, waveform
 * reset, and playhead reset are applied immediately so the UI keeps up with
 * rapid arrow-key scrubbing without spamming the backend.
 * `forcePlay` starts playback even with autoplay off (transport skip / auto-
 * advance — a deliberate "keep sound coming" gesture, unlike passive selection).
 */
export function loadAndSelect(file: LibFile, index: number, debounceMs = 0, forcePlay = false): void {
  const lib = useLibraryStore.getState();
  // A deliberate pick ends the current auto-advance chain; the next "ended"
  // re-freezes the order from here. (maybeAutoAdvance restores it after its
  // own loadAndSelect so the chain it drives keeps walking the frozen order.)
  advanceOrder = null;
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
  usePlayerStore.setState({ playing: true });
  positionRef.seconds = 0;
  positionRef.playing = true;
  usePositionStore.setState({ seconds: 0 });
  void playerLoad(currentPath, true);
}

/**
 * `playback:state` = "ended" hook (events.ts): with auto-advance on and loop
 * off, move to the NEXT file in the visible audio order and play it — the
 * "just let the pack play" mode. Stops quietly at the end of the list.
 */
export function maybeAutoAdvance(): void {
  const { autoAdvance, loop, currentPath, shuffle } = usePlayerStore.getState();
  // Loop never emits "ended" (the engine restarts the track itself), but guard.
  if (!autoAdvance || loop || currentPath === null) return;
  // Walk the FROZEN order (see advanceOrder), freezing it on the first step of
  // a chain, so the Recent scope's play-driven reshuffle can't make us revisit.
  // With shuffle on the freeze is a random permutation (current track first).
  const paths = audioVisibleRef.current.map((f) => f.path);
  const order = advanceOrder ?? (shuffle ? shuffledOrder(paths, currentPath) : paths);
  const index = order.indexOf(currentPath);
  if (index < 0 || index + 1 >= order.length) {
    advanceOrder = null; // end of the frozen list (or fell out of it): stop
    return;
  }
  const nextPath = order[index + 1]!;
  // Resolve the frozen path to its slot in the LIVE list: recency may have
  // reordered it since the freeze, and select/scroll need a current index.
  const files = audioVisibleRef.current;
  const nextIdx = files.findIndex((f) => f.path === nextPath);
  if (nextIdx < 0) {
    advanceOrder = null; // next track filtered out from under us: stop
    return;
  }
  // forcePlay: advancing exists to keep sound coming, autoplay pref or not.
  loadAndSelect(files[nextIdx]!, nextIdx, 0, true); // clears advanceOrder...
  advanceOrder = order; // ...so restore the frozen chain to keep walking it
  // The scroll ref belongs to the ACTIVE pane — only aim it on the audio tab
  // (its flat indices match; a texture grid's do not).
  if (useLibraryStore.getState().activeTab === "audio") {
    scrollToIndexRef.current?.(nextIdx);
  }
}

/**
 * Manual prev/next track over the visible audio order — the transport skip
 * buttons. Steps the selection by ±1 and plays it (forcePlay), stopping at
 * either edge. Reads the published audio order (not the active pane), so it
 * works while the user browses another tab, exactly like auto-advance.
 */
export function playAdjacent(delta: 1 | -1): void {
  const files = audioVisibleRef.current;
  if (files.length === 0) return;
  const { currentPath } = usePlayerStore.getState();
  const cur = currentPath === null ? -1 : files.findIndex((f) => f.path === currentPath);
  // From no current track: next → first, prev → last.
  const next = cur < 0 ? (delta > 0 ? 0 : files.length - 1) : cur + delta;
  if (next < 0 || next >= files.length) return; // at an edge: stay put
  loadAndSelect(files[next]!, next, 0, true);
  if (useLibraryStore.getState().activeTab === "audio") scrollToIndexRef.current?.(next);
}
