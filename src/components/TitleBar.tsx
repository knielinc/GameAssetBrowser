import { useEffect, useMemo, useState, type ReactElement } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import clsx from "clsx";
import { AudioLines, Box, Copy, FileText, Image, Maximize2, Minimize2, Minus, Square, X } from "lucide-react";
import { scopePredicate, useLibraryStore } from "../stores/libraryStore";
import { ASSET_KINDS, type AssetKind } from "../types";
import { switchTab } from "../stores/tabs";
import { toggleWindowFullscreen, toggleWindowMaximize } from "../hooks/useWindowFullscreen";
import { useOverflowCollapse } from "../hooks/useOverflowCollapse";
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
 *
 * Maximize and fullscreen are deliberately routed through the helpers in
 * hooks/useWindowFullscreen, which keep the two states mutually exclusive —
 * naive setFullscreen on a maximized undecorated window renders like a plain
 * maximize on Windows (tao clamps maximized borderless windows to the work
 * area, fullscreen or not).
 */
const win = getCurrentWindow();

const TAB_META: Record<AssetKind, { label: string; icon: typeof Box; hue: string }> = {
  audio: { label: "Audio", icon: AudioLines, hue: "text-kind-audio" },
  texture: { label: "Images", icon: Image, hue: "text-kind-texture" },
  model: { label: "Models", icon: Box, hue: "text-kind-model" },
  document: { label: "Docs", icon: FileText, hue: "text-kind-document" },
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
  const folderScopes = useLibraryStore((s) => s.folderScopes);
  const hiddenFolders = useLibraryStore((s) => s.hiddenFolders);

  // Counts reflect the active folder scope — one pass over the library, not
  // three. Same derivation the tab row used before it moved up here.
  const counts = useMemo(() => {
    const inScope = scopePredicate(folderScopes, hiddenFolders);
    const c: Record<AssetKind, number> = { audio: 0, texture: 0, model: 0, document: 0 };
    for (const f of allFiles) {
      if (!inScope(f.path)) continue;
      c[f.kind]++;
    }
    return c;
  }, [allFiles, folderScopes, hiddenFolders]);

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

  // Collapse the tab labels/counts (and the branding text) to icons when the
  // bar would otherwise overflow — otherwise the window controls on the right
  // get pushed off the edge in a narrow window.
  const { ref: barRef, compact } = useOverflowCollapse();

  return (
    <div
      ref={barRef}
      className="flex h-10 shrink-0 select-none items-center gap-2 bg-header pr-0"
    >
      {/* App branding. Draggable; icon/text are pointer-events-none so the drag
          handler still receives the pointer. */}
      <div data-tauri-drag-region className="flex h-full shrink-0 items-center gap-2 pl-3 pr-1">
        {/* The mark is the transparent white logo used as an alpha mask filled
            with the accent, so it takes each theme's colour on a clean,
            background-free shape. (GAB_no_bg.png is white-on-transparent, so its
            alpha IS the silhouette — the earlier opaque PNG masked to a full
            square, which is why this uses the no-background export.) */}
        <div
          aria-hidden
          className="pointer-events-none h-[18px] w-[18px] shrink-0"
          style={{
            backgroundColor: "var(--color-accent)",
            maskImage: "url(/GAB_no_bg.png)",
            maskSize: "contain",
            maskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskImage: "url(/GAB_no_bg.png)",
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
          }}
        />
        {!compact && (
          <span className="pointer-events-none text-[12px] font-semibold tracking-tight">
            Game Asset Browser
          </span>
        )}
      </div>

      <SettingsMenu />

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
              title={`${label} · ${counts[kind].toLocaleString()} — Ctrl+${i + 1}`}
              className={clsx(
                "flex h-[26px] items-center rounded-full text-[11px] font-medium transition-[background-color,color] duration-[120ms]",
                compact ? "w-8 justify-center" : "gap-1.5 px-2.5",
                active ? "bg-raised text-text shadow-e1" : "text-dim hover:text-text",
              )}
              onClick={() => switchTab(kind)}
            >
              <Icon size={13} className={clsx(hue, !active && "opacity-60")} />
              {!compact && (
                <>
                  {label}
                  <span
                    className={clsx(
                      "rounded-full px-1.5 text-[10px] tabular-nums",
                      active ? "bg-accent/15 text-accent" : "bg-overlay text-dim",
                    )}
                  >
                    {counts[kind].toLocaleString()}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {/* Drag strip — fills the rest so the whole bar minus the controls is
          grabbable. */}
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />

      <div className="flex h-full shrink-0">
        <ControlButton title="Minimize" onClick={() => void win.minimize().catch(log("minimize"))}>
          <Minus size={15} />
        </ControlButton>
        <ControlButton
          title={maximized ? "Restore" : "Maximize"}
          onClick={() => void toggleWindowMaximize().catch(log("toggle-maximize"))}
        >
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </ControlButton>
        <ControlButton
          title={fullscreen ? "Exit full screen" : "Full screen"}
          onClick={() => void toggleWindowFullscreen().catch(log("fullscreen"))}
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
