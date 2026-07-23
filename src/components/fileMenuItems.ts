import {
  BookmarkMinus,
  BookmarkPlus,
  Copy,
  ExternalLink,
  FolderOpen,
  FolderTree as FolderTreeIcon,
  Image as ImageIcon,
} from "lucide-react";
import { copyImageToClipboard, openWith, showInExplorer } from "../ipc/commands";
import { revealInNavigator } from "../stores/revealFolder";
import { useFavoritesStore } from "../stores/favoritesStore";
import { appsForKind, useExternalAppsStore } from "../stores/externalApps";
import type { LibFile } from "../stores/libraryStore";
import type { ContextMenuItem } from "./ContextMenu";

export interface FileMenuArgs {
  /** The single-target file (the clicked cell/row; a material offers its face). */
  file: LibFile;
  /** The whole acted-on selection, as paths (materials already expanded). */
  paths: string[];
  /** Selection size, for the "(N)" suffixes. */
  count: number;
  /** The sole scoped user collection, or null — enables "Remove from collection". */
  removeColName: string | null;
  /** Registered "Open with…" apps (SettingsMenu → External apps…). */
  externalApps: ReturnType<typeof useExternalAppsStore.getState>["apps"];
  /** Open the "Add to collection…" chooser, anchored by the caller. */
  onAddToCollection: () => void;
}

/**
 * The shared file context-menu items, used by BOTH the grid (TabPane) and the
 * list (FileList) so the two can never drift — the earlier All-tab bugs (Copy
 * image / Open with vanishing) came from keeping two hand-synced copies.
 *
 * Per-file actions (Copy image, Open with) key off the FILE's own kind, so they
 * behave the same on a homogeneous tab and on the mixed "all" tab.
 */
export function buildFileMenuItems({
  file,
  paths,
  count,
  removeColName,
  externalApps,
  onAddToCollection,
}: FileMenuArgs): ContextMenuItem[] {
  return [
    {
      label: "Show in Explorer",
      icon: FolderOpen,
      onClick: () => {
        showInExplorer(file.path).catch((err: unknown) => {
          console.error("show_in_explorer failed", err);
        });
      },
    },
    {
      label: "Show in navigator",
      icon: FolderTreeIcon,
      onClick: () => revealInNavigator(file.path),
    },
    {
      // Acts on the whole selection; Show in Explorer above stays single-target.
      label: count > 1 ? `Copy paths (${count})` : "Copy path",
      icon: Copy,
      onClick: () => {
        navigator.clipboard.writeText(paths.join("\n")).catch((err: unknown) => {
          console.error("clipboard write failed", err);
        });
      },
    },
    // Textures only, single-target — the OS clipboard holds one image. HDR/EXR
    // land tone-mapped (as shown). File kind, not tab kind, so it appears on the
    // "all" tab too.
    ...(file.kind === "texture"
      ? [
          {
            label: "Copy image",
            icon: ImageIcon,
            onClick: () => {
              copyImageToClipboard(file.path).catch((err: unknown) => {
                console.warn("copy_image_to_clipboard failed", err);
              });
            },
          },
        ]
      : []),
    {
      // Whole selection, like Copy paths (materials expand to members).
      label: count > 1 ? `Add to collection… (${count})` : "Add to collection…",
      icon: BookmarkPlus,
      onClick: onAddToCollection,
    },
    // One entry per registered app of this file's kind, single-target: an editor
    // opens one document, not a selection.
    ...appsForKind(externalApps, file.kind, file.ext).map((a) => ({
      label: `Open with ${a.name}`,
      icon: ExternalLink,
      onClick: () => {
        openWith(a.exe, file.path).catch((err: unknown) => {
          console.error("open_with failed", err);
        });
      },
    })),
    // Only while browsing a single user collection — the one place "remove" has
    // an unambiguous target.
    ...(removeColName !== null
      ? [
          {
            label: count > 1 ? `Remove from collection (${count})` : "Remove from collection",
            icon: BookmarkMinus,
            onClick: () => {
              useFavoritesStore.getState().removeFromCollection(removeColName, paths);
            },
          },
        ]
      : []),
  ];
}
