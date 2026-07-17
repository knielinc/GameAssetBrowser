import { useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import clsx from "clsx";
import { ChevronRight, Copy, Folder, FolderOpen, Library, X } from "lucide-react";
import { basename, removeRoot, useLibraryStore, type LibFile } from "../stores/libraryStore";
import { openInExplorer } from "../ipc/commands";
import ContextMenu from "./ContextMenu";

/** One directory in the derived folder tree. */
export interface FolderNode {
  /** Directory path, exactly as it prefixes the scanned file paths. */
  path: string;
  /** Last path segment, precomputed for display + sorting. */
  name: string;
  /** Number of audio files in this directory's subtree. */
  count: number;
  /** Subdirectories that (transitively) contain audio files, sorted by name. */
  children: FolderNode[];
}

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
 * least one audio file, and each file increments the count of every ancestor.
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
    const node: FolderNode = { path: root, name: basename(root), count: 0, children: [] };
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

    owner.node.count++;
    let parent = owner.node;
    let segStart = owner.trimmed.length + 1;
    for (;;) {
      const sep = nextSeparator(p, segStart);
      if (sep === -1) break; // the remaining segment is the file name
      const dirPath = p.slice(0, sep);
      let node = nodeByPath.get(dirPath);
      if (node === undefined) {
        node = { path: dirPath, name: p.slice(segStart, sep), count: 0, children: [] };
        nodeByPath.set(dirPath, node);
        parent.children.push(node);
      }
      node.count++;
      parent = node;
      segStart = sep + 1;
    }
  }

  // Roots keep the user's order; only subdirectories get sorted.
  for (const root of rootNodes) sortChildrenDeep(root.children);
  return rootNodes;
}

const INDENT_PX = 12;
/**
 * Depth at which indentation stops growing. The sidebar is a fixed 240px, so
 * uncapped indent would squeeze deep folder names to zero width and then push
 * the fixed-width chevron/icon/badge past the row box (horizontal scrollbar,
 * hover backgrounds that stop short). Levels beyond the cap align flush.
 */
const MAX_INDENT_DEPTH = 8;

interface TreeNodeProps {
  node: FolderNode;
  depth: number;
  isRoot: boolean;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onNodeContextMenu: (path: string, e: ReactMouseEvent) => void;
}

function TreeNode({ node, depth, isRoot, expanded, onToggle, onNodeContextMenu }: TreeNodeProps): ReactElement {
  const selected = useLibraryStore((s) => s.folderScope === node.path);
  const setFolderScope = useLibraryStore((s) => s.setFolderScope);
  const hasChildren = node.children.length > 0;
  const isExpanded = hasChildren && expanded.has(node.path);

  // Single-click UX: selecting a folder also expands it; clicking the already
  // active folder collapses it again (scope stays). The chevron still toggles
  // expansion on its own via stopPropagation.
  const selectNode = (): void => {
    if (hasChildren && (!isExpanded || selected)) onToggle(node.path);
    setFolderScope(node.path);
  };

  const chevron = hasChildren ? (
    <button
      type="button"
      title={isExpanded ? "Collapse" : "Expand"}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-dim transition-colors duration-[120ms] hover:text-text"
      onClick={(e) => {
        e.stopPropagation();
        onToggle(node.path);
      }}
    >
      <ChevronRight
        size={12}
        className={clsx("transition-transform duration-[120ms]", isExpanded && "rotate-90")}
      />
    </button>
  ) : (
    <span className="h-4 w-4 shrink-0" />
  );

  const badge = (
    <span className={clsx("shrink-0 text-[10px] tabular-nums", selected ? "text-accent" : "text-dim")}>
      {node.count.toLocaleString()}
    </span>
  );

  return (
    <>
      {isRoot ? (
        <div
          className={clsx(
            "group tree-row flex items-start gap-1 rounded-md py-1.5 pl-1 pr-2",
            selected && "tree-row-selected",
          )}
          onClick={selectNode}
          onContextMenu={(e) => onNodeContextMenu(node.path, e)}
        >
          <span className="mt-px">{chevron}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold text-text">{node.name}</div>
            <div className="truncate text-[10px] text-dim" title={node.path}>
              {node.path}
            </div>
          </div>
          <span className="mt-px">{badge}</span>
          <button
            type="button"
            title="Remove folder"
            className="mt-px shrink-0 rounded p-0.5 text-dim opacity-0 transition-all duration-[120ms] hover:text-danger group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              removeRoot(node.path);
            }}
          >
            <X size={12} />
          </button>
        </div>
      ) : (
        <div
          className={clsx(
            "tree-row flex h-[26px] items-center gap-1 rounded-md pr-2",
            selected && "tree-row-selected",
          )}
          style={{ paddingLeft: `${Math.min(depth, MAX_INDENT_DEPTH) * INDENT_PX + 4}px` }}
          onClick={selectNode}
          onContextMenu={(e) => onNodeContextMenu(node.path, e)}
          title={node.path}
        >
          {chevron}
          {isExpanded ? (
            <FolderOpen size={13} className={clsx("shrink-0", selected ? "text-accent" : "text-dim")} />
          ) : (
            <Folder size={13} className={clsx("shrink-0", selected ? "text-accent" : "text-dim")} />
          )}
          <span className={clsx("min-w-0 flex-1 truncate text-xs", selected ? "text-text" : "text-dim")}>
            {node.name}
          </span>
          {badge}
        </div>
      )}
      {isExpanded &&
        node.children.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            isRoot={false}
            expanded={expanded}
            onToggle={onToggle}
            onNodeContextMenu={onNodeContextMenu}
          />
        ))}
    </>
  );
}

/**
 * The sidebar folder tree: an "All Files" node, then one expandable node per
 * root. Expansion is local UI state; the selected scope lives in the library
 * store so the file list and status bar stay in sync.
 */
export default function FolderTree(): ReactElement {
  const roots = useLibraryStore((s) => s.roots);
  const allFiles = useLibraryStore((s) => s.allFiles);
  const totalCount = allFiles.length;
  const scopeIsAll = useLibraryStore((s) => s.folderScope === null);
  const setFolderScope = useLibraryStore((s) => s.setFolderScope);

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

  if (roots.length === 0) {
    return (
      <p className="px-2 py-1.5 text-[11px] leading-relaxed text-dim">
        No folders yet. Add one to start browsing your samples.
      </p>
    );
  }

  return (
    <div>
      <div
        className={clsx(
          "tree-row mb-1 flex h-[26px] items-center gap-1.5 rounded-md px-2",
          scopeIsAll && "tree-row-selected",
        )}
        onClick={() => setFolderScope(null)}
      >
        <Library size={13} className={clsx("shrink-0", scopeIsAll ? "text-accent" : "text-dim")} />
        <span className={clsx("min-w-0 flex-1 truncate text-xs", scopeIsAll ? "text-text" : "text-dim")}>
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
          expanded={expanded}
          onToggle={onToggle}
          onNodeContextMenu={onNodeContextMenu}
        />
      ))}
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
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
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
