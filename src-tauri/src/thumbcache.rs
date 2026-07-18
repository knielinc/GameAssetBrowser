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
use std::io::Cursor;

use parking_lot::Mutex;

/// RAM budget for decoded thumbnails. RGBA at 256px is ~256 KB each, so this
/// holds ~1500 thumbnails — comfortably more than any on-screen working set,
/// and enough that ordinary browsing rarely re-decodes.
const BUDGET_BYTES: usize = 384 * 1024 * 1024;

/// A decoded thumbnail: tightly-packed RGBA8, `width * height * 4` bytes.
#[derive(Clone)]
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    /// Source image dimensions before downscale — kept so a cache hit can still
    /// report the real resolution without re-touching the original file.
    pub src_w: u32,
    pub src_h: u32,
    pub rgba: Vec<u8>,
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
    /// key -> pixels. Insertion order in `order` drives LRU eviction.
    map: HashMap<u64, Pixels>,
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

    pub fn get(&self, key: u64) -> Option<Pixels> {
        let mut g = self.inner.lock();
        if !g.map.contains_key(&key) {
            return None;
        }
        // promote to most-recently-used
        if let Some(pos) = g.order.iter().position(|k| *k == key) {
            g.order.remove(pos);
            g.order.push(key);
        }
        g.map.get(&key).cloned()
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
        g.map.insert(key, pixels);
        g.order.push(key);
    }

    /// Encode a cached thumbnail to PNG on demand, for the handful of surfaces
    /// that still consume an `<img>`/three.js texture (fullscreen, inspector
    /// preview, map swatches). The grid never calls this — it takes RGBA
    /// directly. Rare enough that the encode is not worth caching.
    pub fn get_png(&self, key: u64) -> Option<Vec<u8>> {
        let p = self.get(key)?;
        let buf = image::RgbaImage::from_raw(p.width, p.height, p.rgba)?;
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(buf)
            .write_to(&mut out, image::ImageFormat::Png)
            .ok()?;
        Some(out.into_inner())
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
