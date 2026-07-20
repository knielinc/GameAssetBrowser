import { useEffect, useRef, useState, type ReactElement } from "react";
import clsx from "clsx";
import { usePlayerStore } from "../../stores/playerStore";

/** The auditioning ladder — matches every DAW's coarse preview steps. */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** `1×`, `0.75×` — trailing zeros dropped, so the button stays compact. */
function speedLabel(speed: number): string {
  return `${speed}×`;
}

/**
 * Compact playback-rate button for the player bar. Opens a small popup with
 * the fixed speed steps (SettingsMenu's outside-mousedown + Escape idiom);
 * anchored upward because the bar sits at the window's bottom edge. The value
 * is session-only — see playerStore.speed.
 */
export default function SpeedControl(): ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const speed = usePlayerStore((s) => s.speed);
  const setSpeed = usePlayerStore((s) => s.setSpeed);

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

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Speed (affects pitch)"
        className={clsx(
          "h-[26px] min-w-11 rounded-md px-2 text-[11px] font-semibold tabular-nums transition-colors duration-[120ms]",
          speed !== 1
            ? "bg-accent/15 text-accent hover:bg-accent/20 hover:text-accent-hover"
            : "text-dim hover:bg-raised hover:text-text",
        )}
      >
        {speedLabel(speed)}
      </button>

      {open && (
        <div className="absolute bottom-[calc(100%+4px)] right-0 z-50 w-24 rounded-xl bg-raised p-1 shadow-e2">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSpeed(s);
                setOpen(false);
              }}
              className={clsx(
                "flex w-full items-center justify-between rounded-lg px-2 py-1 text-[11px] tabular-nums transition-colors duration-[120ms]",
                s === speed
                  ? "bg-accent-fill text-accent-fg"
                  : "text-dim hover:bg-overlay hover:text-text",
              )}
            >
              {speedLabel(s)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
