import { useEffect, useState, type ReactElement } from "react";
import clsx from "clsx";
import { open } from "@tauri-apps/plugin-dialog";
import { AudioLines, Box, FileSearch, Image as ImageIcon, Plus, X } from "lucide-react";
import { ASSET_KINDS, type AssetKind } from "../types";
import { useExternalAppsStore } from "../stores/externalApps";
import { useLibraryStore } from "../stores/libraryStore";
import { IS_WINDOWS } from "../platform";

/** Kind labels/icons for the picker chips and the per-entry badge. */
const KIND_LABEL: Record<AssetKind, string> = { audio: "Audio", texture: "Texture", model: "Model" };
const KIND_ICON: Record<AssetKind, typeof AudioLines> = {
  audio: AudioLines,
  texture: ImageIcon,
  model: Box,
};

/** Filename without directory or a trailing `.exe`/`.app` — the default app
 *  name. The suffixes are Windows/macOS-only; a bare Linux binary is unchanged. */
function exeStem(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const base = i < 0 ? path : path.slice(i + 1);
  return base.replace(/\.(exe|app)$/i, "");
}

/**
 * "External apps…" (SettingsMenu): manage the per-kind "Open with <name>"
 * entries the file context menus offer. Add flow: pick a kind (defaults to
 * the current tab), pick an executable via the native dialog, adjust the name
 * (defaults to the file stem), Add. Same modal shell as DuplicatesModal.
 */
export default function ExternalAppsModal({ onClose }: { onClose: () => void }): ReactElement {
  const apps = useExternalAppsStore((s) => s.apps);
  const addApp = useExternalAppsStore((s) => s.addApp);
  const removeApp = useExternalAppsStore((s) => s.removeApp);

  // Draft entry being added; exe === null means "not picked yet".
  const [kind, setKind] = useState<AssetKind>(useLibraryStore.getState().activeTab);
  const [exe, setExe] = useState<string | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    // Capture phase: beat the global shortcut handler (FullscreenPreview idiom).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const pickExe = (): void => {
    open({
      multiple: false,
      directory: false,
      // Windows executables are .exe; on macOS/Linux there's no single
      // extension (a Unix binary has none, a macOS .app is a bundle), so don't
      // filter — the user picks the binary or app directly.
      filters: IS_WINDOWS ? [{ name: "Programs", extensions: ["exe"] }] : undefined,
    })
      .then((picked) => {
        if (typeof picked !== "string") return;
        setExe(picked);
        // Default only — a name already typed for this draft is kept.
        setName((n) => (n.trim() === "" ? exeStem(picked) : n));
      })
      .catch((err: unknown) => {
        console.error("exe picker failed", err);
      });
  };

  const canAdd = exe !== null && name.trim() !== "";
  const add = (): void => {
    if (exe === null || name.trim() === "") return;
    addApp({ kind, name: name.trim(), exe });
    setExe(null);
    setName("");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-[480px] flex-col rounded-xl bg-raised shadow-e2">
        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
          <span className="text-[13px] font-medium">External apps</span>
          <span className="text-[11px] text-dim">shown as "Open with…" per kind</span>
          <button type="button" className="icon-btn ml-auto shrink-0" title="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {apps.length === 0 ? (
          <div className="px-4 pb-2 pt-1 text-[12px] text-dim">
            No apps registered yet — add one below and it appears in the context menu of every
            file of that kind.
          </div>
        ) : (
          <div className="facet-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-1">
            {apps.map((a, i) => {
              const Icon = KIND_ICON[a.kind];
              return (
                // Index key on purpose: entries have no identity beyond their
                // position (name+exe pairs may repeat), and removal is by index.
                <div
                  key={i}
                  className="group flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors duration-[120ms] hover:bg-overlay"
                >
                  <span
                    title={KIND_LABEL[a.kind]}
                    className={clsx(
                      "flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide",
                      a.kind === "audio" && "text-kind-audio",
                      a.kind === "texture" && "text-kind-texture",
                      a.kind === "model" && "text-kind-model",
                    )}
                  >
                    <Icon size={11} />
                    {KIND_LABEL[a.kind]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] text-text">{a.name}</div>
                    <div className="truncate font-mono text-[10px] text-faint" title={a.exe}>
                      {a.exe}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="icon-btn shrink-0 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100"
                    title="Remove"
                    onClick={() => removeApp(i)}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="shrink-0 border-t border-bg px-4 pb-3 pt-2.5">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-faint">
            Add app
          </div>
          <div className="mb-2 flex items-center gap-1.5">
            {ASSET_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className={clsx("chip", k === kind && "chip-active")}
                onClick={() => setKind(k)}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
            <button type="button" className="chip ml-auto" onClick={pickExe}>
              <span className="flex items-center gap-1">
                <FileSearch size={11} />
                {exe === null ? "Choose .exe…" : "Change…"}
              </span>
            </button>
          </div>
          {exe !== null && (
            <div className="mb-2 truncate font-mono text-[10px] text-faint" title={exe}>
              {exe}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={name}
              placeholder="Name (shown in the menu)"
              onChange={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canAdd) add();
              }}
              className="h-7 min-w-0 flex-1 rounded-lg bg-bg px-2.5 text-[12px] text-text outline-none placeholder:text-faint"
            />
            <button
              type="button"
              className="chip"
              disabled={!canAdd}
              style={canAdd ? undefined : { opacity: 0.4 }}
              onClick={add}
            >
              <span className="flex items-center gap-1">
                <Plus size={11} />
                Add
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
