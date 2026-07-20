import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { filterDirs } from "../ipc/commands";
import { rescanRoots, useLibraryStore } from "../stores/libraryStore";
import { isDragOutActive } from "../dragOut";

/** Merge dropped DIRECTORIES into the roots and rescan — the drop twin of
 *  addFolders(), sharing its merge-then-rescan shape. Files in the drop are
 *  silently ignored (the Rust gate returns only real directories). */
async function addDroppedRoots(paths: string[]): Promise<void> {
  const dirs = await filterDirs(paths);
  if (dirs.length === 0) return;
  const state = useLibraryStore.getState();
  const merged = [...state.roots];
  for (const d of dirs) {
    if (!merged.includes(d)) merged.push(d);
  }
  if (merged.length === state.roots.length) return;
  state.setRoots(merged);
  await rescanRoots(merged);
}

/**
 * Drop-a-folder-to-add-a-root: subscribes to the webview's native drag-drop
 * events (HTML5 drag events carry no real paths in Tauri) and returns whether
 * an external drag is currently hovering the window — App renders the
 * full-window "Drop to add folder" overlay from it.
 *
 * Our own drag-OUTs echo back as drag events over our own window; those are
 * filtered via isDragOutActive so dragging a cell across the app never offers
 * to re-add its folder.
 */
export function useExternalDrop(): boolean {
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (isDragOutActive()) return;
        switch (event.payload.type) {
          case "enter":
          case "over":
            setHovering(true);
            break;
          case "leave":
            setHovering(false);
            break;
          case "drop": {
            setHovering(false);
            addDroppedRoots(event.payload.paths).catch((err: unknown) => {
              console.error("drop add-root failed", err);
            });
            break;
          }
        }
      })
      .then((un) => {
        // Unmounted while the listen round-trip was in flight — release here.
        if (disposed) {
          un();
        } else {
          unlisten = un;
        }
      })
      .catch((err: unknown) => {
        console.error("drag-drop listener failed", err);
      });
    return () => {
      disposed = true;
      if (unlisten !== null) unlisten();
    };
  }, []);

  return hovering;
}
