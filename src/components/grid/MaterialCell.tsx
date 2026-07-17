import type { ReactElement } from "react";
import clsx from "clsx";
import { Image as ImageIcon } from "lucide-react";
import { useThumbSrc } from "../../hooks/useThumbSrc";
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
 * One cell per material. Three signals separate it from a lone texture: the
 * stacked frame edge, the ×N badge, and the channel strip replacing the
 * metadata line. The strip is the useful one — `BC N R —` tells you the AO map
 * is missing before you click.
 */
export default function MaterialCell({ material, selected }: MaterialCellProps): ReactElement {
  // Face = base color if present, else whatever we have.
  const face = material.channels.get("baseColor") ?? material.members[0]!;
  const { src, imgKey, onError, onLoad } = useThumbSrc(face.file);
  const packed = packedOf(material);
  const lowConfidence = material.confidence < 0.8;

  return (
    // No margins here: AssetGrid computes row height from the cell box, so
    // anything that grows the box overlaps the row below. The stacked cards
    // are absolutely positioned and transform-offset, so they render outside
    // the box without contributing to layout — the 12px grid gap absorbs them.
    <div className="relative">
      {/* Stacked cards behind the frame — the "this is a set" signal. */}
      <div className="pointer-events-none absolute inset-0 translate-x-[5px] translate-y-[-5px] rounded-lg border border-border bg-panel opacity-55" />
      <div className="pointer-events-none absolute inset-0 translate-x-[2.5px] translate-y-[-2.5px] rounded-lg border border-border bg-panel" />

      <div
        className={clsx(
          "relative overflow-hidden rounded-lg border bg-panel transition-colors duration-[120ms]",
          selected
            ? "border-accent bg-accent/8 shadow-[0_0_0_1px_var(--color-accent)]"
            : "border-border hover:border-accent/40",
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
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <ImageIcon size={22} className="text-kind-texture opacity-30" />
            </div>
          )}
          <div className="pointer-events-none absolute inset-x-1.5 bottom-1.5 flex items-center gap-1">
            {lowConfidence && (
              <span
                title={`Resolved by content — ${Math.round(material.confidence * 100)}% confidence`}
                className="rounded bg-kind-model px-1.5 py-0.5 text-[9px] font-semibold text-[#1a1208]"
              >
                ?
              </span>
            )}
            <span className="ml-auto rounded bg-accent/80 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-white">
              ×{material.members.length}
            </span>
          </div>
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
                    "rounded border px-1 py-px font-mono text-[8.5px] font-bold leading-tight",
                    has
                      ? "border-accent/45 bg-accent/12 text-accent"
                      : "border-border text-dim opacity-45",
                  )}
                >
                  {CHANNEL_CODE[ch]}
                </span>
              );
            })}
            {packed !== undefined && (
              <span
                title={`${CHANNEL_LABEL[packed]} — three channels in RGB`}
                className="rounded border border-kind-texture/45 bg-kind-texture/12 px-1 py-px font-mono text-[8.5px] font-bold leading-tight text-kind-texture"
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
