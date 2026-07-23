import { useEffect, useState, type ReactElement } from "react";
import { BookOpen, FileText, Layers } from "lucide-react";
import type { LibFile } from "../../stores/libraryStore";
import { toggleFavoriteSmart, useFavoritesStore } from "../../stores/favoritesStore";
import { humanSize } from "../FileRow";
import AssetCell, { type Badge } from "../grid/AssetCell";
import { docFormat } from "./doc";
import { docThumbCache, renderDocThumb } from "./docThumb";

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
  const [url, setUrl] = useState<string | null>(() => docThumbCache.get(file.path) ?? null);

  useEffect(() => {
    if (!raster || url !== null) return;
    let cancelled = false;
    void renderDocThumb(file.path, file.ext).then((u) => {
      if (!cancelled && u !== null) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [file.path, file.ext, raster, url]);

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
      <div className="flex h-full w-full items-center justify-center bg-gradient-to-b from-[#15151d] to-[#0c0c12]">
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
