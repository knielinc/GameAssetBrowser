import type { ReactElement } from "react";
import clsx from "clsx";
import { Maximize2 } from "lucide-react";

export interface ExpandButtonProps {
  onClick: () => void;
  className?: string;
}

/**
 * Overlay button in the top-right corner of an inspector preview: open the
 * fullscreen preview for what the drawer is showing. Every kind gets one, so
 * "blow this up" is a single, discoverable gesture that does not depend on
 * Space / double-click — which on audio mean play, not fullscreen.
 *
 * The host container must be `relative`.
 */
export default function ExpandButton({ onClick, className }: ExpandButtonProps): ReactElement {
  return (
    <button
      type="button"
      title="Fullscreen preview"
      aria-label="Fullscreen preview"
      className={clsx(
        "icon-btn absolute right-1.5 top-1.5 z-10 bg-panel/80 shadow-e1 backdrop-blur-sm",
        className,
      )}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Maximize2 size={13} />
    </button>
  );
}
