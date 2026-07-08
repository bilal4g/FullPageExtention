/* FullPage Studio - PDF renderer (proxies to the sandboxed pdf.js).
 * Exposes: window.FPPDF.fileToImage(file, scale) -> Promise<dataURL|null>
 * The PDF engine loads from CDN on first use; no manual install. */
(function () {
  async function fileToImage(file, scale) {
    const buf = await file.arrayBuffer();
    const r = await window.FPSandbox.request({ type: 'pdf', buffer: buf, scale: scale || 2 }, [buf]);
    return r && r.dataUrl;
  }
  window.FPPDF = { fileToImage };
})();
