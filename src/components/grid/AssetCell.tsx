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
}

function AssetCellInner({
  name,
  sub,
  badges,
  selected,
  children,
  checker,
}: AssetCellProps): ReactElement {
  return (
    <div
      className={clsx(
        "group relative overflow-hidden rounded-lg border bg-panel transition-colors duration-[120ms]",
        // Grids want an outline; lists want a leading edge. Same accent, and
        // deliberately a different affordance from .row-selected.
        selected
          ? "border-accent bg-accent/8 shadow-[0_0_0_1px_var(--color-accent)]"
          : "border-border hover:border-accent/40",
      )}
    >
      <div
        className={clsx("relative aspect-square w-full overflow-hidden bg-raised", checker && "alpha-checker")}
      >
        {children}
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

      <div className="flex flex-col gap-0.5 px-2 pb-2 pt-1.5">
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
