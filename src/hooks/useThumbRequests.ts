import { useCallback, useEffect, useRef } from "react";
import { requestThumbs } from "../ipc/commands";
import { useLibraryStore, type LibFile } from "../stores/libraryStore";

/** Coalesce scroll churn into one invoke. Short enough to feel instant,
 *  long enough that a flick doesn't fire twenty requests. */
const DEBOUNCE_MS = 120;

/**
 * Request thumbnails for whatever the grid currently shows.
 *
 * Lazy is not an optimization here, it's the only design: a folder of 2000 4K
 * textures cannot be decoded eagerly at any concurrency. The backend keeps a
 * generation counter and drains LIFO, so a fast scroll drops the fly-over
 * cells and renders what's under the cursor.
 *
 * Returns the `onVisibleRange` callback to hand to AssetGrid.
 */
export function useThumbRequests(files: readonly LibFile[], enabled: boolean): (start: number, end: number) => void {
  const filesRef = useRef(files);
  filesRef.current = files;
  const timer = useRef<number | undefined>(undefined);
  const range = useRef<[number, number]>([0, 0]);
  /** Ids already sent for the current file set — never ask twice. */
  const asked = useRef(new Set<number>());

  // The file set changed (filter, scope, rescan) → previous asks are moot.
  useEffect(() => {
    asked.current.clear();
  }, [files]);

  // Re-arm the debounce after ids come back un-asked, so the cells that are
  // still on screen get picked up on the next tick rather than waiting for
  // the user to scroll again.
  const scheduleRef = useRef<(() => void) | undefined>(undefined);
  const schedule = useCallback(() => scheduleRef.current?.(), []);

  const flush = useCallback(() => {
    const [start, end] = range.current;
    const have = useLibraryStore.getState().thumbs;
    const items: [number, string][] = [];
    for (let i = start; i < end; i++) {
      const f = filesRef.current[i];
      if (f === undefined) continue;
      // Only kinds whose thumbnail is a Rust decode go through request_thumbs:
      // textures (image decode) and audio (cover art / waveform). Models render
      // in the webview (useModelThumbs) and documents render in-cell — skipping
      // them here matters for the mixed "all" grid, which drives both hooks over
      // the same visible range.
      if (f.kind !== "texture" && f.kind !== "audio") continue;
      if (have.has(f.id) || asked.current.has(f.id)) continue;
      asked.current.add(f.id);
      items.push([f.id, f.path]);
    }
    if (items.length === 0) return;
    void requestThumbs(items)
      .then((dropped) => {
        // Each request supersedes the last, so anything still queued from a
        // previous one is abandoned. Those ids are already in `asked` and
        // would never be requested again — their cells would stay blank
        // forever, with no error anywhere. Un-ask them so the next flush
        // picks up whatever is still on screen.
        for (const id of dropped) asked.current.delete(id);
        if (dropped.length > 0) schedule();
      })
      .catch((err: unknown) => {
        // Same reasoning for an outright failure.
        for (const [id] of items) asked.current.delete(id);
        console.error("request_thumbs failed", err);
      });
  }, []);

  const arm = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, DEBOUNCE_MS);
  }, [flush]);
  scheduleRef.current = arm;

  useEffect(() => {
    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    };
  }, []);

  return useCallback(
    (start: number, end: number) => {
      if (!enabled) return;
      range.current = [start, end];
      arm();
    },
    [enabled, arm],
  );
}
