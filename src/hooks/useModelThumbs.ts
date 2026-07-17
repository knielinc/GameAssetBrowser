import { useCallback, useEffect, useRef } from "react";
import { useLibraryStore, type LibFile } from "../stores/libraryStore";

/**
 * Lazy model thumbnails for the visible grid window.
 *
 * The thumbQueue module is imported DYNAMICALLY and nothing else references
 * it, which is what keeps ~600 KB of `three` out of the main chunk: a single
 * eager runtime import from any module the Audio tab touches would drag it all
 * in and make the lazy boundary decorative.
 *
 * Returns the `onVisibleRange` callback for AssetGrid.
 */
export function useModelThumbs(files: readonly LibFile[], enabled: boolean): (start: number, end: number) => void {
  const filesRef = useRef(files);
  filesRef.current = files;
  const timer = useRef<number | undefined>(undefined);
  const range = useRef<[number, number]>([0, 0]);

  // Subscribe once, so renders landing from the queue reach the store.
  useEffect(() => {
    if (!enabled) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    void import("../model/thumbQueue").then((m) => {
      if (cancelled) return;
      off = m.onModelThumb((id, key) => {
        useLibraryStore.getState().setModelThumbs([[id, key]]);
      });
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [enabled]);

  const flush = useCallback(() => {
    const [start, end] = range.current;
    const window = filesRef.current.slice(start, end);
    if (window.length === 0) return;
    void import("../model/thumbQueue").then(async (m) => {
      // Disk cache first — a hit costs one fs::metadata, a miss costs a full
      // FBX parse. Always ask before rendering.
      const hits = await m.lookupModelThumbs(window);
      if (hits.length > 0) useLibraryStore.getState().setModelThumbs(hits);
      const have = useLibraryStore.getState().thumbs;
      m.requestModelThumbs(window.filter((f) => !have.has(f.id)));
    });
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(
    (start: number, end: number) => {
      if (!enabled) return;
      range.current = [start, end];
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 150);
    },
    [enabled, flush],
  );
}
