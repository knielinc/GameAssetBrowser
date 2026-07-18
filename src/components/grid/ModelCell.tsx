import type { ReactElement } from "react";
import { Box, FileQuestion } from "lucide-react";
import { useLibraryStore, type LibFile } from "../../stores/libraryStore";
import { useRenderPrefs } from "../../stores/renderPrefs";
import { thumbUrl } from "../../types";
import { humanSize } from "../FileRow";
import AssetCell, { type Badge } from "./AssetCell";

export interface ModelCellProps {
  file: LibFile;
  selected: boolean;
}

/** Scanned and listed, but no viable loader exists — say so rather than
 *  letting the file vanish from a folder the user knows has models in it. */
export const UNPREVIEWABLE = new Set(["blend", "3ds"]);

export default function ModelCell({ file, selected }: ModelCellProps): ReactElement {
  useLibraryStore((s) => s.thumbsVersion);
  const thumb = useLibraryStore.getState().thumbs.get(file.id);
  const pixelArt = useRenderPrefs((s) => s.pixelArt);

  const unsupported = UNPREVIEWABLE.has(file.ext);
  const badges: Badge[] = [{ text: file.ext.toUpperCase() }];
  if (unsupported) {
    badges.push({ text: "no preview", warn: true, title: "No viable loader for this format" });
  }

  return (
    <AssetCell name={file.name} sub={humanSize(file.size)} badges={badges} selected={selected}>
      <div className="flex h-full w-full items-center justify-center bg-gradient-to-b from-[#15151d] to-[#0c0c12]">
        {thumb !== undefined ? (
          // A rendered thumbnail is a plain <img> — the grid holds no WebGL
          // contexts at all, whatever the folder size.
          <img
            src={thumbUrl(thumb.key)}
            alt=""
            loading="lazy"
            draggable={false}
            className="h-full w-full object-contain"
            style={{ imageRendering: pixelArt ? "pixelated" : "auto" }}
          />
        ) : unsupported ? (
          <FileQuestion size={22} className="text-dim opacity-50" />
        ) : (
          <Box size={24} className="text-kind-model opacity-50" />
        )}
      </div>
    </AssetCell>
  );
}
