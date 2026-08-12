import { type ReactElement } from "react";
import clsx from "clsx";
import { AlignCenter, AlignJustify } from "lucide-react";
import { useDocView, MIN_READ_W, MAX_READ_W, type ReadWidth } from "../../stores/docView";

const OPTIONS: { id: ReadWidth; label: string; icon: typeof AlignCenter }[] = [
  { id: "readable", label: "Readable width", icon: AlignCenter },
  { id: "full", label: "Full width", icon: AlignJustify },
];

/** Centered-column vs full-width toggle for text/markdown, backed by the shared
 *  docView store so both preview surfaces agree and it persists. In readable
 *  mode a slider adjusts the column's width. */
export default function ReadWidthControls({ className }: { className?: string }): ReactElement {
  const readWidth = useDocView((s) => s.readWidth);
  const setReadWidth = useDocView((s) => s.setReadWidth);
  const readableWidth = useDocView((s) => s.readableWidth);
  const setReadableWidth = useDocView((s) => s.setReadableWidth);
  return (
    <div className={clsx("flex items-center gap-1 rounded-full bg-bg p-1", className)}>
      {readWidth === "readable" && (
        <input
          type="range"
          min={MIN_READ_W}
          max={MAX_READ_W}
          step={20}
          value={readableWidth}
          aria-label="Column width"
          title={`Column width (${readableWidth}px)`}
          className="rd-width-slider mx-1 w-20"
          onChange={(e) => setReadableWidth(Number(e.currentTarget.value))}
        />
      )}
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          title={o.label}
          aria-pressed={readWidth === o.id}
          onClick={() => setReadWidth(o.id)}
          className={clsx(
            "flex h-6 w-7 items-center justify-center rounded-full transition-colors duration-[120ms]",
            readWidth === o.id
              ? "bg-accent-fill text-accent-fg"
              : "text-dim hover:bg-hover-strong hover:text-text",
          )}
        >
          <o.icon size={13} />
        </button>
      ))}
    </div>
  );
}
