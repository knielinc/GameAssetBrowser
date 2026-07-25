// Build stamp, substituted at compile time by vite.config.ts's `define`. Kept
// behind this module so nothing else has to know the magic global exists.

declare const __BUILD_STAMP__: { version: string; commit: string; date: string };

export interface BuildInfo {
  /** Semver from package.json at build time; CI stamps the release version in. */
  version: string;
  /** Short git SHA, or "unknown" when built outside a git checkout. */
  commit: string;
  /** ISO date (YYYY-MM-DD) the bundle was built. */
  date: string;
}

export const BUILD: BuildInfo = __BUILD_STAMP__;

/** Product name as shown to users — matches tauri.conf.json's productName. */
export const APP_NAME = "Game Asset Browser";

export const REPO_URL = "https://github.com/knielinc/GameAssetBrowser";
