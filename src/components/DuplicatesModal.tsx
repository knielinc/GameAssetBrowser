import { useEffect, useMemo, useState, type ReactElement } from "react";
import { listen } from "@tauri-apps/api/event";
import clsx from "clsx";
import { Copy, FolderOpen, FolderTree, Image as ImageIcon, Pause, Play, X } from "lucide-react";
import { cancelDuplicates, findDuplicates, showInExplorer } from "../ipc/commands";
import {
  DUPES_DONE,
  DUPES_PROGRESS,
  type DupeGroup,
  type DupeProgress,
  type DupesDone,
} from "../ipc/events";
import { useLibraryStore, type LibFile } from "../stores/libraryStore";
import { audioVisibleRef, loadAndSelect, usePlayerStore } from "../stores/playerStore";
import { revealInNavigator } from "../stores/revealFolder";
import { useThumbSrc } from "../hooks/useThumbSrc";
import { humanSize } from "./FileRow";

/**
 * A duplicate row's thumbnail. Reuses the shared instant-thumbnail path
 * (`useThumbSrc`), so on a warm cache the image shows straight off disk with
 * no IPC. Needs a real LibFile (path + size + mtime derive the cache key); a
 * dupe path missing from the current library falls back to the icon below.
 */
function DupeThumb({ file }: { file: LibFile }): ReactElement {
  const { src, imgKey, onError, onLoad } = useThumbSrc(file);
  return (
    <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-bg">
      {src !== null ? (
        <img
          key={imgKey}
          src={src}
          alt=""
          loading="lazy"
          draggable={false}
          onError={onError}
          onLoad={onLoad}
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <ImageIcon size={16} className="text-faint opacity-40" />
        </div>
      )}
    </div>
  );
}

/**
 * Audio rows have no image to show, so their thumbnail slot doubles as a
 * play/pause toggle that auditions the file through the shared player (so the
 * transport bar and waveform sync too). Loading needs the file's index in the
 * visible audio order for library selection; a dupe filtered out of that list
 * resolves to -1, which still loads and plays — it just isn't row-selected.
 */
function DupePreviewButton({ file }: { file: LibFile }): ReactElement {
  const isCurrent = usePlayerStore((s) => s.currentPath === file.path);
  const playing = usePlayerStore((s) => s.playing && s.currentPath === file.path);
  return (
    <button
      type="button"
      title={playing ? "Pause preview" : "Play preview"}
      onClick={() => {
        if (usePlayerStore.getState().currentPath === file.path) {
          usePlayerStore.getState().togglePlay();
        } else {
          const idx = audioVisibleRef.current.findIndex((f) => f.path === file.path);
          loadAndSelect(file, idx, 0, true);
        }
      }}
      className={clsx(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors duration-[120ms]",
        isCurrent ? "bg-accent/20 text-accent" : "bg-bg text-faint hover:text-text",
      )}
    >
      {playing ? (
        <Pause size={16} fill="currentColor" strokeWidth={0} />
      ) : (
        <Play size={16} fill="currentColor" strokeWidth={0} className="translate-x-px" />
      )}
    </button>
  );
}

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

  // Resolve each duplicate path back to its LibFile for the thumbnail key.
  // Only the paths in the report are wanted, so this is a single pass over the
  // (stable) file list, recomputed once when the hunt lands.
  const byPath = useMemo(() => {
    const m = new Map<string, LibFile>();
    if (groups === null) return m;
    const wanted = new Set<string>();
    for (const g of groups) for (const p of g.paths) wanted.add(p);
    for (const f of useLibraryStore.getState().allFiles) {
      if (wanted.has(f.path)) m.set(f.path, f);
    }
    return m;
  }, [groups]);

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
                {g.paths.map((p) => {
                  const lf = byPath.get(p);
                  return (
                  <div
                    key={p}
                    className="group flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors duration-[120ms] hover:bg-overlay"
                  >
                    {lf === undefined ? (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-bg">
                        <ImageIcon size={16} className="text-faint opacity-40" />
                      </div>
                    ) : lf.kind === "audio" ? (
                      <DupePreviewButton file={lf} />
                    ) : (
                      <DupeThumb file={lf} />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] text-text" title={p}>
                        {nameOf(p)}
                      </div>
                      <div className="truncate font-mono text-[10px] text-faint">{dirOf(p)}</div>
                    </div>
                    <button
                      type="button"
                      className="icon-btn shrink-0 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100"
                      title="Show in navigator"
                      onClick={() => {
                        revealInNavigator(p);
                        onClose();
                      }}
                    >
                      <FolderTree size={13} />
                    </button>
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
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
