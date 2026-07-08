/* FullPage Studio - PDF -> image rendering via pdf.js (bundled in vendor/).
 * Chrome's built-in PDF viewer blocks extensions from scrolling/injecting, so
 * we don't screenshot it. Instead we render the PDF ourselves, page by page,
 * onto canvases and stitch them into one tall image for the Studio.
 * Exposes window.FPPdf.renderToDataUrl(fileOrArrayBuffer, {scale, onProgress}). */
(function () {
  'use strict';
  const LIB = 'vendor/pdf.min.mjs';
  const WORKER = 'vendor/pdf.worker.min.mjs';
  let pdfjs = null;

  function fileExists(url) { return fetch(url, { method: 'HEAD' }).then((r) => r.ok).catch(() => false); }

  async function ensureLib() {
    if (pdfjs) return pdfjs;
    const libUrl = chrome.runtime.getURL(LIB);
    if (!(await fileExists(libUrl))) { const e = new Error('NO_PDFJS'); e.code = 'NO_PDFJS'; throw e; }
    pdfjs = await import(libUrl);
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(WORKER);
    return pdfjs;
  }

  async function toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) return input;
    if (input instanceof Blob) return await input.arrayBuffer();
    throw new Error('Unsupported PDF input');
  }

  // Render all pages, stitch vertically into one PNG dataURL.
  async function renderToDataUrl(input, opts = {}) {
    const scale = opts.scale || 2;            // 2x for crisp text/math
    const gap = opts.gap == null ? 16 : opts.gap;
    const lib = await ensureLib();
    const data = await toArrayBuffer(input);
    const doc = await lib.getDocument({ data }).promise;

    const pages = [];
    let maxW = 0, totalH = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      if (opts.onProgress) opts.onProgress({ page: i, total: doc.numPages });
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.ceil(viewport.width); c.height = Math.ceil(viewport.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      pages.push(c);
      maxW = Math.max(maxW, c.width);
      totalH += c.height + (i < doc.numPages ? gap : 0);
    }

    const out = document.createElement('canvas');
    out.width = maxW; out.height = totalH;
    const octx = out.getContext('2d');
    octx.fillStyle = '#e5e7eb'; octx.fillRect(0, 0, out.width, out.height); // page gutter
    let y = 0;
    for (const c of pages) { octx.drawImage(c, Math.round((maxW - c.width) / 2), y); y += c.height + gap; }
    return out.toDataURL('image/png');
  }

  async function isAvailable() { return fileExists(chrome.runtime.getURL(LIB)); }

  window.FPPdf = { renderToDataUrl, isAvailable };
})();
