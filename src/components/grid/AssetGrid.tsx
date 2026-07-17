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
}: AssetGridProps<T>): ReactElement {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

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
  const rowHeight = cellSize + CELL_META_HEIGHT + GAP;
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
    onVisibleRange(firstRow * columns, Math.min(items.length, (lastRow + 1) * columns));
  }, [onVisibleRange, firstRow, lastRow, columns, items.length]);

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-scroll">
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
  );
}
