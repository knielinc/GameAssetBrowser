import { type ReactElement } from "react";
import { X } from "lucide-react";
import { basename, useLibraryStore } from "../../stores/libraryStore";
import type { LibFile } from "../../stores/libraryStore";
import { humanSize } from "../FileRow";
import { CHANNEL_LABEL, type Channel } from "../../material/table";
import type { Material, TextureItem } from "../../material/classify";
import TexturePreview, { type ChannelKeys } from "./TexturePreview";
import PreviewControls, { type PreviewState } from "./PreviewControls";

/**
 * Map a material's resolved channels onto the preview's texture slots.
 *
 * Packed maps get the elegant part for free: three's MeshStandardMaterial
 * already reads aoMap from .r, roughnessMap from .g and metalnessMap from .b,
 * so an ORM/ARM texture is assigned to all three slots as the SAME object —
 * zero channel extraction, zero extra VRAM. ORM was designed for exactly this.
 */
export function keysForMaterial(
  material: Material,
  thumbs: Map<number, { key: string; info: unknown }>,
): ChannelKeys {
  const keys: ChannelKeys = {};
  const put = (slot: keyof ChannelKeys, ch: Channel): void => {
    const m = material.channels.get(ch);
    if (m === undefined) return;
    const t = thumbs.get(m.file.id);
    if (t !== undefined) keys[slot] = t.key;
  };
  put("baseColor", "baseColor");
  put("normal", "normal");
  put("roughness", "roughness");
  put("ao", "ao");
  put("height", "height");

  for (const packed of ["packedORM", "packedARM", "packedRMA", "packedMRA"] as Channel[]) {
    const m = material.channels.get(packed);
    if (m === undefined) continue;
    const t = thumbs.get(m.file.id);
    if (t === undefined) continue;
    // Same texture into both slots — three reads the right channel from each.
    keys.roughness ??= t.key;
    keys.ao ??= t.key;
  }
  return keys;
}

export function keysForFile(
  file: LibFile,
  channel: Channel | undefined,
  thumbs: Map<number, { key: string; info: unknown }>,
): ChannelKeys {
  const t = thumbs.get(file.id);
  if (t === undefined) return {};
  // A lone normal map previewed on a sphere should BE the normal map, not the
  // albedo — showing raw blue-purple on a sphere is useless.
  switch (channel) {
    case "normal":
      return { normal: t.key, baseColor: undefined };
    case "roughness":
      return { roughness: t.key };
    case "ao":
      return { ao: t.key };
    default:
      return { baseColor: t.key };
  }
}

export interface TextureInspectorProps {
  item: TextureItem | null;
  preview: PreviewState;
  onPreviewChange: (patch: Partial<PreviewState>) => void;
  onClose: () => void;
}

export default function TextureInspector({
  item,
  preview,
  onPreviewChange,
  onClose,
}: TextureInspectorProps): ReactElement {
  useLibraryStore((s) => s.thumbsVersion);
  const thumbs = useLibraryStore.getState().thumbs;

  const keys =
    item === null
      ? {}
      : item.kind === "material"
        ? keysForMaterial(item.material, thumbs)
        : keysForFile(item.file, item.channel, thumbs);

  const title =
    item === null ? "" : item.kind === "material" ? item.material.display : item.file.name;
  const path = item === null ? "" : item.kind === "material" ? item.material.dir : item.file.path;

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-border bg-panel">
      <div className="flex h-[34px] shrink-0 items-center justify-between border-b border-border px-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-dim">Inspector</span>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <div className="aspect-square w-full shrink-0 overflow-hidden rounded-lg border border-border bg-[#07070b]">
          {item === null ? (
            <div className="flex h-full items-center justify-center text-[11px] text-dim">
              Select a texture
            </div>
          ) : (
            <TexturePreview keys={keys} mesh={preview.mesh} light={preview.light} tiles={preview.tiles} />
          )}
        </div>

        {item !== null && (
          <>
            <PreviewControls value={preview} onChange={onPreviewChange} />

            <div>
              <div className="break-words text-[14px] font-semibold tracking-tight">{title}</div>
              <div className="break-all font-mono text-[10px] text-dim">{path}</div>
            </div>

            {item.kind === "material" ? (
              <section className="flex flex-col gap-1.5">
                <h4 className="text-[10px] font-semibold uppercase tracking-widest text-dim">
                  Maps · {item.material.members.length}
                </h4>
                {item.material.members.map((m) => (
                  <div
                    key={m.file.path}
                    className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[11px] transition-colors duration-[120ms] hover:bg-raised"
                    title={m.file.name}
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <b className="text-[11px] font-semibold">{CHANNEL_LABEL[m.channel]}</b>
                      <span className="truncate font-mono text-[9px] text-dim">{m.file.name}</span>
                    </div>
                    <span
                      title={
                        m.resolved >= 0.9
                          ? "Pinned by name — unambiguous"
                          : "Resolved jointly against siblings + content"
                      }
                      className={
                        m.resolved >= 0.9
                          ? "rounded bg-kind-texture/15 px-1 font-mono text-[9px] tabular-nums text-kind-texture"
                          : "rounded bg-kind-model/15 px-1 font-mono text-[9px] tabular-nums text-kind-model"
                      }
                    >
                      {m.resolved.toFixed(2)}
                    </span>
                  </div>
                ))}
              </section>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
                <dt className="text-dim">Format</dt>
                <dd className="m-0 text-right">{item.file.ext.toUpperCase()}</dd>
                <dt className="text-dim">Size</dt>
                <dd className="m-0 text-right tabular-nums">{humanSize(item.file.size)}</dd>
                <dt className="text-dim">Folder</dt>
                <dd className="m-0 truncate text-right">{basename(path.replace(/[\\/][^\\/]*$/, ""))}</dd>
              </dl>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
