import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import clsx from "clsx";
import { ChevronRight, Copy, Eye, EyeOff, Folder, FolderOpen, Library, Trash2 } from "lucide-react";
import { basename, folderMatcher, removeRoot, useLibraryStore, type LibFile } from "../stores/libraryStore";
import { useRevealFolder } from "../stores/revealFolder";
import { openInExplorer } from "../ipc/commands";
import type { AssetKind } from "../types";
import ContextMenu from "./ContextMenu";

/** One directory in the derived folder tree. */
export interface FolderNode {
  /** Directory path, exactly as it prefixes the scanned file paths. */
  path: string;
  /** Last path segment, precomputed for display + sorting. */
  name: string;
  /** Per-kind asset counts in this directory's subtree. */
  counts: Record<AssetKind, number>;
  /** Subdirectories that (transitively) contain assets of ANY kind. */
  children: FolderNode[];
}

// `all` tracks the whole-subtree total so the "All" tab's folder rows light up
// on any content; the real-kind counts drive the per-lens dimming + breakdown.
const emptyCounts = (): Record<AssetKind, number> => ({ all: 0, audio: 0, texture: 0, model: 0, document: 0 });

/** Natural, case-insensitive folder ordering ("Kick 2" before "Kick 10"). */
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function nextSeparator(path: string, from: number): number {
  const bs = path.indexOf("\\", from);
  if (bs === -1) return path.indexOf("/", from);
  const fs = path.indexOf("/", from);
  return fs === -1 || bs < fs ? bs : fs;
}

function sortChildrenDeep(nodes: FolderNode[]): void {
  nodes.sort((a, b) => collator.compare(a.name, b.name));
  for (const n of nodes) sortChildrenDeep(n.children);
}

/**
 * Derive the sidebar folder tree from the flat scan results — one O(n·depth)
 * pass, no backend calls. Every root always gets a node (so it can be removed
 * even when empty); subdirectories appear only if their subtree contains at
 * least one asset OF ANY KIND, and each file increments its own kind's count
 * on every ancestor.
 *
 * The tree structure is deliberately kind-AGNOSTIC. The tab is a filter; the
 * tree is navigation, and navigation must be stable or it isn't navigation.
 * Synty packs ship Models/, Textures/, Materials/ as siblings — hiding two of
 * three while you browse the third destroys the map of the pack you're in
 * (and silently drops your expansion state, which is keyed by path). Folders
 * with nothing for the active tab dim instead.
 *
 * Directory paths are built by slicing the file path at separator positions,
 * never by re-joining segments, so a node's `path` is byte-for-byte the prefix
 * the scanner emitted — which is what the scope filter matches against.
 *
 * Roots may be nested inside one another (addFolders only dedupes exact
 * paths). Each file is attributed to the OUTERMOST root containing it, and
 * root nodes are registered in `nodeByPath` so the segment walk increments a
 * nested root's own top-level node instead of spawning a duplicate child with
 * the same path. That keeps every node's count equal to the prefix count the
 * scope filter (and the status bar) computes when the node is clicked.
 */
export function buildFolderTree(files: readonly LibFile[], roots: readonly string[]): FolderNode[] {
  const rootNodes: FolderNode[] = [];
  const specs: { node: FolderNode; trimmed: string }[] = [];
  const nodeByPath = new Map<string, FolderNode>();

  for (const root of roots) {
    const node: FolderNode = { path: root, name: basename(root), counts: emptyCounts(), children: [] };
    rootNodes.push(node);
    const trimmed = root.replace(/[\\/]+$/, "");
    specs.push({ node, trimmed });
    // Keyed by trimmed path so an ancestor root's walk (which slices dirPaths
    // without trailing separators) finds this node when it passes through it.
    if (!nodeByPath.has(trimmed)) nodeByPath.set(trimmed, node);
  }

  for (const f of files) {
    const p = f.path;

    // Attribute the file to the outermost (shortest) root that contains it,
    // so the walk below crosses — and counts — every nested root on the way
    // down. Root counts are tiny, so a linear probe per file is cheap.
    let owner: { node: FolderNode; trimmed: string } | undefined;
    for (const spec of specs) {
      if (owner !== undefined && spec.trimmed.length >= owner.trimmed.length) continue;
      if (!p.startsWith(spec.trimmed)) continue;
      const c = p.charCodeAt(spec.trimmed.length);
      if (c === 92 /* \ */ || c === 47 /* / */) {
        owner = spec;
      }
    }
    // Files from a superseded root set can flash by mid-rescan — skip them.
    if (owner === undefined) continue;

    owner.node.counts[f.kind]++;
    owner.node.counts.all++;
    let parent = owner.node;
    let segStart = owner.trimmed.length + 1;
    for (;;) {
      const sep = nextSeparator(p, segStart);
      if (sep === -1) break; // the remaining segment is the file name
      const dirPath = p.slice(0, sep);
      let node = nodeByPath.get(dirPath);
      if (node === undefined) {
        node = { path: dirPath, name: p.slice(segStart, sep), counts: emptyCounts(), children: [] };
        nodeByPath.set(dirPath, node);
        parent.children.push(node);
      }
      node.counts[f.kind]++;
      node.counts.all++;
      parent = node;
      segStart = sep + 1;
    }
  }

  // Roots keep the user's order; only subdirectories get sorted.
  for (const root of rootNodes) sortChildrenDeep(root.children);
  return rootNodes;
}

