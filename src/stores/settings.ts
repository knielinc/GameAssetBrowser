import { load, type Store } from "@tauri-apps/plugin-store";
import {
  ASSET_KINDS,
  EXTENSIONS,
  SORT_FIELDS_BY_KIND,
  type AssetKind,
  type Settings,
  type SortDir,
  type SortField,
  type TabSettings,
  type ViewMode,
} from "../types";
import { playerSetLoop, playerSetVolume, settingsStorePath } from "../ipc/commands";
import { defaultTabs, useLibraryStore, type TabState } from "./libraryStore";
import { usePlayerStore } from "./playerStore";

function defaultTabSettings(kind: AssetKind): TabSettings {
  return {
    sortField: "name",
    sortDir: "asc",
    extFilter: [],
    viewMode: kind === "audio" ? "list" : "grid",
    cellSize: 132,
    groupMaterials: true,
  };
}

export const DEFAULT_SETTINGS: Settings = {
  version: 2,
  roots: [],
  volume: 0.8,
  loop: false,
  autoplay: true,
  activeTab: "audio",
  tabs: {
    audio: defaultTabSettings("audio"),
    texture: defaultTabSettings("texture"),
    model: defaultTabSettings("model"),
  },
};

const SORT_DIRS: readonly SortDir[] = ["asc", "desc"];
const VIEW_MODES: readonly ViewMode[] = ["list", "grid"];
export const MIN_CELL = 96;
export const MAX_CELL = 220;

let storeHandle: Store | null = null;
let saveTimer: number | undefined;
let subscribed = false;

/** The v1 (SoundPreviewer) on-disk shape. Keep this type forever — it is the
 *  only record of what an un-versioned settings.json looked like. */
interface SettingsV1 {
  roots?: unknown;
  volume?: unknown;
  loop?: unknown;
  autoplay?: unknown;
  sortField?: unknown;
  sortDir?: unknown;
  extFilter?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const strArray = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [...fallback];

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

function sanitizeTab(kind: AssetKind, raw: unknown): TabSettings {
  const d = defaultTabSettings(kind);
  if (!isObj(raw)) return d;
  return {
    // Gated per kind: a persisted `duration` sort on the texture tab (however
    // it got there) degrades to name rather than sorting by a field that has
    // no values.
    sortField: oneOf<SortField>(raw.sortField, SORT_FIELDS_BY_KIND[kind], d.sortField),
    sortDir: oneOf<SortDir>(raw.sortDir, SORT_DIRS, d.sortDir),
    extFilter: strArray(raw.extFilter, d.extFilter).filter((e) => EXTENSIONS[kind].includes(e)),
    viewMode: oneOf<ViewMode>(raw.viewMode, VIEW_MODES, d.viewMode),
    cellSize: Math.round(clampNum(raw.cellSize, MIN_CELL, MAX_CELL, d.cellSize)),
    groupMaterials: bool(raw.groupMaterials, d.groupMaterials),
  };
}

/** v1 had one sort/filter at the top level. Those were audio's — everything
 *  scanned back then was audio — so they upgrade into the audio tab. */
function upgradeV1(old: SettingsV1): Record<string, unknown> {
  return {
    roots: old.roots,
    volume: old.volume,
    loop: old.loop,
    autoplay: old.autoplay,
    activeTab: "audio",
    tabs: {
      audio: {
        ...defaultTabSettings("audio"),
        sortField: old.sortField,
        sortDir: old.sortDir,
        extFilter: old.extFilter,
      },
      texture: defaultTabSettings("texture"),
      model: defaultTabSettings("model"),
    },
  };
}

/**
 * Total by construction: never throws, always returns a complete valid
 * Settings. A corrupt or half-written settings.json must degrade to defaults,
 * never crash startup.
 */
export function sanitize(raw: unknown): Settings {
  if (!isObj(raw)) return structuredClone(DEFAULT_SETTINGS);
  const v2 = raw.version === 2 ? raw : upgradeV1(raw as SettingsV1);
  const tabs = isObj(v2.tabs) ? v2.tabs : {};
  const d = DEFAULT_SETTINGS;
  return {
    version: 2,
    roots: strArray(v2.roots, d.roots),
    volume: clampNum(v2.volume, 0, 1, d.volume),
    loop: bool(v2.loop, d.loop),
    autoplay: bool(v2.autoplay, d.autoplay),
    activeTab: oneOf<AssetKind>(v2.activeTab, ASSET_KINDS, d.activeTab),
    tabs: {
      audio: sanitizeTab("audio", tabs.audio),
      texture: sanitizeTab("texture", tabs.texture),
      model: sanitizeTab("model", tabs.model),
    },
  };
}

function tabToSettings(t: TabState): TabSettings {
  return {
    sortField: t.sortField,
    sortDir: t.sortDir,
    extFilter: [...t.extFilter],
    viewMode: t.viewMode,
    cellSize: t.cellSize,
    groupMaterials: t.groupMaterials,
  };
}

function currentSettings(): Settings {
  const lib = useLibraryStore.getState();
  const player = usePlayerStore.getState();
  return {
    version: 2,
    roots: lib.roots,
    volume: player.volume,
    loop: player.loop,
    autoplay: player.autoplay,
    activeTab: lib.activeTab,
    tabs: {
      audio: tabToSettings(lib.tabs.audio),
      texture: tabToSettings(lib.tabs.texture),
      model: tabToSettings(lib.tabs.model),
    },
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
  // `tabs` gets a fresh identity on every per-tab mutation (see patchTab), so
  // one shallow compare covers all three tabs' sort/filter/view state.
  useLibraryStore.subscribe((state, prev) => {
    if (
      state.roots !== prev.roots ||
      state.tabs !== prev.tabs ||
      state.activeTab !== prev.activeTab
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
  const raw = await storeHandle.get<unknown>("settings");
  const settings = sanitize(raw);

  // Merge persisted view state onto fresh defaults so session-only fields
  // (selection, query) start clean rather than being left undefined.
  const tabs = defaultTabs();
  for (const kind of ASSET_KINDS) {
    const p = settings.tabs[kind];
    tabs[kind] = {
      ...tabs[kind],
      sortField: p.sortField,
      sortDir: p.sortDir,
      extFilter: new Set(p.extFilter),
      viewMode: p.viewMode,
      cellSize: p.cellSize,
      groupMaterials: p.groupMaterials,
    };
  }
  useLibraryStore.setState({ roots: settings.roots, activeTab: settings.activeTab, tabs });
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
