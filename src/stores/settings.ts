import { load, type Store } from "@tauri-apps/plugin-store";
import { AUDIO_EXTENSIONS, type AudioExt, type Settings, type SortDir, type SortField } from "../types";
import { playerSetLoop, playerSetVolume, settingsStorePath } from "../ipc/commands";
import { useLibraryStore } from "./libraryStore";
import { usePlayerStore } from "./playerStore";

export const DEFAULT_SETTINGS: Settings = {
  roots: [],
  volume: 0.8,
  loop: false,
  autoplay: true,
  sortField: "name",
  sortDir: "asc",
  extFilter: [],
};

const SORT_FIELDS: readonly SortField[] = ["name", "size", "modified", "ext", "duration"];
const SORT_DIRS: readonly SortDir[] = ["asc", "desc"];

let storeHandle: Store | null = null;
let saveTimer: number | undefined;
let subscribed = false;

function sanitize(raw: Partial<Settings> | null | undefined): Settings {
  const d = DEFAULT_SETTINGS;
  if (!raw) return { ...d };
  return {
    roots: Array.isArray(raw.roots)
      ? raw.roots.filter((r): r is string => typeof r === "string")
      : [...d.roots],
    volume:
      typeof raw.volume === "number" && Number.isFinite(raw.volume)
        ? Math.min(1, Math.max(0, raw.volume))
        : d.volume,
    loop: typeof raw.loop === "boolean" ? raw.loop : d.loop,
    autoplay: typeof raw.autoplay === "boolean" ? raw.autoplay : d.autoplay,
    sortField:
      raw.sortField !== undefined && SORT_FIELDS.includes(raw.sortField)
        ? raw.sortField
        : d.sortField,
    sortDir:
      raw.sortDir !== undefined && SORT_DIRS.includes(raw.sortDir)
        ? raw.sortDir
        : d.sortDir,
    extFilter: Array.isArray(raw.extFilter)
      ? raw.extFilter.filter((e) => (AUDIO_EXTENSIONS as readonly string[]).includes(e))
      : [...d.extFilter],
  };
}

function currentSettings(): Settings {
  const lib = useLibraryStore.getState();
  const player = usePlayerStore.getState();
  return {
    roots: lib.roots,
    volume: player.volume,
    loop: player.loop,
    autoplay: player.autoplay,
    sortField: lib.sortField,
    sortDir: lib.sortDir,
    extFilter: [...lib.extFilter],
  };
}

async function persist(): Promise<void> {
  if (storeHandle === null) return;
  try {
    // autoSave: 300 on the store handle flushes to disk shortly after set().
    await storeHandle.set("settings", currentSettings());
  } catch (err) {
    console.error("Failed to persist settings", err);
  }
}

/** Debounced save; called from store subscriptions on any relevant change. */
export function saveSettings(): void {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    void persist();
  }, 400);
}

function installSubscriptions(): void {
  if (subscribed) return;
  subscribed = true;

  // Subscriptions live outside React — installed once, after hydration, so
  // hydrating the stores doesn't immediately echo a save.
  useLibraryStore.subscribe((state, prev) => {
    if (
      state.roots !== prev.roots ||
      state.sortField !== prev.sortField ||
      state.sortDir !== prev.sortDir ||
      state.extFilter !== prev.extFilter
    ) {
      saveSettings();
    }
  });

  usePlayerStore.subscribe((state, prev) => {
    if (
      state.volume !== prev.volume ||
      state.loop !== prev.loop ||
      state.autoplay !== prev.autoplay
    ) {
      saveSettings();
    }
  });
}

/**
 * Load persisted settings, hydrate both stores, sync the audio engine's
 * volume/loop, and install the auto-save subscriptions. Call once at startup,
 * before the first scan.
 */
export async function loadSettings(): Promise<Settings> {
  // Absolute path from the backend so portable copies keep settings next to
  // the exe; absolute paths bypass the plugin's BaseDirectory::AppData root.
  storeHandle = await load(await settingsStorePath(), {
    autoSave: 300,
    defaults: { settings: DEFAULT_SETTINGS },
  });
  const raw = await storeHandle.get<Partial<Settings>>("settings");
  const settings = sanitize(raw);

  useLibraryStore.setState({
    roots: settings.roots,
    sortField: settings.sortField,
    sortDir: settings.sortDir,
    extFilter: new Set<AudioExt>(settings.extFilter),
  });
  usePlayerStore.setState({
    volume: settings.volume,
    loop: settings.loop,
    autoplay: settings.autoplay,
  });

  // Bring the audio engine in line with the persisted preferences.
  void playerSetVolume(settings.volume);
  void playerSetLoop(settings.loop);

  installSubscriptions();
  return settings;
}
