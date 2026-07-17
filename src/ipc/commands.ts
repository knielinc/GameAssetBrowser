// Typed wrappers around every Tauri command in the IPC contract
// (see the header comment of src/types.ts — names and args must not drift).

import { invoke } from "@tauri-apps/api/core";

/** Kick off a recursive scan of `roots`. Resolves to the scan generation id. */
export function startScan(roots: string[]): Promise<number> {
  return invoke<number>("start_scan", { roots });
}

/** Load `path` into the audio engine, optionally starting playback immediately. */
export function playerLoad(path: string, autoplay: boolean): Promise<void> {
  return invoke<void>("player_load", { path, autoplay });
}

export function playerPlay(): Promise<void> {
  return invoke<void>("player_play");
}

export function playerPause(): Promise<void> {
  return invoke<void>("player_pause");
}

export function playerStop(): Promise<void> {
  return invoke<void>("player_stop");
}

export function playerSeek(seconds: number): Promise<void> {
  return invoke<void>("player_seek", { seconds });
}

/** `volume` is 0..1. */
export function playerSetVolume(volume: number): Promise<void> {
  return invoke<void>("player_set_volume", { volume });
}

export function playerSetLoop(enabled: boolean): Promise<void> {
  return invoke<void>("player_set_loop", { enabled });
}

/** Request min/max peaks for `path`; the result arrives via the `waveform:ready` event. */
export function requestWaveform(path: string, bins: number): Promise<void> {
  return invoke<void>("request_waveform", { path, bins });
}

/**
 * Queue thumbnails for `items` ([file id, path] pairs) and supersede any
 * earlier request. Resolves to the new generation; results arrive batched via
 * the `thumb:ready` event, and the pixels themselves over `thumb://`.
 */
export function requestThumbs(items: [number, string][]): Promise<number> {
  return invoke<number>("request_thumbs", { items });
}

/** Open a Windows Explorer window with `path` pre-selected. Rejects if the path no longer exists. */
export function showInExplorer(path: string): Promise<void> {
  return invoke<void>("show_in_explorer", { path });
}

/** Open a folder directly in Windows Explorer. Rejects if `path` is not a directory. */
export function openInExplorer(path: string): Promise<void> {
  return invoke<void>("open_in_explorer", { path });
}

/**
 * Absolute path of `settings.json` inside the app's data home — next to the
 * exe for portable copies, the OS app-data dir otherwise. Pass it to the
 * store plugin's `load()`, which keeps absolute paths as-is.
 */
export function settingsStorePath(): Promise<string> {
  return invoke<string>("settings_store_path");
}
