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
  /** Hover tint, and its stronger rung. Split out from raised/overlay because
   *  those two roles CONFLICT in a light theme: an elevated popup must go
   *  lighter than the canvas (white), while a hover on a near-white card must
   *  go darker. In dark themes both directions are "lighter", so these simply
   *  equal raised/overlay there and nothing changes. */
  hover: string;
  hoverStrong: string;
  /** Recessed well INSIDE the header (the tab pill's track). `bg` serves this
   *  role on every other surface, but in a light theme the header is darker
   *  than the canvas, so a bg-coloured well there reads raised, not sunk. */
  well: string;
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
    "--color-hover": c.hover,
    "--color-hover-strong": c.hoverStrong,
    "--color-well": c.well,
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
  /** Glass theme: surface tokens carry alpha and styles.css paints a gradient
   *  wallpaper behind the app (see the `glass` section there). Stamped on
   *  :root as `data-ui-glass` by applyTheme. */
  glass?: boolean;
  vars: Vars;
  /** Per-theme overrides applied AFTER the mode set. Every key here must also
   *  exist in DARK_MODE/LIGHT_MODE, so switching to another theme resets it —
   *  applyTheme never removes properties, it only overwrites. */
  extra?: Vars;
}

export const THEMES: Theme[] = [
  // ---- dark ----
  // Grid cells separate from the canvas by TONE ALONE — no drop shadow, no
  // outline — so `bg` sits well below `panel`: the card has to clear ~1.3:1 to
  // read as a card. Note darkening `bg` alone cannot get there (even a pure
  // black canvas caps the old panel at ~1.30), so `panel` and the rungs above it
  // are lifted with it; `hover`/`hoverStrong` mirror raised/overlay, as always
  // in dark themes.
  {
    id: "midnight", name: "Midnight", swatch: ["#242832", "#8aa6ff"],
    vars: mk({ bg: "#08080b", header: "#13151b", panel: "#242832", raised: "#2f3240", overlay: "#3b414e", hover: "#2f3240", hoverStrong: "#3b414e", well: "#08080b", border: "#323744", text: "#edeff4", dim: "#a2a8b8", faint: "#6b7284", accent: "#8aa6ff", accentHover: "#a2b8ff", accentFill: "#2c3b6a", accentFg: "#cdd8ff", accentSolid: "#4a6cf0" }),
  },
  {
    id: "ember", name: "Ember", swatch: ["#2a2620", "#f0b64e"],
    vars: mk({ bg: "#0a0908", header: "#171411", panel: "#2a2620", raised: "#35302a", overlay: "#423c32", hover: "#35302a", hoverStrong: "#423c32", well: "#0a0908", border: "#403a32", text: "#f0ece4", dim: "#b3a999", faint: "#7a7060", accent: "#f0b64e", accentHover: "#f6c66e", accentFill: "#493716", accentFg: "#f8dca0", accentSolid: "#a06a12" }),
  },
  {
    id: "forest", name: "Forest", swatch: ["#1f2b24", "#4fcf8b"],
    vars: mk({ bg: "#070908", header: "#111713", panel: "#1f2b24", raised: "#2a372f", overlay: "#35463a", hover: "#2a372f", hoverStrong: "#35463a", well: "#070908", border: "#314237", text: "#e8f0ea", dim: "#9db3a5", faint: "#66786c", accent: "#4fcf8b", accentHover: "#6fdaa1", accentFill: "#153a28", accentFg: "#a8ecc8", accentSolid: "#1f9e63" }),
  },
  {
    id: "orchid", name: "Orchid", swatch: ["#2b2032", "#d67ce6"],
    vars: mk({ bg: "#0a070b", header: "#17121b", panel: "#2b2032", raised: "#372b40", overlay: "#44364f", hover: "#372b40", hoverStrong: "#44364f", well: "#0a070b", border: "#403249", text: "#efe9f2", dim: "#b0a3b8", faint: "#766a7d", accent: "#d67ce6", accentHover: "#e096ee", accentFill: "#43244d", accentFg: "#edc4f4", accentSolid: "#a94bb8" }),
  },
  {
    id: "glacier", name: "Glacier", swatch: ["#222a32", "#4bc6d8"],
    vars: mk({ bg: "#07090b", header: "#12161a", panel: "#222a32", raised: "#2c3740", overlay: "#38464f", hover: "#2c3740", hoverStrong: "#38464f", well: "#07090b", border: "#344049", text: "#e9f1f5", dim: "#9db0bb", faint: "#667680", accent: "#4bc6d8", accentHover: "#6bd4e3", accentFill: "#113942", accentFg: "#a6e6f0", accentSolid: "#1f8fa0" }),
  },
  // ---- light ----
  // `panel` is the near-white card and `bg` the recessed canvas under it;
  // `raised`/`overlay` stay ELEVATION (popups, modals — white, above the
  // canvas) while `hover`/`hoverStrong` carry the hover tint DOWNWARD, since a
  // hover on a near-white card has nowhere lighter to go.
  //
  // `bg` is deliberately deeper than a "white app" instinct wants: grid cells
  // separate from the canvas by TONE ALONE (no drop shadow, no outline), so
  // panel-on-bg carries ~1.35:1. A near-white canvas put that at 1.09 and the
  // cells dissolved into it.
  //
  // `header` goes the OTHER way — a light bar sitting just under the card white
  // — with `well` cut deep beneath it, so the tab track reads as a groove in the
  // bar (1.28:1) rather than a panel floating on it.
  //
  // `accentFill` is a SOLID accent here, not the pale tint the dark set uses,
  // with a near-white `accentFg` on top. A dark theme's pill already clears its
  // near-black well by ~1.5:1 just by being lighter; a pale tint on a light bar
  // managed only ~1.2:1 and the active tab washed out. Solid puts it at
  // 3.7–4.8:1 with a 5:1+ label — the same "obviously the selected one" read.
  {
    id: "daylight", name: "Daylight", swatch: ["#d7dae0", "#2f62e8"], light: true,
    vars: mk({ bg: "#d7dae0", header: "#f0f1f4", panel: "#fafbfd", raised: "#ffffff", overlay: "#ffffff", hover: "#e6eaf2", hoverStrong: "#d7dbe3", well: "#d3d6dc", border: "#cdd0d8", text: "#171b24", dim: "#4e5768", faint: "#868f9f", accent: "#2f62e8", accentHover: "#1c4bc9", accentFill: "#2a5be0", accentFg: "#f2f5ff", accentSolid: "#2a5be0" }),
  },
  {
    id: "sand", name: "Sand", swatch: ["#dcd8d2", "#9a6510"], light: true,
    vars: mk({ bg: "#dcd8d2", header: "#f2f0eb", panel: "#fcfaf6", raised: "#ffffff", overlay: "#ffffff", hover: "#ebe5da", hoverStrong: "#dfd9cf", well: "#d9d5cf", border: "#d5cfc6", text: "#241f17", dim: "#635b4c", faint: "#9c937f", accent: "#9a6510", accentHover: "#7d5109", accentFill: "#8f5d0d", accentFg: "#fff8ec", accentSolid: "#8f5d0d" }),
  },
  {
    id: "meadow", name: "Meadow", swatch: ["#d6dad7", "#14804d"], light: true,
    vars: mk({ bg: "#d6dad7", header: "#eef1ef", panel: "#f8fbf9", raised: "#ffffff", overlay: "#ffffff", hover: "#e2ebe5", hoverStrong: "#d4dcd7", well: "#d2d6d3", border: "#cad2cd", text: "#16211a", dim: "#4c5b50", faint: "#8b9c90", accent: "#14804d", accentHover: "#0f663d", accentFill: "#137a49", accentFg: "#eefaf3", accentSolid: "#137a49" }),
  },
  {
    id: "blossom", name: "Blossom", swatch: ["#ddd6dc", "#9c3486"], light: true,
    vars: mk({ bg: "#ddd6dc", header: "#f3eef2", panel: "#fcf8fb", raised: "#ffffff", overlay: "#ffffff", hover: "#ece1ea", hoverStrong: "#e1d6df", well: "#dad3d9", border: "#d6ccd4", text: "#231a25", dim: "#5e5460", faint: "#9c8fa0", accent: "#9c3486", accentHover: "#7f2a6d", accentFill: "#94317f", accentFg: "#fdeff9", accentSolid: "#94317f" }),
  },
  {
    id: "frost", name: "Frost", swatch: ["#d5dadc", "#0b7a8c"], light: true,
    vars: mk({ bg: "#d5dadc", header: "#eef1f2", panel: "#f8fbfc", raised: "#ffffff", overlay: "#ffffff", hover: "#e1e9ee", hoverStrong: "#d4dbe0", well: "#d2d7d8", border: "#cad1d6", text: "#15212a", dim: "#4b5a64", faint: "#8a9aa4", accent: "#0b7a8c", accentHover: "#086271", accentFill: "#0a7182", accentFg: "#eafafd", accentSolid: "#0a7182" }),
  },
  // ---- glass ----
  // Liquid glass: every surface is an #rrggbbaa TINT over the wallpaper that
  // styles.css paints behind the app. The wallpaper is smooth gradients, so
  // plain translucency already reads as frosted glass — real backdrop-blur is
  // reserved for the floating popups that overlap content (see styles.css).
  // The ladder still steps panel < raised < overlay, but in OPACITY as much as
  // tone: cards are a thin frost, popups are dense enough to carry text.
  // `hover` diverges from `raised` (unlike the opaque dark themes): raised is a
  // popup surface here, far too heavy for a transient row tint, so hover is a
  // thin white wash instead.
  {
    id: "liquid-glass", name: "Liquid Glass", swatch: ["#2c3560", "#8fb8ff"], glass: true,
    vars: mk({ bg: "#0709148c", header: "#1b254794", panel: "#3d4b8f61", raised: "#2a3358d9", overlay: "#39447180", hover: "#aebdff1f", hoverStrong: "#b7c5ff2e", well: "#05071099", border: "#aab8f029", text: "#eef1fc", dim: "#aab3d6", faint: "#707aa3", accent: "#8fb8ff", accentHover: "#aac9ff", accentFill: "#5d8bff52", accentFg: "#d6e4ff", accentSolid: "#4f74f2" }),
    extra: {
      // The chip's legibility comes from ITS opacity (see styles.css) — the
      // dark set derives it from `bg`, which glass makes translucent, and
      // 0.9 × 0.55 alpha left chips see-through over arbitrary thumbnails.
      "--color-chip": "rgb(10 14 32 / 0.82)",
      // White-glass scrollbar thumbs instead of the opaque midnight greys.
      "--scroll-thumb": "#b9c6ff33",
      "--scroll-thumb-strong": "#b9c6ff4d",
      "--scroll-thumb-hover": "#b9c6ff66",
    },
  },
];

