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
  onClick: () => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
}

/** One scope row — the tree-row idiom so Collections reads as a sibling of
 *  the folder tree above it. Click toggles the scope on/off. */
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
 * (Favorites, Recent), then the user's collections. Clicking a row toggles it
 * as the active collection scope (libraryStore.collectionScope) — a membership
 * filter layered on top of the folder scopes, see useVisibleFiles. Rename and
 * delete live in each collection row's context menu; rename swaps the row for
 * an inline input rather than opening a dialog.
 */
export default function CollectionsSection(): ReactElement {
  const collections = useFavoritesStore((s) => s.collections);
  const favoritesCount = useFavoritesStore((s) => s.favorites.size);
  const recentsCount = useFavoritesStore((s) => s.recents.length);
  const renameCollection = useFavoritesStore((s) => s.renameCollection);
  const deleteCollection = useFavoritesStore((s) => s.deleteCollection);
  const scope = useLibraryStore((s) => s.collectionScope);
  const setCollectionScope = useLibraryStore((s) => s.setCollectionScope);

  const toggle = (key: string): void => {
    setCollectionScope(scope === key ? null : key);
  };

  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  // Name of the collection being renamed inline, plus the draft text.
  const [renaming, setRenaming] = useState<{ name: string; draft: string } | null>(null);

  const commitRename = (): void => {
    if (renaming === null) return;
    const { name, draft } = renaming;
    const trimmed = draft.trim();
    setRenaming(null);
    if (trimmed === "" || trimmed === name) return;
    // The store no-ops on a taken name — check first so the active scope only
    // follows a rename that actually happened.
    if (useFavoritesStore.getState().collections.some((c) => c.name === trimmed)) return;
    renameCollection(name, trimmed);
    if (useLibraryStore.getState().collectionScope === collectionScopeKey(name)) {
      setCollectionScope(collectionScopeKey(trimmed));
    }
  };

  const onDelete = (name: string): void => {
    deleteCollection(name);
    if (useLibraryStore.getState().collectionScope === collectionScopeKey(name)) {
      setCollectionScope(null);
    }
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
        icon={<Star size={14} className={clsx("shrink-0", scope === FAVORITES_SCOPE ? "text-accent" : "text-kind-model")} />}
        label="Favorites"
        count={favoritesCount}
        active={scope === FAVORITES_SCOPE}
        onClick={() => toggle(FAVORITES_SCOPE)}
      />
      <ScopeRow
        icon={<Clock size={14} className={clsx("shrink-0", scope === RECENTS_SCOPE ? "text-accent" : "text-dim")} />}
        label="Recent"
        count={recentsCount}
        active={scope === RECENTS_SCOPE}
        onClick={() => toggle(RECENTS_SCOPE)}
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
            icon={<Bookmark size={14} className={clsx("shrink-0", scope === key ? "text-accent" : "text-dim")} />}
            label={c.name}
            count={c.paths.length}
            active={scope === key}
            onClick={() => toggle(key)}
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
              // Deletes the collection only — never the files in it.
              label: "Delete",
              icon: Trash2,
              onClick: () => onDelete(menu.name),
            },
          ]}
        />
      )}
    </div>
  );
}
