import { create } from "zustand";
import type { AssetKind, ExternalAppSettings } from "../types";

/**
 * User-registered "Open with…" apps (SettingsMenu → External apps…). Persisted
 * in Settings as `externalApps`; hydrated/saved through the same subscription
 * mechanism as favorites (see settings.ts). Every mutation builds a fresh
 * array identity — the save subscription and React consumers both compare by
 * identity, the contract the other stores follow.
 */
export interface ExternalAppsState {
  apps: ExternalAppSettings[];

  /** Replace everything from persisted settings (startup / import). */
  hydrate: (apps: ExternalAppSettings[]) => void;
  addApp: (app: ExternalAppSettings) => void;
  /** Remove by index — name+exe pairs aren't unique, positions are. */
  removeApp: (index: number) => void;
}

export const useExternalAppsStore = create<ExternalAppsState>()((set) => ({
  apps: [],

  hydrate: (apps) => set({ apps: apps.map((a) => ({ ...a })) }),

  addApp: (app) => set((s) => ({ apps: [...s.apps, app] })),

  removeApp: (index) => set((s) => ({ apps: s.apps.filter((_, i) => i !== index) })),
}));

/** The apps offered on a file of `kind` — context menus filter through here so
 *  a model editor never shows up on an audio row. */
export function appsForKind(
  apps: readonly ExternalAppSettings[],
  kind: AssetKind,
): ExternalAppSettings[] {
  return apps.filter((a) => a.kind === kind);
}
