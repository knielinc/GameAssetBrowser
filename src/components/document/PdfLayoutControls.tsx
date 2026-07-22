import { type ReactElement } from "react";
import clsx from "clsx";
import { BookOpen, File, StretchHorizontal } from "lucide-react";
import { useDocView, type PdfLayout } from "../../stores/docView";

const OPTIONS: { id: PdfLayout; label: string; icon: typeof File }[] = [
  { id: "width", label: "Fit width", icon: StretchHorizontal },
  { id: "single", label: "Single page", icon: File },
  { id: "spread", label: "Two-page spread", icon: BookOpen },
];

/** Segmented PDF page-layout toggle, backed by the shared docView store so both
 *  preview surfaces (docked + fullscreen) reflect the choice, and it persists. */
export default function PdfLayoutControls({ className }: { className?: string }): ReactElement {
  const layout = useDocView((s) => s.pdfLayout);
  const setLayout = useDocView((s) => s.setPdfLayout);
  return (
    <div className={clsx("flex items-center gap-0.5 rounded-full bg-bg p-0.5", className)}>
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          title={o.label}
          aria-pressed={layout === o.id}
          onClick={() => setLayout(o.id)}
          className={clsx(
            "flex h-6 w-7 items-center justify-center rounded-full transition-colors duration-[120ms]",
            layout === o.id
              ? "bg-accent-fill text-accent-fg"
              : "text-dim hover:bg-overlay hover:text-text",
          )}
        >
          <o.icon size={13} />
        </button>
      ))}
    </div>
  );
}
