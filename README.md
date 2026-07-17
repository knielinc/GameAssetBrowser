# SoundPreviewer

A sleek dark-mode audio sample previewer for Windows — a faster, prettier take on Pulp.

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
