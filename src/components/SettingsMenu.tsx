import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Check, Settings } from "lucide-react";
import { MAX_SCALE, MIN_SCALE, THEMES, useThemeStore } from "../stores/theme";

/**
 * The header settings menu: theme palette + UI scale. Both are global, persisted
 * frontend prefs (see stores/theme). The gear lives at the right of the header.
 *
 * The whole document is zoomed by the UI-scale factor, so the popup is portaled
 * to <body> and positioned in screen space (the gear's measured rect / zoom),
 * with a counter-zoom on its content — that keeps it a FIXED size and in a
 * FIXED place while you drag the scale slider, instead of riding the header.
 */
export default function SettingsMenu(): ReactElement {
  const [open, setOpen] = useState(false);
  const gearRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const uiScale = useThemeStore((s) => s.uiScale);
  const setUiScale = useThemeStore((s) => s.setUiScale);
  const z = uiScale / 100;

  // Anchor to the gear's screen position. Fixed offsets are in CSS px, which the
  // document zoom multiplies by `z`, so divide the real px target by `z`.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = (): void => {
      const r = gearRef.current?.getBoundingClientRect();
      if (r === undefined) return;
      setPos({ top: (r.bottom + 4) / z, right: (window.innerWidth - r.right) / z });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, z]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (gearRef.current?.contains(t) === true) return;
      if (popupRef.current?.contains(t) === true) return;
      setOpen(false);
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
    <div className="flex h-full items-center pr-1">
      <button
        ref={gearRef}
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

      {open &&
        pos !== null &&
        createPortal(
          // Fixed position (screen space); the inner content counter-zooms so it
          // stays a fixed 16px size regardless of the app scale.
          <div style={{ position: "fixed", top: pos.top, right: pos.right, zoom: 100 / uiScale }} className="z-50">
            <div ref={popupRef} className="w-64 rounded-xl bg-raised p-3 shadow-e2">
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
                <span className="text-[10px] font-medium uppercase tracking-wide text-faint">UI scale</span>
                <span className="font-mono text-[11px] tabular-nums text-dim">{uiScale}%</span>
              </div>
              <input
                type="range"
                aria-label="UI scale"
                min={MIN_SCALE}
                max={MAX_SCALE}
                step={5}
                value={uiScale}
                className="volume w-full"
                style={{ ["--fill" as string]: `${((uiScale - MIN_SCALE) / (MAX_SCALE - MIN_SCALE)) * 100}%` }}
                onChange={(e) => setUiScale(Number(e.currentTarget.value))}
              />
              <div className="mt-1.5 text-[10px] leading-snug text-faint">
                Scales the whole interface — 100% is the 16px base.
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
