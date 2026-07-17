import type { CSSProperties, ReactElement } from "react";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { usePlayerStore } from "../../stores/playerStore";

export default function VolumeSlider(): ReactElement {
  const volume = usePlayerStore((s) => s.volume);
  const setVolume = usePlayerStore((s) => s.setVolume);

  const Icon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div className="flex w-36 shrink-0 items-center gap-2.5">
      <Icon size={15} className="shrink-0 text-dim" />
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        aria-label="Volume"
        className="volume w-full"
        style={{ "--fill": `${volume * 100}%` } as CSSProperties}
        onChange={(e) => setVolume(Number(e.currentTarget.value))}
      />
    </div>
  );
}
