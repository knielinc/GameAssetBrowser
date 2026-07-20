// Drag-out: turn a press-and-move on a row or grid cell into a native OS
// file drag (tauri-plugin-drag), so assets drop straight into Explorer, a
// DAW, or a game engine.

import { startDrag } from "@crabnebula/tauri-plugin-drag";

/** Movement (px) before a press becomes a drag. Under this, the gesture stays
 *  a click for the row/cell handlers — same order of magnitude as the OS drag
 *  threshold, and small enough that a deliberate pull always fires. */
const DRAG_THRESHOLD_PX = 6;

/** 64px rounded square in the app accent — the cursor-attached preview image.
 *  Hardcoded data URL: the plugin accepts `data:image/png;base64,` directly,
 *  and a constant beats generating a canvas per gesture. */
const DRAG_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAN0SURBVHhe7ZtNaNRAGIZ78+bRmzdvCmIRlCpFUVCQYkEoQlEK/hyKlEpLkdYfqqibbYUtHvaiK6xk0puXIp48KAjipTcLHvYi2qq0/lOr/ZR3drOw32bXZJJmNtkZeKAw2eSdd2a+L83MdHSYErxkBG3PONQ1JajPEjSiG+iAHujiWiMpM49pk3yITXnLppIl6F2LU7AcOjXzkDbztgQuuJElaN7jIS1PRtBCRtA5dCBv138L3LNsmuM3TSJZQc+mHdrK29iw4OKsoJf8RklGjgaHunhb6wp6Pm2Nd4EJt4q0jbe5WjBX0jLsG4HObRgcETD4D9JIVtAkb3u59xMa7QNjU2mqSFtqDKiku/qL04pD47UGCLLrLkoxSI3VxldyfhLe8CKlmhGsWerkle1AVtBRaQD+4JVhGb/79sOw9frT2YnnKyeHHn1TBb/HfcZypY/8GWFB1pMGRJn+To8++bL32NXfO/YN/o2aPUcm/sCUm8XV9/y5ioy4ARD/VvLKQKDHu3tvr3HRGwEMHr3zJooREY0BGKY7u4eIC91o+ofnvnItAQlvAHpeR+NdEB+4pgCENyCuYd+I3YfG1q8/+L7IdfkknAEIeFyQDnoG7v/k2nwSzgBEZS5GB5iCiqNA3QDkZS5EJ4OTr5a5Rh+oG3D+yosVLkInihlB3YBWmf8ueEHiGn2gbgAeyEXoxBhgDDAGGAO4Rh8YA4wBxgBjgDHAGGAMMAYYA4wBHpVNwQcILkInsRuAtQAuQiexG4CVGS5CJ/hExzX6QN0ArM/tOnBxnQvRxeX80hLX6AN1A0DvmeIPLkQH+3turHFtPglnwLV7y4tYmeGC4gRrAiGWzsMZAPA9nouKE8XP4S7hDQC6psLhvtwq1xKQaAwASItxBUUM+5A971I2IGPTBY/KwCAmHDwx/YsLjpIIN0eAsgFZh457VCqDlDRw6elnvJxEBVaisBeBPysM6PjyCHCoi1e2A+h4aQC2jfLKtmCWOqUBMhCmfJe4B/PVxksDIsgESSIrKFdjgJwGbbRd1vOEGfbR8wtTSoG3XZZKMEz3mQGbSk2PzciN0ymeCtXU16zIF6N0mlB+8/NTKkdRFzxukjxsKvnqeV4QE+RxWX7DZFFoOuf9FKQM5M2kBEh5SNKmvK+DkkELgmTlfAFenFoK6Ara6H8q0yXGAawE6AAAAABJRU5ErkJggg==";

/** True while a drag-out is in flight — useExternalDrop reads it so dragging
 *  our own items across our own window never shows the "add to library"
 *  overlay (the OS delivers drag-over events for our own drag too). */
let dragOutActive = false;
export const isDragOutActive = (): boolean => dragOutActive;

/**
 * Arm a drag-out gesture from a row/cell mousedown. Once the pointer moves
 * past the threshold with the button held, `getPaths()` resolves what to drag
 * (the caller decides: full selection when the pressed item is selected, else
 * just the pressed item) and the native drag starts — exactly once per press.
 * Under the threshold nothing happens and the press stays a plain click.
 *
 * Presses on inner buttons (the star) are ignored so pulling on one can never
 * start a drag. `startDrag` resolves when the OS drag ENDS (drop or cancel) —
 * during it the webview sees no mouseup, so cleanup happens at fire time.
 */
export function armDragOut(
  e: { button: number; clientX: number; clientY: number; target: EventTarget | null },
  getPaths: () => string[],
): void {
  if (e.button !== 0) return;
  if (e.target instanceof Element && e.target.closest("button") !== null) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const onMove = (ev: globalThis.MouseEvent): void => {
    if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
    cleanup();
    const paths = getPaths();
    if (paths.length === 0 || dragOutActive) return;
    dragOutActive = true;
    startDrag({ item: paths, icon: DRAG_ICON })
      .catch((err: unknown) => {
        console.warn("drag-out failed", err);
      })
      .finally(() => {
        dragOutActive = false;
      });
  };
  const cleanup = (): void => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", cleanup);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", cleanup);
}
