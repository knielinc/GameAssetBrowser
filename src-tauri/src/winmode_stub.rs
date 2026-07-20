//! Non-Windows stand-in for `winmode`. The real module (winmode.rs) is a Win32
//! workaround for a tao maximize-vs-fullscreen bug that only exists on Windows;
//! it uses the `windows` crate and `hwnd()`, so it can't compile elsewhere.
//!
//! Compiled under `#[cfg(not(windows))]` with `#[path = "winmode_stub.rs"] mod
//! winmode;`, so the command name and the `generate_handler!` list stay
//! identical on every platform. The frontend never invokes this off Windows
//! (see useWindowFullscreen.ts, which drives the standard window APIs there);
//! the stub exists only to keep the invoke contract total.

/// No-op stand-in for the Windows `set_fullscreen_smooth`. Returns `false`
/// ("was not maximized") — the frontend ignores the result off Windows.
#[tauri::command]
pub fn set_fullscreen_smooth(_on: bool, _remaximize: bool) -> Result<bool, String> {
    Ok(false)
}
