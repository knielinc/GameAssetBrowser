import { useCallback, useState, type MouseEvent, type ReactElement } from "react";
import { Copy, FolderOpen, Loader2 } from "lucide-react";
import { useVisibleFiles } from "../hooks/useVisibleFiles";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useLibraryStore, type LibFile } from "../stores/libraryStore";
import { showInExplorer } from "../ipc/commands";
import type { AssetKind } from "../types";
import Toolbar from "./Toolbar";
import FileList from "./FileList";
import StatusBar from "./StatusBar";
import ContextMenu from "./ContextMenu";
import AssetGrid from "./grid/AssetGrid";
import TextureCell from "./grid/TextureCell";
import ModelCell from "./grid/ModelCell";

export interface TabPaneProps {
  kind: AssetKind;
}

/**
 * One tab's pane: toolbar, content, status bar.
 *
 * App mounts this with `key={activeTab}`, which is load-bearing. The remount
 * resets useVisibleFiles' debounce state (otherwise a tab switch shows the
 * previous tab's query for 100 ms), the virtualizer's scroll offset, and the
 * scrollToIndex/gridNav refs — all in one stroke.
 */
export default function TabPane({ kind }: TabPaneProps): ReactElement {
  const visible = useVisibleFiles(kind);
  useKeyboardShortcuts(kind, visible);

  const tab = useLibraryStore((s) => s.tabs[kind]);
  const scanning = useLibraryStore((s) => s.scanning);
  const anyFiles = useLibraryStore((s) => s.allFiles.length > 0);
  const select = useLibraryStore((s) => s.select);

  const [menu, setMenu] = useState<{ x: number; y: number; file: LibFile } | null>(null);
  const onCellSelect = useCallback(
    (index: number) => {
      const file = visible[index];
      if (file) select(kind, index, file.path);
    },
    [visible, select, kind],
  );
  const onCellContextMenu = useCallback(
    (index: number, e: MouseEvent<HTMLDivElement>) => {
      const file = visible[index];
      if (!file) return;
      select(kind, index, file.path);
      setMenu({ x: e.clientX, y: e.clientY, file });
    },
    [visible, select, kind],
  );

  let content: ReactElement;
  if (scanning && !anyFiles) {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-dim">
        <Loader2 size={22} className="animate-spin text-accent" />
        <p className="text-xs">Scanning folders…</p>
      </div>
    );
  } else if (tab.viewMode === "grid" && kind !== "audio") {
    content = visible.length === 0 ? (
      <div className="flex flex-1 items-center justify-center text-xs text-dim">
        {anyFiles ? "Nothing matches the current filters" : "Nothing found for this tab"}
      </div>
    ) : (
      <AssetGrid
        items={visible}
        cellSize={tab.cellSize}
        getKey={(f) => f.path}
        selectedIndex={tab.selectedIndex}
        onSelect={onCellSelect}
        onContextMenu={onCellContextMenu}
        renderCell={(f) =>
          kind === "texture" ? (
            <TextureCell file={f} selected={f.path === tab.selectedPath} />
          ) : (
            <ModelCell file={f} selected={f.path === tab.selectedPath} />
          )
        }
      />
    );
  } else {
    content = <FileList kind={kind} files={visible} />;
  }

  return (
    <>
      <Toolbar kind={kind} />
      {content}
      <StatusBar kind={kind} visibleCount={visible.length} />
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Show in Explorer",
              icon: FolderOpen,
              onClick: () => {
                showInExplorer(menu.file.path).catch((err: unknown) => {
                  console.error("show_in_explorer failed", err);
                });
              },
            },
            {
              label: "Copy path",
              icon: Copy,
              onClick: () => {
                navigator.clipboard.writeText(menu.file.path).catch((err: unknown) => {
                  console.error("clipboard write failed", err);
                });
              },
            },
          ]}
        />
      )}
    </>
  );
}
