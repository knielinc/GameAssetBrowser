//! Portable mode: when the exe is a loose standalone copy, ALL app data
//! lives in one `AssetPreviewer.data` folder next to the exe. Installed
//! copies (MSI/NSIS) keep using the OS-standard app-data locations.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Where all persistent app data lives. Resolved once in `setup()` and
/// managed as tauri `State`.
pub struct DataHome {
    dir: PathBuf,
    portable: bool,
}

impl DataHome {
    pub fn is_portable(&self) -> bool {
        self.portable
    }

    /// Absolute `settings.json` path, handed to the frontend for the store
    /// plugin (absolute inputs bypass its `BaseDirectory::AppData` resolution).
    pub fn settings_path(&self) -> PathBuf {
        self.dir.join("settings.json")
    }

    /// WebView2 user-data folder. Only used in portable mode; installed
    /// copies keep tauri's default `%LOCALAPPDATA%` location.
    pub fn webview_dir(&self) -> PathBuf {
        self.dir.join("webview")
    }

    /// Decoded texture thumbnails, keyed by content hash. Lives under the data
    /// home so a portable copy carries its cache with it — re-decoding a few
    /// thousand 4K textures on every launch is not acceptable.
    pub fn thumbs_dir(&self) -> PathBuf {
        self.dir.join("thumbs")
    }
}

/// Resolve the data home once at startup.
///
/// Portable iff the exe's directory passes a real write probe AND has no
/// `uninstall.exe` sibling (the NSIS-install marker; MSI installs land under
/// Program Files, where the write probe already fails without admin).
/// Everything else falls back to the OS app-data dir — the previous behavior.
pub fn resolve(app: &tauri::App) -> Result<DataHome, Box<dyn std::error::Error>> {
    if let Some(exe_dir) = portable_exe_dir() {
        let dir = exe_dir.join("AssetPreviewer.data");
        // One call covers both: creating `webview` creates `dir` as well.
        match fs::create_dir_all(dir.join("webview")) {
            Ok(()) => return Ok(DataHome { dir, portable: true }),
            // The probe said writable, so this is truly exceptional; degrade
            // to the installed-mode location rather than refusing to start.
            Err(e) => eprintln!(
                "portable data dir {} could not be created ({e}); falling back to app data",
                dir.display()
            ),
        }
    }

    let dir = app.path().app_data_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(DataHome { dir, portable: false })
}

/// One-time migration: the first portable run on a machine with an existing
/// installed profile copies the legacy settings over, so the portable copy
/// starts from the user's current preferences. Failures are logged, never
/// fatal — the app then just starts with defaults.
pub fn migrate_legacy_settings(app: &tauri::App, data_home: &DataHome) {
    if !data_home.is_portable() {
        return;
    }
    let dest = data_home.settings_path();
    if dest.exists() {
        return;
    }
    let legacy = match app.path().app_data_dir() {
        Ok(dir) => dir.join("settings.json"),
        // No resolvable legacy location means nothing to migrate.
        Err(_) => return,
    };
    if !legacy.exists() {
        return;
    }
    if let Err(e) = fs::copy(&legacy, &dest) {
        eprintln!(
            "settings migration {} -> {} failed: {e}",
            legacy.display(),
            dest.display()
        );
    }
}

/// Absolute path of `settings.json` for the frontend to pass to the store
/// plugin's `load()`.
#[tauri::command]
pub fn settings_store_path(state: tauri::State<'_, DataHome>) -> Result<String, String> {
    state
        .settings_path()
        .into_os_string()
        .into_string()
        .map_err(|raw| {
            format!(
                "settings path is not valid UTF-8: {}",
                PathBuf::from(raw).display()
            )
        })
}

/// The exe's directory iff it qualifies as a portable install location.
fn portable_exe_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.to_path_buf();
    if dir.join("uninstall.exe").exists() {
        return None;
    }
    if !dir_is_writable(&dir) {
        return None;
    }
    Some(dir)
}

/// Probe writability by creating and deleting a uniquely-named temp file.
/// ACLs make metadata-based checks unreliable on Windows; only an actual
/// write proves anything.
fn dir_is_writable(dir: &Path) -> bool {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let probe = dir.join(format!(".ap-write-probe-{}-{nanos}", std::process::id()));
    let created = fs::OpenOptions::new()
        .write(true)
        .create_new(true) // never clobber an existing file
        .open(&probe)
        .is_ok();
    if created {
        let _ = fs::remove_file(&probe);
    }
    created
}
