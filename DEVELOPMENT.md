# Development

Build, architecture, and release notes for Game Asset Browser. For what the app actually
does, see the [README](README.md).

## Getting started

Prerequisites: **Node 20+** and **Rust (stable)**, plus your platform's Tauri toolchain:

- **Windows** — Visual Studio Build Tools with the C++ workload; WebView2 (bundled on
  Windows 11).
- **macOS** — Xcode Command Line Tools (`xcode-select --install`).
- **Linux** — `webkit2gtk-4.1` and the usual build deps, e.g. on Ubuntu:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf
  ```

Then:

```bash
npm install
npm run tauri dev      # run the app with hot reload
npm run tauri build    # produce a release build + installer for the current OS
```

Tauri can't cross‑compile — build each OS on that OS (or in CI, one runner per target).
On Windows, `npm run export` also drops a standalone, portable `GameAssetBrowser.exe` into
`export/`, alongside the license and attribution files.

Checks before committing — the same gate CI runs before it spends three platform builds:

```bash
npm run build          # tsc + vite build
npm test               # vitest run
cargo check            # from src-tauri/, for the Rust side
```

## How it works

- **Tauri 2** (Rust backend) + **React / TypeScript** (Vite) frontend + **three.js** for
  3D. `src-tauri/src/types.rs` and `src/types.ts` are a pinned IPC contract — keep them
  mirrored.
- **Native decode, zero‑copy serve.** Audio plays on a dedicated Rust thread that owns the
  `rodio` output stream; textures, models, layered art, and documents are decoded in Rust
  and handed to the webview over custom URI schemes (`thumb://`, `tex://`, `model://`,
  `preview://`, `cels://`, `doc://`) — thumbnails and raw RGBA never round‑trip as JSON.
  On Windows these resolve as `http://<scheme>.localhost`; see `schemeBase` for the
  per‑platform form.
- **One canvas for the whole grid.** Thumbnails upload into a WebGL2 texture array and draw
  as a single instanced call behind the cells, which stay ordinary DOM so selection, badges,
  and chrome keep working. Alignment is re‑measured from the DOM every frame, so the canvas
  can't drift from the cells it paints behind.
- **Streamed scans, in‑memory views.** Scans arrive as batched events; durations,
  dimensions, and thumbnails are probed lazily by capped worker pools. Filtering, sorting,
  the folder tree, and facet counts are all derived in the frontend from the in‑memory file
  list — no IPC round‑trips while you type or click.
- **Theming is CSS custom properties on `:root`.** `src/stores/theme.ts` writes a per‑theme
  set plus a mode‑scoped set (`LIGHT_MODE` / `DARK_MODE`) for the tokens that have to flip
  between light and dark, and Tailwind's `@theme` block in `src/styles.css` declares the
  defaults those override. Canvas and WebGL surfaces read the same vars through
  `getComputedStyle` at draw‑setup time, since a canvas holds pixels rather than live
  `var()` references.

## Releasing

| Command | What it does |
| --- | --- |
| `npm run licenses` | Regenerate `THIRD-PARTY-LICENSES.md` from the cargo + npm trees |
| `npm run licenses:check` | Fail if that file is out of date (used by CI) |
| `npm run export` | Portable single‑exe build (regenerates attributions, signs if configured) |
| `npm run release` | Full installer build (MSI + NSIS), signed if configured |

**CI.** `.github/workflows/release.yml` is a manual `workflow_dispatch` release to itch.io
(`kniti/gab`). It computes the next patch version from the latest `vX.Y.Z` tag, runs a cheap
typecheck + unit‑test gate before spending three platform builds, builds Windows / macOS
(universal) / Linux, verifies the attribution file is current, uploads via `butler`, and
tags the released version. Without a `BUTLER_API_KEY` secret it still builds — it just skips
the upload and the tag.

The release version is stamped into **both** `tauri.conf.json` (the installer's version) and
`package.json` (the build stamp the About dialog shows), so the two can't disagree.

**Code signing.** Unsigned Windows binaries trip SmartScreen, and Smart App Control blocks
them outright (the `os error 4551` noted in `src-tauri/Cargo.toml`). `src-tauri/tauri.windows.conf.json`
is merged automatically into every Windows build and points Tauri's `signCommand` at
`scripts/sign.ps1`, which is driven entirely by environment variables — an unconfigured
machine still builds, it just builds unsigned and says so. Set `GAB_SIGN_METHOD` to
`trustedsigning` (Azure Trusted Signing — cheapest sane option for a solo dev, no hardware
token), `signtool` (an OV/EV cert on a token or in the cert store), or `custom` (any other
cloud‑HSM provider); see the header of `scripts/sign.ps1` for the variables each one needs.
In CI the same variables come from repository secrets, and `trustedsigning` additionally
installs Microsoft's `sign` dotnet tool on the runner. Tauri throws away the sign command's
output — a failure shows up only as ``failed to bundle project: `failed to run powershell` `` —
so `sign.ps1` mirrors every run to `sign.log` in the repo root, which the release workflow
prints when a Windows build fails.

**Installers.** NSIS installs **per‑user** (`installMode: currentUser`) so there is no UAC
prompt — an admin elevation on first run costs more conversions than a per‑machine install
is worth. English and German, no language picker.

**Attributions.** Generated, not hand‑written — rerun `npm run licenses` whenever
dependencies change. It emits three artifacts:

| Artifact | Size | Consumer |
| --- | --- | --- |
| `THIRD-PARTY-LICENSES.md` | ~2.1 MB | Humans / compliance review; bundled + shipped beside the portable exe |
| `src/generated/thirdParty.json` | ~52 KB | The About dialog's component list |
| `src/generated/thirdPartyTexts.json` | ~2.1 MB | Individual license texts, fetched only on expand |

The generator detects the workspace's own crates structurally (a `Cargo.lock` entry with no
`source` is local), so adding another path crate needs no edit, and it fails loudly on any
dependency with a copyleft, noncommercial, or missing license. The notices ship embedded in
the binary (Settings → **About** → *Third-party licenses*), as a bundled installer resource,
and as a file beside the portable exe.
