import type { ReactElement } from "react";
import clsx from "clsx";
import { Image as ImageIcon } from "lucide-react";
import { useThumbSrc } from "../../hooks/useThumbSrc";
import { useRenderPrefs } from "../../stores/renderPrefs";
import { CHANNEL_CODE, CHANNEL_LABEL, STRIP_CHANNELS, type Channel } from "../../material/table";
import type { Material } from "../../material/classify";

export interface MaterialCellProps {
  material: Material;
  selected: boolean;
}

/** Packed maps carry three channels at once — show them after the strip. */
function packedOf(m: Material): Channel | undefined {
  for (const c of m.channels.keys()) if (c.startsWith("packed")) return c;
  return undefined;
}

/**
 * Per-channel colour for the strip. Each PBR channel reads in its own hue —
 * normal is periwinkle, like a real tangent-space normal map — so a material's
 * makeup registers at a glance. Full literal class strings so Tailwind's
 * scanner emits them.
 */
const CH_CLS: Partial<Record<Channel, string>> = {
  baseColor: "bg-ch-bc/15 text-ch-bc",
  normal: "bg-ch-n/15 text-ch-n",
  roughness: "bg-ch-r/15 text-ch-r",
  metallic: "bg-ch-m/15 text-ch-m",
  ao: "bg-ch-ao/15 text-ch-ao",
  height: "bg-ch-h/15 text-ch-h",
};

/**
 * One cell per material. Three signals separate it from a lone texture: the
 * stacked frame edge, the ×N badge, and the channel strip replacing the
 * metadata line. The strip is the useful one — `BC N R —` tells you the AO map
 * is missing before you click.
 */
export default function MaterialCell({ material, selected }: MaterialCellProps): ReactElement {
  // Face = base color if present, else whatever we have.
  const face = material.channels.get("baseColor") ?? material.members[0]!;
  const { src, imgKey, onError, onLoad } = useThumbSrc(face.file);
  const pixelArt = useRenderPrefs((s) => s.pixelArt);
  const showCellInfo = useRenderPrefs((s) => s.showCellInfo);
  const packed = packedOf(material);
  const lowConfidence = material.confidence < 0.8;

  return (
    // No margins here: AssetGrid computes row height from the cell box, so
    // anything that grows the box overlaps the row below. The stacked cards
    // are absolutely positioned and transform-offset, so they render outside
    // the box without contributing to layout — the 12px grid gap absorbs them.
    <div className="group relative">
      {/* Stacked cards behind the frame — the "this is a set" signal, now read
          as tonal cards with their own soft shadow rather than outlines. */}
      <div className="pointer-events-none absolute inset-0 translate-x-[5px] translate-y-[-5px] rounded-lg bg-panel opacity-45 shadow-e1" />
      <div className="pointer-events-none absolute inset-0 translate-x-[2.5px] translate-y-[-2.5px] rounded-lg bg-panel shadow-e1" />

      <div
        className={clsx(
          "relative overflow-hidden rounded-lg bg-panel transition-[box-shadow] duration-200 ease-spring",
          selected ? "bg-accent/8 shadow-sel" : "shadow-e1 group-hover:shadow-e2",
        )}
      >
        <div className="alpha-checker relative aspect-square w-full overflow-hidden">
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
          {showCellInfo && (
            <div className="pointer-events-none absolute inset-x-1.5 bottom-1.5 flex items-center gap-1">
              {lowConfidence && (
                <span
                  title={`Resolved by content — ${Math.round(material.confidence * 100)}% confidence`}
                  className="rounded-full bg-kind-model px-2 py-0.5 text-[9px] font-semibold text-[#1a1208]"
                >
                  ?
                </span>
              )}
              <span className="ml-auto rounded-full bg-accent/85 px-2 py-0.5 text-[9px] font-semibold tabular-nums text-white">
                ×{material.members.length}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1 px-2 pb-2 pt-1.5">
          <div className="truncate text-[11.5px]" title={`${material.display}\n${material.dir}`}>
            {material.display}
          </div>
          <div className="flex gap-[3px]">
            {STRIP_CHANNELS.map((ch) => {
              const has = material.channels.has(ch);
              return (
                <span
                  key={ch}
                  title={CHANNEL_LABEL[ch] + (has ? "" : " — missing")}
                  className={clsx(
                    "rounded-md px-1 py-px font-mono text-[8.5px] font-bold leading-tight",
                    has ? (CH_CLS[ch] ?? "bg-accent/15 text-accent") : "bg-bg text-faint opacity-70",
                  )}
                >
                  {CHANNEL_CODE[ch]}
                </span>
              );
            })}
            {packed !== undefined && (
              <span
                title={`${CHANNEL_LABEL[packed]} — three channels in RGB`}
                className="rounded-md bg-kind-texture/15 px-1 py-px font-mono text-[8.5px] font-bold leading-tight text-kind-texture"
              >
                {CHANNEL_CODE[packed]}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
