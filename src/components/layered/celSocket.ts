/**
 * Client for the loopback WebSocket transport (see `src-tauri/src/celsock.rs`).
 *
 * Serves the same payloads as the `cels://` scheme — flattened image, cel pack,
 * PSD prefix — over a socket instead of wry's custom-scheme handler, which
 * measured ~57 MB/s against the socket's ~546 MB/s in this webview.
 *
 * Split in two on purpose. `celSocket()` uses `invoke`, which only exists on the
 * main thread, so the coordinates are fetched THERE and passed into the worker
 * as part of its request; `receive()` needs nothing but the coordinates and runs
 * anywhere. Everything degrades to `cels://` when `celSocket()` resolves null.
 */
import { invoke } from "@tauri-apps/api/core";

/** Where the loopback listener is, and the per-launch token that opens it. */
export interface CelSocket {
  port: number;
  token: string;
}

let cached: Promise<CelSocket | null> | null = null;

/**
 * The socket's coordinates, or null if it failed to bind. Memoized: the token is
 * fixed for the life of the process, and this is on the path of every document
 * open. MAIN THREAD ONLY — `invoke` is not available in a worker.
 */
export function celSocket(): Promise<CelSocket | null> {
  cached ??= invoke<CelSocket | null>("cel_socket").catch(() => null);
  return cached;
}

/**
 * URL for one payload. The token rides in the query because the browser's
 * WebSocket constructor cannot set request headers — safe here, since the
 * listener is loopback-only and there is no Referer to leak it to.
 *
 * `query` is the same shape the `cels://` scheme takes, minus the leading `?`
 * (`"what=merged&max=2560"`).
 */
export function celSocketUrl(sock: CelSocket, path: string, query = ""): string {
  const p = encodeURI(path.replace(/\\/g, "/").replace(/^\//, ""));
  return `ws://127.0.0.1:${sock.port}/${p}?${query === "" ? "" : `${query}&`}token=${sock.token}`;
}

/**
 * Open a socket, concatenate the frames, resolve when the server closes.
 *
 * There is deliberately no length prefix: the close IS the terminator, which is
 * what will later let the server stream layer-by-layer without knowing the total
 * up front. An empty payload is a legitimate result (a PSD has no cel pack), so
 * only an abnormal close before any frame is treated as failure.
 */
export function receive(sock: CelSocket, path: string, query = ""): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(celSocketUrl(sock, path, query));
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    ws.binaryType = "arraybuffer";

    const parts: ArrayBuffer[] = [];
    let total = 0;
    let settled = false;

    ws.onmessage = (e: MessageEvent<ArrayBuffer>): void => {
      parts.push(e.data);
      total += e.data.byteLength;
    };
    // A refused handshake (bad token, disallowed origin) surfaces here as a
    // generic failure — the browser never exposes the 403 body to script.
    ws.onerror = (): void => {
      if (settled) return;
      settled = true;
      reject(new Error("celsock: connection refused"));
    };
    ws.onclose = (e: CloseEvent): void => {
      if (settled) return;
      settled = true;
      // 1000 = normal, 1005 = closed with no status (what a bare close frame
      // looks like to the browser). Anything else with nothing received is a
      // rejection rather than an empty payload.
      if (parts.length === 0 && e.code !== 1000 && e.code !== 1005) {
        reject(new Error(`celsock: closed ${e.code}`));
        return;
      }
      const out = new Uint8Array(total);
      let at = 0;
      for (const part of parts) {
        out.set(new Uint8Array(part), at);
        at += part.byteLength;
      }
      resolve(out.buffer);
    };
  });
}
