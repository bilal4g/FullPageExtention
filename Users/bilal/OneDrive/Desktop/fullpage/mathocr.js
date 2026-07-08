/* FullPage Studio - offline math OCR (proxies to the sandboxed transformers.js).
 * Exposes: window.FPOCR.run(dataUrl, onProgress) -> Promise<{ latex }>
 * The model loads from CDN on first use and is cached; no API key, no server. */
(function () {
  function getModel() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['fp_settings'], (d) => {
        const s = d.fp_settings || {};
        resolve(s.ocrModel || 'Xenova/nougat-small');
      });
    });
  }
  async function run(dataUrl, onProgress) {
    const model = await getModel();
    const r = await window.FPSandbox.request({ type: 'ocr', dataUrl, model }, null, onProgress);
    return { latex: (r && r.latex) || '' };
  }
  window.FPOCR = { run };
})();
