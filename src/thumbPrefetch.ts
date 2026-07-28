import { requestThumbs } from "./ipc/commands";
import { useLibraryStore, type LibFile } from "./stores/libraryStore";

/**
 * Idle thumbnail prefetch: warm thumbnails for files no grid has shown yet, so
 * switching to a tab (or scrolling into fresh rows) finds them already made
 * instead of paying the cost on first view. All four kinds, each through its
 * own existing pipeline:
 *
 * - Textures + audio: Rust decodes, via `background` requests that APPEND
 *   behind the decode queue and drop nothing — a visible cell or a pinned
 *   inspector file always decodes first, and any interactive supersede is free
 *   to discard backfill wholesale. Discards need no bookkeeping: each round
 *   re-derives "still undone" from the store (bounded by MAX_ATTEMPTS so an
 *   undecodable file can't retry forever).
 * - Documents: `renderDocThumb` is path-cached and idempotent, so calling it
 *   ahead of the Docs tab IS the prefetch; the cell reads the cache on mount.
 *   One at a time — it renders on the main thread and shares docThumb's
 *   3-slot limiter with visible cells, so backfill may only ever hold one.
 * - Models: `backfillModelThumbs` appends behind the worker-pool queue the
 *   same way `background` does for Rust, and a batch is only sent when the
 *   queue reports EMPTY — so backfill never runs alongside a visible window's
 *   renders. Rendered pixels land in the Rust RAM cache; the tab picks them up
 *   through its normal `lookupModelThumbs` on entry, so no store coupling.
 *   The queue module is imported dynamically — it carries `three`, and an
 *   eager import here would drag ~600 KB into the main chunk (see
 *   useModelThumbs' warning).
 *
 * The whole loop is gated on USER INACTIVITY (no pointer/wheel/key input for
 * a few seconds). The Rust kinds wouldn't strictly need it, but documents
 * render on the main thread and a model whose worker died falls back to a
 * main-thread render — both can jank active use, and "only work when the user
 * isn't" is the honest definition of idle anyway.
 *
 * Pacing is by landings/queue-drain, not by clock (audio decodes whole files
 * and a Synty FBX parse is 100-400 ms — timers would pile queues up). CAPs
 * bound the warmed set: texture/audio to stay inside the Rust pixel cache's
 * byte budget (384 MB ≈ ~1500 thumbs — warming past it evicts warm pixels for
 * pixels nobody asked for), models/docs to bound session RAM on huge libraries.
 */

const BATCH = 16;
const CAP = 1200;
const MAX_ATTEMPTS = 3;
const TICK_MS = 300;
/** Re-check cadence while a batch is still decoding/rendering. */
const STALL_MS = 1000;
/** Nothing left to do (or cap reached) — nap, then re-derive. */
const IDLE_MS = 30_000;
/** Let a finished scan's own burst (metadata, dimension probes) settle first. */
const SETTLE_MS = 4000;
/** Give up waiting on a batch (superseded away, or genuinely slow audio). */
const BATCH_TIMEOUT_MS = 20_000;
/** No input for this long = the user is idle enough to spend their cores. */
const QUIET_MS = 3000;

const MODEL_BATCH = 8;
/** Session cap on backfill model renders (each ~256 KB in the Rust cache). */
const MODEL_CAP = 600;
/** Skip huge models: parse time scales with size, and a wedged parse retires
 *  its worker (12 s timeout) and pushes later jobs to the MAIN thread. The
 *  visible path accepts that risk for a cell the user is looking at; idle
 *  backfill shouldn't court it for one nobody asked about. */
const MODEL_MAX_BYTES = 64 * 1024 * 1024;
const DOC_CAP = 500;

let started = false;

