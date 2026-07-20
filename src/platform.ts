/**
 * OS detection for the handful of places the frontend must branch on platform.
 *
 * WebView2 (Windows) always reports "Windows NT" in its user-agent; WKWebView
 * (macOS) reports "Macintosh" and webkit2gtk (Linux) reports "Linux". We only
 * ever need the Windows-vs-not split, so a synchronous UA test is enough and
 * avoids pulling in @tauri-apps/plugin-os (+ its capability) for one bit. It
 * must be synchronous: the custom-scheme URL builders below are called during
 * render, many times per frame.
 */
export const IS_WINDOWS =
  typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);

/**
 * Base of a Tauri custom-scheme URL. Tauri resolves a registered scheme as
 * `http://<scheme>.localhost` on Windows/Android (WebView2 needs a "special"
 * http origin) and as `<scheme>://localhost` everywhere else. The Rust handlers
 * parse the URL path only, so the base is all that changes across platforms.
 */
export const schemeBase = (scheme: string): string =>
  IS_WINDOWS ? `http://${scheme}.localhost` : `${scheme}://localhost`;
