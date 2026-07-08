/* FullPage Studio - PDF renderer.
 * Renders a PDF file into a single tall stitched image using pdf.js, so PDFs
 * can be opened, edited and exported inside the Studio. This sidesteps
 * Chrome's built-in PDF viewer, which extensions cannot scroll or capture.
 *
 * Requires the pdf.js library dropped into lib/ (see lib/README.md):
 *   lib/pdf.min.js  and  lib/pdf.worker.min.js
 * Exposes: window.FPPDF.fileToImage(file, scale) -> Promise<dataURL|null>
 */
(function () {
  let loading = null;

  function loadLib() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('lib/pdf.min.js');
      s.onload = () => {
        const lib = window.pdfjsLib || (window.pdfjsDistBuildPdf && window.pdfjsDistBuildPdf);
        if (!lib) { reject(new Error('pdf.js loaded but pdfjsLib not found')); return; }
        try { lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js'); } catch (e) {}
        resolve(lib);
      };
      s.onerror = () => reject(new Error('MISSING_LIB'));
      document.head.appendChild(s);
    });
    return loading;
  }

  async function fileToImage(file, scale) {
    const lib = await loadLib();
    const buf = await file.arrayBuffer();
    const pdf = await lib.getDocument({ data: buf }).promise;
    const s = scale || 2; // render at 2x for crisp text/math
    const pages = [];
    let totalH = 0, maxW = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: s });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      pages.push(c);
      totalH += c.height; maxW = Math.max(maxW, c.width);
    }
    if (!pages.length) return null;
    const gap = 16;
    const out = document.createElement('canvas');
    out.width = maxW; out.height = totalH + gap * (pages.length - 1);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height);
    let y = 0;
    for (const p of pages) { ctx.drawImage(p, Math.round((maxW - p.width) / 2), y); y += p.height + gap; }
    return out.toDataURL('image/png');
  }

  window.FPPDF = { fileToImage, isAvailable: () => !!window.pdfjsLib || true };
})();