/** Path of the folder whose direct children include `path`, or null if `path`
 *  is a root. Lets "Show all hidden folders" on a subfolder reveal its siblings
 *  (the counterpart to "Hide all others"), not just its own hidden descendants. */
function parentPathOf(roots: readonly FolderNode[], path: string): string | null {
  let found: string | null = null;
  const visit = (node: FolderNode): void => {
    if (found) return;
    if (node.children.some((c) => c.path === path)) {
      found = node.path;
      return;
    }
    for (const c of node.children) visit(c);
  };
  for (const root of roots) visit(root);
  return found;
}

/** Horizontal step added per nesting level. One step is wider than the chevron
 *  column so each depth reads as a clear, even stair. */
const INDENT_STEP_PX = 14;
/** Left padding every row starts from before depth indentation. Matches the
 *  "All Files" row so the whole tree shares one left margin. */
const BASE_PAD_PX = 8;
/**
 * Depth at which indentation stops growing. The sidebar is a fixed 240px, so
 * uncapped indent would squeeze deep folder names to zero width and then push
 * the fixed-width chevron/icon/badge past the row box (horizontal scrollbar,
 * hover backgrounds that stop short). Levels beyond the cap align flush.
 */
const MAX_INDENT_DEPTH = 8;

/** The eye toggle that drops a folder's content from the query. Hidden folders
 *  keep the icon visible (with EyeOff) so you can always find and reverse them;
 *  visible folders only reveal it on row hover. */
function EyeToggle({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }): ReactElement {
  const Icon = hidden ? EyeOff : Eye;
  return (
    <button
      type="button"
      title={hidden ? "Show this folder's content" : "Hide this folder's content"}
      className={clsx(
        "shrink-0 rounded p-0.5 text-dim transition-all duration-[120ms] hover:text-text",
        hidden ? "opacity-100" : "opacity-0 group-hover:opacity-100",
      )}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Icon size={12} />
    </button>
  );
}

interface TreeNodeProps {
  node: FolderNode;
  depth: number;
  isRoot: boolean;
  /** A hidden ancestor already excludes this subtree — dim it so the redundant
   *  state reads at a glance. */
  ancestorHidden: boolean;
  expanded: ReadonlySet<string>;
  /** Path being flash-highlighted by "Show in navigator", or null. */
  flash: string | null;
  onToggle: (path: string) => void;
  onNodeContextMenu: (path: string, e: ReactMouseEvent) => void;
}

