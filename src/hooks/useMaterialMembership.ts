import { useMemo } from "react";
import { scopePredicate, thumbInfos, useLibraryStore, type LibFile } from "../stores/libraryStore";
import { groupTextures } from "../material/classify";

/** What the grouping engine says about one texture. Total once computed —
 *  every texture is either in a multi-file material or standalone. */
export type MaterialMembership = "standalone" | "grouped";

/**
 * SCOPE-level material membership for every texture in the current folder
 * scope — deliberately independent of query/filters (deriving from the visible
 * list would be circular) and of the "Group materials" display toggle. Same
 * engine and recompute cadence as TabPane's grouped memo: groupTextures over
 * scoped textures, re-run as thumb batches land (content can regroup files;
 * that self-corrects — thumbsVersion is a dep).
 *
 * `enabled` gates the O(n) pass: pass false and the memo returns null so idle
 * browsing pays nothing. Callers: useVisibleFiles enables it only while the
 * material facet is active; FilterPopup enables it while mounted (i.e. open).
 * Both at once doubles the pass — the cost TabPane already accepts.
 */
export function useMaterialMembership(
  enabled: boolean,
): Map<number, MaterialMembership> | null {
  const allFiles = useLibraryStore((s) => s.allFiles);
  const folderScopes = useLibraryStore((s) => s.folderScopes);
  const hiddenFolders = useLibraryStore((s) => s.hiddenFolders);
  const thumbsVersion = useLibraryStore((s) => s.thumbsVersion);
  return useMemo(() => {
    if (!enabled) return null;
    const inScope = scopePredicate(folderScopes, hiddenFolders);
    const scoped: LibFile[] = [];
    for (const f of allFiles) {
      if (f.kind !== "texture") continue;
      if (!inScope(f.path)) continue;
      scoped.push(f);
    }
    const map = new Map<number, MaterialMembership>();
    for (const it of groupTextures(scoped, thumbInfos())) {
      if (it.kind === "file") {
        // Lone files AND single-file "groups" both arrive as kind:"file".
        map.set(it.file.id, "standalone");
      } else {
        for (const m of it.material.members) map.set(m.file.id, "grouped");
      }
    }
    return map;
  }, [enabled, allFiles, folderScopes, hiddenFolders, thumbsVersion]);
}
