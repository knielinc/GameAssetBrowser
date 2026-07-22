import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Flip to `compact` when a horizontal bar's inline content no longer fits, and
 * back when there's room again. Detection is genuine overflow (scrollWidth vs
 * clientWidth) rather than a guessed pixel breakpoint, so it adapts to whatever
 * a given bar actually renders. A hysteresis margin on the way back out stops it
 * oscillating around the threshold.
 *
 * Attach `ref` to the flex row and render its optional pieces only when
 * `!compact`; the row must be allowed to overflow (no wrap) for the measurement
 * to mean anything.
 */
export function useOverflowCollapse(): {
  ref: RefObject<HTMLDivElement | null>;
  compact: boolean;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(false);
  const collapseWidthRef = useRef(0);
  compactRef.current = compact;

  const measure = useCallback((): void => {
    const el = ref.current;
    if (el === null) return;
    if (!compactRef.current) {
      // Expanded: collapse once the content spills past the available width.
      if (el.scrollWidth > el.clientWidth + 1) {
        collapseWidthRef.current = el.clientWidth;
        setCompact(true);
      }
    } else if (el.clientWidth > collapseWidthRef.current + 64) {
      // Compact: expand again once we've clearly grown past where we collapsed.
      setCompact(false);
    }
  }, []);

  // Re-measure after every commit — an expand that still overflows re-collapses
  // on the next pass and settles (collapseWidth only ratchets up, so it converges).
  useLayoutEffect(measure);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  return { ref, compact };
}
