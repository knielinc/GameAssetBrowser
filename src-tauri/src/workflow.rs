//! Workflow exits: the commands that hand assets OFF to the rest of the
//! pipeline — dropping folders in to become roots, copying decoded pixels to
//! the clipboard, and launching a user-registered external editor. (Drag-OUT
//! itself lives in `tauri-plugin-drag`; only its registration is in lib.rs.)

use std::path::Path;

/// Keep only the paths that are directories — the gate behind
/// drop-to-add-root. A drop can mix files and folders (or be a stray file
/// drag); only real directories may become library roots, and the frontend
/// silently ignores the rest.
///
/// `async` for the same reason as `show_in_explorer`: `is_dir()` is a
/// blocking stat that can hang on an offline network share, and a sync
/// command would freeze the UI for the duration.
#[tauri::command]
pub async fn filter_dirs(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| Path::new(p).is_dir())
        .collect()
}

/// Decode `path` to full-resolution RGBA8 and put it on the OS clipboard, so
/// a DDS/TGA/EXR pastes straight into any editor without an export step.
///
/// Reuses the preview pipeline's decode (`thumbs::decode_image` +
/// `thumbs::to_ldr`): HDR/EXR arrive tone-mapped exactly like the preview
/// panel shows them — a float image cannot go on the clipboard anyway, and
/// matching what the user is looking at is the point. Same consent gate as
/// `preview://`: only files inside a scanned root are read.
///
/// `async` keeps the multi-hundred-ms decode of a 4K source off the main
/// thread (repo convention for disk/CPU-heavy commands).
#[tauri::command]
pub async fn copy_image_to_clipboard(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !crate::scanner::is_within_roots(&app, &p) {
        return Err(format!("refused out-of-scope read: {path}"));
    }
    let img = crate::thumbs::decode_image(&p).map_err(|e| format!("decode {path}: {e}"))?;
    let img = crate::thumbs::to_ldr(img);
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    // A fresh Clipboard per call, dropped right after: arboard holds the OS
    // clipboard open for the handle's lifetime, and copies are rare one-shots.
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: std::borrow::Cow::Owned(rgba.into_raw()),
        })
        .map_err(|e| format!("clipboard image write: {e}"))?;
    Ok(())
}

/// Launch a user-registered external app with `path` as its one argument —
/// the "Open with <name>" context action. Spawn-and-forget like
/// `show_in_explorer`: the child is never waited on (an editor session can
/// outlive this process), so only the spawn itself can fail.
#[tauri::command]
pub async fn open_with(exe: String, path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("path does not exist: {path}"));
    }
    // Plain per-argument quoting (no raw_arg): unlike explorer.exe, normal
    // programs parse argv conventionally, so std's quoting is correct.
    std::process::Command::new(&exe)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("failed to launch {exe}: {e}"))?;
    Ok(())
}
