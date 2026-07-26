# Native UI spike — egui + wgpu

A measurement rig, not a port and not a product. It exists to answer whether a
native UI beats the webview for Game Asset Browser, with numbers instead of
argument. Gitignored on `main` (see the repo `.gitignore`); if it earns its keep
it moves to a branch of its own.

## Why this shape

The earlier GPUI attempt stalled on macOS: GPUI's mac backend is Metal
(`gpui_macos`), not the cross-platform `gpui_wgpu` path, so there was no way to
render our own GPU content into the toolkit's surface. `egui_wgpu` exposes that
through `CallbackTrait` on every platform wgpu supports — `src/material.rs` is
the proof, and `src/headless.rs` runs the same draw with no window so a CI
runner can confirm it on mac.

Godot and SDL/C++ were considered and rejected: neither addresses that blocker
(it was toolkit architecture, not language), and both would strand the ~7.4k
lines of Rust decoders in `src-tauri` behind FFI.

## What it reuses

Nothing in `src-tauri/` is modified. The spike depends on two standalone path
crates that were already split out of the shipping tree:

- `exrthumb` — bounded, downsampling EXR decode (`image::open` would materialize
  a 67 MP float image and OOM)
- `psdcomp` — reads a PSD composite by seeking past the layer section

`src/decode.rs` mirrors the dispatch in `src-tauri/src/thumbs.rs` so the grid is
measuring the UI toolkit and not a different decode path. Camera RAW, Krita,
Aseprite and Affinity are deliberately left out — they add decoder crates without
telling us anything new.

The `[profile.dev.package.*]` overrides in `Cargo.toml` are copied from the
shipping manifest for the reason recorded there: at opt-level 0 the mean texture
decode is 964 ms versus 34.6 ms, 27.9×. Without them the grid feels broken for
reasons that have nothing to do with egui.

## Running it

```powershell
cargo run --release -- "D:\Packs\Textures"      # windowed; the path is optional
cargo run --release --bin headless -- frame.png # no window, no display needed

# Self-driving scroll benchmark: opens briefly, scrolls the grid at a fixed rate,
# prints frame statistics to stdout and exits. Removes the hand-scrolling from
# the measurement, so runs are comparable to each other.
cargo run --release -- --bench "D:\Packs\Textures"

# Synthetic library, when a real one is not to hand (understates decode cost —
# see the caveat under "Measured so far").
cargo run --release --bin genlib -- C:\temp\synthlib 20000
```

Drag in the right-hand viewport to orbit, scroll to zoom. Click a grid cell to
put that texture on the mesh.

## What to measure

Run the shipping app side by side on the same library for every comparison.

| Question | Where the number comes from |
| --- | --- |
| Custom wgpu content on macOS | `ci/spike-macos.yml` — the decisive one |
| Scroll frame time on a 20k library | bottom bar: mean / p95 / max / dropped |
| Cold start to first thumbnail | bottom bar, after passing a folder as argv |
| Release binary size | `target/release/gab-native-spike.exe` vs the 20.5 MB Tauri exe |
| Non-ASCII filenames | bottom bar reports which CJK face was found; a file named e.g. `テクスチャ.png` must not render as boxes |

Decision rule: proceed to a hybrid (native grid/viewport, `wry` window retained
for reflowable ebooks) only if the mac path works **and** scroll/startup beat the
webview by a margin worth the platform-tail debugging. Otherwise keep Tauri and
fix the webview bugs individually.

## Measured so far

Windows 11, RTX 5070 Ti Laptop (hybrid graphics), `rustc` 1.97.1, eframe/egui
0.35, wgpu 29, release profile. Grid figures are from `--bench` over a 20,000-file
synthetic library.

**Custom wgpu pass: works.** `headless` covered 129,752/262,144 px (49.5%), which
is what a unit sphere at distance 3.2 under a 45° FOV should cover — so the
geometry is right, not an accident. The saved frame shows correct UV mapping, 2×
tiling, specular and ambient. **macOS still unrun** — that is the open question.

**Scroll frame time: comfortable.** Over 900 frames of continuous scrolling:

| | mean | p95 | max | over 16.67 ms |
| --- | --- | --- | --- | --- |
| 20k files | 6.9–9.6 ms | 10.0–12.5 ms | 11.5–17.4 ms | 0.2–0.7% |

Scanning 20k files takes 33–36 ms. Eviction holds at exactly the 600-texture
budget with no errors. **Caveat: synthetic 64×64 PNGs.** Decode runs off the UI
thread, so frame time should hold on a real pack, but fill latency will be much
worse — quote scroll numbers from a real library before deciding anything.

**Cold start: ~1.0 s to first thumbnail, and it is mostly not our code.**

| | default (all backends) | `WGPU_BACKEND=vulkan` |
| --- | --- | --- |
| eframe + wgpu init | 906 ms | 718 ms |
| first frame | 951 ms | 762 ms |
| first thumbnail | 1021 ms | 1026 ms |

Headless (no window, so pure GPU-stack cost) is ~997 ms enumerating every backend
versus **445 ms** pinned to Vulkan, against a ~12 ms bare-process baseline. So
roughly half the default cost is wgpu probing backends it will not use, and a
real port should pin one per platform. Two warnings about these numbers: this is
a hybrid-graphics laptop, where adapter enumeration is unusually expensive, and a
freshly built unsigned binary pays a one-off ~650 ms Defender scan on first run —
measure warm or you will measure antivirus.

**Startup is not a clear win over the webview.** Time from launch to a window
existing, same method for both: spike 268–385 ms; the shipping Tauri app 3590 ms
cold then 85–137 ms warm. But that measures the *window*, and Tauri's window
appears before the webview has painted, so it flatters Tauri. An honest
comparison needs time-to-first-painted-content instrumented in the shipping app
too; the spike reports its own (≈1.0 s).

**Release binary: 14.29 MB** stripped with LTO, versus the shipping Tauri exe's
20.5 MB. Not a win: the spike does a grid and one viewport, while the Tauri binary
carries the whole app *plus* the bundled frontend (React, three.js, pdf.js).
Roughly 10% of the feature surface already costs 70% of the size, because wgpu +
naga + winit + egui is a large fixed floor. What it does buy is self-containment —
the 20.5 MB excludes the WebView2 runtime it depends on.

**CJK filenames: work, but only because the fallback is hardcoded.** The bench
library seeds `テクスチャ_*.png` every 1000 files; egui found
`C:\Windows\Fonts\msgothic.ttc` from the candidate list in `app.rs`. There is no
system fallback — every platform needs its own list, and any script outside it
renders as tofu.

## Known limitations (deliberate)

- **No depth buffer.** egui's render pass has none, so `material.rs` relies on
  back-face culling: the sphere is convex, and the plane is emitted twice with
  opposing winding. A real port would render to its own colour+depth target.
  This changes nothing about the question being answered.
- **Blinn-Phong, not PBR/IBL.** Enough to show normal detail and tiling. The
  shipping preview uses three.js PBR with a room environment.
- **Tone mapping is simplified** — a fixed ACES fit, where
  `src-tauri/src/tonemap.rs` is user-configurable.
- **Font fallback is one hardcoded system face.** egui does no system fallback of
  its own. This is a real cost of leaving the webview, surfaced rather than
  hidden.
- Grid only: no facets, folder tree, filtering, persistence, or other tabs.
