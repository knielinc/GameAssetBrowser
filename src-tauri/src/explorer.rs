//! "Show in file manager": reveal a file (or open a folder) in the OS file
//! manager, for the file-list and folder-tree context menus. Windows Explorer
//! (`/select`), macOS Finder (`open -R`), or the Linux desktop's xdg handler.

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

    #[cfg(target_os = "macos")]
    {
        // `open -R` reveals the file selected in a Finder window.
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("failed to launch Finder: {e}"))?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No portable "select this file" across Linux file managers, so open
        // its containing folder — every xdg-compliant desktop handles that.
        let dir = Path::new(&path)
            .parent()
            .ok_or_else(|| format!("no parent directory for {path}"))?;
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("failed to launch file manager: {e}"))?;
        Ok(())
    }
}

/// Open a folder window directly, for the sidebar folder-tree context menu.
/// Same spawn-and-forget and `async` rules as [`show_in_explorer`].
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

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("failed to launch Finder: {e}"))?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("failed to launch file manager: {e}"))?;
        Ok(())
    }
}
