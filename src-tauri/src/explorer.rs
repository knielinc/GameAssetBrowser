//! "Show in Explorer": open a Windows Explorer window with a file
//! pre-selected, for the file-list context menu.

use std::path::Path;

/// Spawn `explorer.exe /select,"<path>"` and return immediately.
///
/// Explorer parses its own command line instead of following normal argv
/// quoting rules, so the `/select,"<path>"` form must arrive verbatim via
/// `raw_arg` — standard per-argument quoting mangles the comma form. The
/// child is deliberately never waited on: explorer.exe exits nonzero even
/// on success, so its exit status carries no signal.
///
/// `async` so Tauri runs it off the main thread: `Path::exists()` is a
/// blocking stat that can hang for seconds on an offline network share,
/// and a sync command would freeze the UI and all other IPC for the
/// duration (matches the repo convention for disk-touching commands).
#[tauri::command]
pub async fn show_in_explorer(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("path does not exist: {path}"));
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{path}\""))
            .spawn()
            .map_err(|e| format!("failed to launch explorer: {e}"))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        Err(format!("show_in_explorer is Windows-only (path: {path})"))
    }
}

/// Spawn `explorer.exe "<dir>"` to open a folder window directly, for the
/// sidebar folder-tree context menu. Same spawn-and-forget and `async`
/// rules as [`show_in_explorer`].
#[tauri::command]
pub async fn open_in_explorer(path: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("\"{path}\""))
            .spawn()
            .map_err(|e| format!("failed to launch explorer: {e}"))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        Err(format!("open_in_explorer is Windows-only (path: {path})"))
    }
}
