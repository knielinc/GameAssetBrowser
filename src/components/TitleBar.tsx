import { useEffect, useState, type ReactElement } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, Maximize2, Minimize2, X } from "lucide-react";

/**
 * Custom window chrome for the frameless window (Rust sets decorations:false).
 *
 * Left is the app branding (icon + name) followed by a drag region
 * (`data-tauri-drag-region`) — click-drag moves the window, double-click
 * toggles maximize, both handled natively by the webview. The branding block is
 * itself a drag region so the whole bar minus the buttons is grabbable; its
 * icon/text are pointer-events-none so clicks fall through to the drag handler.
 * Right are the controls: minimize, maximize/restore, fullscreen, close.
 *
 * Needs core:window allow-minimize / toggle-maximize / is-maximized /
 * start-dragging / close (+ the existing set/is-fullscreen) in
 * capabilities/default.json.
 */
const win = getCurrentWindow();

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
        (danger === true ? "hover:bg-[#e81123] hover:text-white" : "hover:bg-raised hover:text-text")
      }
    >
      {children}
    </button>
  );
}

export default function TitleBar(): ReactElement {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

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
    <div className="flex h-8 shrink-0 select-none items-center border-b border-border bg-panel">
      {/* App branding, moved here from the sidebar. Draggable like the rest of
          the bar; the icon/text below are pointer-events-none so the drag
          handler still receives the pointer. */}
      <div data-tauri-drag-region className="flex h-full shrink-0 items-center gap-2 pl-3 pr-2">
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
      {/* Empty drag strip — fills the rest so the whole bar (minus buttons) is
          grabbable. */}
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
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
