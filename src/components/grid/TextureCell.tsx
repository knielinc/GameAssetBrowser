import type { ReactElement } from "react";
import { Image as ImageIcon } from "lucide-react";
import type { LibFile } from "../../stores/libraryStore";
import { humanSize } from "../FileRow";
import AssetCell, { type Badge } from "./AssetCell";

export interface TextureCellProps {
  file: LibFile;
  selected: boolean;
}

/** Formats Chromium cannot decode — they need the Rust thumbnailer, and until
 *  it exists the cell says so rather than showing a broken image. */
const NEEDS_DECODE = new Set(["dds", "tga", "exr", "hdr", "tif", "tiff"]);

export default function TextureCell({ file, selected }: TextureCellProps): ReactElement {
  const badges: Badge[] = [{ text: file.ext.toUpperCase() }];

  return (
    <AssetCell name={file.name} sub={humanSize(file.size)} badges={badges} selected={selected} checker>
      <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-dim">
        <ImageIcon size={22} className="text-kind-texture opacity-50" />
        {NEEDS_DECODE.has(file.ext) && (
          <span className="text-[9px] uppercase tracking-wider opacity-70">needs decode</span>
        )}
      </div>
    </AssetCell>
  );
}
