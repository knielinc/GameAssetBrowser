//! In-memory thumbnail cache — NOTHING is written to disk.
//!
//! Stores DECODED RGBA, not PNG. That is the point of the WebGL grid: the
//! pixels reach the GPU without a PNG encode (Rust) + decode (browser) round
//! trip. The grid fetches raw RGBA over the `tex://` scheme and uploads it
//! straight into a texture atlas.
//!
//! Bounded by a BYTE budget (RGBA is ~17x larger than PNG), with LRU eviction;
//! an evicted thumbnail re-decodes from its source if scrolled back to. Nothing
//! persists across launches — that is the deliberate cost of leaving the user's
//! hard drive untouched.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::types::ThumbInfo;

/// RAM budget for decoded thumbnails. RGBA at 256px is ~256 KB each, so this
/// holds ~1500 thumbnails — comfortably more than any on-screen working set,
/// and enough that ordinary browsing rarely re-decodes.
const BUDGET_BYTES: usize = 384 * 1024 * 1024;

/// A decoded thumbnail: tightly-packed RGBA8, `width * height * 4` bytes.
#[derive(Clone)]
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    /// Per-image stats computed once at decode time (the source dimensions live
    /// here as source_width/height). Stored so a cache hit returns them directly
    /// instead of re-running the per-pixel analyze().
    pub info: ThumbInfo,
}

impl Pixels {
    fn bytes(&self) -> usize {
        self.rgba.len() + 16
    }
}

pub struct ThumbCache {
    inner: Mutex<Inner>,
}

struct Inner {
    /// key -> pixels, held behind an `Arc` so `get`/`tex_bytes` hand out a
    /// cheap refcount bump instead of memcpying a 256 KB+ buffer while the
    /// mutex is held (the decode threads want that lock during scroll).
    map: HashMap<u64, Arc<Pixels>>,
    /// Keys oldest-first. `get` moves the key to the back (most-recent).
    order: Vec<u64>,
    used: usize,
}

impl ThumbCache {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                map: HashMap::new(),
                order: Vec::new(),
                used: 0,
            }),
        }
    }

    pub fn contains(&self, key: u64) -> bool {
        self.inner.lock().map.contains_key(&key)
    }

    pub fn get(&self, key: u64) -> Option<Arc<Pixels>> {
        let mut g = self.inner.lock();
        // Clone the Arc (cheap) and drop the map borrow before touching `order`.
        let px = g.map.get(&key)?.clone();
        // promote to most-recently-used
        if let Some(pos) = g.order.iter().position(|k| *k == key) {
            g.order.remove(pos);
            g.order.push(key);
        }
        Some(px)
    }

    pub fn put(&self, key: u64, pixels: Pixels) {
        let mut g = self.inner.lock();
        let add = pixels.bytes();
        if let Some(old) = g.map.remove(&key) {
            g.used -= old.bytes();
            if let Some(pos) = g.order.iter().position(|k| *k == key) {
                g.order.remove(pos);
            }
        }
        // Evict oldest until the newcomer fits.
        while g.used + add > BUDGET_BYTES && !g.order.is_empty() {
            let victim = g.order.remove(0);
            if let Some(p) = g.map.remove(&victim) {
                g.used -= p.bytes();
            }
        }
        g.used += add;
        g.map.insert(key, Arc::new(pixels));
        g.order.push(key);
    }

    /// Encode a cached thumbnail to PNG on demand, for every `<img>`/three.js
    /// consumer — which since the grid moved off the WebGL overlay is the MAIN
    /// thumbnail path, not a rare one.
    ///
    /// Still encoded per request, not cached: the webview's in-page image
    /// memory cache serves a remounted `<img>` with a known URL without hitting
    /// this scheme at all (measured: a remount is ~0.5 ms with zero resource
    /// entries), so each key reaches us roughly once per session and a byte
    /// cache would hold ~nothing but misses.
    ///
    /// Fast compression + adaptive filtering, not the encoder default: measured
    /// on real 256px thumbnails it is ~30% faster (0.20 vs 0.29 ms) at the SAME
    /// average output size (21.4 KB) — adaptive filtering is what carries PNG
    /// compression at this size, so the cheaper deflate costs nothing.
    pub fn get_png(&self, key: u64) -> Option<Vec<u8>> {
        use image::codecs::png::{CompressionType, FilterType, PngEncoder};
        use image::ImageEncoder;
        let p = self.get(key)?;
        let mut out = Vec::new();
        // Encodes straight from the borrowed pixels — no 256 KB clone.
        PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive)
            .write_image(&p.rgba, p.width, p.height, image::ExtendedColorType::Rgba8)
            .ok()?;
        Some(out)
    }
}

impl Default for ThumbCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse the 16-hex-char external key (as used in `tex://<key>` / `thumb://<key>`
/// and by the frontend's derived-key path) back into the u64 the store uses.
pub fn parse_key(hex: &str) -> Option<u64> {
    if hex.len() != 16 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(hex, 16).ok()
}

/// One-time cleanup of any on-disk cache a previous build left behind: the
/// legacy `thumbs/` directory of loose PNGs, the single-file `thumbs.cache`, and
/// the `model-thumbs/` directory (model thumbnails were briefly persisted; they
/// are RAM-only again now). We keep nothing on disk, so remove all of them.
pub fn remove_legacy_dir(data_home: &std::path::Path) {
    for name in ["thumbs", "model-thumbs"] {
        let dir = data_home.join(name);
        if dir.is_dir() {
            if let Err(e) = std::fs::remove_dir_all(&dir) {
                eprintln!("[thumbs] could not remove legacy dir {}: {e}", dir.display());
            }
        }
    }
    let blob = data_home.join("thumbs.cache");
    if blob.is_file() {
        if let Err(e) = std::fs::remove_file(&blob) {
            eprintln!("[thumbs] could not remove {}: {e}", blob.display());
        }
    }
}
