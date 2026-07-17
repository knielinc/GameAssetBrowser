import { useCallback, useState, type ReactElement } from "react";
import { X } from "lucide-react";
import { basename } from "../../stores/libraryStore";
import { humanSize } from "../FileRow";
import type { ModelStats } from "../../model/loadModel";
import type { RescueResult } from "../../model/rescueTextures";
import ModelViewport from "./ModelViewport";
import AtlasPicker from "./AtlasPicker";

export interface ModelInspectorProps {
  path: string | null;
  size: number | null;
  onClose: () => void;
}

const fmt = (n: number): string => n.toLocaleString();

/** Right-side drawer. Model metadata is intrinsically tall-and-narrow, and the
 *  grid stays the tool for the stated core need — browsing beats inspecting,
 *  so browsing keeps the space. Drag it wider for a big 3D view. */
export default function ModelInspector({ path, size, onClose }: ModelInspectorProps): ReactElement {
  const [stats, setStats] = useState<ModelStats | null>(null);
  const onStats = useCallback((s: ModelStats | null) => setStats(s), []);
  const [rescue, setRescue] = useState<RescueResult | null>(null);
  const onRescue = useCallback((r: RescueResult | null) => setRescue(r), []);

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-border bg-panel">
      <div className="flex h-[34px] shrink-0 items-center justify-between border-b border-border px-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-dim">Inspector</span>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <div className="aspect-square w-full shrink-0">
          <ModelViewport path={path} onStats={onStats} onRescue={onRescue} />
        </div>

        {path !== null && rescue !== null && (
          <AtlasPicker
            modelPath={path}
            candidates={rescue.candidates}
            applied={rescue.applied}
            manual={rescue.manual === true}
          />
        )}

        {path === null ? (
          <p className="text-[11px] text-dim">Select a model to preview it.</p>
        ) : (
          <>
            <div>
              <div className="break-words text-[14px] font-semibold tracking-tight">{basename(path)}</div>
              <div className="break-all font-mono text-[10px] text-dim">{path}</div>
            </div>

            {stats !== null && (
              <>
                <section className="flex flex-col gap-1.5">
                  <h4 className="text-[10px] font-semibold uppercase tracking-widest text-dim">Geometry</h4>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
                    <dt className="text-dim">Triangles</dt>
                    <dd className="m-0 text-right tabular-nums">{fmt(stats.triangles)}</dd>
                    <dt className="text-dim">Vertices</dt>
                    <dd className="m-0 text-right tabular-nums">{fmt(stats.vertices)}</dd>
                    <dt className="text-dim">Meshes</dt>
                    <dd className="m-0 text-right tabular-nums">{fmt(stats.meshes)}</dd>
                    <dt className="text-dim">Materials</dt>
                    <dd className="m-0 text-right tabular-nums">{fmt(stats.materials)}</dd>
                    {size !== null && (
                      <>
                        <dt className="text-dim">File size</dt>
                        <dd className="m-0 text-right tabular-nums">{humanSize(size)}</dd>
                      </>
                    )}
                  </dl>
                </section>

                <section className="flex flex-col gap-1.5">
                  <h4 className="text-[10px] font-semibold uppercase tracking-widest text-dim">Bounds</h4>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
                    <dt className="text-dim">Size</dt>
                    <dd className="m-0 text-right tabular-nums">
                      {stats.size.map((v) => v.toFixed(2)).join(" × ")}
                    </dd>
                  </dl>
                  {/* FBX unit scale is usually cm, so models arrive 100x wrong.
                      Naming the number is the cheapest useful check there is. */}
                  <p className="rounded-md border border-kind-texture/25 bg-kind-texture/8 p-2 text-[10.5px] leading-snug text-dim">
                    Grid squares are 1 unit. FBX exports are usually authored in
                    cm, so a model arriving 100× off is the most common import
                    surprise — compare against the grid before trusting it.
                  </p>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
