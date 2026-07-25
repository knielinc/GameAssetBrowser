/**
 * Reader for the binary cel pack Rust writes (`layered::pack_cels`).
 *
 * ```text
 * magic  u32  "LYR1"
 * count  u32
 * count x record { layer i32, frame u32, x i32, y i32, w u32, h u32,
 *                  offset u32, len u32 }   // 32 bytes each
 * payload bytes (RGBA runs, in record order)
 * ```
 *
 * Kept apart from the worker that consumes it so both ends of the wire format
 * can be tested: the layout here has to match `pack_cels` byte for byte, and a
 * silent mismatch would just render nothing.
 */

export const PACK_MAGIC = 0x3152_594c; // "LYR1", little-endian
const HEADER = 8;
const RECORD = 32;

export interface CelRecord {
  /** Index into the document's layer list, or -1 for a standalone image. */
  layer: number;
  frame: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Straight RGBA8, `width * height * 4` bytes, viewing the pack's buffer. */
  pixels: Uint8ClampedArray;
}

/**
 * Parse every record out of `buf`. Throws if the magic is wrong; skips
 * individual records whose geometry doesn't add up rather than losing the
 * whole document to one bad layer.
 */
export function readCelPack(buf: ArrayBuffer): CelRecord[] {
  const view = new DataView(buf);
  if (buf.byteLength < HEADER || view.getUint32(0, true) !== PACK_MAGIC) {
    throw new Error("not a cel pack");
  }
  const count = view.getUint32(4, true);
  const payload = HEADER + count * RECORD;
  if (payload > buf.byteLength) throw new Error("truncated cel pack");
  const out: CelRecord[] = [];
  for (let i = 0; i < count; i++) {
    const o = HEADER + i * RECORD;
    const layer = view.getInt32(o, true);
    const frame = view.getUint32(o + 4, true);
    const x = view.getInt32(o + 8, true);
    const y = view.getInt32(o + 12, true);
    const width = view.getUint32(o + 16, true);
    const height = view.getUint32(o + 20, true);
    const off = view.getUint32(o + 24, true);
    const len = view.getUint32(o + 28, true);
    if (width === 0 || height === 0) continue;
    if (len !== width * height * 4) continue;
    if (payload + off + len > buf.byteLength) continue;
    out.push({
      layer,
      frame,
      x,
      y,
      width,
      height,
      pixels: new Uint8ClampedArray(buf, payload + off, len),
    });
  }
  return out;
}
