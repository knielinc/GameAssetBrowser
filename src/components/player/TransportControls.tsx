import type { ReactElement } from "react";
import clsx from "clsx";
import { Pause, Play, Repeat, Square } from "lucide-react";
import { playerStop } from "../../ipc/commands";
import { positionRef, usePlayerStore, usePositionStore } from "../../stores/playerStore";

export default function TransportControls(): ReactElement {
  const playing = usePlayerStore((s) => s.playing);
  const loop = usePlayerStore((s) => s.loop);
  const autoplay = usePlayerStore((s) => s.autoplay);
  const hasTrack = usePlayerStore((s) => s.currentPath !== null);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const toggleLoop = usePlayerStore((s) => s.toggleLoop);
  const toggleAutoplay = usePlayerStore((s) => s.toggleAutoplay);

  const onStop = (): void => {
    if (!hasTrack) return;
    void playerStop();
    usePlayerStore.setState({ playing: false });
    positionRef.playing = false;
    positionRef.seconds = 0;
    usePositionStore.setState({ seconds: 0 });
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        className="play-btn"
        disabled={!hasTrack}
        onClick={togglePlay}
        title="Play / Pause (Space)"
      >
        {playing ? (
          <Pause size={15} fill="currentColor" strokeWidth={0} />
        ) : (
          <Play size={15} fill="currentColor" strokeWidth={0} className="translate-x-px" />
        )}
      </button>

      <button
        type="button"
        className="icon-btn"
        disabled={!hasTrack}
        onClick={onStop}
        title="Stop"
      >
        <Square size={11} fill="currentColor" strokeWidth={0} />
      </button>

      <button
        type="button"
        className={clsx("icon-btn", loop && "icon-btn-active")}
        onClick={toggleLoop}
        title="Loop (L)"
      >
        <Repeat size={14} />
      </button>

      <button
        type="button"
        onClick={toggleAutoplay}
        title="Autoplay on select"
        className={clsx(
          "h-[26px] rounded-md px-2 text-[10px] font-semibold uppercase tracking-widest transition-colors duration-[120ms]",
          autoplay
            ? "bg-accent/15 text-accent hover:bg-accent/20 hover:text-accent-hover"
            : "text-dim hover:bg-raised hover:text-text",
        )}
      >
        auto
      </button>
    </div>
  );
}
