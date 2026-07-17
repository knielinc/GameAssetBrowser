//! One-file thumbnail cache.
//!
//! Thumbnails used to be thousands of loose `<hash>.png` files under the data
//! home — tidy for the code, but clutter on the user's disk. This replaces all
//! of them with a SINGLE append-only blob, `thumbs.cache`, plus an in-memory
//! index mapping key -> (offset, len). Payloads are read on demand, so memory
//! stays flat no matter how large the cache grows, and the data folder holds
//! one file instead of a directory full of images.
//!
//! Record layout: `[u64 key LE][u32 len LE][len payload bytes]`, repeated.
//! Last write for a key wins (a re-decoded texture supersedes the old bytes,
//! which become dead weight until compaction reclaims them).

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use parking_lot::Mutex;

const HEADER: u64 = 12; // u64 key + u32 len

pub struct ThumbCache {
    inner: Mutex<Inner>,
    path: PathBuf,
}

struct Inner {
    file: File,
    /// key -> (payload offset, payload len). Only LIVE entries.
    index: HashMap<u64, (u64, u32)>,
    /// Bytes occupied by superseded records, for the compaction decision.
    dead: u64,
}

impl ThumbCache {
    /// Open (or create) the cache and rebuild its index. Compacts up front if
    /// the file is mostly dead weight — cheap because it only runs when the
    /// cache is genuinely bloated, and single-threaded here at startup.
    pub fn open(path: PathBuf) -> std::io::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&path)?;
        let (index, dead) = build_index(&mut file)?;
        let cache = Self {
            inner: Mutex::new(Inner { file, index, dead }),
            path,
        };
        cache.compact_if_bloated(512 * 1024 * 1024);
        Ok(cache)
    }

    pub fn contains(&self, key: u64) -> bool {
        self.inner.lock().index.contains_key(&key)
    }

    pub fn get(&self, key: u64) -> Option<Vec<u8>> {
        let mut g = self.inner.lock();
        let (off, len) = *g.index.get(&key)?;
        let mut buf = vec![0u8; len as usize];
        g.file.seek(SeekFrom::Start(off)).ok()?;
        g.file.read_exact(&mut buf).ok()?;
        Some(buf)
    }

    pub fn put(&self, key: u64, bytes: &[u8]) -> std::io::Result<()> {
        let mut g = self.inner.lock();
        let rec_start = g.file.seek(SeekFrom::End(0))?;
        let mut rec = Vec::with_capacity(HEADER as usize + bytes.len());
        rec.extend_from_slice(&key.to_le_bytes());
        rec.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        rec.extend_from_slice(bytes);
        g.file.write_all(&rec)?;
        let payload_off = rec_start + HEADER;
        if let Some((_, old_len)) = g.index.insert(key, (payload_off, bytes.len() as u32)) {
            g.dead += HEADER + old_len as u64;
        }
        Ok(())
    }

    /// Rewrite keeping only live entries when dead weight dominates or the file
    /// exceeds `cap`. When over `cap` even after dropping dead bytes, keep the
    /// most recent entries (highest offset ≈ most recently written) up to the
    /// cap — a crude but effective bound with no age tracking.
    fn compact_if_bloated(&self, cap: u64) {
        let mut g = self.inner.lock();
        let file_len = match g.file.seek(SeekFrom::End(0)) {
            Ok(n) => n,
            Err(_) => return,
        };
        let live_bytes: u64 = g.index.values().map(|(_, l)| HEADER + *l as u64).sum();
        if file_len <= cap && g.dead <= file_len / 2 {
            return; // healthy enough
        }

        // Live entries, newest first (offset order).
        let mut live: Vec<(u64, u64, u32)> =
            g.index.iter().map(|(k, (o, l))| (*k, *o, *l)).collect();
        live.sort_by(|a, b| b.1.cmp(&a.1));

        let tmp = self.path.with_extension("cache.tmp");
        let Ok(mut out) = File::create(&tmp) else { return };
        let mut new_index: HashMap<u64, (u64, u32)> = HashMap::new();
        let mut written: u64 = 0;
        let _ = live_bytes;

        for (key, off, len) in live {
            if written + HEADER + len as u64 > cap {
                break; // bound reached — drop the oldest remainder
            }
            let mut payload = vec![0u8; len as usize];
            if g.file.seek(SeekFrom::Start(off)).is_err()
                || g.file.read_exact(&mut payload).is_err()
            {
                continue;
            }
            let rec_start = written;
            if out.write_all(&key.to_le_bytes()).is_err()
                || out.write_all(&len.to_le_bytes()).is_err()
                || out.write_all(&payload).is_err()
            {
                let _ = std::fs::remove_file(&tmp);
                return;
            }
            new_index.insert(key, (rec_start + HEADER, len));
            written += HEADER + len as u64;
        }
        drop(out);

        // Swap the compacted file in. On any failure, keep the original.
        let reopened = (|| -> std::io::Result<File> {
            std::fs::rename(&tmp, &self.path)?;
            OpenOptions::new().read(true).write(true).open(&self.path)
        })();
        if let Ok(f) = reopened {
            g.file = f;
            g.index = new_index;
            g.dead = 0;
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// Scan the blob once, indexing every record. Reads only the 12-byte headers
/// (seeks past each payload), so startup is fast even for a large cache. A
/// truncated tail from an interrupted write stops the scan cleanly — earlier
/// records stay valid.
fn build_index(file: &mut File) -> std::io::Result<(HashMap<u64, (u64, u32)>, u64)> {
    let end = file.seek(SeekFrom::End(0))?;
    file.seek(SeekFrom::Start(0))?;
    let mut index: HashMap<u64, (u64, u32)> = HashMap::new();
    let mut dead: u64 = 0;
    let mut pos: u64 = 0;
    let mut hdr = [0u8; HEADER as usize];
    while pos + HEADER <= end {
        if file.read_exact(&mut hdr).is_err() {
            break;
        }
        let key = u64::from_le_bytes(hdr[0..8].try_into().unwrap());
        let len = u32::from_le_bytes(hdr[8..12].try_into().unwrap());
        let payload_off = pos + HEADER;
        if payload_off + len as u64 > end {
            break; // truncated final record
        }
        if let Some((_, old)) = index.insert(key, (payload_off, len)) {
            dead += HEADER + old as u64;
        }
        pos = payload_off + len as u64;
        file.seek(SeekFrom::Start(pos))?;
    }
    Ok((index, dead))
}

/// Parse the 16-hex-char external key (as used in `thumb://<key>` and by the
/// frontend's derived-key path) back into the u64 the store is keyed by.
pub fn parse_key(hex: &str) -> Option<u64> {
    if hex.len() != 16 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(hex, 16).ok()
}

/// One-time cleanup: delete the legacy `thumbs/` directory of loose PNGs.
pub fn remove_legacy_dir(data_home: &Path) {
    let legacy = data_home.join("thumbs");
    if legacy.is_dir() {
        if let Err(e) = std::fs::remove_dir_all(&legacy) {
            eprintln!("[thumbs] could not remove legacy dir {}: {e}", legacy.display());
        }
    }
}
