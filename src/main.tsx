import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { initIpcEvents } from "./ipc/events";
import { loadSettings } from "./stores/settings";
import { rescanRoots } from "./stores/libraryStore";

// Wire backend event listeners once, at module scope — NOT inside a React
// effect, where StrictMode's double-mount would double-subscribe.
initIpcEvents();

/** Input types where the caret/clipboard native menu is still wanted. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

// Suppress WebView2's default context menu (Back/Refresh/Print/…) app-wide,
// installed once at module scope so StrictMode's double-mount can't stack
// listeners. Text fields are exempt: the search box keeps the native
// cut/copy/paste menu. Custom menus (file rows) render on top of this.
document.addEventListener("contextmenu", (e) => {
  const t = e.target;
  if (t instanceof HTMLTextAreaElement) return;
  if (t instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(t.type)) return;
  e.preventDefault();
});

async function bootstrap(): Promise<void> {
  let roots: string[] = [];
  try {
    const settings = await loadSettings();
    roots = settings.roots;
  } catch (err) {
    console.error("Failed to load settings; continuing with defaults.", err);
  }

  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  if (roots.length > 0) {
    void rescanRoots(roots);
  }
}

void bootstrap();
