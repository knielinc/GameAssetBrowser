# AssetPreviewer

A sleek dark-mode game-asset previewer for Windows — built for navigating big
asset packs (Synty, ambientCG/freestylized, Megascans, HDRIs) without opening an
engine.

> **Status:** the audio previewer below is complete and is what ships today.
> Texture/material and 3D-model browsing are in progress — see *Roadmap*.
> (The project began life as SoundPreviewer, a faster, prettier take on Pulp.)

## Features

- **Recursive scanning** of any number of root folders (wav, mp3, flac, ogg, aiff, aif, m4a), streamed in batches — 20k+ file libraries stay smooth
- **Folder tree** in the sidebar: expand roots, click any subfolder to scope the list to that subtree (Pulp-style), with live per-folder counts
- **Filter & sort**: instant text search, per-format filter chips, sortable columns (name, type, size, modified, length)
- **Instant preview**: click or arrow-key through files with auto-play, Space to pause, seek bar, loop, volume — decoding happens natively in Rust (rodio + symphonia), so click-to-sound is near-instant
- **Waveform** rendering of the current file with click-to-seek playhead
- **Persistent settings**: folders, volume, loop, autoplay, sort, and filters survive restarts

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| ↓ / ↑ | Select next/previous file (auto-plays) |
| Space | Play / pause |
| Enter | Replay from start |
| L | Toggle loop |
| ← / → | Seek ∓/± 2 s |

## Roadmap

Three tabs over one library — audio keeps the list, visual assets get a grid.

| Phase | Scope |
| --- | --- |
| 1 ✅ | Rename to AssetPreviewer |
| 2 | Tab shell: `AssetKind`, per-tab store + settings, Audio unchanged |
| 3 | Scanner classifies audio / texture / model in one walk |
| 4 | Shared virtualized `AssetGrid` |
| 5 | Inspector drawer |
| 6a | Textures: Rust thumbnailer (DDS/TGA/EXR), **material grouping**, PBR preview |
| 6b | Models: three.js viewport, glTF/OBJ/FBX |

**Material grouping** is the headline: loose files that form one PBR material
(`Rock_D.png` + `Rock_N.png` + `Rock_ORM.png`) collapse into a single material.
Suffixes are resolved *per group, not per file* — `Rock_A.png` is undecidable
alone (Albedo? Alpha? AO?) but decidable next to `Rock_D.png`, because `_D` is
unambiguously Diffuse.

## Development

Prerequisites: Node 20+, Rust (stable-msvc) with VS Build Tools C++ workload.

```powershell
npm install
npm run tauri dev     # run the app with hot reload
npm run tauri build   # produce release exe + NSIS installer (src-tauri/target/release/bundle)
```

## Architecture notes

- `src-tauri/src/types.rs` and `src/types.ts` are the **pinned IPC contract** (event names, payload shapes, command signatures). Keep them mirrored — everything else builds against them.
- Audio playback lives on a dedicated Rust thread that owns the `rodio::OutputStream` (`src-tauri/src/audio/engine.rs`); commands arrive over a channel, position events stream back at 20 Hz.
- Scans stream `scan:batch` events (≤1000 entries) instead of one big payload; durations are probed lazily by a capped worker pool; waveform peaks are downsampled Rust-side (never raw PCM over IPC).
- Filtering, sorting, and the folder tree are derived in the frontend from the in-memory file list — no IPC round-trips while typing or clicking folders.
