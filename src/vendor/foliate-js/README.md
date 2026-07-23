# foliate-js (vendored)

Ebook **parser** for the Documents tab — EPUB, MOBI/AZW3, FB2/FBZ, CBZ.
Upstream: <https://github.com/johnfactotum/foliate-js> (MIT, see `LICENSE`).

## Parser only — we don't use foliate's renderer

The app calls `makeBook()` to decode the container and `section.createDocument()`
to get each section's HTML (with images rewritten to blob: URLs), then renders
those sections itself in a Shadow DOM (see `components/document/EbookView.tsx`).
It does **not** use foliate's `<foliate-view>` / paginator.

Why: the app's target WebView2 (Edge Chromium build `150.0.4078`) miscomputes
layout geometry for content inside sandboxed iframes — foliate renders every
section in one, and there CSS multi-column explodes into phantom columns and
constrained widths collapse to one word per line, so its renderer is unusable on
that engine (it renders fine in Google Chrome). The parser is plain JS and works
everywhere. The renderer files (`view.js`, `paginator.js`, `fixed-layout.js`,
`overlayer.js`, …) stay only because `makeBook` lives in `view.js` and its
dynamic imports must resolve at build time; they are never exercised at runtime.

## What's here

A **subset** of upstream, trimmed to the runtime graph `view.js` actually reaches
for the formats we render. Not vendored: `opds.js`, `dict.js`, `footnotes.js`,
`quote-image.js`, `uri-template.js`, `reader.*`, the `ui/` demo, and the `tests/`.

`pdf.js` is a **local stub**, not upstream's. The real one bundles its own
~3 MB copy of PDF.js; this app renders PDFs with its own `pdfjs-dist` viewer
(`components/document/PdfView.tsx`) and never sends a PDF to foliate, so the
adapter is replaced with a throw. `view.js`'s `makeBook` still `import()`s it,
which is why the stub has to exist.

`view.d.ts` is our own minimal typings for `view.js` (upstream ships no types).

## Local patches (must be re-applied when updating)

- **`pdf.js`** — replaced with a throwing stub (see above). This is the only
  edit to upstream source.

## Updating

Re-copy the same file set from a fresh clone of upstream, then re-apply the
`pdf.js` stub and keep `view.d.ts`. Consumed by
`components/document/EbookView.tsx` and `components/document/docThumb.ts`.
