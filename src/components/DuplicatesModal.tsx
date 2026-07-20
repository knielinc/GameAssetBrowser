import { useEffect, useMemo, useState, type ReactElement } from "react";
import { listen } from "@tauri-apps/api/event";
import { Copy, FolderOpen, X } from "lucide-react";
import { cancelDuplicates, findDuplicates, showInExplorer } from "../ipc/commands";
import {
  DUPES_DONE,
  DUPES_PROGRESS,
  type DupeGroup,
  type DupeProgress,
  type DupesDone,
} from "../ipc/events";
import { useLibraryStore } from "../stores/libraryStore";
import { humanSize } from "./FileRow";

/** Directory containing `path` (Windows or POSIX separators). */
function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i < 0 ? path : path.slice(0, i);
}

/** Last path segment — local rather than importing basename to keep this
 *  modal's deps to the store value it snapshots. */
function nameOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * "Find duplicates…" modal (SettingsMenu). Mounting starts a backend hunt
 * over the current in-memory file list; unmounting cancels it. Listeners are
 * modal-scoped — registered before the run starts so a fast hunt over a tiny
 * library cannot finish before anyone is listening — and torn down on close.
 *
 * Deliberately NO delete action: this is a browser. The rows offer Show in
 * Explorer and Copy path so the cleanup happens where it belongs.
 */
export default function DuplicatesModal({ onClose }: { onClose: () => void }): ReactElement {
  const [progress, setProgress] = useState<DupeProgress | null>(null);
  const [groups, setGroups] = useState<DupeGroup[] | null>(null);

  useEffect(() => {
    let disposed = false;
    const unlistens: (() => void)[] = [];
    const start = async (): Promise<void> => {
      const unProgress = await listen<DupeProgress>(DUPES_PROGRESS, (e) => {
        setProgress(e.payload);
      });
      const unDone = await listen<DupesDone>(DUPES_DONE, (e) => {
        setGroups(e.payload.groups);
      });
      if (disposed) {
        // Closed while the listen() round-trips were in flight — the cleanup
        // below already ran with an empty list, so release here instead.
        unProgress();
        unDone();
        return;
      }
      unlistens.push(unProgress, unDone);
      // Snapshot, not subscription: a rescan mid-hunt changes ids but the hunt
      // is path-keyed, so the report stays valid for the moment it was asked.
      const files: [string, number][] = useLibraryStore
        .getState()
        .allFiles.map((f) => [f.path, f.size]);
      await findDuplicates(files);
    };
    start().catch((err: unknown) => console.error("[dupes] start failed", err));
    return () => {
      disposed = true;
      for (const un of unlistens) un();
      void cancelDuplicates().catch((err: unknown) => console.error("[dupes] cancel", err));
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    // Capture phase: beat the global shortcut handler (FullscreenPreview idiom).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const reclaimable = useMemo(
    () => (groups ?? []).reduce((sum, g) => sum + g.size * (g.paths.length - 1), 0),
    [groups],
  );

  const pct =
    progress === null || progress.total === 0
      ? 0
      : Math.min(100, (progress.done / progress.total) * 100);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-[600px] flex-col rounded-xl bg-raised shadow-e2">
        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
          <span className="text-[13px] font-medium">Duplicate files</span>
          {groups !== null && (
            <span className="text-[11px] tabular-nums text-dim">
              {groups.length.toLocaleString()} duplicate {groups.length === 1 ? "group" : "groups"}{" "}
              · {humanSize(reclaimable)} reclaimable
            </span>
          )}
          <button type="button" className="icon-btn ml-auto shrink-0" title="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {groups === null ? (
          <div className="px-4 pb-4 pt-2">
            <div className="mb-2 text-[12px] text-dim">
              {progress === null
                ? "Comparing file sizes…"
                : `Hashing ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} size-collision candidates…`}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg">
              <span
                className="block h-full rounded-full bg-accent transition-[width] duration-[120ms]"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        ) : groups.length === 0 ? (
          <div className="px-4 pb-6 pt-2 text-[12px] text-dim">
            No duplicates found — every file's content is unique.
          </div>
        ) : (
          <div className="facet-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {groups.map((g) => (
              <div key={g.paths[0]} className="mb-1 rounded-lg bg-bg/40 p-1.5">
                <div className="flex items-center gap-2 px-1 pb-1 text-[11px]">
                  <span className="font-medium tabular-nums text-text">
                    {g.paths.length} × {humanSize(g.size)}
                  </span>
                  <span className="tabular-nums text-faint">
                    {humanSize(g.size * (g.paths.length - 1))} wasted
                  </span>
                </div>
                {g.paths.map((p) => (
                  <div
                    key={p}
                    className="group flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors duration-[120ms] hover:bg-overlay"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] text-text" title={p}>
                        {nameOf(p)}
                      </div>
                      <div className="truncate font-mono text-[10px] text-faint">{dirOf(p)}</div>
                    </div>
                    <button
                      type="button"
                      className="icon-btn shrink-0 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100"
                      title="Show in Explorer"
                      onClick={() => {
                        showInExplorer(p).catch((err: unknown) => {
                          console.error("show_in_explorer failed", err);
                        });
                      }}
                    >
                      <FolderOpen size={13} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn shrink-0 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100"
                      title="Copy path"
                      onClick={() => {
                        navigator.clipboard.writeText(p).catch((err: unknown) => {
                          console.error("clipboard write failed", err);
                        });
                      }}
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
