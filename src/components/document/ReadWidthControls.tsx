import { type ReactElement } from "react";
import clsx from "clsx";
import { AlignCenter, AlignJustify } from "lucide-react";
import { useDocView, type ReadWidth } from "../../stores/docView";

const OPTIONS: { id: ReadWidth; label: string; icon: typeof AlignCenter }[] = [
  { id: "readable", label: "Readable width", icon: AlignCenter },
  { id: "full", label: "Full width", icon: AlignJustify },
];

/** Centered-column vs full-width toggle for text/markdown, backed by the shared
 *  docView store so both preview surfaces agree and it persists. */
export default function ReadWidthControls({ className }: { className?: string }): ReactElement {
  const readWidth = useDocView((s) => s.readWidth);
  const setReadWidth = useDocView((s) => s.setReadWidth);
  return (
    <div className={clsx("flex items-center gap-0.5 rounded-full bg-bg p-0.5", className)}>
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
              : "text-dim hover:bg-overlay hover:text-text",
          )}
        >
          <o.icon size={13} />
        </button>
      ))}
    </div>
  );
}
