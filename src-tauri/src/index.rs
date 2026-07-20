//! Persistent library index — the "instant startup" path.
//!
//! After every completed disk walk the scanner serializes the file list
//! (path, size, mtime) plus the roots it walked to ONE json file in the app
//! data dir. The next `start_scan` over the same roots streams that list to
//! the frontend immediately — the UI is populated in milliseconds — while the
//! real walk re-runs in the background and only re-streams (under a new
//! generation) if the disk actually changed.
//!
//! Deliberately dumb format: serde_json of `(path, size, mtime)` tuples with a
//! version stamp. Any parse failure, version mismatch, or roots mismatch just
//! means "no index" — the scan falls back to a cold walk and rewrites it.
//! Never migrated, never repaired.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::portable::DataHome;
use crate::types::FileEntry;

/// Bump when the on-disk shape changes. A mismatch is not an error — the old
/// file is simply ignored and overwritten after the next completed walk.
const FORMAT_VERSION: u32 = 1;
const FILE_NAME: &str = "library-index.json";

/// `(path, size bytes, mtime unix secs)` — everything a `FileEntry` carries
/// that can't be re-derived from the path itself (id/name/ext/kind can).
type IndexedFile = (String, u64, i64);

#[derive(Serialize, Deserialize)]
struct IndexFile {
    version: u32,
    /// The roots this index was walked from. Compared order-insensitively
    /// against the requested roots — same set, same index; any difference
    /// invalidates it wholesale (partial reuse would need per-root bookkeeping
    /// for no real win: adding a root is rare, editing files is not).
    roots: Vec<String>,
    files: Vec<IndexedFile>,
}

/// Where the index lives: next to settings.json in the resolved data home
/// (portable-aware). `try_state` because scans can only start after `setup()`
/// managed `DataHome`, but a missing state must degrade to "no index", never
/// panic.
fn index_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.try_state::<DataHome>()?.dir().join(FILE_NAME))
}

/// Load the persisted index iff it is valid and was built from exactly the
/// requested roots. Returns the stored `(path, size, mtime)` list.
pub fn load_matching(app: &AppHandle, roots: &[String]) -> Option<Vec<IndexedFile>> {
    let path = index_path(app)?;
    let bytes = std::fs::read(&path).ok()?;
    let doc: IndexFile = serde_json::from_slice(&bytes).ok()?;
    if doc.version != FORMAT_VERSION {
        return None;
    }
    let mut a = doc.roots.clone();
    let mut b = roots.to_vec();
    a.sort_unstable();
    b.sort_unstable();
    if a != b {
        return None;
    }
    Some(doc.files)
}

/// Persist the completed walk. Atomic: write a sibling temp file, then rename
/// over the old index (std's rename replaces on Windows), so a crash mid-write
/// can never leave a torn file that half-parses.
pub fn save(app: &AppHandle, roots: &[String], files: &[FileEntry]) {
    let Some(path) = index_path(app) else {
        return;
    };
    let doc = IndexFile {
        version: FORMAT_VERSION,
        roots: roots.to_vec(),
        files: files
            .iter()
            .map(|f| (f.path.clone(), f.size, f.modified))
            .collect(),
    };
    let json = match serde_json::to_vec(&doc) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[index] serialize failed: {e}");
            return;
        }
    };
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, &json) {
        eprintln!("[index] write {} failed: {e}", tmp.display());
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        eprintln!("[index] rename to {} failed: {e}", path.display());
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Change detector for the verify pass: count + order-independent hash over
/// `(path, size, mtime)`. Compared between the index-SERVED entry list and the
/// fresh walk — not the raw stored tuples — so a classification change (e.g. a
/// new doc-image marker dropping a file) also reads as "different" and
/// triggers the corrective re-stream.
pub fn fingerprint(files: &[FileEntry]) -> (usize, u64) {
    let mut refs: Vec<&FileEntry> = files.iter().collect();
    refs.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    let mut h = DefaultHasher::new();
    for f in refs {
        f.path.hash(&mut h);
        f.size.hash(&mut h);
        f.modified.hash(&mut h);
    }
    (files.len(), h.finish())
}
