//! Loopback WebSocket transport for layered-art payloads.
//!
//! A SPIKE. It runs ALONGSIDE the `cels://` scheme rather than replacing it, so
//! the two can be measured against each other on the same file with no risk to
//! the path the app actually uses.
//!
//! WHY. Bytes handed to the webview through wry's custom-scheme handler move at
//! ~57 MB/s. The request is intercepted by WebView2's `WebResourceRequested`,
//! crosses into this process as a COM callback, comes back as a fully
//! materialized `Response<Vec<u8>>` (wry's API has no streaming body), and is
//! then read out again through an `IStream`. A plain loopback socket skips all
//! of it: Chromium's network service moves the bytes over the same path it uses
//! for every other resource on the web. Measured in this webview, same file,
//! same read:
//!
//! | transport                        | MB/s | first byte |
//! |----------------------------------|------|------------|
//! | `cels://` custom scheme          |   57 |    7935 ms |
//! | loopback HTTP, one buffered body |  421 |     444 ms |
//! | loopback WebSocket, 8 MiB frames |  546 |      51 ms |
//!
//! Frame size is what actually matters, not the protocol. The same 128 MB sent
//! as ONE frame manages only 206 MB/s, because nothing is delivered until the
//! whole thing is buffered at both ends — the same materialize-everything-first
//! problem as the scheme handler, merely relocated. At 8 MiB the file read, the
//! socket and the renderer's ingest all overlap.
//!
//! SECURITY. A custom scheme is reachable only from inside the webview. A TCP
//! port is reachable by anything on the machine, so that exposure is closed
//! deliberately, with four controls:
//!
//!   * bound to `127.0.0.1`, so it is not routable from the network at all;
//!   * an ephemeral port, so there is no well-known number to aim at;
//!   * a 32-byte token from the OS CSPRNG, minted per launch, never persisted
//!     and never logged, compared in constant time;
//!   * a strict `Origin` allowlist — and this one is NOT belt-and-braces.
//!     WebSocket handshakes are exempt from CORS, so without it any page in the
//!     user's browser could open a socket here and read the library. That is
//!     Cross-Site WebSocket Hijacking, and it is what made the 2019 Zoom
//!     local-server bug exploitable from any website. Browsers set `Origin`
//!     themselves and script cannot forge it, so the check is airtight against
//!     exactly that vector; the token covers the local-process one.
//!
//! What is left is a local process that can read this process's memory — and
//! that attacker already runs at the user's privilege and can open the files
//! directly, so it is not an escalation.
//!
//! `is_within_roots` still performs the actual authorization, unchanged, inside
//! each payload function: the token decides who may ask, the scope check decides
//! what they may reach.

use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::Arc;

use tauri::Manager;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::Message;

/// Payload chunk size, and the one number in here worth tuning: 8 MiB measured
/// fastest (546 MB/s). One giant frame drops to 206, and 256 KiB frames to 362
/// as per-message allocation starts to dominate.
const FRAME: usize = 8 * 1024 * 1024;

/// Live socket, published into Tauri's state so the command below can hand the
/// webview its coordinates.
pub struct CelSock {
    pub port: u16,
    pub token: String,
}

/// Tauri serves the app from a different origin per platform, and the dev server
/// from a third. Nothing else may open a socket.
fn origin_allowed(origin: &str) -> bool {
    matches!(origin, "http://tauri.localhost" | "tauri://localhost")
        || (cfg!(debug_assertions) && origin == "http://localhost:1420")
}

/// Constant-time comparison. A plain `==` short-circuits on the first differing
/// byte, which leaks the token prefix through timing to anything that can retry.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Refuse a connection.
///
/// This LOGS, because the failure mode is otherwise invisible: the client falls
/// back to `cels://` and everything keeps working, just slower. If a packaged
/// build ever serves the app from an origin not in the allowlist, every socket
/// would be refused and the only symptom would be that the transport silently
/// stopped paying for itself. The refused origin is printed; the token never is.
fn deny(why: &str, origin: &str) -> ErrorResponse {
    eprintln!("[celsock] refused connection ({why}); origin={origin:?}");
    tungstenite::http::Response::builder()
        .status(403)
        .body(Some(why.to_string()))
        .expect("static response builds")
}