function TreeNode({
  node,
  depth,
  isRoot,
  ancestorHidden,
  expanded,
  flash,
  onToggle,
  onNodeContextMenu,
}: TreeNodeProps): ReactElement {
  const selected = useLibraryStore((s) => s.folderScopes.includes(node.path));
  const hidden = useLibraryStore((s) => s.hiddenFolders.includes(node.path));
  const activeTab = useLibraryStore((s) => s.activeTab);
  const soloScope = useLibraryStore((s) => s.soloScope);
  const toggleScope = useLibraryStore((s) => s.toggleScope);
  const toggleHidden = useLibraryStore((s) => s.toggleHidden);
  const hasChildren = node.children.length > 0;
  const isExpanded = hasChildren && expanded.has(node.path);
  const count = node.counts[activeTab];
  // Nothing here for this lens — dim it, keep it. See buildFolderTree's note.
  const emptyForTab = count === 0;
  // Self-hidden, or excluded because an ancestor is hidden. Either way the
  // content is out of the query, so present the row the same muted way.
  const effectiveHidden = hidden || ancestorHidden;
  const breakdown = `${node.counts.audio} audio · ${node.counts.texture} images · ${node.counts.model} models · ${node.counts.document} documents`;

  // Every folder — root or subfolder — scopes the file list the same way: plain
  // click shows ONLY this folder's content, ctrl/cmd-click adds it to what's
  // shown, shift-click hides it. Expansion is the chevron's job; the eye handles
  // its own clicks via stopPropagation.
  const onRowClick = (e: ReactMouseEvent): void => {
    if (e.shiftKey) toggleHidden(node.path);
    else if (e.ctrlKey || e.metaKey) toggleScope(node.path);
    else soloScope(node.path);
  };

  // Leading disclosure column, one fixed width at every depth so the identity
  // icons below it line up. A childless folder keeps the empty slot.
  const chevron = hasChildren ? (
    <button
      type="button"
      title={isExpanded ? "Collapse" : "Expand"}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-dim transition-colors duration-[120ms] hover:text-text"
      onClick={(e) => {
        e.stopPropagation();
        onToggle(node.path);
      }}
    >
      <ChevronRight
        size={13}
        className={clsx("transition-transform duration-[120ms]", isExpanded && "rotate-90")}
      />
    </button>
  ) : (
    <span className="h-5 w-5 shrink-0" />
  );

  // Identity column, same 14px box for every row so names align at every depth.
  // A scoped subfolder goes flat-accent (icon, name, count) over the tinted row.
  const FolderIcon = isExpanded ? FolderOpen : Folder;
  const identity = (
    <FolderIcon size={14} className={clsx("shrink-0", selected ? "text-accent" : "text-dim")} />
  );

  const badge = (
    <span
      className={clsx("shrink-0 text-[10px] tabular-nums", selected ? "text-accent" : "text-dim")}
      title={breakdown}
    >
      {count.toLocaleString()}
    </span>
  );

  // The eye hides this folder's content — same control at every depth. Removing
  // a root lives in the context menu now.
  const trailing = <EyeToggle hidden={hidden} onToggle={() => toggleHidden(node.path)} />;

  return (
    <>
      <div
        data-tree-path={node.path}
        className={clsx(
          "group tree-row flex items-center gap-1.5 rounded-md pr-2",
          isRoot ? "py-1" : "h-7",
          selected && "tree-row-selected",
          flash === node.path && "tree-row-flash",
          emptyForTab && !selected && !effectiveHidden && "opacity-40",
          effectiveHidden && "opacity-50",
        )}
        style={{
          paddingLeft: `${BASE_PAD_PX + Math.min(depth, MAX_INDENT_DEPTH) * INDENT_STEP_PX}px`,
        }}
        onClick={onRowClick}
        onContextMenu={(e) => onNodeContextMenu(node.path, e)}
        title={isRoot ? node.path : `${node.path}\n${breakdown}`}
      >
        {chevron}
        {identity}
        <div className="min-w-0 flex-1">
          <div
            className={clsx(
              "truncate text-xs",
              selected ? "text-accent" : "text-text",
              isRoot && "font-semibold",
            )}
          >
            {node.name}
          </div>
          {isRoot && <div className="truncate text-[10px] leading-tight text-dim">{node.path}</div>}
        </div>
        {badge}
        {trailing}
      </div>
      {isExpanded &&
        node.children.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            isRoot={false}
            ancestorHidden={effectiveHidden}
            expanded={expanded}
            flash={flash}
            onToggle={onToggle}
            onNodeContextMenu={onNodeContextMenu}
          />
        ))}
    </>
  );
}

/**
 * The sidebar folder tree: an "All Files" master-switch header, then one
 * expandable node per root. Expansion is local UI state; enable/disable and
 * subfolder hiding live in the store's hidden set so the file list, counts, and
 * status bar stay in sync.
 */
