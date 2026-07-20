//! Maximize <-> fullscreen transitions without intermediate window states.
//!
//! tao (0.35) does not clear the Win32 maximized bit when entering borderless
//! fullscreen, and its WM_NCCALCSIZE handler clamps a maximized undecorated
//! window to the taskbar work area even while fullscreen — so fullscreen
//! entered from a maximized window renders exactly like maximize. Clearing
//! the bit first with a plain unmaximize works, but paints the restored
//! (small) window for the few frames between the two IPC calls.
//!
//! `set_fullscreen_smooth` avoids both problems: it clears the maximized bit
//! via SetWindowPlacement with rcNormalPosition pinned to the CURRENT window
//! rect — the window never changes size on screen, it just stops being
//! "maximized" — and then enters fullscreen in the same command. tao saves
//! that pinned placement on entry, so leaving fullscreen restores the same
//! monitor-sized rect before `remaximize` snaps the work-area clamp back on.
//! Every intermediate rect matches one of the endpoints, so each direction
//! reads as a single resize.
//!
//! The pin overwrites the placement's rcNormalPosition — the rect a later
//! un-maximize restores to — so the original windowed geometry is remembered
//! here and written back once the exit sequence has applied. Ordering is
//! deterministic without polling: dispatcher messages and run_on_main_thread
//! tasks share one FIFO event-loop channel, and tao executes each window op
//! inline on that thread, so a task posted after set_fullscreen(false) and
//! maximize() runs strictly after both have taken effect.

use std::sync::Mutex;

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowPlacement, GetWindowRect, IsZoomed, SetWindowPlacement, SW_SHOWNORMAL,
    WINDOWPLACEMENT,
};

/// The true pre-maximize restore rect, held for the duration of a fullscreen
/// episode entered from the maximized state.
static ORIGINAL_NORMAL_RECT: Mutex<Option<RECT>> = Mutex::new(None);

fn placement(hwnd: HWND) -> Result<WINDOWPLACEMENT, String> {
    let mut wp = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    unsafe { GetWindowPlacement(hwnd, &mut wp) }.map_err(|e| e.to_string())?;
    Ok(wp)
}

/// Returns whether the window was maximized when entering fullscreen; the
/// frontend passes that back as `remaximize` when leaving so the window
/// returns to the state it came from.
#[tauri::command]
pub fn set_fullscreen_smooth(
    window: tauri::WebviewWindow,
    on: bool,
    remaximize: bool,
) -> Result<bool, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    if on {
        let was_maximized = unsafe { IsZoomed(hwnd) }.as_bool();
        if was_maximized {
            // Demote "maximized" to "normal at the same rect". Synchronous:
            // by the time set_fullscreen queues its work on the main thread,
            // the bit is already clear and the work-area clamp is gone.
            unsafe {
                let mut rect = RECT::default();
                GetWindowRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
                let mut wp = placement(hwnd)?;
                let mut saved = ORIGINAL_NORMAL_RECT.lock().unwrap();
                if saved.is_none() {
                    *saved = Some(wp.rcNormalPosition);
                }
                wp.showCmd = SW_SHOWNORMAL.0 as u32;
                wp.rcNormalPosition = rect;
                SetWindowPlacement(hwnd, &wp).map_err(|e| e.to_string())?;
            }
        }
        window.set_fullscreen(true).map_err(|e| e.to_string())?;
        Ok(was_maximized)
    } else {
        window.set_fullscreen(false).map_err(|e| e.to_string())?;
        let saved = ORIGINAL_NORMAL_RECT.lock().unwrap().take();
        if remaximize {
            window.maximize().map_err(|e| e.to_string())?;
            if let Some(orig) = saved {
                // Re-point the restore rect at the pre-maximize geometry the
                // pin clobbered, so un-maximizing later lands on the original
                // windowed rect. Runs after the restore+maximize above (FIFO,
                // see module docs); while maximized this changes no pixels.
                let hwnd_raw = hwnd.0 as isize;
                window
                    .run_on_main_thread(move || {
                        let hwnd = HWND(hwnd_raw as _);
                        if let Ok(mut wp) = placement(hwnd) {
                            wp.rcNormalPosition = orig;
                            let _ = unsafe { SetWindowPlacement(hwnd, &wp) };
                        }
                    })
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(false)
    }
}
