#!/usr/bin/env node
//
// Stamp a release version into every file that reports one.
//
//   node scripts/stamp-version.mjs 0.1.5
//
// Used twice by .github/workflows/release.yml: once per build job (so the
// artifacts carry the right version) and once in the itch job (so the same bump
// is committed back to main). It lives here rather than inline in the YAML
// because a `node -e "…"` heredoc inside a bash step inside YAML has three
// layers of quoting to get wrong, and because this way it can be run and tested
// on its own.
//
// Who reads which file:
//   package.json          → vite.config.ts's buildStamp(), i.e. the About
//                           dialog, and scripts/export-release.ps1's VERSION.txt
//   package-lock.json     → nothing at runtime, but it carries a copy of the
//                           root version and drifting from package.json is
//                           needless confusion
//   tauri.conf.json       → the bundle/installer version
//
// Cargo.toml and Cargo.lock are deliberately NOT touched: the bundle version
// comes from tauri.conf.json and nothing in src-tauri/src reads
// CARGO_PKG_VERSION, so bumping them would drag the lock along for a number
// nobody can see.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`usage: node scripts/stamp-version.mjs <x.y.z>   (got: ${version ?? "nothing"})`);
  process.exit(1);
}

// Relative to this file, not the cwd — the caller's working directory is not
// this script's business.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The npm files round-trip through JSON cleanly: npm already writes the same
// two-space form, so re-serialising them changes only the version lines.
for (const name of ["package.json", "package-lock.json"]) {
  const path = join(root, name);
  const json = JSON.parse(readFileSync(path, "utf8"));
  json.version = version;
  // npm keeps a second copy of the root version under packages[""].
  if (json.packages?.[""] !== undefined) json.packages[""].version = version;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${name} -> ${version}`);
}

// tauri.conf.json is hand-formatted — it holds single-line arrays (nsis
// languages, deb depends) that JSON.stringify would explode across a dozen
// lines. Since this file is committed back now, rewrite the version line and
// leave every other byte alone. `m` anchors to a line start, so the first match
// is the top-level key rather than anything nested.
{
  const path = join(root, "src-tauri", "tauri.conf.json");
  const before = readFileSync(path, "utf8");
  const after = before.replace(
    /^(\s*"version"\s*:\s*)"[^"]*"/m,
    (_match, key) => `${key}"${version}"`,
  );
  if (after === before) {
    console.error("tauri.conf.json: no top-level \"version\" key to stamp");
    process.exit(1);
  }
  writeFileSync(path, after);
  console.log(`src-tauri/tauri.conf.json -> ${version}`);
}
