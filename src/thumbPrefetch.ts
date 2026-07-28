import { requestThumbs } from "./ipc/commands";
import { useLibraryStore } from "./stores/libraryStore";

/**
 * Idle thumbnail prefetch: warm the Rust thumbnail cache for files no grid has
 * shown yet, so switching to a tab (or scrolling into fresh rows) finds its
 * thumbnails already decoded instead of paying the decode on first view.
 *
 * Only the Rust-decoded kinds (texture + audio) are prefetched — the same set
 * request_thumbs owns. Models render in the webview per cell (a three.js
 * scene per file; prerendering 600 of them would fight the UI for the GPU)
 * and documents render in-cell, so neither has anything to warm here.
 *
 * Interaction safety comes from the backend, not from idle detection:
 * batches go out as `background` requests, which APPEND behind everything in
 * the decode queue and drop nothing — a visible cell or a pinned inspector
 * file always decodes first, and any interactive supersede is free to discard
 * queued backfill wholesale. Discards need no bookkeeping: each round re-derives
 * "still undone" from the store, so a dropped file is simply re-found (bounded
 * by MAX_ATTEMPTS so a genuinely undecodable file can't retry forever).
 *
 * Pacing is by landings, not by clock: the next batch waits until most of the
 * previous one has arrived in the store (audio waveforms decode the whole
 * file, so a batch can take seconds — a timer would pile the queue up).
 *
 * CAP keeps the warmed set inside the Rust pixel cache's byte budget
 * (384 MB ≈ ~1500 thumbs): prefetching past it would evict the oldest warm
 * pixels to make room for pixels nobody asked for.
 */

const BATCH = 16;
const CAP = 1200;
const MAX_ATTEMPTS = 3;
const TICK_MS = 300;
/** Re-check cadence while a batch is still decoding. */
const STALL_MS = 1000;
/** Nothing left to do (or cap reached) — nap, then re-derive. */
const IDLE_MS = 30_000;
/** Let a finished scan's own burst (metadata, dimension probes) settle first. */
const SETTLE_MS = 4000;
/** Give up waiting on a batch (superseded away, or genuinely slow audio). */
const BATCH_TIMEOUT_MS = 20_000;

let started = false;

export function startThumbPrefetch(): void {
  if (started) return;
  started = true;

  /** id → send count, bounded by MAX_ATTEMPTS. Reset when the file set turns
   *  over (rescan reassigns ids, so stale entries would shadow new files). */
  let attempts = new Map<number, number>();
  let lastFiles: unknown = null;
  let waiting: number[] = [];
  let sentAt = 0;

  const schedule = (ms: number): void => {
    window.setTimeout(() => void tick(), ms);
  };

  const tick = async (): Promise<void> => {
    const s = useLibraryStore.getState();
    if (s.scanning) {
      schedule(SETTLE_MS);
      return;
    }
    if (s.allFiles !== lastFiles) {
      lastFiles = s.allFiles;
      attempts = new Map();
      waiting = [];
    }
    if (waiting.length > 0) {
      const landed = waiting.filter((id) => s.thumbs.has(id)).length;
      const timedOut = performance.now() - sentAt >= BATCH_TIMEOUT_MS;
      if (landed < Math.ceil(waiting.length / 2) && !timedOut) {
        schedule(STALL_MS);
        return;
      }
      waiting = [];
    }
    if (s.thumbs.size >= CAP) {
      schedule(IDLE_MS);
      return;
    }

    // Textures first: they're the cheap, numerous wins. Audio afterwards —
    // each waveform is a full symphonia decode, but it's exactly the work the
    // Audio tab would trigger on entry anyway.
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
    if (batch.length === 0) {
      schedule(IDLE_MS);
      return;
    }
    try {
      await requestThumbs(batch, false, true);
      waiting = batch.map(([id]) => id);
      sentAt = performance.now();
      schedule(TICK_MS);
    } catch {
      schedule(IDLE_MS);
    }
  };

  schedule(SETTLE_MS);
}
