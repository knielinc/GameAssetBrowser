import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
} from "react";
import clsx from "clsx";
import {
  BookmarkMinus,
  BookmarkPlus,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  FolderOpen,
  FolderTree as FolderTreeIcon,
  Image as ImageIcon,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SORT_FIELDS_BY_KIND, type AssetKind, type SortField } from "../types";
import { copyImageToClipboard, openWith, showInExplorer } from "../ipc/commands";
import { activeFilterCount, useLibraryStore, type LibFile } from "../stores/libraryStore";
import { revealInNavigator } from "../stores/revealFolder";
import { toggleFavoriteSmart, useFavoritesStore } from "../stores/favoritesStore";
import { appsForKind, useExternalAppsStore } from "../stores/externalApps";
import { armDragOut } from "../dragOut";
import { hoverPlay, hoverStop, loadAndSelect, usePlayerStore } from "../stores/playerStore";
import { scrollToIndexRef } from "../hooks/useKeyboardShortcuts";
import type { TextureItem } from "../material/classify";
import ContextMenu from "./ContextMenu";
import CollectionPopup from "./CollectionPopup";
import FileRow, { MaterialRow, rowGrid } from "./FileRow";

const ROW_HEIGHT = 28;
/** Hover-preview dwell before a row auditions — long enough that mousing
 *  across the list to the scrollbar doesn't fire a stray play. */
const HOVER_PREVIEW_MS = 350;

interface HeaderSpec {
  field: SortField;
  label: string;
  alignRight?: boolean;
}

const ALL_HEADERS: HeaderSpec[] = [
  { field: "name", label: "Name" },
  { field: "ext", label: "Type" },
  { field: "size", label: "Size", alignRight: true },
  { field: "modified", label: "Modified", alignRight: true },
  { field: "duration", label: "Length", alignRight: true },
];

/** Columns follow the same per-kind gate as the sort dropdown, so a texture
 *  list can neither show nor sort by "Length". */
function headersFor(kind: AssetKind): HeaderSpec[] {
  const allowed = SORT_FIELDS_BY_KIND[kind];
  return ALL_HEADERS.filter((h) => allowed.includes(h.field));
}

/** Channel-count shorthand: mono/stereo dominate game audio; the common
 *  surround layouts get their familiar names, anything exotic its raw count. */
function channelLabel(n: number): string {
  if (n === 1) return "mo";
  if (n === 2) return "st";
  if (n === 6) return "5.1";
  if (n === 8) return "7.1";
  return `${n}ch`;
}

/** Compact audio format readout, e.g. `44.1k · 16-bit · st`. Unknown (0)
 *  parts are omitted — a lossy mp3 has no bit depth but still shows rate +
 *  channels. Empty string until the probe has reported the file. */
function formatAudioMeta(
  meta: readonly [rate: number, channels: number, bits: number] | undefined,
): string {
  if (meta === undefined) return "";
  const [rate, channels, bits] = meta;
  const parts: string[] = [];
  // Number formatting keeps only meaningful decimals: 48000 → "48k",
  // 44100 → "44.1k", 22050 → "22.05k".
  if (rate > 0) parts.push(`${rate / 1000}k`);
  if (bits > 0) parts.push(`${bits}-bit`);
  if (channels > 0) parts.push(channelLabel(channels));
  return parts.join(" · ");
}

export interface FileListProps {
  kind: AssetKind;
  files: LibFile[];
  /** When set (texture list + grouping on), rows are grouped materials + loose
   *  files instead of the flat file list; selection keys off each item's key. */
  items?: TextureItem[];
}

/**
 * Resolve a selection (row/cell keys, kept in visible order) to concrete file
 * paths for clipboard actions. In the grouped texture view a selected material
 * contributes every member map's path — its group key names nothing on disk.
 * Shared with TabPane's grid context menu.
 */
export function selectionFilePaths(
  selected: ReadonlySet<string>,
  files: readonly LibFile[],
  items?: readonly TextureItem[],
): string[] {
  const out: string[] = [];
  if (items !== undefined) {
    for (const it of items) {
      if (!selected.has(it.key)) continue;
      if (it.kind === "material") {
        for (const m of it.material.members) out.push(m.file.path);
      } else {
        out.push(it.file.path);
      }
    }
    return out;
  }
  for (const f of files) if (selected.has(f.path)) out.push(f.path);
  return out;
}

/** An open row context menu: where it sits, its single-target file, and the
 *  selection it acts on (`paths` for the clipboard, `count` for the label). */
interface RowMenu {
  x: number;
  y: number;
  file: LibFile;
  paths: string[];
  count: number;
}

