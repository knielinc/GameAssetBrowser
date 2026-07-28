import { type ReactElement } from "react";
import clsx from "clsx";
import { Moon, Sun } from "lucide-react";
import { useDocView, type ReadTheme } from "../../stores/docView";

const OPTIONS: { id: ReadTheme; label: string; icon: typeof Moon }[] = [
  { id: "dark", label: "Dark page", icon: Moon },
  { id: "light", label: "Light page", icon: Sun },
];

/** Reading-page colour for prose documents (ebook / markdown / text), backed by
 *  the shared docView store so the drawer and fullscreen agree and it persists.
 *  Seeded from the app theme, then independent of it — see docView.readTheme. */
export default function ReadThemeControls({ className }: { className?: string }): ReactElement {
  const readTheme = useDocView((s) => s.readTheme);
  const setReadTheme = useDocView((s) => s.setReadTheme);
  return (
    <div className={clsx("flex items-center gap-1 rounded-full bg-bg p-1", className)}>
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          title={o.label}
          aria-pressed={readTheme === o.id}
          onClick={() => setReadTheme(o.id)}
          className={clsx(
            "flex h-6 w-7 items-center justify-center rounded-full transition-colors duration-[120ms]",
            readTheme === o.id
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