export default function FolderTree(): ReactElement {
  const roots = useLibraryStore((s) => s.roots);
  const allFiles = useLibraryStore((s) => s.allFiles);
  const activeTab = useLibraryStore((s) => s.activeTab);
  const hiddenFolders = useLibraryStore((s) => s.hiddenFolders);
  // "All Files" is the master switch across BOTH scope kinds — lit only when no
  // folder AND no collection is selected (a collection scope is a folder peer).
  const scopeIsAll = useLibraryStore(
    (s) => s.folderScopes.length === 0 && s.collectionScopes.length === 0,
  );
  const clearScopes = useLibraryStore((s) => s.clearScopes);
  const toggleHidden = useLibraryStore((s) => s.toggleHidden);
  const resetHidden = useLibraryStore((s) => s.resetHidden);
  const totalCount = useMemo(
    () => allFiles.reduce((n, f) => (f.kind === activeTab ? n + 1 : n), 0),
    [allFiles, activeTab],
  );

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const onToggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const onNodeContextMenu = (path: string, e: ReactMouseEvent): void => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, path });
  };

  const tree = useMemo(() => buildFolderTree(allFiles, roots), [allFiles, roots]);

  // "Show in navigator": expand every ancestor of the requested folder, then
  // scroll to and flash its row. Fresh object per flash so revealing the same
  // folder again re-runs the scroll.
  const [flash, setFlash] = useState<{ path: string } | null>(null);
  const revealTarget = useRevealFolder((s) => s.target);
  useEffect(() => {
    if (revealTarget === null) return;
    const target = revealTarget.path;
    // Root nodes are keyed by the root string EXACTLY as picked (possibly with
    // a trailing separator, e.g. "C:\"); inner nodes by the separator slices
    // buildFolderTree produces. Add both spellings so every level opens.
    let ownerTrimmed: string | null = null;
    let flashPath = target;
    const toExpand: string[] = [];
    for (const r of roots) {
      const t = r.replace(/[\\/]+$/, "");
      const c = target.charCodeAt(t.length);
      if (target !== t && !(target.startsWith(t) && (c === 92 || c === 47))) continue;
      toExpand.push(r);
      if (target === t) flashPath = r; // the folder IS a root — flash its node
      // Outermost root owns the walk, exactly like buildFolderTree.
      if (ownerTrimmed === null || t.length < ownerTrimmed.length) ownerTrimmed = t;
    }
    if (ownerTrimmed !== null) {
      let segStart = ownerTrimmed.length + 1;
      for (;;) {
        const sep = nextSeparator(target, segStart);
        if (sep === -1) break;
        toExpand.push(target.slice(0, sep));
        segStart = sep + 1;
      }
      toExpand.push(target);
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of toExpand) next.add(p);
      return next;
    });
    setFlash({ path: flashPath });
    useRevealFolder.getState().clear();
  }, [revealTarget, roots]);

  // Runs after the expansion above has committed, so the row exists to scroll
  // to. The flash class rides on the row for the animation's duration.
  useEffect(() => {
    if (flash === null) return;
    document
      .querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(flash.path)}"]`)
      ?.scrollIntoView({ block: "center" });
    const t = window.setTimeout(() => setFlash(null), 1400);
    return () => window.clearTimeout(t);
  }, [flash]);

  if (roots.length === 0) {
    return (
      <p className="px-2 py-1.5 text-[11px] leading-relaxed text-dim">
        No folders yet. Add one to start browsing your assets.
      </p>
    );
  }

  return (
    <div>
      <div
        className={clsx(
          "tree-row mb-1 flex h-7 items-center gap-1.5 rounded-md pr-2",
          scopeIsAll && "tree-row-selected",
        )}
        style={{ paddingLeft: `${BASE_PAD_PX}px` }}
        title="Show every folder's content (clears the focus)"
        onClick={() => clearScopes()}
      >
        <span className="h-5 w-5 shrink-0" />
        <Library size={14} className={clsx("shrink-0", scopeIsAll ? "text-accent" : "text-dim")} />
        <span className={clsx("min-w-0 flex-1 truncate text-xs", scopeIsAll ? "text-accent" : "text-text")}>
          All Files
        </span>
        <span className={clsx("shrink-0 text-[10px] tabular-nums", scopeIsAll ? "text-accent" : "text-dim")}>
          {totalCount.toLocaleString()}
        </span>
      </div>
      {tree.map((root) => (
        <TreeNode
          key={root.path}
          node={root}
          depth={0}
          isRoot
          ancestorHidden={false}
          expanded={expanded}
          flash={flash?.path ?? null}
          onToggle={onToggle}
          onNodeContextMenu={onNodeContextMenu}
        />
      ))}
      {menu !== null &&
        (() => {
          const isRootMenu = roots.includes(menu.path);
          const menuHidden = hiddenFolders.includes(menu.path);
          // A root reveals its own subtree; a subfolder reveals its parent's
          // subtree, so hidden siblings come back too.
          const revealScope = isRootMenu ? menu.path : parentPathOf(tree, menu.path);
          const under = revealScope !== null ? folderMatcher(revealScope) : null;
          const hasHiddenInScope =
            revealScope !== null && hiddenFolders.some((f) => f === revealScope || under!(f));
          const items = [
            {
              label: "Open in Explorer",
              icon: FolderOpen,
              onClick: () => {
                void openInExplorer(menu.path).catch((err: unknown) => {
                  console.error("[explorer]", err);
                });
              },
            },
            {
              label: "Copy path",
              icon: Copy,
              onClick: () => {
                void navigator.clipboard.writeText(menu.path).catch((err: unknown) => {
                  console.error("[clipboard]", err);
                });
              },
            },
          ];
          if (!isRootMenu) {
            items.push({
              label: menuHidden ? "Show this folder" : "Hide this folder",
              icon: menuHidden ? Eye : EyeOff,
              onClick: () => toggleHidden(menu.path),
            });
          }
          if (hasHiddenInScope && revealScope !== null) {
            const scope = revealScope;
            items.push({
              label: "Show all hidden folders",
              icon: Eye,
              onClick: () => resetHidden(scope),
            });
          }
          if (isRootMenu) {
            items.push({
              label: "Remove folder",
              icon: Trash2,
              onClick: () => removeRoot(menu.path),
            });
          }
          return <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />;
        })()}
    </div>
  );
}
