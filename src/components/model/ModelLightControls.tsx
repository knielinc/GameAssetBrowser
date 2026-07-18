import type { ReactElement } from "react";
import clsx from "clsx";
import { useRenderPrefs, MODEL_LIGHTS } from "../../stores/renderPrefs";

/**
 * Lighting-rig selector for the 3D model viewport. The rig is a GLOBAL render
 * choice (useRenderPrefs), so this one control drives the docked inspector and
 * the fullscreen preview interchangeably — change it in either and both agree.
 */
export default function ModelLightControls({ className }: { className?: string }): ReactElement {
  const modelLight = useRenderPrefs((s) => s.modelLight);
  const setModelLight = useRenderPrefs((s) => s.setModelLight);
  return (
    <div className={clsx("flex gap-[3px]", className)}>
      {MODEL_LIGHTS.map((l) => (
        <button
          key={l.id}
          type="button"
          className={clsx(
            "h-[23px] flex-1 rounded-md border px-1.5 text-[10px] transition-colors duration-[120ms]",
            modelLight === l.id
              ? "border-accent/45 bg-accent/12 text-accent"
              : "border-border text-dim hover:bg-raised hover:text-text",
          )}
          onClick={() => setModelLight(l.id)}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
