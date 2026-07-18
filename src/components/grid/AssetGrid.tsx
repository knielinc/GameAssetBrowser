import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { gridNavRef, scrollToIndexRef } from "../../hooks/useKeyboardShortcuts";
import { useLibraryStore } from "../../stores/libraryStore";
import ThumbGLOverlay from "./ThumbGLOverlay";

const GAP = 12;
const PAD = 14;
/** Cell chrome below the square thumbnail: name + sub-line. */
export const CELL_META_HEIGHT = 42;

export interface AssetGridProps<T> {
  items: readonly T[];
  cellSize: number;
  getKey: (item: T) => string;
  renderCell: (item: T, index: number) => ReactNode;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onContextMenu: (index: number, e: MouseEvent<HTMLDivElement>) => void;
  /** Flat [start, end) item range currently rendered (incl. overscan). Drives
   *  lazy thumbnail requests — decoding 2000 textures eagerly is not an
   *  option at any concurrency. */
  onVisibleRange?: (start: number, end: number) => void;
  /** Paint thumbnails through the shared WebGL canvas behind the grid — cells
   *  must render `[data-thumb-key]` holes (see TextureCell `gl`). */
  glThumbs?: boolean;
}

/**
 * Virtualized wrapping grid.
 *
 * ROW-ONLY virtualization on purpose. react-virtual can pair a column
 * virtualizer, but that is for grids scrolling in both axes — here every
 * column is on screen, so virtualizing that axis buys nothing and adds a
 * second source of measurement bugs. Structurally this is FileList's row loop
 * with N cells per row.
 */
export default function AssetGrid<T>({
  items,
  cellSize,
  getKey,
  renderCell,
  selectedIndex,
  onSelect,
  onContextMenu,
  onVisibleRange,
  glThumbs,
}: AssetGridProps<T>): ReactElement {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  // The WebGL overlay measures the DOM each frame, so it only needs a nudge
  // when the slots move for a reason other than scroll/resize: a new item set
  // (filter, group toggle) or a decode landing (a 404'd fetch can now succeed).
  const thumbsVersion = useLibraryStore((s) => s.thumbsVersion);
  const [glRevision, setGlRevision] = useState(0);
  useEffect(() => {
    if (glThumbs === true) setGlRevision((r) => r + 1);
  }, [items, thumbsVersion, glThumbs]);

  // Column count comes from the live container width, so the grid reflows when
  // the sidebar or inspector is dragged.
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (el === null) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const usable = Math.max(0, width - PAD * 2);
  const columns = Math.max(1, Math.floor((usable + GAP) / (cellSize + GAP)));
  // Cells STRETCH to fill (minmax(cellSize, 1fr)), so the rendered width is
  // >= cellSize. The thumb is aspect-square, so its height follows that real
  // width — deriving rowHeight from cellSize instead let every row under-
  // estimate itself and the rows overlapped.
  const cellWidth = columns > 0 ? (usable - (columns - 1) * GAP) / columns : cellSize;
  const rowHeight = Math.ceil(cellWidth + CELL_META_HEIGHT + GAP);
  const rowCount = Math.ceil(items.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
  });

  // Keep the first visible item anchored across a column-count change. The
  // total size changes with `columns`, so preserving raw scrollTop (what the
  // browser does) lands somewhere arbitrary. Anchor by INDEX, not pixels.
  const anchorRef = useRef(0);
  const prevColumns = useRef(columns);
  const virtualItems = virtualizer.getVirtualItems();
  const firstRow = virtualItems[0]?.index ?? 0;
  useEffect(() => {
    anchorRef.current = firstRow * prevColumns.current;
  }, [firstRow]);
  useLayoutEffect(() => {
    if (prevColumns.current === columns) return;
    prevColumns.current = columns;
    virtualizer.scrollToIndex(Math.floor(anchorRef.current / columns), { align: "start" });
  }, [columns, virtualizer]);

  // Register both nav contracts for the window-level keyboard handler:
  // scrollToIndex takes a FLAT item index (rows are an internal detail), and
  // gridNav supplies the ±columns step a 1-D list handler cannot know.
  useEffect(() => {
    scrollToIndexRef.current = (index: number) => {
      virtualizer.scrollToIndex(Math.floor(index / columns), { align: "auto" });
    };
    gridNavRef.current = { columns };
    return () => {
      scrollToIndexRef.current = null;
      gridNavRef.current = null;
    };
  }, [virtualizer, columns]);

  const handleContext = useCallback(
    (index: number, e: MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      onContextMenu(index, e);
    },
    [onContextMenu],
  );

  // Report the rendered window so the owner can request just these thumbs.
  // Derived from the virtual rows, so it already includes overscan.
  const lastRow = virtualItems[virtualItems.length - 1]?.index ?? -1;
  useEffect(() => {
    if (onVisibleRange === undefined || lastRow < 0) return;
    // Wait for a real measured width. Before layout `width` is 0, which
    // collapses `columns` to 1 and makes `rowHeight` a wrong (tiny) estimate —
    // the virtualizer then renders far more rows than actually fit and we'd
    // request thumbnails for a big slab of the list instead of just what's on
    // screen. One frame later the ResizeObserver reports the true width and
    // this fires with the correct, small window.
    if (width === 0) return;
    onVisibleRange(firstRow * columns, Math.min(items.length, (lastRow + 1) * columns));
  }, [onVisibleRange, firstRow, lastRow, columns, items.length, width]);

  return (
    <div className="relative min-h-0 flex-1">
      {/* Behind the grid: one WebGL canvas paints every visible thumbnail. It
          shows through the cells' transparent `[data-thumb-key]` holes, so it
          must sit under the scroll layer (z-0 vs z-10). */}
      {glThumbs === true && <ThumbGLOverlay scrollRef={parentRef} revision={glRevision} />}
      <div
        ref={parentRef}
        className="absolute inset-0 z-10 overflow-x-hidden overflow-y-scroll"
      >
      <div style={{ height: `${virtualizer.getTotalSize() + PAD * 2}px`, position: "relative" }}>
        {virtualItems.map((row) => {
          const start = row.index * columns;
          const rowItems = items.slice(start, start + columns);
          return (
            <div
              key={row.key}
              className="absolute left-0 top-0 grid w-full"
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gap: `${GAP}px`,
                padding: `0 ${PAD}px`,
                height: `${row.size}px`,
                transform: `translateY(${row.start + PAD}px)`,
              }}
            >
              {rowItems.map((item, i) => {
                const index = start + i;
                return (
                  <div
                    key={getKey(item)}
                    data-selected={index === selectedIndex || undefined}
                    onClick={() => onSelect(index)}
                    onContextMenu={(e) => handleContext(index, e)}
                  >
                    {renderCell(item, index)}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}
