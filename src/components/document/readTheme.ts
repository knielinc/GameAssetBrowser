import type { CSSProperties } from "react";
import { useDocView, type ReadTheme } from "../../stores/docView";

/**
 * The reading page palette, shared by every document view that renders prose —
 * the ebook reader, markdown, and plain text. PDF is excluded: its pages are
 * images of paper produced by the file itself, not something we colour.
 *
 * Deliberately independent of the app theme (it only seeds the DEFAULT — see
 * docView), because the page you read on is its own choice: people run a dark
 * app with a light page and vice versa.
 */
export interface ReadPalette {
  /** The page itself. */
  bg: string;
  /** Body copy. */
  fg: string;
  /** Headings — a touch brighter/darker than body so structure reads. */
  head: string;
  link: string;
  /** Rules, table cell borders, blockquote bars. */
  rule: string;
  /** Blockquote text, captions, line numbers — the quiet tone. */
  quote: string;
  /** Inset surface: code blocks, the text view's line-number gutter. */
  well: string;
  sel: string;
  /** Scrollbar thumb for the page's own scroll container. */
  thumb: string;
  scheme: "dark" | "light";
  /** The floating control pill, re-tinted to sit on the PAGE rather than on
   *  whatever the app chrome happens to be. */
  hud: { bg: string; fg: string; dim: string; hover: string; line: string; mark: string };
}

/**
 * Dark is a soft near-black with a warm off-white body — pure #fff on #000
 * glares at book length. Light is the sepia paper the reader has always used.
 */
export const READ_THEMES: Record<ReadTheme, ReadPalette> = {
  dark: {
    bg: "#14161a",
    fg: "#d3cfc7",
    head: "#e8e4dc",
    link: "#86b6ff",
    rule: "#3a3f48",
    quote: "#a19d95",
    well: "#1d2026",
    sel: "#3a4763",
    thumb: "#33373f",
    scheme: "dark",
    hud: { bg: "rgb(0 0 0 / 0.7)", fg: "rgb(255 255 255 / 0.9)", dim: "rgb(255 255 255 / 0.6)", hover: "rgb(255 255 255 / 0.15)", line: "rgb(255 255 255 / 0.2)", mark: "#fcd34d" },
  },
  light: {
    bg: "#f6f2e8",
    fg: "#1a1712",
    head: "#12100c",
    link: "#1a5fb4",
    rule: "#d8cdb0",
    quote: "#4a4436",
    well: "#ece5d4",
    sel: "#d5cba8",
    thumb: "#d2c9b2",
    scheme: "light",
    hud: { bg: "rgb(38 33 24 / 0.82)", fg: "rgb(255 253 246 / 0.95)", dim: "rgb(255 253 246 / 0.65)", hover: "rgb(255 255 255 / 0.18)", line: "rgb(255 255 255 / 0.22)", mark: "#fbbf24" },
  },
};

/** The reading palette currently in force. */
export function useReadPalette(): ReadPalette {
  return READ_THEMES[useDocView((s) => s.readTheme)];
}

/**
 * The palette as CSS custom properties. Set these on a view's outer element:
 * they inherit to descendants AND across a shadow boundary, which is what lets
 * the ebook reader restyle every mounted section without re-injecting a single
 * shadow root.
 */
export function readVars(p: ReadPalette): CSSProperties {
  return {
    "--rd-bg": p.bg,
    "--rd-fg": p.fg,
    "--rd-head": p.head,
    "--rd-link": p.link,
    "--rd-rule": p.rule,
    "--rd-quote": p.quote,
    "--rd-well": p.well,
    "--rd-sel": p.sel,
    "--rd-thumb": p.thumb,
    colorScheme: p.scheme,
    // The pill floats over the page, so it takes the PAGE's palette — not the
    // app chrome's (see the .hud vars applyTheme sets on :root).
    "--hud-bg": p.hud.bg,
    "--hud-fg": p.hud.fg,
    "--hud-dim": p.hud.dim,
    "--hud-hover": p.hud.hover,
    "--hud-line": p.hud.line,
    "--hud-mark": p.hud.mark,
  } as CSSProperties;
}
