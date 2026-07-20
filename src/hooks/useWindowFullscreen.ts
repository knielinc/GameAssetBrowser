import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_WINDOWS } from "../platform";

/**
 * F11 toggles the OS window fullscreen for the whole application.
 *
 * Deliberately separate from FullscreenPreview: this resizes the native window
 * (title bar gone, covers the taskbar) and shows the same UI bigger. That one
 * is an in-app overlay that shows ONE asset and nothing else. Different jobs,
 * so they compose — F11 into fullscreen, then Space to blow up a texture
 * inside it.
 *
 * Needs core:window allow-set-fullscreen / is-fullscreen / toggle-maximize /
 * is-maximized in capabilities/default.json; `core:default` does not include
 * them.
 */
const win = getCurrentWindow();

// Maximize and fullscreen must never overlap: tao (0.35, Windows) leaves the
// Win32 maximized bit set when entering borderless fullscreen, and clamps any
// maximized undecorated window to the taskbar work area — fullscreen or not —
// so fullscreen from a maximized window renders exactly like maximize. The
// `set_fullscreen_smooth` command (winmode.rs) clears/restores the maximized
// bit around the fullscreen change natively and without intermediate window
// geometry, so the transition is a single resize instead of a flash through
// the restored window. This flag remembers where fullscreen was entered from.
//
// That whole dance is a Windows/tao bug workaround; macOS (WKWebView) and Linux
// (webkit2gtk) don't have it, and winmode.rs doesn't compile there, so off
// Windows we drive the standard tao window APIs directly.
let remaximizeOnExit = false;

/** Toggle real OS fullscreen (covers the taskbar). */
export async function toggleWindowFullscreen(): Promise<void> {
  const isFullscreen = await win.isFullscreen();
  if (!IS_WINDOWS) {
    await win.setFullscreen(!isFullscreen);
    return;
  }
  if (isFullscreen) {
    const remaximize = remaximizeOnExit;
    remaximizeOnExit = false;
    await invoke("set_fullscreen_smooth", { on: false, remaximize });
  } else {
    remaximizeOnExit = await invoke<boolean>("set_fullscreen_smooth", {
      on: true,
      remaximize: false,
    });
  }
}

/** Toggle work-area maximize (taskbar stays visible). */
export async function toggleWindowMaximize(): Promise<void> {
  // Maximize pressed while fullscreen means "back to a normal window, but
  // big": leave fullscreen straight into the maximized state.
  if (await win.isFullscreen()) {
    if (!IS_WINDOWS) {
      await win.setFullscreen(false);
      await win.maximize();
      return;
    }
    remaximizeOnExit = false;
    await invoke("set_fullscreen_smooth", { on: false, remaximize: true });
    return;
  }
  await win.toggleMaximize();
}

export function useWindowFullscreen(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== "F11") return;
      e.preventDefault();
      void toggleWindowFullscreen().catch((err: unknown) => {
        console.error("window fullscreen toggle failed", err);
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
