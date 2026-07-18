import { memo, type ReactElement, type ReactNode } from "react";
import clsx from "clsx";
import { useRenderPrefs } from "../../stores/renderPrefs";

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
  /** Pill pinned to the thumb's top-right — e.g. the file size. */
  topRight?: ReactNode;
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
  topRight,
}: AssetCellProps): ReactElement {
  const gl = thumbKey !== undefined;
  // The size/dimension/format pills are opt-out per the global setting.
  const showInfo = useRenderPrefs((s) => s.showCellInfo);
  return (
    <div
      className={clsx(
        // Separation by tone + soft shadow, never a 1px outline. Elevation on
        // hover is shadow-only — no transform — because the WebGL grid paints
        // the thumb hole at its measured rect and only repaints on
        // scroll/resize; a translate here would slide the frame off its paint.
        "group relative overflow-hidden rounded-lg transition-[box-shadow] duration-200 ease-spring",
        // GL cells keep the frame transparent so the canvas behind shows
        // through the thumb hole; the meta strip below carries its own bg.
        gl ? "bg-transparent" : "bg-panel",
        selected
          ? gl
            ? "shadow-sel"
            : "bg-accent/8 shadow-sel"
          : "shadow-e1 group-hover:shadow-e2",
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
        {showInfo && corner !== undefined && (
          <div className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-[#0c0d12e6] px-2 py-0.5 text-[9px] font-semibold tabular-nums text-text">
            {corner}
          </div>
        )}
        {showInfo && topRight !== undefined && (
          <div className="pointer-events-none absolute right-1.5 top-1.5 rounded-full bg-[#0c0d12e6] px-2 py-0.5 text-[9px] font-semibold tabular-nums text-text">
            {topRight}
          </div>
        )}
        {showInfo && badges !== undefined && badges.length > 0 && (
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
                  "rounded-full px-2 py-0.5 text-[9px] font-semibold tabular-nums",
                  i === badges.length - 1 && badges.length > 1 && "ml-auto",
                  b.warn ? "bg-kind-model text-[#1a1208]" : "bg-[#0c0d12e6] text-text",
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
        {sub !== undefined && <div className="truncate text-[10px] tabular-nums text-dim">{sub}</div>}
      </div>
    </div>
  );
}

const AssetCell = memo(AssetCellInner);
export default AssetCell;
