import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import postcss from "postcss";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Tailwind v4 emits its ENTIRE stylesheet inside cascade layers — theme/base in
// their own layers and every utility inside `@layer utilities`. Cascade layers
// need a modern engine (Safari 16.4+ for the rest of Tailwind's output too);
// WebView2 on Windows is Chromium and fine, but older macOS WKWebViews silently
// DROP every `@layer {}` block. When that happens all the layout utilities
// (flex/grid/gap/padding/…) vanish and the app collapses to unstyled block flow,
// while our own unlayered component classes (.btn-primary, .icon-btn, …) survive.
//
// Flattening the layers in place reproduces the exact same cascade: the inner
// rules keep their source order (theme → base → utilities, then our unlayered
// component rules last), so utilities still beat base and our components still
// win ties over utilities — which is how Tailwind behaved before layers existed.
// The result works on every WebView. `@property`/`@supports`/`@keyframes` inside
// the layers are preserved untouched.
function flattenCascadeLayers(css: string): string {
  const root = postcss.parse(css);
  root.walkAtRules("layer", (rule) => {
    if (rule.nodes) {
      rule.replaceWith(rule.nodes); // block form: splice the layer's rules in
    } else {
      rule.remove(); // bare `@layer a, b;` ordering statement
    }
  });
  return root.toString();
}

function flattenCascadeLayersPlugin(): Plugin {
  return {
    name: "flatten-cascade-layers",
    enforce: "post",
    // Build: rewrite the final emitted CSS asset. This is the path the shipped
    // Tauri app uses, so it's the one that must be correct.
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (
          file.type === "asset" &&
          file.fileName.endsWith(".css") &&
          typeof file.source === "string" &&
          file.source.includes("@layer")
        ) {
          file.source = flattenCascadeLayers(file.source);
        }
      }
    },
    // Dev (`tauri dev`): best-effort so the same old-WebView machines can run the
    // dev server too. Idempotent — a second pass finds no `@layer` and no-ops.
    //
    // With enforce:"post" this hook can fire AFTER Vite's css-post plugin has
    // already wrapped the stylesheet into a JS module (`import { updateStyle }
    // … const __vite__css = "…@layer…"`). That module body still contains the
    // "@layer" substring, but it is JavaScript — feeding it to postcss.parse
    // throws "Unknown word updateStyle". Skip anything that has been module-
    // wrapped, and fail soft on any other non-CSS payload: the build path
    // (generateBundle) is the one that must be correct.
    transform(code, id) {
      if (!id.endsWith(".css") || !code.includes("@layer")) return;
      if (/\b(?:import|export|const)\b/.test(code) || code.includes("updateStyle")) return;
      try {
        return { code: flattenCascadeLayers(code), map: null };
      } catch {
        return;
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), flattenCascadeLayersPlugin()],

  // The model-thumbnail worker (modelThumbWorker.ts) dynamically imports three's
  // loaders, i.e. it code-splits. Vite's default worker format is `iife`, which
  // can't code-split and fails the production build (dev is unaffected). ES
  // module workers can — and WebView2 supports `{ type: "module" }` workers.
  worker: {
    format: "es",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
