import { create } from "zustand";
import { usePanelPrefs } from "./panelPrefs";

/** Directory containing `path` (Windows or POSIX separators). */
function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i < 0 ? path : path.slice(0, i);
}

export interface RevealFolderState {
  /** Pending reveal request, consumed (cleared) by FolderTree once handled.
   *  A fresh object per request, so revealing the same folder twice still
   *  re-triggers the scroll/flash. */
  target: { path: string } | null;
  clear: () => void;
}

export const useRevealFolder = create<RevealFolderState>((set) => ({
  target: null,
  clear: () => set({ target: null }),
}));

/**
 * "Show in navigator": open the sidebar if it's hidden and ask the folder
 * tree to expand to, scroll to, and flash the file's parent folder. A store
 * value rather than an event on purpose — with the sidebar closed the tree
 * isn't mounted yet, and the request must survive until it is.
 */
export function revealInNavigator(filePath: string): void {
  const panels = usePanelPrefs.getState();
  if (!panels.left) panels.toggleLeft();
  useRevealFolder.setState({ target: { path: dirOf(filePath) } });
}
