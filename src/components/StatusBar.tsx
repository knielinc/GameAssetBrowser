import { useMemo, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { activeFilterCount, basename, facetActive, useLibraryStore, type TabFilters } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { useThumbProgress } from "../stores/thumbProgress";
import { useScopeCount } from "../hooks/useVisibleFiles";
import { humanSize } from "./FileRow";
import { FILTER_FACETS_BY_KIND, NOUN, type AssetKind, type TabFilterSettings } from "../types";

const FACET_LABEL: Record<keyof TabFilterSettings, string> = {
  duration: "Length",
  modified: "Modified",
  channels: "Channel",
  material: "Material",
  res: "Resolution",
  square: "Square",
  pot: "Power of two",
  size: "File size",
  colors: "Color",
  audioChannels: "Channels",
  sampleRates: "Sample rate",
  favorite: "Favorite",
};

/** Comma-joined active facet names for the "· filtered" tooltip. */
function facetSummary(kind: AssetKind, f: TabFilters, extFilter: ReadonlySet<string>): string {
  const labels: string[] = extFilter.size > 0 ? ["Format"] : [];
  for (const facet of FILTER_FACETS_BY_KIND[kind]) {
    if (facetActive(f[facet])) labels.push(FACET_LABEL[facet]);
  }
  return labels.join(", ");
}

export interface StatusBarProps {
  kind: AssetKind;
  visibleCount: number;
}

export default function StatusBar({ kind, visibleCount }: StatusBarProps): ReactElement {
  const folderScopes = useLibraryStore((s) => s.folderScopes);
  const hiddenFolders = useLibraryStore((s) => s.hiddenFolders);
  const scanning = useLibraryStore((s) => s.scanning);
  const filters = useLibraryStore((s) => s.tabs[kind].filters);
  const extFilter = useLibraryStore((s) => s.tabs[kind].extFilter);
  const currentPath = usePlayerStore((s) => s.currentPath);
  // Model thumbnails render one at a time in the webview; show how many are
  // still queued so a slow folder reads as "working", not "frozen".
  const buildingThumbs = useThumbProgress((s) => s.modelRemaining);

  // Selected asset readout (bottom-right): its file size, and for an image its
  // real resolution. Subscribing to selectedPath + thumbsVersion re-runs the
  // lookups when the selection changes or a decode lands.
  const selectedPath = useLibraryStore((s) => s.tabs[kind].selectedPath);
  useLibraryStore((s) => s.thumbsVersion);
  const selectedFile =
    selectedPath === null
      ? null
      : (useLibraryStore.getState().allFiles.find((f) => f.path === selectedPath) ?? null);
  const info =
    selectedFile !== null ? useLibraryStore.getState().thumbs.get(selectedFile.id)?.info : undefined;
  const resolution =
    kind === "texture" && info != null && info.sourceWidth > 0
      ? `${info.sourceWidth.toLocaleString()} × ${info.sourceHeight.toLocaleString()}`
      : null;

  // Multi-selection readout: `N selected · total size`. The size sum is one
  // pass over allFiles, memoized on the Set's identity (every selection action
  // builds a fresh Set). In the grouped texture view material keys are no file
  // paths and contribute no bytes — the count still reflects selected items.
  const selectedPaths = useLibraryStore((s) => s.tabs[kind].selectedPaths);
  const selCount = selectedPaths.size;
  const selBytes = useMemo(() => {
    if (selectedPaths.size < 2) return 0;
    let sum = 0;
    for (const f of useLibraryStore.getState().allFiles) {
      if (selectedPaths.has(f.path)) sum += f.size;
    }
    return sum;
  }, [selectedPaths]);

  // Denominator = files OF THIS KIND in the current scope (minus hidden), so
  // "N / M" reads "visible after filters / total of this kind in what I'm
  // looking at". (Per-kind here, while pruneFolders in libraryStore keeps a
  // scope alive on any-kind evidence — opposite directions on purpose: a scope
  // must survive a tab switch.)
  const scopeCount = useScopeCount(kind);

  // "in …": name the single scoped folder, else how many. A trailing hidden
  // count reminds the user why some content is missing from the list.
  const scopeLabel =
    folderScopes.length === 0
      ? null
      : folderScopes.length === 1
        ? `in ${basename(folderScopes[0]!)}`
        : `in ${folderScopes.length} folders`;

  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-x border-bg bg-panel px-3 text-[11px] text-dim">
      <span className="tabular-nums">
        {visibleCount.toLocaleString()} / {scopeCount.toLocaleString()} {NOUN[kind]}
      </span>
      {selCount > 1 && (
        <span className="tabular-nums text-text">
          {selCount.toLocaleString()} selected · {humanSize(selBytes)}
        </span>
      )}
      {activeFilterCount(kind, { filters, extFilter }) > 0 && (
        <span className="text-accent" title={facetSummary(kind, filters, extFilter)}>
          · filtered
        </span>
      )}
      {scopeLabel !== null && (
        <span className="max-w-[30%] truncate" title={folderScopes.join("\n")}>
          {scopeLabel}
        </span>
      )}
      {hiddenFolders.length > 0 && (
        <span className="text-dim" title={hiddenFolders.join("\n")}>
          {hiddenFolders.length} hidden
        </span>
      )}
      {scanning && (
        <span className="flex items-center gap-1.5 text-accent">
          <Loader2 size={11} className="animate-spin" />
          scanning…
        </span>
      )}
      {kind === "model" && buildingThumbs > 0 && (
        <span className="flex items-center gap-1.5 text-accent">
          <Loader2 size={11} className="animate-spin" />
          <span className="tabular-nums">
            building {buildingThumbs.toLocaleString()} {buildingThumbs === 1 ? "preview" : "previews"}…
          </span>
        </span>
      )}
      <span className="flex-1" />
      {currentPath !== null && (
        <span className="max-w-[35%] truncate" title={currentPath}>
          {basename(currentPath)}
        </span>
      )}
      {selectedFile !== null && (
        <span className="tabular-nums text-dim">
          {humanSize(selectedFile.size)}
          {resolution !== null && <span className="ml-3 text-text">{resolution}</span>}
        </span>
      )}
    </div>
  );
}
