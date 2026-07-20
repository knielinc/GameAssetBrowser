import { useEffect, useRef, useState, type ReactElement } from "react";
import clsx from "clsx";
import { AppWindow, BarChart3, Check, CopyCheck, MousePointer2, Settings } from "lucide-react";
import { MAX_SCALE, MIN_SCALE, THEMES, useThemeStore } from "../stores/theme";
import { usePlayerStore } from "../stores/playerStore";
import DuplicatesModal from "./DuplicatesModal";
import ExternalAppsModal from "./ExternalAppsModal";
import StatsModal from "./StatsModal";

/**
 * The header settings menu: theme palette + UI scale. Both are global, persisted
 * frontend prefs (see stores/theme).
 *
 * The scale slider only PREVIEWS its value while dragging; the document zoom is
 * applied on release, so nothing (including this popup) scales or jumps under
 * the cursor mid-drag — the whole UI snaps to the new size when you let go.
 */
export default function SettingsMenu(): ReactElement {
  const [open, setOpen] = useState(false);
  // Library tools launched from the menu. Mounted as siblings of the popup —
  // opening one closes the popup, so the outside-mousedown closer never
  // fights the modal's own backdrop handling.
  const [showDupes, setShowDupes] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showApps, setShowApps] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const uiScale = useThemeStore((s) => s.uiScale);
  const setUiScale = useThemeStore((s) => s.setUiScale);
  const hoverPreview = usePlayerStore((s) => s.hoverPreview);
  const toggleHoverPreview = usePlayerStore((s) => s.toggleHoverPreview);

  // Live preview value; the committed scale (uiScale) only changes on release.
  const [pending, setPending] = useState(uiScale);
  useEffect(() => setPending(uiScale), [uiScale, open]);

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
  const commit = (): void => setUiScale(pending);

  return (
    <div ref={ref} className="relative flex h-full items-center">
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

      {/* Left-anchored: the button lives on the left side of the header
          (between branding and the lens tabs), so a right-anchored popup
          would hang off the window edge. */}
      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-50 w-64 rounded-xl bg-raised p-3 shadow-e2">
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
            <span className="font-mono text-[11px] tabular-nums text-dim">{pending}%</span>
          </div>
          <input
            type="range"
            aria-label="UI scale"
            min={MIN_SCALE}
            max={MAX_SCALE}
            step={5}
            value={pending}
            className="volume w-full"
            style={{ ["--fill" as string]: `${((pending - MIN_SCALE) / (MAX_SCALE - MIN_SCALE)) * 100}%` }}
            onChange={(e) => setPending(Number(e.currentTarget.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
          />
          <div className="mt-1.5 text-[10px] leading-snug text-faint">
            Scales the whole interface on release — 100% is the 16px base.
          </div>

          <div className="mb-1.5 mt-4 text-[10px] font-medium uppercase tracking-wide text-faint">
            Playback
          </div>
          {/* Persisted in Settings (see playerStore.hoverPreview); the dwell
              behavior itself lives in FileList's row hover handlers. */}
          <button
            type="button"
            aria-pressed={hoverPreview}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-dim transition-colors duration-[120ms] hover:bg-overlay hover:text-text"
            onClick={toggleHoverPreview}
          >
            <MousePointer2 size={13} className="shrink-0 text-faint" />
            <span className="flex-1">Hover to preview (audio)</span>
            {hoverPreview && <Check size={13} className="shrink-0 text-accent" />}
          </button>

          <div className="mb-1.5 mt-4 text-[10px] font-medium uppercase tracking-wide text-faint">
            Library
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-dim transition-colors duration-[120ms] hover:bg-overlay hover:text-text"
            onClick={() => {
              setOpen(false);
              setShowDupes(true);
            }}
          >
            <CopyCheck size={13} className="shrink-0 text-faint" />
            Find duplicates…
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-dim transition-colors duration-[120ms] hover:bg-overlay hover:text-text"
            onClick={() => {
              setOpen(false);
              setShowStats(true);
            }}
          >
            <BarChart3 size={13} className="shrink-0 text-faint" />
            Library statistics…
          </button>
          {/* Per-kind "Open with…" targets for the file context menus. */}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-dim transition-colors duration-[120ms] hover:bg-overlay hover:text-text"
            onClick={() => {
              setOpen(false);
              setShowApps(true);
            }}
          >
            <AppWindow size={13} className="shrink-0 text-faint" />
            External apps…
          </button>
        </div>
      )}

      {showDupes && <DuplicatesModal onClose={() => setShowDupes(false)} />}
      {showStats && <StatsModal onClose={() => setShowStats(false)} />}
      {showApps && <ExternalAppsModal onClose={() => setShowApps(false)} />}
    </div>
  );
}
