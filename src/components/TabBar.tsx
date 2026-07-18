import { useMemo, type ReactElement } from "react";
import clsx from "clsx";
import { AudioLines, Box, Image, PanelLeft, PanelRight } from "lucide-react";
import { folderMatcher, useLibraryStore } from "../stores/libraryStore";
import { usePanelPrefs } from "../stores/panelPrefs";
import { ASSET_KINDS, type AssetKind } from "../types";
import { switchTab } from "../stores/tabs";

function PanelToggle({
  on,
  onClick,
  icon: Icon,
  title,
}: {
  on: boolean;
  onClick: () => void;
  icon: typeof PanelLeft;
  title: string;
}): ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      className={clsx(
        "flex h-7 w-7 items-center justify-center rounded-md border transition-colors duration-[120ms]",
        on
          ? "border-accent/45 bg-accent/12 text-accent"
          : "border-transparent text-dim hover:bg-raised hover:text-text",
      )}
      onClick={onClick}
    >
      <Icon size={14} />
    </button>
  );
}

const TAB_META: Record<AssetKind, { label: string; icon: typeof Box; hue: string }> = {
  audio: { label: "Audio", icon: AudioLines, hue: "text-kind-audio" },
  texture: { label: "Textures", icon: Image, hue: "text-kind-texture" },
  model: { label: "Models", icon: Box, hue: "text-kind-model" },
};

/**
 * Segmented control over the three lenses, reusing the chip language rather
 * than inventing a third visual idiom. Counts reflect the active folder scope
 * — one pass over the library, not three.
 */
export default function TabBar(): ReactElement {
  const activeTab = useLibraryStore((s) => s.activeTab);
  const allFiles = useLibraryStore((s) => s.allFiles);
  const folderScope = useLibraryStore((s) => s.folderScope);
  const leftOpen = usePanelPrefs((s) => s.left);
  const rightOpen = usePanelPrefs((s) => s.right);
  const toggleLeft = usePanelPrefs((s) => s.toggleLeft);
  const toggleRight = usePanelPrefs((s) => s.toggleRight);
  // Audio has no inspector, so hide the right toggle there.
  const hasInspector = activeTab !== "audio";

  const counts = useMemo(() => {
    const inScope = folderScope === null ? null : folderMatcher(folderScope);
    const c: Record<AssetKind, number> = { audio: 0, texture: 0, model: 0 };
    for (const f of allFiles) {
      if (inScope !== null && !inScope(f.path)) continue;
      c[f.kind]++;
    }
    return c;
  }, [allFiles, folderScope]);

  return (
    <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-3">
      <PanelToggle
        on={leftOpen}
        onClick={toggleLeft}
        icon={PanelLeft}
        title={leftOpen ? "Hide folders panel" : "Show folders panel"}
      />
      <div className="mr-1 h-5 w-px bg-border" />
      {ASSET_KINDS.map((kind, i) => {
        const { label, icon: Icon, hue } = TAB_META[kind];
        const active = activeTab === kind;
        return (
          <button
            key={kind}
            type="button"
            title={`${label} — Ctrl+${i + 1}`}
            className={clsx(
              "flex h-7 items-center gap-2 rounded-md border px-2.5 text-xs transition-colors duration-[120ms]",
              active
                ? "border-accent/45 bg-accent/12 text-accent"
                : "border-transparent text-dim hover:bg-raised hover:text-text",
            )}
            onClick={() => switchTab(kind)}
          >
            <Icon size={13} className={clsx(hue, !active && "opacity-60")} />
            {label}
            <span
              className={clsx(
                "rounded-full px-1.5 text-[10px] tabular-nums",
                active ? "bg-accent/18 text-accent" : "bg-raised text-dim",
              )}
            >
              {counts[kind].toLocaleString()}
            </span>
          </button>
        );
      })}
      {hasInspector && (
        <div className="ml-auto">
          <PanelToggle
            on={rightOpen}
            onClick={toggleRight}
            icon={PanelRight}
            title={rightOpen ? "Hide inspector" : "Show inspector"}
          />
        </div>
      )}
    </div>
  );
}
