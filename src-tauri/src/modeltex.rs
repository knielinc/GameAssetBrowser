//! Rescue textures for models whose own references are broken.
//!
//! Two real failures, both from the same Synty POLYGON pack:
//!
//! * **FBX** bakes the artist's absolute authoring path —
//!   `U:/Dropbox/SyntyStudios/PolygonNature/_Working/_Andrew/PolygonNature.png`.
//!   Worse, that basename does not exist in the shipped pack either: it ships
//!   `PolygonNature_01.png` … `_04.png`. So even an exact-basename sibling
//!   search misses. It needs fuzzy stem matching.
//! * **OBJ** ships with no `.mtl` file at all — no `mtllib` line, no material
//!   data. There is nothing to resolve, only something to guess.
//!
//! This is not our bug: Unity shows the same grey models on first import, and
//! Synty expects you to assign the pack atlas by hand. But we can do better
//! than grey, because a Synty pack is one-atlas-per-pack by construction.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

use crate::scanner::is_within_roots;
use crate::types::TEXTURE_EXTENSIONS;

/// Directories to search for the atlas, relative to the model. Ordered
/// nearest-first; Synty's layout is `Source Files/{FBX,OBJ}/` beside
/// `Source Files/Textures/`, which `../Textures` covers.
const SEARCH_DIRS: [&str; 6] = ["", "Textures", "Materials", "../Textures", "../Materials", "../../Textures"];
/// Cap the candidate list — a texture folder can hold thousands.
const MAX_CANDIDATES: usize = 64;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureHints {
    /// Image basenames the model file mentions, however broken their paths.
    pub declared: Vec<String>,
    /// Real image files found near the model, absolute paths.
    pub candidates: Vec<String>,
}

/// Image basenames referenced anywhere in the file.
///
/// A byte scan, not a parser. FBX stores paths as plain (non-compressed)
/// strings in its property records, so this finds them without walking the
/// node tree or inflating array payloads — and it works the same for ASCII
/// FBX, OBJ `mtllib`/`map_Kd` lines, and `.mtl` files. Reading 4 MB and
/// regex-free scanning is far cheaper than a real parse for a hint.
fn declared_textures(path: &Path) -> Vec<String> {
    const LIMIT: usize = 8 * 1024 * 1024;
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let slice = &bytes[..bytes.len().min(LIMIT)];
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::new();

    for ext in TEXTURE_EXTENSIONS {
        let pat = format!(".{ext}");
        let pb = pat.as_bytes();
        let mut i = 0;
        while let Some(found) = find(slice, pb, i) {
            let end = found + pb.len();
            // Walk back to the start of the filename: stop at a separator or
            // any byte that cannot be in one.
            let mut start = found;
            while start > 0 {
                let c = slice[start - 1];
                if c == b'/' || c == b'\\' || c == b':' || c < 0x20 || c == b'"' {
                    break;
                }
                start -= 1;
            }
            if end - start > 4 && end - start < 128 {
                if let Ok(name) = std::str::from_utf8(&slice[start..end]) {
                    let low = name.to_lowercase();
                    if seen.insert(low) {
                        out.push(name.to_string());
                    }
                }
            }
            i = end;
            if out.len() >= 32 {
                break;
            }
        }
    }
    out
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= hay.len() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w.eq_ignore_ascii_case(needle))
        .map(|p| p + from)
}

/// Real image files sitting near the model.
fn nearby_textures(model: &Path) -> Vec<String> {
    let Some(dir) = model.parent() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for rel in SEARCH_DIRS {
        let d: PathBuf = if rel.is_empty() { dir.to_path_buf() } else { dir.join(rel) };
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            if out.len() >= MAX_CANDIDATES {
                return out;
            }
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let Some(ext) = p.extension().and_then(|x| x.to_str()) else { continue };
            let ext = ext.to_ascii_lowercase();
            // Normal/roughness maps are not the base color — never auto-assign
            // one as the albedo. The name classifier owns that call.
            if !TEXTURE_EXTENSIONS.contains(&ext.as_str()) {
                continue;
            }
            out.push(p.to_string_lossy().into_owned());
        }
    }
    out
}

/// What a model says it needs, and what actually exists next to it.
///
/// Scoped to the user's roots for the same reason `model://` is: this reads
/// arbitrary paths off disk on the frontend's say-so.
#[tauri::command]
pub fn model_texture_hints(app: AppHandle, path: String) -> Result<TextureHints, String> {
    let p = Path::new(&path);
    if !is_within_roots(&app, p) {
        return Err("path is outside the scanned roots".into());
    }
    Ok(TextureHints {
        declared: declared_textures(p),
        candidates: nearby_textures(p),
    })
}