/**
 * Everything that has to flip with the LIGHT/DARK mode but is the same for
 * every theme in that mode: accent-independent hues (danger, per-kind, PBR
 * channel), shadow weight, and the few chrome bits CSS alone can't reach.
 *
 * These were previously fixed in styles.css's `@theme` block, i.e. tuned for
 * dark and simply wrong on a light surface — #ffb454 model amber on white is
 * about 1.6:1, and the scrollbar thumb hover was a hardcoded near-black.
 */
const DARK_MODE: Vars = {
  "--color-danger": "#ff5c7a",
  "--color-kind-audio": "#45c58a",
  "--color-kind-texture": "#66c6dc",
  "--color-kind-model": "#ffb454",
  "--color-kind-document": "#b79cff",
  "--color-star": "#ffc53d",
  "--color-ch-bc": "#e7b15c",
  "--color-ch-n": "#7e8cf6",
  "--color-ch-r": "#93a6bc",
  "--color-ch-m": "#66c6dc",
  "--color-ch-ao": "#d0a06e",
  "--color-ch-h": "#56c79a",
  // Badge text sitting ON a kind-coloured fill.
  "--color-on-kind": "#1a1208",
  // Cell info chips — the near-black they always were, but tinted by the
  // theme's own canvas now rather than a fixed blue-black.
  "--color-chip": "color-mix(in srgb, var(--color-bg) 90%, transparent)",
  "--color-stage": "#0c0c12",
  "--color-stage-top": "#15151d",
  // Dark: the list keeps the canvas tone it always had.
  "--color-list": "var(--color-bg)",
  "--shadow-e1": "0 1px 2px rgb(0 0 0 / 0.3), 0 3px 10px rgb(0 0 0 / 0.22)",
  "--shadow-e2": "0 4px 14px rgb(0 0 0 / 0.34), 0 14px 34px rgb(0 0 0 / 0.3)",
  "--scroll-thumb": "#2f3240",
  "--scroll-thumb-strong": "#3b414e",
  "--scroll-thumb-hover": "#474e5d",
  "--checker-a": "#191920",
  "--checker-b": "#23232b",
  // Floating HUD pills over a viewport (PDF pager, model overlays).
  "--hud-bg": "rgb(0 0 0 / 0.65)",
  "--hud-fg": "rgb(255 255 255 / 0.9)",
  "--hud-dim": "rgb(255 255 255 / 0.6)",
  "--hud-hover": "rgb(255 255 255 / 0.15)",
  "--hud-line": "rgb(255 255 255 / 0.2)",
  "--hud-mark": "#fcd34d",
};