export function startThumbPrefetch(): void {
  if (started) return;
  started = true;

  // ── user-activity gate ────────────────────────────────────────────────────
  let lastInput = 0; // epoch of the last input; 0 = never (boot counts as quiet)
  const touch = (): void => {
    lastInput = performance.now();
  };
  for (const ev of ["pointerdown", "pointermove", "wheel", "keydown"] as const) {
    window.addEventListener(ev, touch, { passive: true, capture: true });
  }
  const quiet = (): boolean => performance.now() - lastInput >= QUIET_MS;

  /** id → send count for the Rust kinds; path → count for model/doc. Reset when
   *  the file set turns over (a rescan reassigns ids). */
  let attempts = new Map<number, number>();
  let pathAttempts = new Map<string, number>();
  let lastFiles: unknown = null;
  let waiting: number[] = [];
  let sentAt = 0;
  let modelsSent = 0;
  let docsDone = 0;
  /** Latest queue depth from thumbQueue, once phase 3 has subscribed. */
  let modelRemaining = 0;
  let modelSubscribed = false;

  const schedule = (ms: number): void => {
    window.setTimeout(() => void tick(), ms);
  };

  // ── phase 1: textures + audio (Rust decode queue) ─────────────────────────
  const rustPhase = async (s: ReturnType<typeof useLibraryStore.getState>): Promise<boolean> => {
    if (waiting.length > 0) {
      const landed = waiting.filter((id) => s.thumbs.has(id)).length;
      const timedOut = performance.now() - sentAt >= BATCH_TIMEOUT_MS;
      if (landed < Math.ceil(waiting.length / 2) && !timedOut) {
        schedule(STALL_MS);
        return true;
      }
      waiting = [];
    }
    if (s.thumbs.size >= CAP) return false;
    // Textures first: cheap, numerous wins. Audio after — each waveform is a
    // full symphonia decode, but it's exactly what the Audio tab would trigger.
    const batch: [number, string][] = [];
    for (const kind of ["texture", "audio"] as const) {
      if (batch.length >= BATCH) break;
      for (const f of s.allFiles) {
        if (batch.length >= BATCH) break;
        if (f.kind !== kind) continue;
        if (s.thumbs.has(f.id)) continue;
        const tried = attempts.get(f.id) ?? 0;
        if (tried >= MAX_ATTEMPTS) continue;
        attempts.set(f.id, tried + 1);
        batch.push([f.id, f.path]);
      }
    }
    if (batch.length === 0) return false;
    await requestThumbs(batch, false, true);
    waiting = batch.map(([id]) => id);
    sentAt = performance.now();
    schedule(TICK_MS);
    return true;
  };

  // ── phase 2: documents (main-thread canvas renders, one at a time) ────────
  const docPhase = async (s: ReturnType<typeof useLibraryStore.getState>): Promise<boolean> => {
    if (docsDone >= DOC_CAP) return false;
    const [{ docThumbCache, renderDocThumb }, { docFormat }] = await Promise.all([
      import("./components/document/docThumb"),
      import("./components/document/doc"),
    ]);
    let next: LibFile | undefined;
    for (const f of s.allFiles) {
      if (f.kind !== "document") continue;
      if (docFormat(f.ext) === "unsupported") continue;
      if (docThumbCache.has(f.path)) continue;
      if ((pathAttempts.get(f.path) ?? 0) >= MAX_ATTEMPTS) continue;
      next = f;
      break;
    }
    if (next === undefined) return false;
    pathAttempts.set(next.path, (pathAttempts.get(next.path) ?? 0) + 1);
    await renderDocThumb(next.path, next.ext);
    docsDone++;
    schedule(TICK_MS);
    return true;
  };

  // ── phase 3: models (worker-pool renders into the Rust cache) ─────────────
  const modelPhase = async (s: ReturnType<typeof useLibraryStore.getState>): Promise<boolean> => {
    if (modelsSent >= MODEL_CAP) return false;
    const m = await import("./model/thumbQueue");
    if (!modelSubscribed) {
      modelSubscribed = true;
      m.onModelThumbProgress((remaining) => {
        modelRemaining = remaining;
      });
    }
    // Anything rendering — a visible window's jobs, or our previous batch —
    // means wait, not append. This is what keeps backfill strictly behind
    // interactive work without touching the queue's supersede semantics.
    if (modelRemaining > 0) {
      schedule(STALL_MS);
      return true;
    }
    const window: LibFile[] = [];
    for (const f of s.allFiles) {
      if (window.length >= MODEL_BATCH) break;
      if (f.kind !== "model") continue;
      if (s.thumbs.has(f.id)) continue;
      if (f.size > MODEL_MAX_BYTES) continue;
      if ((pathAttempts.get(f.path) ?? 0) >= MAX_ATTEMPTS) continue;
      window.push(f);
    }
    if (window.length === 0) return false;
    for (const f of window) pathAttempts.set(f.path, (pathAttempts.get(f.path) ?? 0) + 1);
    // Cache first — a hit costs one fs::metadata, a miss a full parse. Hits go
    // into the store so the tab's own lookup on entry has even less to do.
    const hits = await m.lookupModelThumbs(window);
    if (hits.length > 0) useLibraryStore.getState().setModelThumbs(hits);
    const hitIds = new Set(hits.map(([id]) => id));
    const misses = window.filter((f) => !hitIds.has(f.id));
    if (misses.length > 0) {
      m.backfillModelThumbs(misses);
      modelsSent += misses.length;
    }
    schedule(STALL_MS);
    return true;
  };

  const tick = async (): Promise<void> => {
    try {
      const s = useLibraryStore.getState();
      if (s.scanning) {
        schedule(SETTLE_MS);
        return;
      }
      if (!quiet()) {
        schedule(QUIET_MS);
        return;
      }
      if (s.allFiles !== lastFiles) {
        lastFiles = s.allFiles;
        attempts = new Map();
        pathAttempts = new Map();
        waiting = [];
      }
      if (await rustPhase(s)) return;
      if (await docPhase(s)) return;
      if (await modelPhase(s)) return;
      schedule(IDLE_MS);
    } catch {
      schedule(IDLE_MS);
    }
  };

  schedule(SETTLE_MS);
}
