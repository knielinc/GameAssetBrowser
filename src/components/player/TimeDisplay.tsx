import type { ReactElement } from "react";
import { usePlayerStore, usePositionStore } from "../../stores/playerStore";

/** Format seconds as `m:ss.t` (tenths), e.g. `1:03.4`. */
export function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalTenths = Math.floor(safe * 10);
  const tenths = totalTenths % 10;
  const secs = Math.floor(totalTenths / 10) % 60;
  const mins = Math.floor(totalTenths / 600);
  return `${mins}:${secs.toString().padStart(2, "0")}.${tenths}`;
}

/**
 * The one component that subscribes to the 20 Hz position slice — position
 * ticks re-render this leaf and nothing else.
 */
export default function TimeDisplay(): ReactElement {
  const seconds = usePositionStore((s) => s.seconds);
  const duration = usePlayerStore((s) => s.duration);

  return (
    <div className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-dim">
      <span className="text-text">{formatTime(seconds)}</span>
      <span> / {duration > 0 ? formatTime(duration) : "–:––.–"}</span>
    </div>
  );
}
