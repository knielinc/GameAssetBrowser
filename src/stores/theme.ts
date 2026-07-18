import { create } from "zustand";

/**
 * Theme + UI-scale, applied by writing CSS custom properties onto :root (which
 * override the Tailwind `@theme` defaults), a `color-scheme`, and a `zoom`
 * factor for the whole document. Persisted to localStorage — a pure frontend
 * choice with no Rust side, like renderPrefs.
 *
 * The app is px-pinned rather than em-based, so "base font size" scales the
 * whole UI uniformly via `zoom` — everything grows off the chosen size.
 */

type Vars = Record<string, string>;

function mk(c: {
  bg: string;
  header: string;
  panel: string;
  raised: string;
  overlay: string;
  border: string;
  text: string;
  dim: string;
  faint: string;
  accent: string;
  accentHover: string;
  accentFill: string;
  accentFg: string;
  /** Saturated/darker accent for SOLID buttons that carry white text. */
  accentSolid: string;
}): Vars {
  return {
    "--color-bg": c.bg,
    "--color-header": c.header,
    "--color-panel": c.panel,
    "--color-raised": c.raised,
    "--color-overlay": c.overlay,
    "--color-border": c.border,
    "--color-text": c.text,
    "--color-dim": c.dim,
    "--color-faint": c.faint,
    "--color-accent": c.accent,
    "--color-accent-hover": c.accentHover,
    "--color-accent-fill": c.accentFill,
    "--color-accent-fg": c.accentFg,
    "--color-accent-solid": c.accentSolid,
  };
}

export interface Theme {
  id: string;
  name: string;
  /** Preview swatch: [surface, accent]. */
  swatch: [string, string];
  light?: boolean;
  vars: Vars;
}

export const THEMES: Theme[] = [
  // ---- dark ----
  {
    id: "midnight", name: "Midnight", swatch: ["#1e212a", "#8aa6ff"],
    vars: mk({ bg: "#0d0e13", header: "#16181f", panel: "#1e212a", raised: "#272a35", overlay: "#313641", border: "#2a2e39", text: "#edeff4", dim: "#a2a8b8", faint: "#6b7284", accent: "#8aa6ff", accentHover: "#a2b8ff", accentFill: "#2c3b6a", accentFg: "#cdd8ff", accentSolid: "#4a6cf0" }),
  },
  {
    id: "ember", name: "Ember", swatch: ["#23201b", "#f0b64e"],
    vars: mk({ bg: "#100f0d", header: "#1a1713", panel: "#23201b", raised: "#2c2823", overlay: "#37322a", border: "#35302a", text: "#f0ece4", dim: "#b3a999", faint: "#7a7060", accent: "#f0b64e", accentHover: "#f6c66e", accentFill: "#493716", accentFg: "#f8dca0", accentSolid: "#a06a12" }),
  },
  {
    id: "forest", name: "Forest", swatch: ["#1a241e", "#4fcf8b"],
    vars: mk({ bg: "#0b0f0d", header: "#131a16", panel: "#1a241e", raised: "#232e27", overlay: "#2c3a30", border: "#29372e", text: "#e8f0ea", dim: "#9db3a5", faint: "#66786c", accent: "#4fcf8b", accentHover: "#6fdaa1", accentFill: "#153a28", accentFg: "#a8ecc8", accentSolid: "#1f9e63" }),
  },
  {
    id: "orchid", name: "Orchid", swatch: ["#241b2a", "#d67ce6"],
    vars: mk({ bg: "#100c13", header: "#1a141f", panel: "#241b2a", raised: "#2e2435", overlay: "#392d42", border: "#352a3d", text: "#efe9f2", dim: "#b0a3b8", faint: "#766a7d", accent: "#d67ce6", accentHover: "#e096ee", accentFill: "#43244d", accentFg: "#edc4f4", accentSolid: "#a94bb8" }),
  },
  {
    id: "glacier", name: "Glacier", swatch: ["#1c232a", "#4bc6d8"],
    vars: mk({ bg: "#0b0f12", header: "#14191d", panel: "#1c232a", raised: "#252e35", overlay: "#2f3a42", border: "#2b353d", text: "#e9f1f5", dim: "#9db0bb", faint: "#667680", accent: "#4bc6d8", accentHover: "#6bd4e3", accentFill: "#113942", accentFg: "#a6e6f0", accentSolid: "#1f8fa0" }),
  },
  // ---- light ----
  {
    id: "daylight", name: "Daylight", swatch: ["#eceff4", "#3d6ef5"], light: true,
    vars: mk({ bg: "#eceff4", header: "#e0e4ec", panel: "#f7f8fb", raised: "#ffffff", overlay: "#ffffff", border: "#d7dde7", text: "#1a1f2b", dim: "#565f70", faint: "#98a1b2", accent: "#3d6ef5", accentHover: "#2f5fe0", accentFill: "#dde6ff", accentFg: "#2850c4", accentSolid: "#3d6ef5" }),
  },
  {
    id: "sand", name: "Sand", swatch: ["#f2efe9", "#b77f16"], light: true,
    vars: mk({ bg: "#f2efe9", header: "#e8e3d9", panel: "#faf8f3", raised: "#ffffff", overlay: "#ffffff", border: "#e0d9cc", text: "#26221a", dim: "#6b6355", faint: "#a89e8b", accent: "#b77f16", accentHover: "#9c6b0e", accentFill: "#f2e6c8", accentFg: "#8a5f10", accentSolid: "#b77f16" }),
  },
  {
    id: "meadow", name: "Meadow", swatch: ["#eaf1ec", "#1f9e63"], light: true,
    vars: mk({ bg: "#eaf1ec", header: "#dde8e0", panel: "#f6faf7", raised: "#ffffff", overlay: "#ffffff", border: "#d3e2d8", text: "#17211b", dim: "#536357", faint: "#93a798", accent: "#1f9e63", accentHover: "#178452", accentFill: "#cdeddb", accentFg: "#167a4c", accentSolid: "#1f9e63" }),
  },
  {
    id: "blossom", name: "Blossom", swatch: ["#f4edf4", "#b0479a"], light: true,
    vars: mk({ bg: "#f4edf4", header: "#e9dee9", panel: "#faf6fa", raised: "#ffffff", overlay: "#ffffff", border: "#e4d6e4", text: "#241a26", dim: "#665a68", faint: "#a794aa", accent: "#b0479a", accentHover: "#963c83", accentFill: "#f0d8ec", accentFg: "#8a3579", accentSolid: "#b0479a" }),
  },
  {
    id: "frost", name: "Frost", swatch: ["#e9f0f3", "#0e8fa3"], light: true,
    vars: mk({ bg: "#e9f0f3", header: "#dbe6ea", panel: "#f5f9fb", raised: "#ffffff", overlay: "#ffffff", border: "#d0dfe5", text: "#16222a", dim: "#506069", faint: "#90a4ad", accent: "#0e8fa3", accentHover: "#0b7686", accentFill: "#cceaf0", accentFg: "#0c7a8b", accentSolid: "#0e8fa3" }),
  },
];