export default function FileList({ kind, files, items }: FileListProps): ReactElement {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const rowCount = items ? items.length : files.length;

  const tab = useLibraryStore((s) => s.tabs[kind]);
  const { selectedPath, selectedPaths, sortField, sortDir } = tab;
  // The focus ring only carries information while a real multi-selection
  // exists — single selection keeps its classic look.
  const multiSelect = selectedPaths.size > 1;
  const durations = useLibraryStore((s) => s.durations);
  const audioMeta = useLibraryStore((s) => s.audioMeta);
  // Map identity is stable across merges — subscribe to the version counter so
  // Format cells refresh as probe batches land.
  useLibraryStore((s) => s.audioMetaVersion);
  const setSort = useLibraryStore((s) => s.setSort);
  const clearFilters = useLibraryStore((s) => s.clearFilters);
  const anyFiles = useLibraryStore((s) => s.allFiles.length > 0);
  const folderScopes = useLibraryStore((s) => s.folderScopes);
  const hiddenFolders = useLibraryStore((s) => s.hiddenFolders);
  const currentPath = usePlayerStore((s) => s.currentPath);
  const playing = usePlayerStore((s) => s.playing);
  // Fresh Set identity per toggle, so the row props (plain booleans) recompute.
  const favorites = useFavoritesStore((s) => s.favorites);
  const collectionScope = useLibraryStore((s) => s.collectionScope);
  // "Open with…" targets for this kind (SettingsMenu → External apps…).
  const externalApps = useExternalAppsStore((s) => s.apps);
  const headers = headersFor(kind);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // Let the window-level keyboard handler keep the selection in view.
  useEffect(() => {
    scrollToIndexRef.current = (index: number) => {
      virtualizer.scrollToIndex(index, { align: "auto" });
    };
    return () => {
      scrollToIndexRef.current = null;
    };
  }, [virtualizer]);

  // Each folder-scope change starts the list at the top. Without this the
  // scroll container keeps its old scrollTop across non-empty → non-empty
  // scope switches (it never unmounts), and the browser clamps that stale
  // offset to the collapsed spacer height — landing at the list's bottom.
  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [folderScopes, hiddenFolders, virtualizer]);

  // Stable click handler so memo'd rows never re-render from a callback churn.
  // Plain click keeps the old behavior (audio loads into the player, grouped
  // rows select by key); Ctrl toggles membership and Shift range-selects from
  // the anchor — both are pure selection ops that never load/play, so
  // auditioning stays a deliberate plain-click/arrow gesture.
  const onSelect = useCallback((index: number, e: MouseEvent<HTMLDivElement>) => {
    const its = itemsRef.current;
    const kind = kindRef.current;
    const lib = useLibraryStore.getState();
    // Grouped: a material has no single path, so selection keys off item keys.
    const key = its !== undefined ? its[index]?.key : filesRef.current[index]?.path;
    if (key === undefined) return;
    if (e.shiftKey) {
      const order = its !== undefined ? its.map((i) => i.key) : filesRef.current.map((f) => f.path);
      lib.rangeSelect(kind, index, key, order);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      lib.toggleSelect(kind, index, key);
      return;
    }
    if (its !== undefined || kind !== "audio") {
      lib.select(kind, index, key);
      return;
    }
    loadAndSelect(filesRef.current[index]!, index);
  }, []);

  // Hover preview (audio only, opt-in): a 350 ms dwell on a row auditions it
  // without selecting; leaving cancels the pending timer or stops a fired
  // preview. hoverStop() is a no-op once a deliberate gesture (click/arrow)
  // claims playback, so click-then-leave never cuts the chosen track.
  const hoverPreview = usePlayerStore((s) => s.hoverPreview);
  const hoverTimerRef = useRef<number | undefined>(undefined);
  const onRowHoverStart = useCallback((index: number, e: MouseEvent<HTMLDivElement>) => {
    // Any held button (drag-select, scrollbar drag passing over rows, an
    // in-progress click) suppresses the preview outright.
    if (e.buttons !== 0) return;
    if (hoverTimerRef.current !== undefined) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = undefined;
      const file = filesRef.current[index];
      if (file !== undefined) hoverPlay(file);
    }, HOVER_PREVIEW_MS);
  }, []);
  const cancelHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== undefined) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = undefined;
    }
  }, []);
  const onRowHoverEnd = useCallback(() => {
    cancelHoverTimer();
    hoverStop();
  }, [cancelHoverTimer]);
  // Keyboard tab switches unmount the pane with no mouseleave — don't leave a
  // timer armed or a preview sounding.
  useEffect(
    () => () => {
      if (hoverTimerRef.current !== undefined) window.clearTimeout(hoverTimerRef.current);
      hoverStop();
    },
    [],
  );

  // Drag-out (stable like onSelect, resolved through the same refs): a press
  // that travels past the threshold becomes a native OS file drag. Paths are
  // resolved lazily AT the threshold: the full selection when the pressed row
  // is part of it, else just that row (a material row drags all its maps).
  // Under the threshold nothing fires and the press stays a click.
  const onRowDragOut = useCallback((index: number, e: MouseEvent<HTMLDivElement>) => {
    const its = itemsRef.current;
    const kind = kindRef.current;
    armDragOut(e, () => {
      const it = its?.[index];
      const key = its !== undefined ? it?.key : filesRef.current[index]?.path;
      if (key === undefined) return [];
      const sel = useLibraryStore.getState().tabs[kind].selectedPaths;
      if (sel.has(key)) {
        const paths = selectionFilePaths(sel, filesRef.current, its);
        if (paths.length > 0) return paths;
      }
      if (it !== undefined) {
        return it.kind === "material"
          ? it.material.members.map((m) => m.file.path)
          : [it.file.path];
      }
      const f = filesRef.current[index];
      return f !== undefined ? [f.path] : [];
    });
  }, []);

  // Stable like onSelect, resolved through the same refs. Grouped material
  // rows have no star slot, so only file-backed rows land here.
  const onToggleStar = useCallback((index: number) => {
    const its = itemsRef.current;
    const it = its?.[index];
    const path =
      its !== undefined
        ? it !== undefined && it.kind === "file"
          ? it.file.path
          : undefined
        : filesRef.current[index]?.path;
    if (path !== undefined) toggleFavoriteSmart(path);
  }, []);

  // Single menu state = at most one menu. Right-click INSIDE the selection
  // keeps it — the menu acts on all of it; outside, it collapses to the
  // clicked row first (Explorer convention). Either way it deliberately does
  // NOT load/auto-play. A right-click on another row lands here again after
  // ContextMenu's mousedown close, so the menu re-opens at the new position.
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // "Add to collection…" chooser, anchored where the context menu was — it
  // opens as the menu closes, carrying the same selection snapshot.
  const [colPopup, setColPopup] = useState<{ x: number; y: number; paths: string[] } | null>(null);
  const onRowContextMenu = useCallback((index: number, e: MouseEvent<HTMLDivElement>) => {
    const its = itemsRef.current;
    const kind = kindRef.current;
    const lib = useLibraryStore.getState();
    const it = its?.[index];
    const key = its !== undefined ? it?.key : filesRef.current[index]?.path;
    if (key === undefined) return;
    const file =
      it !== undefined
        ? it.kind === "material"
          ? it.material.members[0]!.file
          : it.file
        : filesRef.current[index]!;
    if (!lib.tabs[kind].selectedPaths.has(key)) {
      lib.select(kind, index, key);
    }
    // Re-read after the possible collapse; snapshot the acted-on paths now so
    // the menu is immune to selection churn while it is open.
    const sel = useLibraryStore.getState().tabs[kind].selectedPaths;
    const paths = selectionFilePaths(sel, filesRef.current, its);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      file,
      paths: paths.length > 0 ? paths : [file.path],
      count: sel.size,
    });
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* pr-[10px] mirrors the scrollbar width so header and rows align. */}
      <div className="shrink-0 pr-[10px] shadow-[inset_0_-1px_0_var(--color-bg)]">
        <div className={clsx(rowGrid(kind === "audio"), "h-8")}>
          {headers.map((h) => (
            <Fragment key={h.field}>
              {/* Format sits before Length but is display-only (no new sort
                  fields), so it can't join ALL_HEADERS — headers are sort
                  buttons keyed by SortField. */}
              {h.field === "duration" && (
                <span className="flex items-center justify-end text-[10px] font-medium uppercase tracking-widest text-dim">
                  Format
                </span>
              )}
              <button
                type="button"
                onClick={() => setSort(kind, h.field)}
                className={clsx(
                  "flex items-center gap-1 text-[10px] font-medium uppercase tracking-widest transition-colors duration-[120ms]",
                  h.alignRight && "justify-end",
                  sortField === h.field ? "text-text" : "text-dim hover:text-text",
                )}
              >
                {h.label}
                {sortField === h.field &&
                  (sortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
              </button>
            </Fragment>
          ))}
        </div>
      </div>

      {rowCount === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center text-xs text-dim">
          {anyFiles ? "Nothing matches the current filters" : "Nothing found for this tab"}
          {activeFilterCount(kind, tab) > 0 && (
            <button type="button" className="chip mt-2" onClick={() => clearFilters(kind)}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div
          ref={parentRef}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-scroll"
          // A press anywhere in the list (click, drag, scrollbar) kills any
          // pending hover-preview dwell — enter-time e.buttons only catches
          // buttons held BEFORE the row was entered. No-op on non-audio.
          onMouseDownCapture={cancelHoverTimer}
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((row) => {
              const it = items?.[row.index];
              const file = it === undefined ? files[row.index] : undefined;
              if (it === undefined && file === undefined) return null;
              return (
                <div
                  key={row.key}
                  className="absolute left-0 top-0 w-full"
                  style={{ height: `${row.size}px`, transform: `translateY(${row.start}px)` }}
                >
                  {it !== undefined ? (
                    it.kind === "material" ? (
                      <MaterialRow
                        index={row.index}
                        material={it.material}
                        selected={selectedPaths.has(it.key)}
                        focused={multiSelect && it.key === selectedPath}
                        onSelect={onSelect}
                        onContextMenu={onRowContextMenu}
                        onDragOut={onRowDragOut}
                      />
                    ) : (
                      <FileRow
                        index={row.index}
                        name={it.file.name}
                        ext={it.file.ext}
                        size={it.file.size}
                        modified={it.file.modified}
                        durationSeconds={undefined}
                        formatLabel={undefined}
                        showDuration={false}
                        starred={favorites.has(it.file.path)}
                        onToggleStar={onToggleStar}
                        selected={selectedPaths.has(it.key)}
                        focused={multiSelect && it.key === selectedPath}
                        playing={false}
                        onSelect={onSelect}
                        onContextMenu={onRowContextMenu}
                        onDragOut={onRowDragOut}
                      />
                    )
                  ) : (
                    <FileRow
                      index={row.index}
                      name={file!.name}
                      ext={file!.ext}
                      size={file!.size}
                      modified={file!.modified}
                      durationSeconds={durations.get(file!.id)}
                      formatLabel={
                        kind === "audio" ? formatAudioMeta(audioMeta.get(file!.id)) : undefined
                      }
                      showDuration={kind === "audio"}
                      starred={favorites.has(file!.path)}
                      onToggleStar={onToggleStar}
                      selected={selectedPaths.has(file!.path)}
                      focused={multiSelect && file!.path === selectedPath}
                      playing={kind === "audio" && playing && file!.path === currentPath}
                      onSelect={onSelect}
                      onContextMenu={onRowContextMenu}
                      onDragOut={onRowDragOut}
                      onHoverStart={kind === "audio" && hoverPreview ? onRowHoverStart : undefined}
                      onHoverEnd={kind === "audio" && hoverPreview ? onRowHoverEnd : undefined}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
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
              // Acts on the whole selection; Show in Explorer above stays
              // single-target (the clicked row) on purpose.
              label: menu.count > 1 ? `Copy paths (${menu.count})` : "Copy path",
              icon: Copy,
              onClick: () => {
                navigator.clipboard.writeText(menu.paths.join("\n")).catch((err: unknown) => {
                  console.error("clipboard write failed", err);
                });
              },
            },
            // Textures only, single-target like Show in Explorer — the OS
            // clipboard holds one image. HDR/EXR land tone-mapped (as shown).
            ...(kind === "texture"
              ? [
                  {
                    label: "Copy image",
                    icon: ImageIcon,
                    onClick: () => {
                      copyImageToClipboard(menu.file.path).catch((err: unknown) => {
                        console.warn("copy_image_to_clipboard failed", err);
                      });
                    },
                  },
                ]
              : []),
            {
              // Whole selection, like Copy paths (materials expand to members).
              label: menu.count > 1 ? `Add to collection… (${menu.count})` : "Add to collection…",
              icon: BookmarkPlus,
              onClick: () => setColPopup({ x: menu.x, y: menu.y, paths: menu.paths }),
            },
            // One entry per registered app of this kind (External apps…),
            // single-target: an editor opens one document, not a selection.
            ...appsForKind(externalApps, kind).map((a) => ({
              label: `Open with ${a.name}`,
              icon: ExternalLink,
              onClick: () => {
                openWith(a.exe, menu.file.path).catch((err: unknown) => {
                  console.error("open_with failed", err);
                });
              },
            })),
            // Only while browsing a user collection — the one place "remove"
            // has an unambiguous target. Favorites/Recent are not collections.
            ...(collectionScope !== null && collectionScope.startsWith("col:")
              ? [
                  {
                    label: menu.count > 1 ? `Remove from collection (${menu.count})` : "Remove from collection",
                    icon: BookmarkMinus,
                    onClick: () => {
                      useFavoritesStore
                        .getState()
                        .removeFromCollection(collectionScope.slice(4), menu.paths);
                    },
                  },
                ]
              : []),
          ]}
        />
      )}

      {colPopup !== null && (
        <CollectionPopup
          x={colPopup.x}
          y={colPopup.y}
          paths={colPopup.paths}
          onClose={() => setColPopup(null)}
        />
      )}
    </div>
  );
}
