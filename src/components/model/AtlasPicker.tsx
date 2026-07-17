import { type ReactElement } from "react";
import clsx from "clsx";
import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { modelUrl } from "../../model/loadModel";
import { packDirOf, useAtlasStore } from "../../stores/atlasStore";

export interface AtlasPickerProps {
  modelPath: string;
  /** Nearby images found by model_texture_hints, offered as quick picks. */
  candidates: string[];
  /** What is currently on the model, if the user has chosen something. */
  applied: string | null;
}

const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/**
 * Choose a model's texture BY HAND.
 *
 * There is no automatic guessing anywhere — Synty OBJ ship no .mtl and Synty
 * FBX name a file that isn't in the pack, so any auto-pick is a coin flip, and
 * a wrong texture looks worse than an honest grey model. Instead the user
 * picks: a nearby image (quick swatches) or any file on disk (Browse). The
 * choice is scoped to the PACK, so one pick covers all its models and both the
 * FBX and OBJ copy of each, and it persists across launches.
 */
export default function AtlasPicker({ modelPath, candidates, applied }: AtlasPickerProps): ReactElement {
  const packDir = packDirOf(modelPath);
  const choice = useAtlasStore((s) => s.overrides[packDir.toLowerCase()]);
  const setOverride = useAtlasStore((s) => s.setOverride);
  const clearOverride = useAtlasStore((s) => s.clearOverride);

  const flipY = choice?.flipY ?? false;

  const choose = (path: string): void => {
    // Let model:// serve this exact file even if it's outside the scanned
    // roots — the user picked it, so it is trusted.
    void invoke("approve_texture", { path }).catch(() => {});
    setOverride(packDir, { path, flipY });
  };

  const browse = async (): Promise<void> => {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "tga", "bmp", "webp", "dds"] }],
    });
    if (typeof picked === "string") choose(picked);
  };

  const toggleFlip = (): void => {
    const target = choice?.path ?? applied;
    if (target == null) return;
    setOverride(packDir, { path: target, flipY: !flipY });
  };

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <h4 className="text-[10px] font-semibold uppercase tracking-widest text-dim">Texture</h4>
        {choice !== undefined && (
          <button
            type="button"
            className="text-[10px] text-dim transition-colors duration-[120ms] hover:text-text"
            onClick={() => clearOverride(packDir)}
          >
            clear
          </button>
        )}
      </div>

      <p className="text-[10.5px] leading-snug text-dim">
        This model's textures aren't embedded. Pick one — it applies to the
        whole pack.
      </p>

      {candidates.length > 0 && (
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
                onClick={() => choose(c)}
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
      )}

      <button
        type="button"
        className="flex h-[26px] items-center justify-center gap-1.5 rounded-md border border-border text-[11px] text-dim transition-colors duration-[120ms] hover:bg-raised hover:text-text"
        onClick={() => void browse()}
      >
        <FolderOpen size={12} />
        Browse for a texture…
      </button>

      {(choice !== undefined || applied !== null) && (
        <button
          type="button"
          title="Palette/ramp atlases are asymmetric, so a wrong flip lands on different COLOURS, not a mirrored image. If the colours look scrambled, try this."
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
      )}
    </section>
  );
}
