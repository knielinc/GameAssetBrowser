import { memo, type ReactElement, type ReactNode } from "react";
import clsx from "clsx";

export interface Badge {
  text: string;
  title?: string;
  /** Amber "needs attention" tint instead of the neutral overlay. */
  warn?: boolean;
}

export interface AssetCellProps {
  name: string;
  sub?: ReactNode;
  badges?: Badge[];
  selected: boolean;
  /** The thumbnail area. Falls back to a format-lettered placeholder. */
  children?: ReactNode;
  /** Alpha checkerboard behind the thumb — cutout foliage on a dark panel
   *  reads as broken without it. */
  checker?: boolean;
  /** When set, the thumb area is a transparent hole tagged for the WebGL grid
   *  (ThumbGLOverlay), which paints the letterbox, checker and image behind it.
   *  `children` are ignored — the canvas is the thumbnail. */
  thumbKey?: string;
  /** Small label pinned to the thumb's top-left — e.g. a texture's pixel
   *  dimensions. Rendered as chrome (like badges), so it shows in GL cells too
   *  where `children` are dropped. */
  corner?: ReactNode;
}

function AssetCellInner({
  name,
  sub,
  badges,
  selected,
  children,
  checker,
  thumbKey,
  corner,
}: AssetCellProps): ReactElement {
  const gl = thumbKey !== undefined;
  return (
    <div
      className={clsx(
        "group relative overflow-hidden rounded-lg border transition-colors duration-[120ms]",
        // GL cells keep the frame transparent so the canvas behind shows
        // through the thumb hole; the meta strip below carries its own bg.
        gl ? "bg-transparent" : "bg-panel",
        selected
          ? gl
            ? "border-accent shadow-[0_0_0_1px_var(--color-accent)]"
            : "border-accent bg-accent/8 shadow-[0_0_0_1px_var(--color-accent)]"
          : "border-border hover:border-accent/40",
      )}
    >
      <div
        data-thumb-key={thumbKey}
        className={clsx(
          "relative aspect-square w-full overflow-hidden",
          // GL cells are a transparent hole; the canvas behind paints the
          // background, so bg-raised/checker here would just occlude it.
          gl ? "bg-transparent" : ["bg-raised", checker && "alpha-checker"],
        )}
      >
        {gl ? null : children}
        {corner !== undefined && (
          <div className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-[#0a0a0fd9] px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-text">
            {corner}
          </div>
        )}
        {badges !== undefined && badges.length > 0 && (
          <div className="pointer-events-none absolute inset-x-1.5 bottom-1.5 flex items-center gap-1">
            {badges.map((b, i) => (
              <span
                key={i}
                title={b.title}
                // NO backdrop-blur. It forces its own compositing layer, and
                // inside a virtualizer whose rows move by translateY those
                // layers visibly lag behind the content while scrolling. A
                // solid tint reads the same and composites for free.
                className={clsx(
                  "rounded px-1.5 py-0.5 text-[9px] font-semibold tabular-nums",
                  i === badges.length - 1 && badges.length > 1 && "ml-auto",
                  b.warn ? "bg-kind-model text-[#1a1208]" : "bg-[#0a0a0fd9] text-text",
                )}
              >
                {b.text}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className={clsx("flex flex-col gap-0.5 px-2 pb-2 pt-1.5", gl && "bg-panel")}>
        <div className="truncate text-[11.5px]" title={name}>
          {name}
        </div>
        <div className="truncate text-[10px] tabular-nums text-dim">{sub}</div>
      </div>
    </div>
  );
}

const AssetCell = memo(AssetCellInner);
export default AssetCell;
