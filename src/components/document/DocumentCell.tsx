import { useEffect, useState, type ReactElement } from "react";
import { BookOpen, FileText, Layers } from "lucide-react";
import type { LibFile } from "../../stores/libraryStore";
import { toggleFavoriteSmart, useFavoritesStore } from "../../stores/favoritesStore";
import { humanSize } from "../FileRow";
import AssetCell, { type Badge } from "../grid/AssetCell";
import { docFormat } from "./doc";
import { docThumbCache, docThumbKey, renderDocThumb } from "./docThumb";

export interface DocumentCellProps {
  file: LibFile;
  selected: boolean;
  /** See AssetCellProps.focused. */
  focused?: boolean;
}

/** Grid cell for a document. PDF/PSD render a thumbnail lazily (see docThumb);
 *  md/txt just show a format icon. */
export default function DocumentCell({ file, selected, focused }: DocumentCellProps): ReactElement {
  const fmt = docFormat(file.ext);
  const raster = fmt !== "unsupported"; // pdf/psd/md/txt all render a thumbnail
  const starred = useFavoritesStore((s) => s.favorites.has(file.path));
  // Keyed by path+size+mtime so a rescan that saw the file change re-renders
  // the thumbnail instead of reusing the stale one.
  const key = docThumbKey(file);
  const [url, setUrl] = useState<string | null>(() => docThumbCache.get(key) ?? null);

  // The virtualizer reuses cells and the stamp can change on rescan — re-check
  // the cache under the current key before rendering.
  useEffect(() => {
    setUrl(docThumbCache.get(key) ?? null);
  }, [key]);

  useEffect(() => {
    if (!raster || url !== null) return;
    let cancelled = false;
    void renderDocThumb(key, file.path, file.ext).then((u) => {
      if (!cancelled && u !== null) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [key, file.path, file.ext, raster, url]);

  const Icon = fmt === "psd" ? Layers : fmt === "ebook" ? BookOpen : FileText;
  const badges: Badge[] = [{ text: file.ext.toUpperCase() }];

  return (
    <AssetCell
      name={file.name}
      sub={humanSize(file.size)}
      badges={badges}
      selected={selected}
      focused={focused}
      starred={starred}
      onToggleStar={() => toggleFavoriteSmart(file.path)}
    >
      <div className="flex h-full w-full items-center justify-center bg-gradient-to-b from-stage-top to-stage">
        {url !== null ? (
          <img
            src={url}
            alt=""
            loading="lazy"
            draggable={false}
            className="h-full w-full object-contain"
          />
        ) : (
          <Icon size={24} className="text-kind-document opacity-50" />
        )}
      </div>
    </AssetCell>
  );
}
