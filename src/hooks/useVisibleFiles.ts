import { useEffect, useMemo, useState } from "react";
import { folderMatcher, useLibraryStore, type LibFile } from "../stores/libraryStore";
import type { AudioExt, SortField } from "../types";

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
 * The filtered + sorted view of the library. Filtering and sorting stay in JS
 * — even at 50k files this is a handful of milliseconds, and it never
 * round-trips the list over IPC.
 */
export function useVisibleFiles(): LibFile[] {
  const allFiles = useLibraryStore((s) => s.allFiles);
  const folderScope = useLibraryStore((s) => s.folderScope);
  const query = useLibraryStore((s) => s.query);
  const extFilter = useLibraryStore((s) => s.extFilter);
  const sortField = useLibraryStore((s) => s.sortField);
  const sortDir = useLibraryStore((s) => s.sortDir);
  const durations = useLibraryStore((s) => s.durations);
  const durationsVersion = useLibraryStore((s) => s.durationsVersion);
  const debouncedQuery = useDebounced(query, 100);

  return useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    const hasQuery = q !== "";
    const hasExtFilter = extFilter.size > 0;
    // Folder scope narrows the library BEFORE query/ext filters apply.
    const inScope = folderScope === null ? null : folderMatcher(folderScope);

    let files: LibFile[];
    if (!hasQuery && !hasExtFilter && inScope === null) {
      files = allFiles.slice();
    } else {
      files = [];
      for (const f of allFiles) {
        if (inScope !== null && !inScope(f.path)) continue;
        if (hasExtFilter && !extFilter.has(f.ext as AudioExt)) continue;
        if (hasQuery && !f.nameLower.includes(q)) continue;
        files.push(f);
      }
    }

    if (files.length > 1) {
      const cmp = makeComparator(sortField, durations);
      const dir = sortDir === "asc" ? 1 : -1;
      files.sort((a, b) => dir * cmp(a, b));
    }
    return files;
  }, [allFiles, folderScope, debouncedQuery, extFilter, sortField, sortDir, durations, durationsVersion]);
}
