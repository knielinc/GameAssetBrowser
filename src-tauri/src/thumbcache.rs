//! In-memory thumbnail cache — NOTHING is written to disk.
//!
//! Thumbnails live only in RAM for the session. Re-scrolling to a cell that was
//! already decoded is instant (served from this map); across launches the cache
//! starts empty and thumbnails re-decode as they come into view. That is the
//! deliberate cost of leaving the user's hard drive untouched.
//!
//! Bounded by an LRU so a huge browse session cannot grow RAM without limit;
//! an evicted thumbnail simply re-decodes if scrolled back to.

use std::num::NonZeroUsize;

use lru::LruCache;
use parking_lot::Mutex;

/// Max thumbnails held in RAM. A 256px PNG is ~10-20 KB, so this caps the store
/// at roughly 80-160 MB — comfortable for a desktop tool, and large enough that
/// ordinary browsing never churns.
const CAP: usize = 8192;

pub struct ThumbCache {
    map: Mutex<LruCache<u64, Vec<u8>>>,
}

impl ThumbCache {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(LruCache::new(NonZeroUsize::new(CAP).unwrap())),
        }
    }

    pub fn contains(&self, key: u64) -> bool {
        self.map.lock().contains(&key)
    }

    pub fn get(&self, key: u64) -> Option<Vec<u8>> {
        // `get` promotes the entry to most-recently-used, so hot thumbnails
        // survive eviction.
        self.map.lock().get(&key).cloned()
    }

    /// Infallible — the signature keeps a `Result` only so call sites written
    /// against the old file-backed store need no change.
    pub fn put(&self, key: u64, bytes: &[u8]) -> std::io::Result<()> {
        self.map.lock().put(key, bytes.to_vec());
        Ok(())
    }
}

impl Default for ThumbCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse the 16-hex-char external key (as used in `thumb://<key>` and by the
/// frontend's derived-key path) back into the u64 the store is keyed by.
pub fn parse_key(hex: &str) -> Option<u64> {
    if hex.len() != 16 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(hex, 16).ok()
}

/// One-time cleanup of any on-disk cache a previous build left behind: the
/// legacy `thumbs/` directory of loose PNGs AND the single-file `thumbs.cache`.
/// We keep nothing on disk now, so remove both.
pub fn remove_legacy_dir(data_home: &std::path::Path) {
    let dir = data_home.join("thumbs");
    if dir.is_dir() {
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            eprintln!("[thumbs] could not remove legacy dir {}: {e}", dir.display());
        }
    }
    let blob = data_home.join("thumbs.cache");
    if blob.is_file() {
        if let Err(e) = std::fs::remove_file(&blob) {
            eprintln!("[thumbs] could not remove {}: {e}", blob.display());
        }
    }
}
