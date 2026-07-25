# Game Asset Browser

A fast, dark‑mode desktop browser for game asset libraries — **audio, textures, 3D models,
and documents in one place**, with instant preview and without opening a game engine. Built
for big packs (Synty, ambientCG / freestylized, Megascans, HDRIs, Kenney, SFX libraries)
where your file explorer gives up and the engine importer is too slow to browse.

<p align="center">
  <img src="docs/textures.png" alt="Texture grid with material grouping and a live 3D material preview" width="920">
</p>

One library, four lenses. The sidebar folder tree, collections, search, and filters are
shared; each tab (Audio, Textures, Models, Documents) adds the preview and facets that make
sense for that kind, and an **All** tab shows every kind at once. Scanning streams in
batches, decoding happens natively in Rust, and everything you filter or sort is derived
in-memory — 20k+ file libraries stay smooth.

---

## Features

### Shared across every tab
- **Recursive multi‑root scanning**, streamed in batches so large libraries fill in
  progressively and stay responsive.
- **Folder tree** with live per‑folder counts — click any subfolder to scope the view to
  that subtree, ctrl‑click to combine folders, hide folders you don't care about.
- **Collections, Favorites & Recent** — usable both as folder‑like scopes ("show me all my
  favourites") and as filters that narrow the current view.
- **Rich filtering** — instant text search, sortable columns, and per‑kind facets (format,
  size, date, and more below), all with live result counts.
- **Duplicate finder** (two‑stage content hash) and a **library stats** overview.
- **Native drag‑out** to Explorer / DAWs / engines, **drop a folder in** to add a root,
  **copy image to clipboard**, and **"Open with…"** your own external tools.
- **Persistent, portable‑aware settings** with import/export, custom window chrome, and a
  cohesive dark theme.
- **About dialog** (settings menu) with the exact version, commit, and build date, plus the
  full third‑party attributions embedded in the app itself.

### Audio
<p align="center">
  <img src="docs/audio.png" alt="Audio browser: file list, folder tree, and waveform player" width="920">
</p>

- Instant native playback (Rust `rodio` + `symphonia`): `wav`, `mp3`, `flac`, `ogg`,
  `aiff`, `m4a` — click or arrow‑key through files and hear them immediately.
- **Waveform** with click‑to‑seek playhead, plus an on‑demand **spectrogram**.
- Transport with play/pause, loop, volume, **playback speed**, **auto‑advance**, and
  **shuffle**.
- Facets for **duration**, **sample rate**, and **channel layout**.

### Textures & materials
- GPU‑accelerated thumbnail grid, decoding `png` `jpg` `bmp` `tga` `dds` `tif` `exr` `hdr`
  `gif` `webp` natively.
- **Layered art** — `psd`/`psb`, Krita `kra`, and Aseprite `ase`/`aseprite` render from
  their composite, and Krita/Aseprite additionally expose the **layer tree, frames, and
  tags**, so you can toggle layers and step animation frames without opening the editor.
- **Camera RAW** — `cr2` `cr3` `nef` `arw` `dng` `raf` `orf` `rw2` and friends, decoded
  from the embedded preview each file carries (fast, and no demosaic pipeline to maintain).
- Affinity `afphoto` / `afdesign` / `afpub` show their embedded preview image. Read‑only
  and unaffiliated with Serif — the layer data in current Affinity versions is not
  documented, so only the preview is available.
- **Material grouping**: loose PBR maps (`Rock_D` + `Rock_N` + `Rock_ORM`…) collapse into a
  single material, with channel roles resolved **per group** (base color, normal,
  roughness, metallic, AO, height, …).
- **2D & 3D preview** — inspect a texture flat, or on a plane / sphere / cube / environment
  with lighting, relief, and tiling controls; **HDR/EXR** environments supported.
- Facets for **color**, **resolution**, **shape** (square, power‑of‑two), and **channel**,
  plus a manual **atlas picker** for packs where the base‑color map can't be inferred.

### Models
<p align="center">
  <img src="docs/models.png" alt="Model grid with rendered thumbnails and a live three.js viewport" width="920">
</p>

- three.js viewport for **glTF/GLB, FBX, OBJ, DAE, 3DS, STL, PLY** — rendered thumbnails in
  the grid and a live **orbit / pan / zoom** preview with lighting presets.
- Geometry inspector: triangles, vertices, meshes, materials, and file size at a glance.

### Documents
- Reference material lives with the art it belongs to: **PDF**, Markdown, and plain text,
  plus **ebooks** (`epub`, `mobi`, `azw3`, `fb2`) and **comics** (`cbz`).
- Paged or scrolling PDF layout, adjustable reading width and text settings for reflowable
  formats, and your place is kept when you change them.

---

## Platforms

Windows is the primary, most‑tested target (WebView2). **macOS (WKWebView)** and
**Linux (webkit2gtk)** are supported for the core experience — browsing, filtering, and all
three preview types — via platform‑aware asset serving. A few niceties (reveal‑in‑file‑
manager on Linux, some external‑app conveniences) are still being finished.

---

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

### Releasing

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
In CI the same variables come from repository secrets.

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

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| ↑ / ↓ | Move selection (by row in a grid); auto‑plays on the Audio tab |
| ← / → | Seek ∓2 s in the audio list · move one cell in a grid |
| Space | Play / pause (Audio) · open the fullscreen preview (Textures / Models) |
| Enter | Replay the current audio file |
| L | Toggle loop |
| F | Toggle favorite (the whole selection when the focused item is part of it) |
| Ctrl + 1 / 2 / 3 | Switch to Audio / Textures / Models |
| Ctrl + A | Select all visible · Escape collapses a multi‑selection |
| F11 | Toggle window fullscreen |

## How it works

- **Tauri 2** (Rust backend) + **React / TypeScript** (Vite) frontend + **three.js** for
  3D. `src-tauri/src/types.rs` and `src/types.ts` are a pinned IPC contract — keep them
  mirrored.
- **Native decode, zero‑copy serve.** Audio plays on a dedicated Rust thread that owns the
  `rodio` output stream; textures and models are decoded in Rust and handed to the webview
  over custom URI schemes (`thumb://`, `tex://`, `model://`, `preview://`) — thumbnails and
  raw RGBA never round‑trip as JSON.
- **Streamed scans, in‑memory views.** Scans arrive as batched events; durations,
  dimensions, and thumbnails are probed lazily by capped worker pools. Filtering, sorting,
  the folder tree, and facet counts are all derived in the frontend from the in‑memory file
  list — no IPC round‑trips while you type or click.

## License

Source‑available under the [Game Asset Browser License 1.0.0](LICENSE.md) — source‑available,
not open source:

- **Use it for any purpose, including commercially.** Hobby, freelance, and studio production
  are all permitted, for individuals and companies alike. There is no separate commercial
  license to buy.
- **Build it yourself and modify it** to suit your needs.
- **Everything you make with it is yours** — the license reaches the software only, never your
  artwork, audio, models, or documents.
- **You may not redistribute or resell it**, modified or not, free or paid.

Ready‑to‑run builds are sold; building from source is a permitted alternative, not a
loophole.

Third‑party components are listed with their licenses in
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md). Every dependency is permissively
licensed (MIT / Apache‑2.0 / BSD / ISC / Zlib / MPL‑2.0); nothing in the tree is GPL, AGPL,
or otherwise restricts commercial distribution. The MPL‑2.0 components (the symphonia audio
decoders and the cssparser family) are used unmodified, so pointing at their upstream source
is all MPL §3.2 asks for.