/// Bind the loopback listener and start accepting. Returns the coordinates the
/// webview needs; the caller decides what to do if binding fails (it must stay
/// non-fatal — the `cels://` scheme is still there).
pub fn start(app: tauri::AppHandle) -> std::io::Result<CelSock> {
    // Port 0 asks the OS for a free one. LOCALHOST rather than UNSPECIFIED also
    // means Windows Firewall never prompts, since that only fires for binds
    // reachable off-machine.
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();

    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw).map_err(|e| std::io::Error::other(e.to_string()))?;
    let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();

    let shared = Arc::new(token.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            let token = Arc::clone(&shared);
            // A thread per connection, matching how the scheme handlers already
            // work. Connections are few and short-lived — one per document load.
            std::thread::spawn(move || {
                if let Err(e) = serve(stream, &app, &token) {
                    eprintln!("[celsock] {e}");
                }
            });
        }
    });

    Ok(CelSock { port, token })
}

fn serve(stream: TcpStream, app: &tauri::AppHandle, token: &str) -> Result<(), String> {
    stream.set_nodelay(true).ok();

    // The handshake callback is the only point at which a connection can still
    // be refused, so BOTH checks live here and the request target is stashed for
    // use after it. Nothing is read from the socket before this returns Ok.
    let target = std::cell::RefCell::new(None::<(String, String)>);
    let mut ws = tungstenite::accept_hdr(
        stream,
        |req: &Request, res: Response| -> Result<Response, ErrorResponse> {
            let origin = req
                .headers()
                .get("origin")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if !origin_allowed(origin) {
                return Err(deny("origin not allowed", origin));
            }
            let query = req.uri().query().unwrap_or("");
            // The browser's WebSocket constructor cannot set request headers, so
            // the token travels in the URL. That is safe here: loopback only, no
            // Referer to leak it to, and request URLs are never logged.
            let supplied = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("token="))
                .unwrap_or("");
            if !ct_eq(supplied, token) {
                return Err(deny("bad token", origin));
            }
            *target.borrow_mut() = Some((
                crate::percent_decode(req.uri().path().trim_start_matches('/')),
                query.to_string(),
            ));
            Ok(res)
        },
    )
    .map_err(|e| e.to_string())?;

    let Some((path, query)) = target.into_inner() else {
        return Err("handshake produced no target".into());
    };

    // Same dispatch as the `cels` scheme, deliberately — identical payloads are
    // what make the A/B meaningful.
    let max_edge = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("max="))
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(2560)
        .clamp(64, 8192);
    let bytes = if query.contains("what=prefix") {
        crate::layered::psd_prefix(app, &path)
    } else if query.contains("what=merged") {
        crate::layered::merged_bytes(app, &path, max_edge).map(|(b, _mime)| b)
    } else {
        crate::layered::cel_pack(app, &path)
    }
    .unwrap_or_default();

    for chunk in bytes.chunks(FRAME) {
        ws.send(Message::binary(chunk.to_vec())).map_err(|e| e.to_string())?;
    }
    // Closing is how the client knows the payload is complete — there is no
    // length prefix, deliberately, so this can later stream layer-by-layer
    // without knowing the total up front.
    ws.close(None).ok();
    ws.flush().ok();
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SockInfo {
    pub port: u16,
    pub token: String,
}

/// Hand the webview the port and token. Only the webview can invoke a Tauri
/// command, so this is the single channel the token ever travels on. `None`
/// means the listener failed to bind and callers should use `cels://`.
#[tauri::command]
pub fn cel_socket(app: tauri::AppHandle) -> Option<SockInfo> {
    app.try_state::<CelSock>().map(|s| SockInfo {
        port: s.port,
        token: s.token.clone(),
    })
}
