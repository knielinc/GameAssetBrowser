import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * F11 toggles the OS window fullscreen for the whole application.
 *
 * Deliberately separate from FullscreenPreview: this resizes the native window
 * (title bar gone, covers the taskbar) and shows the same UI bigger. That one
 * is an in-app overlay that shows ONE asset and nothing else. Different jobs,
 * so they compose — F11 into fullscreen, then Space to blow up a texture
 * inside it.
 *
 * Needs `core:window:allow-set-fullscreen` + `core:window:allow-is-fullscreen`
 * in capabilities/default.json; `core:default` does not include them.
 */
export function useWindowFullscreen(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== "F11") return;
      e.preventDefault();
      const win = getCurrentWindow();
      void win
        .isFullscreen()
        .then((on) => win.setFullscreen(!on))
        .catch((err: unknown) => {
          console.error("window fullscreen toggle failed", err);
        });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
