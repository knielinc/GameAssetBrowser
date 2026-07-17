import { type ReactElement } from "react";
import clsx from "clsx";
import clsxDefault from "clsx";
import { modelUrl } from "../../model/loadModel";
import { packDirOf, useAtlasStore, type AtlasChoice } from "../../stores/atlasStore";

void clsxDefault;

export interface AtlasPickerProps {
  modelPath: string;
  /** Nearby images found by model_texture_hints. */
  candidates: string[];
  /** What is on the model right now (manual or guessed). */
  applied: string | null;
  /** True when `applied` came from the user, not the heuristic. */
  manual: boolean;
}

const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/**
 * Pick the pack's atlas by hand.
 *
 * This exists because auto-detection provably cannot do it: Synty OBJ carry no
 * .mtl, their FBX name a file that is not in the pack, and the four shipped
 * variants share a layout while differing only in colour — no pixel test tells
 * you which one the artist meant. The information simply isn't in the files.
 *
 * Scoped to the PACK, not the model: one pick fixes all ~400 models, and both
 * the FBX and OBJ copies of each.
 */
export default function AtlasPicker({
  modelPath,
  candidates,
  applied,
  manual,
}: AtlasPickerProps): ReactElement | null {
  const packDir = packDirOf(modelPath);
  const choice = useAtlasStore((s) => s.overrides[packDir.toLowerCase()]);
  const setOverride = useAtlasStore((s) => s.setOverride);
  const clearOverride = useAtlasStore((s) => s.clearOverride);

  if (candidates.length === 0) return null;

  const flipY = choice?.flipY ?? false;
  const pick = (path: string): void => setOverride(packDir, { path, flipY });
  const toggleFlip = (): void => {
    const target = choice?.path ?? applied;
    if (target === null || target === undefined) return;
    setOverride(packDir, { path: target, flipY: !flipY } satisfies AtlasChoice);
  };

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <h4 className="text-[10px] font-semibold uppercase tracking-widest text-dim">Atlas</h4>
        {choice !== undefined && (
          <button
            type="button"
            className="text-[10px] text-dim transition-colors duration-[120ms] hover:text-text"
            onClick={() => clearOverride(packDir)}
          >
            reset
          </button>
        )}
      </div>

      <p className="text-[10.5px] leading-snug text-dim">
        {manual
          ? "Your pick, applied to every model in this pack."
          : "This pack's models don't name a usable texture, so this is a guess. Pick the right one — it applies to the whole pack."}
      </p>

      <div className="grid grid-cols-4 gap-1.5">
        {candidates.slice(0, 12).map((c) => {
          const on = (choice?.path ?? applied) === c;
          return (
            <button
              key={c}
              type="button"
              title={basename(c)}
              className={clsx(
                "alpha-checker aspect-square overflow-hidden rounded border transition-colors duration-[120ms]",
                on ? "border-accent shadow-[0_0_0_1px_var(--color-accent)]" : "border-border hover:border-accent/50",
              )}
              onClick={() => pick(c)}
            >
              <img
                src={modelUrl(c)}
                alt={basename(c)}
                draggable={false}
                className="h-full w-full object-cover"
              />
            </button>
          );
        })}
      </div>

      <button
        type="button"
        title="Palette atlases are asymmetric top-to-bottom, so a wrong flip lands on different COLOURS rather than a mirrored image. If the colours look scrambled, try this."
        className={clsx(
          "h-[23px] rounded-md border text-[10px] transition-colors duration-[120ms]",
          flipY
            ? "border-accent/45 bg-accent/12 text-accent"
            : "border-border text-dim hover:bg-raised hover:text-text",
        )}
        onClick={toggleFlip}
      >
        Flip Y {flipY ? "on" : "off"}
      </button>
    </section>
  );
}
