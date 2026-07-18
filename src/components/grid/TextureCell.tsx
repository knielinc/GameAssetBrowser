import type { ReactElement } from "react";
import { Image as ImageIcon } from "lucide-react";
import type { LibFile } from "../../stores/libraryStore";
import { useThumbSrc } from "../../hooks/useThumbSrc";
import { useRenderPrefs } from "../../stores/renderPrefs";
import { humanSize } from "../FileRow";
import AssetCell, { type Badge } from "./AssetCell";

export interface TextureCellProps {
  file: LibFile;
  selected: boolean;
  /** Render a transparent GL hole (the WebGL grid paints it) instead of an
   *  `<img>`. Off → the classic thumb:// image path. */
  gl?: boolean;
}

export default function TextureCell({ file, selected, gl }: TextureCellProps): ReactElement {
  // Derived key → the image shows the instant WebView2 can read it off disk,
  // no IPC round trip. `info` (badges) fills in when the stats request lands.
  const { src, cacheKey, imgKey, info, onError, onLoad } = useThumbSrc(file);
  const pixelArt = useRenderPrefs((s) => s.pixelArt);

  const badges: Badge[] = [{ text: file.ext.toUpperCase() }];
  if (info != null) {
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

  // Real source resolution, once the decode lands — pinned to the corner so a
  // 4K and a 256px atlas are told apart at a glance without opening either.
  const dims =
    info != null && info.sourceWidth > 0
      ? `${info.sourceWidth.toLocaleString()}×${info.sourceHeight.toLocaleString()}`
      : undefined;

  return (
    <AssetCell
      name={file.name}
      sub={humanSize(file.size)}
      badges={badges}
      corner={dims}
      selected={selected}
      checker
      thumbKey={gl === true ? cacheKey : undefined}
    >
      {src !== null ? (
        <img
          key={imgKey}
          src={src}
          alt=""
          loading="lazy"
          draggable={false}
          onError={onError}
          onLoad={onLoad}
          className="h-full w-full object-contain"
          style={{ imageRendering: pixelArt ? "pixelated" : "auto" }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <ImageIcon size={22} className="text-kind-texture opacity-30" />
        </div>
      )}
    </AssetCell>
  );
}
