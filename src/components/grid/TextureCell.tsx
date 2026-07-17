import type { ReactElement } from "react";
import { Image as ImageIcon } from "lucide-react";
import { useLibraryStore, type LibFile } from "../../stores/libraryStore";
import { thumbUrl } from "../../types";
import { humanSize } from "../FileRow";
import AssetCell, { type Badge } from "./AssetCell";

export interface TextureCellProps {
  file: LibFile;
  selected: boolean;
}

export default function TextureCell({ file, selected }: TextureCellProps): ReactElement {
  // Subscribe to the version counter, not the Map — the Map is mutated in
  // place, so its identity never changes.
  useLibraryStore((s) => s.thumbsVersion);
  const thumb = useLibraryStore.getState().thumbs.get(file.id);

  const badges: Badge[] = [{ text: file.ext.toUpperCase() }];
  // info is null for webview-rendered model thumbs; textures always have it.
  if (thumb?.info != null) {
    const { info } = thumb;
    // Content-derived hints, clearly marked as inference. The name-based
    // classifier is authoritative; this is what we can see in the pixels.
    if (info.normalLike) {
      badges.push({ text: "N?", title: "Looks like a tangent-space normal map (mean ≈ 0.5, 0.5, 1.0)" });
    } else if (info.bimodal) {
      badges.push({ text: "MASK?", title: "Luma is bimodal — probably an opacity/cutout mask" });
    } else if (info.grayscale) {
      badges.push({ text: "GRAY", title: "Single-channel — roughness, height, AO or metallic" });
    }
    if (info.hasAlpha) badges.push({ text: "α", title: "Has an alpha channel" });
  }

  return (
    <AssetCell
      name={file.name}
      sub={humanSize(file.size)}
      badges={badges}
      selected={selected}
      checker
    >
      {thumb !== undefined ? (
        <img
          src={thumbUrl(thumb.key)}
          alt=""
          loading="lazy"
          draggable={false}
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <ImageIcon size={22} className="text-kind-texture opacity-30" />
        </div>
      )}
    </AssetCell>
  );
}
