import type { ReactElement } from "react";

export interface EmptyStateProps {
  /** True when the library has files but the current query/filters hide them
   *  all (→ offer a way out), vs the tab genuinely having nothing. */
  anyFiles: boolean;
  /** Whether any filter/query is active — gates the "Clear filters" chip. */
  hasFilters: boolean;
  onClearFilters: () => void;
}

/** The "nothing to show" placeholder shared by the grid (TabPane) and the list
 *  (FileList), so the two read identically. */
export default function EmptyState({ anyFiles, hasFilters, onClearFilters }: EmptyStateProps): ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-xs text-dim">
      {anyFiles ? "Nothing matches the current filters" : "Nothing found for this tab"}
      {hasFilters && (
        <button type="button" className="chip mt-2" onClick={onClearFilters}>
          Clear filters
        </button>
      )}
    </div>
  );
}
