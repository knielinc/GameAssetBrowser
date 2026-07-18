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
    <div className={clsx("flex gap-0.5 rounded-full bg-bg p-0.5", className)}>
      {MODEL_LIGHTS.map((l) => (
        <button
          key={l.id}
          type="button"
          className={clsx(
            "h-[23px] flex-1 rounded-full px-2 text-[10px] transition-colors duration-[120ms]",
            modelLight === l.id
              ? "bg-accent-fill font-medium text-accent-fg shadow-e1"
              : "text-dim hover:bg-overlay hover:text-text",
          )}
          onClick={() => setModelLight(l.id)}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
