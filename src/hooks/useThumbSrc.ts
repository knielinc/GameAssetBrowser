import { useEffect, useMemo, useRef, useState } from "react";
import { useLibraryStore, type LibFile } from "../stores/libraryStore";
import { thumbKeyFor, type ThumbKind } from "../thumbKey";
import { thumbUrl, type ThumbInfo } from "../types";

export interface ThumbSrc {
  /** thumb:// URL to show, or null while a known miss is being decoded. */
  src: string | null;
  /** The bare cache key — what the WebGL grid feeds to the `tex://` atlas. */
  cacheKey: string;
  /** Force-remounts the <img> only when a retry is actually needed. */
  imgKey: string;
  onError: () => void;
  onLoad: () => void;
  /** Content stats, once decoded — drives the classifier badges. */
  info: ThumbInfo | null;
}

/**
 * The instant-thumbnail path.
 *
 * On a warm cache the key is fully determined by (path, size, mtime), so we
 * point the <img> at the derived `thumb://` URL right away — WebView2 serves
 * the cached PNG from disk with zero IPC, no debounce, no batch event. The
 * separate request in useThumbRequests still runs to produce the content stats
 * (and to decode a genuine miss); when that lands, `info` fills in the badges,
 * and a cell that 404'd on the optimistic try is retried exactly once.
 */
export function useThumbSrc(file: LibFile, kind: ThumbKind = "t"): ThumbSrc {
  useLibraryStore((s) => s.thumbsVersion); // re-render when a batch lands
  const stored = useLibraryStore.getState().thumbs.get(file.id);

  const derived = useMemo(
    () => thumbKeyFor(file.path, file.size, file.modified, kind),
    [file.path, file.size, file.modified, kind],
  );

  const [attempt, setAttempt] = useState(0);
  const [broken, setBroken] = useState(false);
  const brokeRef = useRef(false);
  /** How many times we've asked for a re-decode after a 404 on a key we hold.
   *  Bounded so a file that genuinely cannot be decoded can't loop. */
  const reasked = useRef(0);

  // The virtualizer reuses a mounted cell for a new file — reset on identity.
  useEffect(() => {
    brokeRef.current = false;
    reasked.current = 0;
    setBroken(false);
    setAttempt(0);
  }, [file.path]);

  // A real decode landed after we optimistically 404'd: the file now exists at
  // the same key, so retry once (a stable src wouldn't re-fetch on its own).
  useEffect(() => {
    if (stored !== undefined && brokeRef.current) {
      brokeRef.current = false;
      setBroken(false);
      setAttempt((a) => a + 1);
    }
  }, [stored]);

  const key = stored?.key ?? derived;
  return {
    src: broken && stored === undefined ? null : thumbUrl(key),
    cacheKey: key,
    imgKey: `${key}:${attempt}`,
    onError: () => {
      brokeRef.current = true;
      setBroken(true);
      // A key we were HANDED just 404'd, so the Rust pixel cache evicted it (a
      // miss on the optimistically-derived key is ordinary and needs none of
      // this — the pending request already covers it). Drop the record so the
      // decode is re-requested; the fresh `stored` then retries the <img> via
      // the effect above.
      if (stored !== undefined && reasked.current < 2) {
        reasked.current++;
        useLibraryStore.getState().forgetThumbs([stored.key]);
      }
    },
    onLoad: () => {
      reasked.current = 0;
      setBroken(false);
    },
    info: stored?.info ?? null,
  };
}
