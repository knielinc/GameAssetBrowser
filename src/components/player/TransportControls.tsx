import type { ReactElement } from "react";
import clsx from "clsx";
import { ListEnd, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward, Square } from "lucide-react";
import { playerStop } from "../../ipc/commands";
import {
  playAdjacent,
  positionRef,
  shuffleAudio,
  useAudioListStore,
  usePlayerStore,
  usePositionStore,
} from "../../stores/playerStore";

export default function TransportControls(): ReactElement {
  const playing = usePlayerStore((s) => s.playing);
  const loop = usePlayerStore((s) => s.loop);
  const autoplay = usePlayerStore((s) => s.autoplay);
  const autoAdvance = usePlayerStore((s) => s.autoAdvance);
  const hasTrack = usePlayerStore((s) => s.currentPath !== null);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const toggleLoop = usePlayerStore((s) => s.toggleLoop);
  const toggleAutoplay = usePlayerStore((s) => s.toggleAutoplay);
  const toggleAutoAdvance = usePlayerStore((s) => s.toggleAutoAdvance);
  // Prev/next/shuffle step the visible audio list, so they light up as soon as
  // one exists — even before a track is picked (next → first).
  const hasList = useAudioListStore((s) => s.count > 0);

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
      {/* Prev — play — next: the skip buttons flank Play so "back/forward one
          track" reads at a glance, iPod-style. */}
      <button
        type="button"
        className="icon-btn"
        disabled={!hasList}
        onClick={() => playAdjacent(-1)}
        title="Previous track"
      >
        <SkipBack size={14} fill="currentColor" strokeWidth={0} />
      </button>

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
        disabled={!hasList}
        onClick={() => playAdjacent(1)}
        title="Next track"
      >
        <SkipForward size={14} fill="currentColor" strokeWidth={0} />
      </button>

      <button
        type="button"
        className="icon-btn"
        disabled={!hasList}
        onClick={shuffleAudio}
        title="Shuffle — play a random track"
      >
        <Shuffle size={14} />
      </button>

      <div className="mx-0.5 h-5 w-px bg-bg" />

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

      {/* Loop and auto-advance are siblings on purpose: both answer "what
          happens when the track ends?" — loop wins while both are lit. Distinct
          from the manual Next skip above: this is the automatic continue. */}
      <button
        type="button"
        className={clsx("icon-btn", autoAdvance && "icon-btn-active")}
        onClick={toggleAutoAdvance}
        title="Auto-advance: play the next file when a track ends"
      >
        <ListEnd size={14} />
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
