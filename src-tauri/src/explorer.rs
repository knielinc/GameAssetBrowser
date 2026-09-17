//! "Show in file manager": reveal a file (or open a folder) in the OS file
//! manager, for the file-list and folder-tree context menus. Windows Explorer
//! (shell `SHOpenFolderAndSelectItems`, falling back to `explorer.exe
//! /select`), macOS Finder (`open -R`), or on Linux the freedesktop
//! FileManager1 D-Bus interface with the xdg handler as fallback.

use std::path::Path;

/// Reveal `path` in Explorer with the file highlighted.
///
/// Goes through the shell API rather than `explorer.exe /select,"<path>"`:
/// the command-line form is unreliable about actually selecting the item
/// (forward-slash paths open "This PC" instead, and on Windows 11 a folder
/// that is already open frequently just gets focused with nothing selected).
/// `SHOpenFolderAndSelectItems` reuses an open window and selects either way.
/// The command line remains as a fallback if the shell call fails.
///
/// Runs on its own thread: the shell call wants a COM apartment of its own,
/// and it can block briefly while Explorer brings the window up.
#[cfg(windows)]
fn reveal_selected_windows(path: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems};

    // The shell parses `\`-separated paths only; roots picked in older builds
    // (or typed by hand) can carry `/`.
    let path = path.replace('/', "\\");

    let shell = std::thread::spawn({
        let path = path.clone();
        move || -> Result<(), String> {
            // SAFETY: plain Win32 calls with valid arguments; every pidl the
            // shell hands out is freed before the thread ends, and COM is
            // uninitialized on the same thread it was initialized on.
            unsafe {
                let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                if hr.is_err() {
                    return Err(format!("CoInitializeEx failed: {hr}"));
                }
                let pidl = ILCreateFromPathW(&HSTRING::from(path.as_str()));
                if pidl.is_null() {
                    CoUninitialize();
                    return Err("ILCreateFromPathW returned null".to_owned());
                }
                // cidl == 0 with a fully qualified item pidl: open its parent
                // folder and select that single item.
                let result = SHOpenFolderAndSelectItems(pidl, None, 0)
                    .map_err(|e| format!("SHOpenFolderAndSelectItems failed: {e}"));
                ILFree(Some(pidl));
                CoUninitialize();
                result
            }
        }
    })
    .join()
    .unwrap_or_else(|_| Err("shell reveal thread panicked".to_owned()));

    match shell {
        Ok(()) => Ok(()),
        Err(e) => {
            eprintln!("[explorer] shell reveal failed, falling back to explorer.exe: {e}");
            // Explorer parses its own command line instead of following
            // normal argv quoting rules, so the `/select,"<path>"` form must
            // arrive verbatim via `raw_arg` — standard per-argument quoting
            // mangles the comma form. The child is deliberately never waited
            // on: explorer.exe exits nonzero even on success, so its exit
            // status carries no signal.
            std::process::Command::new("explorer.exe")
                .raw_arg(format!("/select,\"{path}\""))
                .spawn()
                .map_err(|e| format!("failed to launch explorer: {e}"))?;
            Ok(())
        }
    }
}

/// Reveal a file selected in the OS file manager.
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
        reveal_selected_windows(&path)
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
        // Best effort: the freedesktop FileManager1 D-Bus interface (Nautilus,
        // Dolphin, Nemo, Thunar, Caja...) reveals the file selected. If the
        // call fails (no dbus-send, no file manager on the bus, headless), fall
        // back to opening the containing folder, which every xdg-compliant
        // desktop handles.
        if let Err(e) = reveal_selected_dbus(&path) {
            eprintln!("[explorer] FileManager1.ShowItems failed, falling back to xdg-open: {e}");
            let dir = Path::new(&path)
                .parent()
                .ok_or_else(|| format!("no parent directory for {path}"))?;
            std::process::Command::new("xdg-open")
                .arg(dir)
                .spawn()
                .map_err(|e| format!("failed to launch file manager: {e}"))?;
        }
        Ok(())
    }
}

/// `org.freedesktop.FileManager1.ShowItems([file URI], "")` over the session
/// bus via `dbus-send`. Waited on (unlike the spawn-and-forget launchers)
/// because the exit status is the only signal that a file manager answered;
/// `--print-reply` makes dbus-send block for the reply and fail if none comes.
#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_selected_dbus(path: &str) -> Result<(), String> {
    let uri = url::Url::from_file_path(path).map_err(|_| format!("not an absolute path: {path}"))?;
    let status = std::process::Command::new("dbus-send")
        .args([
            "--session",
            "--print-reply",
            "--reply-timeout=3000",
            "--dest=org.freedesktop.FileManager1",
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1.ShowItems",
        ])
        .arg(format!("array:string:{uri}"))
        .arg("string:")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("failed to run dbus-send: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("dbus-send exited with {status}"))
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
