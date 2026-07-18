import { useEffect, useMemo, useState, type ReactElement } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import clsx from "clsx";
import { AudioLines, Box, Copy, Image, Maximize2, Minimize2, Minus, Square, X } from "lucide-react";
import { folderMatcher, useLibraryStore } from "../stores/libraryStore";
import { ASSET_KINDS, type AssetKind } from "../types";
import { switchTab } from "../stores/tabs";
import SettingsMenu from "./SettingsMenu";

/**
 * Custom window chrome for the frameless window (Rust sets decorations:false).
 *
 * The header carries the top-level nav: branding, the three lens tabs (a
 * segmented pill with icon + live count), and the window controls. The
 * sidebar toggles live in the toolbar below, next to the panels they open.
 * Everything interactive is a real button; the branding block and the flex-1
 * gap are `data-tauri-drag-region` so the bar minus the buttons stays grabbable
 * (drag moves the window, double-click toggles maximize — both native).
 *
 * Needs core:window allow-minimize / toggle-maximize / is-maximized /
 * start-dragging / close (+ set/is-fullscreen).
 */
const win = getCurrentWindow();

const TAB_META: Record<AssetKind, { label: string; icon: typeof Box; hue: string }> = {
  audio: { label: "Audio", icon: AudioLines, hue: "text-kind-audio" },
  texture: { label: "Textures", icon: Image, hue: "text-kind-texture" },
  model: { label: "Models", icon: Box, hue: "text-kind-model" },
};

function ControlButton({
  onClick,
  title,
  danger,
  children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  children: ReactElement;
}): ReactElement {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={
        "flex h-full w-11 items-center justify-center text-dim transition-colors duration-[120ms] " +
        (danger === true ? "hover:bg-[#e81123] hover:text-white" : "hover:bg-overlay hover:text-text")
      }
    >
      {children}
    </button>
  );
}

export default function TitleBar(): ReactElement {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const activeTab = useLibraryStore((s) => s.activeTab);
  const allFiles = useLibraryStore((s) => s.allFiles);
  const folderScope = useLibraryStore((s) => s.folderScope);

  // Counts reflect the active folder scope — one pass over the library, not
  // three. Same derivation the tab row used before it moved up here.
  const counts = useMemo(() => {
    const inScope = folderScope === null ? null : folderMatcher(folderScope);
    const c: Record<AssetKind, number> = { audio: 0, texture: 0, model: 0 };
    for (const f of allFiles) {
      if (inScope !== null && !inScope(f.path)) continue;
      c[f.kind]++;
    }
    return c;
  }, [allFiles, folderScope]);

  // Keep the maximize/fullscreen icons honest against changes made outside these
  // buttons (F11, OS snap, double-click drag). Every such change resizes the
  // window, so one onResized listener catches them all.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const sync = (): void => {
      void win.isMaximized().then(setMaximized).catch(() => {});
      void win.isFullscreen().then(setFullscreen).catch(() => {});
    };
    sync();
    void win.onResized(sync).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const log = (what: string) => (err: unknown) => console.error(`window ${what} failed`, err);

  return (
    <div className="flex h-10 shrink-0 select-none items-center gap-2 bg-header pr-0">
      {/* App branding. Draggable; icon/text are pointer-events-none so the drag
          handler still receives the pointer. */}
      <div data-tauri-drag-region className="flex h-full shrink-0 items-center gap-2 pl-3 pr-1">
        <img
          src="/GAB.png"
          alt=""
          draggable={false}
          className="pointer-events-none h-[18px] w-[18px] rounded-[4px] object-contain"
        />
        <span className="pointer-events-none text-[12px] font-semibold tracking-tight">
          Game Asset Browser
        </span>
      </div>

      {/* The three lenses as a segmented pill — a tonal well with the active
          tab lifted onto its own filled pill. Icon + live count preserved. */}
      <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-bg p-0.5">
        {ASSET_KINDS.map((kind, i) => {
          const { label, icon: Icon, hue } = TAB_META[kind];
          const active = activeTab === kind;
          return (
            <button
              key={kind}
              type="button"
              title={`${label} — Ctrl+${i + 1}`}
              className={clsx(
                "flex h-[26px] items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition-[background-color,color] duration-[120ms]",
                active ? "bg-raised text-text shadow-e1" : "text-dim hover:text-text",
              )}
              onClick={() => switchTab(kind)}
            >
              <Icon size={13} className={clsx(hue, !active && "opacity-60")} />
              {label}
              <span
                className={clsx(
                  "rounded-full px-1.5 text-[10px] tabular-nums",
                  active ? "bg-accent/15 text-accent" : "bg-overlay text-dim",
                )}
              >
                {counts[kind].toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>

      {/* Drag strip — fills the rest so the whole bar minus the controls is
          grabbable. */}
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />

      <SettingsMenu />

      <div className="flex h-full shrink-0">
        <ControlButton title="Minimize" onClick={() => void win.minimize().catch(log("minimize"))}>
          <Minus size={15} />
        </ControlButton>
        <ControlButton
          title={maximized ? "Restore" : "Maximize"}
          onClick={() => void win.toggleMaximize().catch(log("toggle-maximize"))}
        >
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </ControlButton>
        <ControlButton
          title={fullscreen ? "Exit full screen" : "Full screen"}
          onClick={() =>
            void win
              .isFullscreen()
              .then((on) => win.setFullscreen(!on))
              .catch(log("fullscreen"))
          }
        >
          {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </ControlButton>
        <ControlButton danger title="Close" onClick={() => void win.close().catch(log("close"))}>
          <X size={15} />
        </ControlButton>
      </div>
    </div>
  );
}