const KEY_THEME = "gameassetbrowser.theme";
const KEY_FONT = "gameassetbrowser.baseFont";
/** The size the layout was authored at — zoom = base / this. */
export const DEFAULT_FONT = 14;
export const MIN_FONT = 11;
export const MAX_FONT = 20;

function applyTheme(id: string): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0]!;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  root.style.colorScheme = theme.light === true ? "light" : "dark";
}

function applyFont(px: number): void {
  // `zoom` scales the whole document uniformly (px and all), so the entire UI
  // grows off the chosen base size — the em-scaling the px-based layout can't do.
  document.documentElement.style.setProperty("zoom", String(px / DEFAULT_FONT));
}

function loadTheme(): string {
  try {
    const v = localStorage.getItem(KEY_THEME);
    if (v !== null && THEMES.some((t) => t.id === v)) return v;
  } catch {
    /* storage disabled */
  }
  return THEMES[0]!.id;
}

function loadFont(): number {
  try {
    const v = Number(localStorage.getItem(KEY_FONT));
    if (Number.isFinite(v) && v >= MIN_FONT && v <= MAX_FONT) return v;
  } catch {
    /* storage disabled */
  }
  return DEFAULT_FONT;
}

export interface ThemeStore {
  themeId: string;
  baseFont: number;
  setTheme: (id: string) => void;
  setBaseFont: (px: number) => void;
}

export const useThemeStore = create<ThemeStore>((set) => ({
  themeId: loadTheme(),
  baseFont: loadFont(),
  setTheme: (id) => {
    try {
      localStorage.setItem(KEY_THEME, id);
    } catch {
      /* storage disabled */
    }
    applyTheme(id);
    set({ themeId: id });
  },
  setBaseFont: (px) => {
    const clamped = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(px)));
    try {
      localStorage.setItem(KEY_FONT, String(clamped));
    } catch {
      /* storage disabled */
    }
    applyFont(clamped);
    set({ baseFont: clamped });
  },
}));

// Apply the persisted choices at import (before first paint).
applyTheme(loadTheme());
applyFont(loadFont());
