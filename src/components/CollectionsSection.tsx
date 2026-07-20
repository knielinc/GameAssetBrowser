import { useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import clsx from "clsx";
import { Bookmark, Clock, Pencil, Star, Trash2 } from "lucide-react";
import { useLibraryStore } from "../stores/libraryStore";
import {
  FAVORITES_SCOPE,
  RECENTS_SCOPE,
  collectionScopeKey,
  useFavoritesStore,
} from "../stores/favoritesStore";
import ContextMenu from "./ContextMenu";

/** Matches the tree rows' left padding (FolderTree BASE_PAD_PX). */
const ROW_PAD_PX = 8;

interface RowProps {
  icon: ReactElement;
  label: string;
  count: number;
  active: boolean;
  onClick: (e: ReactMouseEvent) => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
}

/** One scope row — the tree-row idiom so Collections reads as a sibling of the
 *  folder tree above it, and selecting one behaves like selecting a folder:
 *  plain click solos it, Ctrl+click adds/removes (see the click handler). */
function ScopeRow({ icon, label, count, active, onClick, onContextMenu }: RowProps): ReactElement {
  return (
    <div
      className={clsx(
        "tree-row flex h-7 items-center gap-1.5 rounded-md pr-2",
        active && "tree-row-selected",
      )}
      style={{ paddingLeft: `${ROW_PAD_PX}px` }}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {icon}
      <span className={clsx("min-w-0 flex-1 truncate text-xs", active ? "text-accent" : "text-text")}>
        {label}
      </span>
      <span className={clsx("shrink-0 text-[10px] tabular-nums", active ? "text-accent" : "text-dim")}>
        {count.toLocaleString()}
      </span>
    </div>
  );
}

/**
 * Sidebar "Collections" section, below the folder tree: the two pinned scopes
 * (Favorites, Recent), then the user's collections. Each row is a scope PEER of
 * the folder tree — a plain click solos it (clearing folder selection), a
 * Ctrl+click adds/removes it from the union (libraryStore.collectionScopes, see
 * useVisibleFiles). Rename and delete live in each collection row's context
 * menu; the store cascades those into the scope keys and filter facets. Rename
 * swaps the row for an inline input rather than opening a dialog.
 */
export default function CollectionsSection(): ReactElement {
  const collections = useFavoritesStore((s) => s.collections);
  const favoritesCount = useFavoritesStore((s) => s.favorites.size);
  const recentsCount = useFavoritesStore((s) => s.recents.length);
  const renameCollection = useFavoritesStore((s) => s.renameCollection);
  const deleteCollection = useFavoritesStore((s) => s.deleteCollection);
  const scopes = useLibraryStore((s) => s.collectionScopes);
  const soloCollectionScope = useLibraryStore((s) => s.soloCollectionScope);
  const toggleCollectionScope = useLibraryStore((s) => s.toggleCollectionScope);

  // Plain click solos this collection (clears folders); Ctrl/Cmd+click adds or
  // removes it from the scope union — the folder-tree row idiom.
  const onScopeClick = (key: string) => (e: ReactMouseEvent): void => {
    if (e.ctrlKey || e.metaKey) toggleCollectionScope(key);
    else soloCollectionScope(key);
  };

  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  // Name of the collection being renamed inline, plus the draft text.
  const [renaming, setRenaming] = useState<{ name: string; draft: string } | null>(null);

  const commitRename = (): void => {
    if (renaming === null) return;
    const { name, draft } = renaming;
    setRenaming(null);
    // The store validates (empty/taken/missing are no-ops) and cascades the
    // rename into any live scope key and the collection filter facets.
    renameCollection(name, draft.trim());
  };

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-[10px] font-medium uppercase tracking-widest text-dim">
          Collections
        </span>
        {collections.length > 0 && (
          <span className="text-[10px] tabular-nums text-dim">{collections.length}</span>
        )}
      </div>

      <ScopeRow
        icon={<Star size={14} className={clsx("shrink-0", scopes.includes(FAVORITES_SCOPE) ? "text-accent" : "text-kind-model")} />}
        label="Favorites"
        count={favoritesCount}
        active={scopes.includes(FAVORITES_SCOPE)}
        onClick={onScopeClick(FAVORITES_SCOPE)}
      />
      <ScopeRow
        icon={<Clock size={14} className={clsx("shrink-0", scopes.includes(RECENTS_SCOPE) ? "text-accent" : "text-dim")} />}
        label="Recent"
        count={recentsCount}
        active={scopes.includes(RECENTS_SCOPE)}
        onClick={onScopeClick(RECENTS_SCOPE)}
      />

      {collections.map((c) => {
        const key = collectionScopeKey(c.name);
        if (renaming !== null && renaming.name === c.name) {
          return (
            <div
              key={c.name}
              className="flex h-7 items-center gap-1.5 rounded-md pr-2"
              style={{ paddingLeft: `${ROW_PAD_PX}px` }}
            >
              <Bookmark size={14} className="shrink-0 text-dim" />
              <input
                type="text"
                value={renaming.draft}
                autoFocus
                spellCheck={false}
                className="h-6 min-w-0 flex-1 rounded-lg border-0 bg-bg px-1.5 text-xs text-text outline-none focus:ring-2 focus:ring-accent/35"
                onChange={(e) => setRenaming({ name: c.name, draft: e.currentTarget.value })}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  // stopPropagation so the window-level Escape handling
                  // (preview close, selection collapse) stays out of it.
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setRenaming(null);
                  }
                }}
              />
            </div>
          );
        }
        return (
          <ScopeRow
            key={c.name}
            icon={<Bookmark size={14} className={clsx("shrink-0", scopes.includes(key) ? "text-accent" : "text-dim")} />}
            label={c.name}
            count={c.paths.length}
            active={scopes.includes(key)}
            onClick={onScopeClick(key)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, name: c.name });
            }}
          />
        );
      })}

      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Rename…",
              icon: Pencil,
              onClick: () => setRenaming({ name: menu.name, draft: menu.name }),
            },
            {
              // Deletes the collection only — never the files in it. The store
              // cascades the removal into any live scope key and filter facets.
              label: "Delete",
              icon: Trash2,
              onClick: () => deleteCollection(menu.name),
            },
          ]}
        />
      )}
    </div>
  );
}
