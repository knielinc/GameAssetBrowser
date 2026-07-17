import { useEffect, useMemo, useState } from "react";
import { folderMatcher, useLibraryStore, type LibFile } from "../stores/libraryStore";
import type { AssetKind, SortField } from "../types";

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function makeComparator(
  field: SortField,
  durations: Map<number, number>,
): (a: LibFile, b: LibFile) => number {
  switch (field) {
    case "name":
      return (a, b) => (a.nameLower < b.nameLower ? -1 : a.nameLower > b.nameLower ? 1 : 0);
    case "size":
      return (a, b) => a.size - b.size;
    case "modified":
      return (a, b) => a.modified - b.modified;
    case "ext":
      return (a, b) =>
        a.ext < b.ext
          ? -1
          : a.ext > b.ext
            ? 1
            : a.nameLower < b.nameLower
              ? -1
              : a.nameLower > b.nameLower
                ? 1
                : 0;
    case "duration":
      // Unknown durations sort as Infinity (always after known ones, asc).
      return (a, b) => {
        const da = durations.get(a.id) ?? Infinity;
        const db = durations.get(b.id) ?? Infinity;
        return da < db ? -1 : da > db ? 1 : 0;
      };
  }
}

/**
 * The filtered + sorted view of ONE tab's slice of the library. Filtering and
 * sorting stay in JS — even at 50k files this is a handful of milliseconds,
 * and it never round-trips the list over IPC.
 *
 * Call this from inside TabPane, which is keyed on the active tab. The remount
 * that gives you is load-bearing: `useDebounced` holds React state, so without
 * it a tab switch would keep showing the previous tab's query for 100 ms.
 */
export function useVisibleFiles(kind: AssetKind): LibFile[] {
  const allFiles = useLibraryStore((s) => s.allFiles);
  const folderScope = useLibraryStore((s) => s.folderScope);
  const tab = useLibraryStore((s) => s.tabs[kind]);
  const durations = useLibraryStore((s) => s.durations);
  const durationsVersion = useLibraryStore((s) => s.durationsVersion);
  const { query, extFilter, sortField, sortDir } = tab;
  const debouncedQuery = useDebounced(query, 100);

  return useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    const hasQuery = q !== "";
    const hasExtFilter = extFilter.size > 0;
    // Folder scope narrows the library BEFORE query/ext filters apply.
    const inScope = folderScope === null ? null : folderMatcher(folderScope);

    // Always a filtering pass now — every tab shows a subset by kind — so the
    // old "copy the whole array" fast path can't apply.
    const files: LibFile[] = [];
    for (const f of allFiles) {
      if (f.kind !== kind) continue;
      if (inScope !== null && !inScope(f.path)) continue;
      if (hasExtFilter && !extFilter.has(f.ext)) continue;
      if (hasQuery && !f.nameLower.includes(q)) continue;
      files.push(f);
    }

    if (files.length > 1) {
      const cmp = makeComparator(sortField, durations);
      const dir = sortDir === "asc" ? 1 : -1;
      files.sort((a, b) => dir * cmp(a, b));
    }
    return files;
  }, [kind, allFiles, folderScope, debouncedQuery, extFilter, sortField, sortDir, durations, durationsVersion]);
}

/** Count of one kind inside the active folder scope — the status bar's
 *  denominator. Same scope rule as above, minus the query/ext filters. */
export function useScopeCount(kind: AssetKind): number {
  const allFiles = useLibraryStore((s) => s.allFiles);
  const folderScope = useLibraryStore((s) => s.folderScope);
  return useMemo(() => {
    const inScope = folderScope === null ? null : folderMatcher(folderScope);
    let n = 0;
    for (const f of allFiles) {
      if (f.kind !== kind) continue;
      if (inScope !== null && !inScope(f.path)) continue;
      n++;
    }
    return n;
  }, [kind, allFiles, folderScope]);
}
