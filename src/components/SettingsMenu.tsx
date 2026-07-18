import { useEffect, useRef, useState, type ReactElement } from "react";
import clsx from "clsx";
import { Check, Settings } from "lucide-react";
import { DEFAULT_FONT, MAX_FONT, MIN_FONT, THEMES, useThemeStore } from "../stores/theme";

/**
 * The header settings menu: theme palette + base UI size. Both are global,
 * persisted frontend prefs (see stores/theme). The gear lives at the right of
 * the header, just before the window controls.
 */
export default function SettingsMenu(): ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const baseFont = useThemeStore((s) => s.baseFont);
  const setBaseFont = useThemeStore((s) => s.setBaseFont);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = THEMES.find((t) => t.id === themeId);

  return (
    <div ref={ref} className="relative flex h-full items-center pr-1">
      <button
        type="button"
        title="Settings"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "flex h-7 w-7 items-center justify-center rounded-full transition-colors duration-[120ms]",
          open ? "bg-accent-fill text-accent-fg" : "text-dim hover:bg-overlay hover:text-text",
        )}
      >
        <Settings size={14} />
      </button>

      {open && (
        <div
          // Counter the document `zoom` so the menu stays a fixed size while you
          // drag the base-size slider (otherwise it scales under your cursor).
          style={{ zoom: DEFAULT_FONT / baseFont }}
          className="absolute right-0 top-[calc(100%+4px)] z-50 w-64 rounded-xl bg-raised p-3 shadow-e2"
        >
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-faint">Theme</div>
          <div className="grid grid-cols-5 gap-1.5">
            {THEMES.map((t) => {
              const on = t.id === themeId;
              return (
                <button
                  key={t.id}
                  type="button"
                  title={t.name}
                  onClick={() => setTheme(t.id)}
                  className="relative flex h-9 items-center justify-center rounded-lg transition-transform duration-[120ms] hover:-translate-y-0.5"
                  style={{ background: t.swatch[0], boxShadow: on ? `0 0 0 2px var(--color-accent)` : "var(--shadow-e1)" }}
                >
                  <span className="h-3.5 w-3.5 rounded-full" style={{ background: t.swatch[1] }} />
                  {on && (
                    <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-bg">
                      <Check size={10} strokeWidth={3} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="mt-1.5 text-center text-[11px] text-dim">{active?.name}</div>

          <div className="mb-2 mt-4 flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wide text-faint">Base size</span>
            <span className="font-mono text-[11px] tabular-nums text-dim">{baseFont}px</span>
          </div>
          <input
            type="range"
            aria-label="Base UI size"
            min={MIN_FONT}
            max={MAX_FONT}
            step={1}
            value={baseFont}
            className="volume w-full"
            style={{ ["--fill" as string]: `${((baseFont - MIN_FONT) / (MAX_FONT - MIN_FONT)) * 100}%` }}
            onChange={(e) => setBaseFont(Number(e.currentTarget.value))}
          />
          <div className="mt-1.5 text-[10px] leading-snug text-faint">
            Scales the whole interface off the chosen size.
          </div>
        </div>
      )}
    </div>
  );
}
