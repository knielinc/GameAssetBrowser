import { useEffect, useMemo, type ReactElement } from "react";
import { AudioLines, Box, FileText, Image as ImageIcon, X } from "lucide-react";
import { showInExplorer } from "../ipc/commands";
import { basename, useLibraryStore, type LibFile } from "../stores/libraryStore";
import { ASSET_KINDS, type AssetKind } from "../types";
import { humanSize } from "./FileRow";

const KIND_META: Record<AssetKind, { label: string; icon: typeof Box; hue: string }> = {
  audio: { label: "Audio", icon: AudioLines, hue: "text-kind-audio" },
  texture: { label: "Images", icon: ImageIcon, hue: "text-kind-texture" },
  model: { label: "Models", icon: Box, hue: "text-kind-model" },
  document: { label: "Docs", icon: FileText, hue: "text-kind-document" },
};

interface Agg {
  count: number;
  bytes: number;
}

interface PackAgg extends Agg {
  /** "PackRoot / SubFolder" — enough to place it without the full path. */
  label: string;
}

interface Stats {
  perKind: Record<AssetKind, Agg>;
  /** Roots in their configured order; empty roots still listed. */
  perRoot: { root: string; agg: Agg }[];
  /** Top-level folders under each root, top 15 by bytes. */
  packs: PackAgg[];
  largest: LibFile[];
}

/**
 * One O(n) pass over the in-memory library. Each file is attributed to the
 * LONGEST matching root — with overlapping roots (`Documents` plus a folder
 * inside it) the more specific one is the root the user thinks of the file as
 * living under.
 */
function computeStats(files: readonly LibFile[], roots: readonly string[]): Stats {
  const perKind: Record<AssetKind, Agg> = {
    audio: { count: 0, bytes: 0 },
    texture: { count: 0, bytes: 0 },
    model: { count: 0, bytes: 0 },
    document: { count: 0, bytes: 0 },
  };
  const rootAggs = new Map<string, Agg>(roots.map((r) => [r, { count: 0, bytes: 0 }]));
  // Trimmed roots longest-first so the most specific one wins the prefix test.
  const matchers = roots
    .map((root) => ({ root, dir: root.replace(/[\\/]+$/, "") }))
    .sort((a, b) => b.dir.length - a.dir.length);
  const packMap = new Map<string, PackAgg>();

  for (const f of files) {
    const k = perKind[f.kind];
    k.count++;
    k.bytes += f.size;

    const m = matchers.find(({ dir }) => {
      if (!f.path.startsWith(dir)) return false;
      const c = f.path.charCodeAt(dir.length);
      return c === 92 /* \ */ || c === 47 /* / */;
    });
    if (m === undefined) continue; // stale row from a just-removed root

    const r = rootAggs.get(m.root);
    if (r !== undefined) {
      r.count++;
      r.bytes += f.size;
    }

    // "Pack" = first folder below the root; a file sitting directly in the
    // root is bucketed under the root itself.
    const rel = f.path.slice(m.dir.length + 1);
    const sep = rel.search(/[\\/]/);
    const packKey = sep < 0 ? m.dir : `${m.dir}|${rel.slice(0, sep)}`;
    let pack = packMap.get(packKey);
    if (pack === undefined) {
      pack = {
        label: sep < 0 ? basename(m.dir) : `${basename(m.dir)} / ${rel.slice(0, sep)}`,
        count: 0,
        bytes: 0,
      };
      packMap.set(packKey, pack);
    }
    pack.count++;
    pack.bytes += f.size;
  }

  const packs = [...packMap.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 15);
  const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 10);
  return {
    perKind,
    perRoot: roots.map((root) => ({ root, agg: rootAggs.get(root) ?? { count: 0, bytes: 0 } })),
    packs,
    largest,
  };
}

function SectionLabel({ children }: { children: string }): ReactElement {
  return (
    <div className="mb-1.5 mt-4 text-[10px] font-medium uppercase tracking-wide text-faint first:mt-0">
      {children}
    </div>
  );
}

/**
 * "Library statistics…" modal (SettingsMenu). Pure frontend over the
 * in-memory file list — totals per kind and root, the top packs as bars, and
 * the largest files with a jump to Explorer. Snapshot on open: a mid-scan
 * library shows what has streamed in so far, which is honest enough.
 */
export default function StatsModal({ onClose }: { onClose: () => void }): ReactElement {
  const allFiles = useLibraryStore((s) => s.allFiles);
  const roots = useLibraryStore((s) => s.roots);
  const stats = useMemo(() => computeStats(allFiles, roots), [allFiles, roots]);

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

  const totalBytes = ASSET_KINDS.reduce((sum, k) => sum + stats.perKind[k].bytes, 0);
  const maxPackBytes = stats.packs.reduce((m, p) => Math.max(m, p.bytes), 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-[600px] flex-col rounded-xl bg-raised shadow-e2">
        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
          <span className="text-[13px] font-medium">Library statistics</span>
          <span className="text-[11px] tabular-nums text-dim">
            {allFiles.length.toLocaleString()} files · {humanSize(totalBytes)}
          </span>
          <button type="button" className="icon-btn ml-auto shrink-0" title="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="facet-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <SectionLabel>By kind</SectionLabel>
          {ASSET_KINDS.map((kind) => {
            const { label, icon: Icon, hue } = KIND_META[kind];
            const agg = stats.perKind[kind];
            return (
              <div key={kind} className="flex items-center gap-2 py-1 text-[12px]">
                <Icon size={13} className={hue} />
                <span className="w-20 text-text">{label}</span>
                <span className="tabular-nums text-dim">{agg.count.toLocaleString()}</span>
                <span className="ml-auto tabular-nums text-dim">{humanSize(agg.bytes)}</span>
              </div>
            );
          })}

          <SectionLabel>By root</SectionLabel>
          {stats.perRoot.length === 0 && (
            <div className="py-1 text-[12px] text-dim">No folders in the library yet.</div>
          )}
          {stats.perRoot.map(({ root, agg }) => (
            <div key={root} className="flex items-center gap-2 py-1 text-[12px]">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text" title={root}>
                {root}
              </span>
              <span className="shrink-0 tabular-nums text-dim">{agg.count.toLocaleString()}</span>
              <span className="w-16 shrink-0 text-right tabular-nums text-dim">
                {humanSize(agg.bytes)}
              </span>
            </div>
          ))}

          {stats.packs.length > 0 && (
            <>
              <SectionLabel>Largest packs</SectionLabel>
              {stats.packs.map((p) => (
                <div key={p.label} className="py-0.5">
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="min-w-0 flex-1 truncate text-text" title={p.label}>
                      {p.label}
                    </span>
                    <span className="shrink-0 tabular-nums text-faint">
                      {p.count.toLocaleString()}
                    </span>
                    <span className="w-16 shrink-0 text-right tabular-nums text-dim">
                      {humanSize(p.bytes)}
                    </span>
                  </div>
                  <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-bg">
                    <span
                      className="block h-full rounded-full bg-accent/60"
                      style={{ width: `${Math.max(2, (p.bytes / maxPackBytes) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </>
          )}

          {stats.largest.length > 0 && (
            <>
              <SectionLabel>Largest files</SectionLabel>
              {stats.largest.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  title={`${f.path} — Show in Explorer`}
                  className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-[12px] transition-colors duration-[120ms] hover:bg-overlay"
                  onClick={() => {
                    showInExplorer(f.path).catch((err: unknown) => {
                      console.error("show_in_explorer failed", err);
                    });
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-text">{f.name}</span>
                  <span className="w-16 shrink-0 text-right tabular-nums text-dim">
                    {humanSize(f.size)}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
