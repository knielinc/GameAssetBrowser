import { type ReactElement } from "react";
import { Minus, Plus } from "lucide-react";
import { MAX_SCALE, MIN_SCALE, useDocView } from "../../stores/docView";

/** A−/A+ zoom control for the document preview. Reads the shared docView store,
 *  so the docked inspector and the fullscreen viewer stay in lockstep. Click the
 *  percentage to reset to 100%. */
export default function DocViewControls({ className }: { className?: string }): ReactElement {
  const fontScale = useDocView((s) => s.fontScale);
  const zoomIn = useDocView((s) => s.zoomIn);
  const zoomOut = useDocView((s) => s.zoomOut);
  const reset = useDocView((s) => s.reset);
  return (
    <div className={`flex items-center gap-0.5 ${className ?? ""}`}>
      <button
        type="button"
        className="icon-btn"
        title="Smaller"
        disabled={fontScale <= MIN_SCALE + 0.001}
        onClick={zoomOut}
      >
        <Minus size={13} />
      </button>
      <button
        type="button"
        title="Reset zoom"
        onClick={reset}
        className="w-10 shrink-0 text-center text-[11px] tabular-nums text-dim transition-colors duration-[120ms] hover:text-text"
      >
        {Math.round(fontScale * 100)}%
      </button>
      <button
        type="button"
        className="icon-btn"
        title="Larger"
        disabled={fontScale >= MAX_SCALE - 0.001}
        onClick={zoomIn}
      >
        <Plus size={13} />
      </button>
    </div>
  );
}
