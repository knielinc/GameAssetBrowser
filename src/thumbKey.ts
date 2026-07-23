/**
 * Client-side texture thumbnail cache key — an EXACT port of `keyed("t", …)`
 * in src-tauri/src/thumbs.rs. Keep the two in lockstep (same mirrored-contract
 * discipline as types.ts ↔ types.rs).
 *
 * WHY this exists: on a warm cache the key is fully determined by
 * (path, size, mtime), all of which the frontend already has on every
 * FileEntry. Computing it here lets a grid cell point an <img> straight at
 * `thumb://<key>` with ZERO IPC — WebView2 serves the cached PNG from disk
 * instantly, skipping the whole request → queue → decode-stats → 100 ms batch
 * → event round trip. A miss simply 404s, and the normal request path (which
 * we still run, for the content-classifier stats) fills it in.
 */

// MUST match the constants in thumbs.rs.
const CACHE_VERSION = 2;
const THUMB_EDGE = 256;

/** Cache-key namespace, mirroring the `kind` prefix in `thumbs::hash_key`:
 *  "t" = texture image decode, "a" = audio cover art / rendered waveform. */
export type ThumbKind = "t" | "a";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

/** FNV-1a/64 over the UTF-8 bytes of `{kind}:2:256:{size}:{mtime}:{path}` —
 *  an exact port of `hash_key`/`hex_key` in thumbs.rs. */
export function thumbKeyFor(path: string, size: number, mtime: number, kind: ThumbKind = "t"): string {
  const raw = `${kind}:${CACHE_VERSION}:${THUMB_EDGE}:${size}:${mtime}:${path}`;
  const bytes = new TextEncoder().encode(raw);
  let h = FNV_OFFSET;
  for (const b of bytes) {
    h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}
