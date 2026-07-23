// Stub. Upstream foliate-js ships a full PDF.js adapter here (pulling in a
// vendored ~3 MB pdf.mjs + worker). This app never routes PDFs through foliate
// — they use our own pdfjs-dist renderer (see components/document/PdfView.tsx)
// — so we replace the adapter with a throwing stub to keep that copy of PDF.js
// out of the bundle. `makePDF` is only ever reached from view.js's makeBook when
// a file sniffs as a PDF, which cannot happen because docFormat() sends PDFs to
// the pdf viewer, not the ebook viewer.
export const makePDF = () => {
    throw new Error("PDF is handled by the app's own viewer, not foliate-js");
};
