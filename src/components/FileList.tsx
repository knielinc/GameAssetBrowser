import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
} from "react";
import clsx from "clsx";
import { ChevronDown, ChevronUp, Copy, FolderOpen } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SORT_FIELDS_BY_KIND, type AssetKind, type SortField } from "../types";
import { showInExplorer } from "../ipc/commands";
import { useLibraryStore, type LibFile } from "../stores/libraryStore";
import { loadAndSelect, usePlayerStore } from "../stores/playerStore";
import { scrollToIndexRef } from "../hooks/useKeyboardShortcuts";
import type { TextureItem } from "../material/classify";
import ContextMenu from "./ContextMenu";
import FileRow, { MaterialRow, rowGrid } from "./FileRow";

const ROW_HEIGHT = 28;

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

export interface FileListProps {
  kind: AssetKind;
  files: LibFile[];
  /** When set (texture list + grouping on), rows are grouped materials + loose
   *  files instead of the flat file list; selection keys off each item's key. */
  items?: TextureItem[];
}

/** An open row context menu: where it sits and which file it targets. */
interface RowMenu {
  x: number;
  y: number;
  file: LibFile;
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
  const { selectedPath, sortField, sortDir } = tab;
  const durations = useLibraryStore((s) => s.durations);
  const setSort = useLibraryStore((s) => s.setSort);
  const anyFiles = useLibraryStore((s) => s.allFiles.length > 0);
  const folderScope = useLibraryStore((s) => s.folderScope);
  const currentPath = usePlayerStore((s) => s.currentPath);
  const playing = usePlayerStore((s) => s.playing);
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
  }, [folderScope, virtualizer]);

  // Stable click handler so memo'd rows never re-render from a callback churn.
  // Only audio loads into the player; other kinds just move the selection.
  const onSelect = useCallback((index: number) => {
    const its = itemsRef.current;
    if (its !== undefined) {
      // Grouped: a material has no single path, so select by the item's key.
      const it = its[index];
      if (it !== undefined) useLibraryStore.getState().select(kindRef.current, index, it.key);
      return;
    }
    const file = filesRef.current[index];
    if (!file) return;
    if (kindRef.current === "audio") {
      loadAndSelect(file, index);
    } else {
      useLibraryStore.getState().select(kindRef.current, index, file.path);
    }
  }, []);

  // Single menu state = at most one menu. Right-click selects the row like a
  // left-click but deliberately does NOT load/auto-play it. A right-click on
  // another row lands here again after ContextMenu's mousedown close, so the
  // menu re-opens at the new cursor position.
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const onRowContextMenu = useCallback((index: number, e: MouseEvent<HTMLDivElement>) => {
    const its = itemsRef.current;
    if (its !== undefined) {
      const it = its[index];
      if (it === undefined) return;
      useLibraryStore.getState().select(kindRef.current, index, it.key);
      const file = it.kind === "material" ? it.material.members[0]!.file : it.file;
      setMenu({ x: e.clientX, y: e.clientY, file });
      return;
    }
    const file = filesRef.current[index];
    if (!file) return;
    useLibraryStore.getState().select(kindRef.current, index, file.path);
    setMenu({ x: e.clientX, y: e.clientY, file });
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* pr-[10px] mirrors the scrollbar width so header and rows align. */}
      <div className="shrink-0 pr-[10px] shadow-[inset_0_-1px_0_var(--color-bg)]">
        <div className={clsx(rowGrid(kind === "audio"), "h-8")}>
          {headers.map((h) => (
            <button
              key={h.field}
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
          ))}
        </div>
      </div>

      {rowCount === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-dim">
          {anyFiles ? "Nothing matches the current filters" : "Nothing found for this tab"}
        </div>
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-scroll">
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
                        selected={it.key === selectedPath}
                        onSelect={onSelect}
                        onContextMenu={onRowContextMenu}
                      />
                    ) : (
                      <FileRow
                        index={row.index}
                        name={it.file.name}
                        ext={it.file.ext}
                        size={it.file.size}
                        modified={it.file.modified}
                        durationSeconds={undefined}
                        showDuration={false}
                        selected={it.file.path === selectedPath}
                        playing={false}
                        onSelect={onSelect}
                        onContextMenu={onRowContextMenu}
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
                      showDuration={kind === "audio"}
                      selected={file!.path === selectedPath}
                      playing={kind === "audio" && playing && file!.path === currentPath}
                      onSelect={onSelect}
                      onContextMenu={onRowContextMenu}
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
    </div>
  );
}
