import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactElement } from "react";
import clsx from "clsx";
import { Copy, FolderOpen, FolderTree as FolderTreeIcon, Loader2 } from "lucide-react";
import { useVisibleFiles } from "../hooks/useVisibleFiles";
import { usePanelWidth } from "../hooks/usePanelWidth";
import { usePanelPrefs } from "../stores/panelPrefs";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useThumbRequests } from "../hooks/useThumbRequests";
import { useModelThumbs } from "../hooks/useModelThumbs";
import { activeFilterCount, thumbInfos, useLibraryStore, type LibFile } from "../stores/libraryStore";
import { showInExplorer } from "../ipc/commands";
import { revealInNavigator } from "../stores/revealFolder";
import type { AssetKind } from "../types";
import FileList from "./FileList";
import StatusBar from "./StatusBar";
import ContextMenu from "./ContextMenu";
import AssetGrid from "./grid/AssetGrid";
import { hasWebGL2 } from "./grid/thumbGL";
import TextureCell from "./grid/TextureCell";
import MaterialCell from "./grid/MaterialCell";
import ModelCell from "./grid/ModelCell";
import ModelInspector from "./model/ModelInspector";
import TextureInspector from "./texture/TextureInspector";
import type { PreviewState } from "./texture/PreviewControls";
import FullscreenPreview from "./FullscreenPreview";
import { groupTextures, type TextureItem } from "../material/classify";

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

  const tab = useLibraryStore((s) => s.tabs[kind]);
  const scanning = useLibraryStore((s) => s.scanning);
  const anyFiles = useLibraryStore((s) => s.allFiles.length > 0);
  const select = useLibraryStore((s) => s.select);
  const clearFilters = useLibraryStore((s) => s.clearFilters);
  const thumbsVersion = useLibraryStore((s) => s.thumbsVersion);

  // Materials are derived in the frontend in one memoized pass — the same
  // precedent as buildFolderTree, no IPC and no backend state. It re-runs as
  // thumbnails land, because content breaks ties the names cannot: a group
  // whose `_A` is undecidable on names alone resolves once we can see that
  // the pixels are grayscale.
  const grouped: TextureItem[] | null = useMemo(() => {
    if (kind !== "texture" || !tab.groupMaterials) return null;
    return groupTextures(visible, thumbInfos());
  }, [kind, tab.groupMaterials, visible, thumbsVersion]);

  const [preview, setPreview] = useState<LibFile | null>(null);
  // The shortcut hook resolves Space against the FLAT file list, but in the
  // grouped view the selection is keyed by the grouped item — a material's key
  // is no file path, and its index is a grouped index. Re-resolve here, where
  // the grouping lives; a material previews as its face file (same one the
  // cell thumbnail shows).
  const onPreview = useCallback(
    (f: LibFile) => {
      if (grouped !== null) {
        const t = useLibraryStore.getState().tabs[kind];
        const it =
          grouped.find((i) => i.key === t.selectedPath) ?? grouped[t.selectedIndex] ?? grouped[0];
        if (it !== undefined) {
          setPreview(
            it.kind === "material"
              ? (it.material.channels.get("baseColor") ?? it.material.members[0]!).file
              : it.file,
          );
          return;
        }
      }
      setPreview(f);
    },
    [grouped, kind],
  );
  useKeyboardShortcuts(kind, visible, kind === "audio" ? undefined : onPreview);
  const onTextureRange = useThumbRequests(visible, kind === "texture");
  const onModelRange = useModelThumbs(visible, kind === "model");
  const onVisibleRange = kind === "model" ? onModelRange : onTextureRange;

  const [menu, setMenu] = useState<{ x: number; y: number; file: LibFile } | null>(null);
  // Inspector show/hide is shared with the TabBar toggle; its width is a
  // user-dragged right-anchored panel, just like the left sidebar.
  const inspectorOpen = usePanelPrefs((s) => s.right);
  const toggleInspector = usePanelPrefs((s) => s.toggleRight);
  const inspector = usePanelWidth({
    storageKey: "inspectorWidth",
    min: 240,
    max: 720,
    defaultWidth: 300,
    side: "right",
  });
  // Shared by the drawer and the fullscreen overlay, so switching to
  // fullscreen keeps the mesh/lighting you were already looking at.
  const [preview3d, setPreview3d] = useState<PreviewState>({
    // Flat by default: a texture preview is first of all the image itself.
    mesh: "flat",
    light: "studio",
    tiles: 1,
    relief: 0.05,
    zoomFit: true,
    zoomPct: 100,
    spriteOn: false,
    spriteCols: 1,
    spriteRows: 1,
    spriteFps: 12,
    spritePlaying: true,
  });
  const patchPreview = useCallback(
    (p: Partial<PreviewState>) => setPreview3d((s) => ({ ...s, ...p })),
    [],
  );
  // Sprite mode is a property of one image, not a global mode. Turn it off
  // whenever the selection changes, so a normal texture never opens cropped
  // into a grid cell because the last one happened to be a sprite sheet.
  useEffect(() => {
    setPreview3d((s) => (s.spriteOn ? { ...s, spriteOn: false } : s));
  }, [tab.selectedPath]);
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

  // Grouped view: selection is keyed by the item's own key (a material has no
  // single path), and thumbs are requested for each visible material's members.
  const onGroupSelect = useCallback(
    (index: number) => {
      const it = grouped?.[index];
      if (it !== undefined) select(kind, index, it.key);
    },
    [grouped, select, kind],
  );
  const onGroupContextMenu = useCallback(
    (index: number, e: MouseEvent<HTMLDivElement>) => {
      const it = grouped?.[index];
      if (it === undefined) return;
      select(kind, index, it.key);
      const file = it.kind === "material" ? it.material.members[0]!.file : it.file;
      setMenu({ x: e.clientX, y: e.clientY, file });
    },
    [grouped, select, kind],
  );
  const onGroupedRange = useCallback(
    (start: number, end: number) => {
      if (grouped === null) return;
      // Map the material window back onto flat file indices for the thumb
      // request hook, which knows nothing about grouping.
      const paths = new Set<string>();
      for (let i = start; i < end; i++) {
        const it = grouped[i];
        if (it === undefined) continue;
        if (it.kind === "material") {
          const face = it.material.channels.get("baseColor") ?? it.material.members[0]!;
          paths.add(face.file.path);
        } else {
          paths.add(it.file.path);
        }
      }
      let lo = Infinity;
      let hi = -1;
      for (let i = 0; i < visible.length; i++) {
        if (!paths.has(visible[i]!.path)) continue;
        lo = Math.min(lo, i);
        hi = Math.max(hi, i);
      }
      if (hi >= 0) onVisibleRange(lo, hi + 1);
    },
    [grouped, visible, onVisibleRange],
  );

  // Textures render through the shared WebGL canvas (no PNG round-trip, one
  // draw call); everything else stays on the classic <img> path. Falls back to
  // <img> if this WebView somehow lacks WebGL2.
  const glThumbs = kind === "texture" && hasWebGL2();

  let content: ReactElement;
  if (scanning && !anyFiles) {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-dim">
        <Loader2 size={22} className="animate-spin text-accent" />
        <p className="text-xs">Scanning folders…</p>
      </div>
    );
  } else if (visible.length === 0 && tab.viewMode === "grid" && kind !== "audio") {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center text-xs text-dim">
        {anyFiles ? "Nothing matches the current filters" : "Nothing found for this tab"}
        {activeFilterCount(kind, tab) > 0 && (
          <button type="button" className="chip mt-2" onClick={() => clearFilters(kind)}>
            Clear filters
          </button>
        )}
      </div>
    );
  } else if (grouped !== null && tab.viewMode === "grid") {
    // Grouped textures: thumbnail requests still key off the FLAT file list,
    // so the range the grid reports (over materials) can't drive them. Ask for
    // every visible material's face texture instead — the count is bounded by
    // the same window, just indexed differently.
    content = (
      <AssetGrid
        items={grouped}
        cellSize={tab.cellSize}
        getKey={(it) => it.key}
        selectedIndex={tab.selectedIndex}
        onSelect={onGroupSelect}
        onContextMenu={onGroupContextMenu}
        onVisibleRange={onGroupedRange}
        glThumbs={glThumbs}
        renderCell={(it) =>
          it.kind === "material" ? (
            <MaterialCell material={it.material} selected={it.key === tab.selectedPath} />
          ) : (
            <TextureCell file={it.file} selected={it.file.path === tab.selectedPath} gl={glThumbs} />
          )
        }
      />
    );
  } else if (tab.viewMode === "grid" && kind !== "audio") {
    content = (
      <AssetGrid
        items={visible}
        cellSize={tab.cellSize}
        getKey={(f) => f.path}
        selectedIndex={tab.selectedIndex}
        onSelect={onCellSelect}
        onContextMenu={onCellContextMenu}
        onVisibleRange={onVisibleRange}
        glThumbs={glThumbs}
        renderCell={(f) =>
          kind === "texture" ? (
            <TextureCell file={f} selected={f.path === tab.selectedPath} gl={glThumbs} />
          ) : (
            <ModelCell file={f} selected={f.path === tab.selectedPath} />
          )
        }
      />
    );
  } else {
    content = <FileList kind={kind} files={visible} items={grouped ?? undefined} />;
  }

  const selectedFile = visible.find((f) => f.path === tab.selectedPath) ?? null;

  // The texture inspector works on the grid ITEM (a material or a lone file),
  // not the raw file — grouping is the whole point of the preview.
  const selectedItem: TextureItem | null =
    kind !== "texture"
      ? null
      : (grouped?.find((i) => i.key === tab.selectedPath) ??
        (selectedFile !== null ? { kind: "file", file: selectedFile, key: selectedFile.path } : null));

  return (
    <>
      <div className="flex min-h-0 flex-1">
        {/* Status bar lives INSIDE the content column so it stops at the
            inspector, not across it — the inspector runs the full height beside
            it. Its own left/right separators delineate it from both panels. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {content}
          <StatusBar kind={kind} visibleCount={visible.length} />
        </div>
        {/* Hidden while the fullscreen preview is up: both host a WebGL
            context, and there is no reason to pay for two. Drag the handle to
            resize, just like the left sidebar; double-click resets the width. */}
        {kind !== "audio" && inspectorOpen && preview === null && (
          <div
            role="separator"
            aria-orientation="vertical"
            className={clsx("sidebar-resizer", inspector.isDragging && "sidebar-resizer-active")}
            {...inspector.handleProps}
          />
        )}
        {kind === "model" && inspectorOpen && preview === null && (
          <ModelInspector
            path={selectedFile?.path ?? null}
            size={selectedFile?.size ?? null}
            onClose={toggleInspector}
            width={inspector.width}
          />
        )}
        {kind === "texture" && inspectorOpen && preview === null && (
          <TextureInspector
            item={selectedItem}
            preview={preview3d}
            onPreviewChange={patchPreview}
            onClose={toggleInspector}
            width={inspector.width}
          />
        )}
        {/* While the fullscreen preview is up the inspector unmounts (one WebGL
            context, not two). Reserve its width with a spacer so the grid keeps
            the same column count — otherwise it reflows open then reflows back
            on Escape, snapping the scroll to a fresh row-aligned offset. */}
        {kind !== "audio" && inspectorOpen && preview !== null && (
          <div aria-hidden className="shrink-0" style={{ width: inspector.width }} />
        )}
      </div>
      {preview !== null && (
        <FullscreenPreview
          file={preview}
          item={preview.kind === "texture" ? selectedItem : null}
          preview3d={preview3d}
          onPreviewChange={patchPreview}
          onClose={() => setPreview(null)}
        />
      )}
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
              label: "Show in navigator",
              icon: FolderTreeIcon,
              onClick: () => revealInNavigator(menu.file.path),
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