const LIGHT_MODE: Vars = {
  "--color-danger": "#cf2440",
  // Darkened to carry ~4.5:1 as TEXT on a near-white panel — the dark set's
  // pastels are tints meant for a dark surface and vanish here.
  "--color-kind-audio": "#0f7a52",
  "--color-kind-texture": "#0f6f86",
  "--color-kind-model": "#96590a",
  "--color-kind-document": "#6a45cf",
  // Deliberately NOT darkened to the 4.5:1 the kind hues above take. Those are
  // text; this is a filled glyph, and dragging a gold down to text contrast on
  // white lands in brown — the exact thing this token exists to avoid. Gold at
  // ~2.2:1 still reads as a solid shape, and the grid star carries a drop
  // shadow on top of that.
  "--color-star": "#e0a10a",
  "--color-ch-bc": "#8a6212",
  "--color-ch-n": "#4a52c4",
  "--color-ch-r": "#566878",
  "--color-ch-m": "#0f6f86",
  "--color-ch-ao": "#8a5a2c",
  "--color-ch-h": "#0f7a52",
  "--color-on-kind": "#fdfaf4",
  // The card white, not the canvas: a chip has to be the LIGHT end of the
  // ladder here to read as a chip rather than a grey smear, and `bg` is cut
  // deep in light themes so grid cells separate from it. `--color-chip-fg`
  // needs no override — it tracks `--color-text`, which already flipped.
  "--color-chip": "color-mix(in srgb, var(--color-panel) 92%, transparent)",
  "--color-stage": "#dcdee4",
  "--color-stage-top": "#f2f3f6",
  // Light: the card white. A var() indirection, so each theme keeps its own
  // tint. This also fixes row hover, which is tuned as a tint ON the card white
  // — over the deep canvas it was LIGHTER than the surface, i.e. inverted.
  "--color-list": "var(--color-panel)",
  // Full-strength black shadows read as smudges on a light surface; soften and
  // keep a hairline top edge so cards still separate from the canvas.
  "--shadow-e1": "0 1px 2px rgb(24 32 48 / 0.09), 0 3px 10px rgb(24 32 48 / 0.07)",
  "--shadow-e2": "0 4px 14px rgb(24 32 48 / 0.13), 0 14px 34px rgb(24 32 48 / 0.11)",
  // A neutral mid-grey, not a hover tint: the thumb rides over BOTH the canvas
  // and near-white panels, so borrowing --color-hover (tuned against the panel)
  // put it at 1.03:1 on the canvas — effectively invisible.
  "--scroll-thumb": "#a9b1bd",
  "--scroll-thumb-strong": "#98a1af",
  "--scroll-thumb-hover": "#8a94a3",
  "--checker-a": "#e9e9ef",
  "--checker-b": "#d7d7e0",
  // A light pill would disappear over a PDF's white page, so the HUD stays
  // dark in both modes — just warmer and less absolute than pure black.
  "--hud-bg": "rgb(28 33 44 / 0.8)",
  "--hud-fg": "rgb(255 255 255 / 0.94)",
  "--hud-dim": "rgb(255 255 255 / 0.66)",
  "--hud-hover": "rgb(255 255 255 / 0.18)",
  "--hud-line": "rgb(255 255 255 / 0.24)",
  "--hud-mark": "#fbbf24",
};

const KEY_THEME = "gameassetbrowser.theme";
const KEY_SCALE = "gameassetbrowser.uiScale";
/** UI scale is a percentage; 100% renders the 16px base. */
export const DEFAULT_SCALE = 100;
export const MIN_SCALE = 50;
export const MAX_SCALE = 200;

function applyTheme(id: string): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0]!;
  const light = theme.light === true;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(light ? LIGHT_MODE : DARK_MODE)) root.style.setProperty(k, v);
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  if (theme.extra !== undefined) for (const [k, v] of Object.entries(theme.extra)) root.style.setProperty(k, v);
  root.style.colorScheme = light ? "light" : "dark";
  // A hook for the few rules that can't be expressed as a var swap — chiefly
  // github-markdown-css, which ships hardcoded hex per mode (see styles.css).
  root.dataset.uiMode = light ? "light" : "dark";
  // Glass themes: styles.css keys the wallpaper and popup blur off this.
  root.dataset.uiGlass = theme.glass === true ? "true" : "false";
}

function applyScale(pct: number): void {
  // `zoom` scales the whole document uniformly (px and all), so the entire UI
  // grows off the chosen size — 100% is the 16px base.
  document.documentElement.style.setProperty("zoom", String(pct / 100));
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

function loadScale(): number {
  try {
    const v = Number(localStorage.getItem(KEY_SCALE));
    if (Number.isFinite(v) && v >= MIN_SCALE && v <= MAX_SCALE) return v;
  } catch {
    /* storage disabled */
  }
  return DEFAULT_SCALE;
}

export interface ThemeStore {
  themeId: string;
  /** UI scale as a percentage (50–200); 100% = 16px base. */
  uiScale: number;
  setTheme: (id: string) => void;
  setUiScale: (pct: number) => void;
}

export const useThemeStore = create<ThemeStore>((set) => ({
  themeId: loadTheme(),
  uiScale: loadScale(),
  setTheme: (id) => {
    try {
      localStorage.setItem(KEY_THEME, id);
    } catch {
      /* storage disabled */
    }
    applyTheme(id);
    set({ themeId: id });
  },
  setUiScale: (pct) => {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(pct)));
    try {
      localStorage.setItem(KEY_SCALE, String(clamped));
    } catch {
      /* storage disabled */
    }
    applyScale(clamped);
    set({ uiScale: clamped });
  },
}));

// Apply the persisted choices at import (before first paint).
applyTheme(loadTheme());
applyScale(loadScale());
