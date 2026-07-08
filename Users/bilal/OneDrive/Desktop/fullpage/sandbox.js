/* FullPage Studio - sandboxed worker frame.
 * Runs pdf.js and transformers.js loaded from CDN (allowed by the sandbox CSP)
 * so PDF rendering and offline math OCR work with no manual library install.
 * Talks to the Studio page via postMessage. Everything still runs locally in
 * the browser; the libraries/models download once and are then cached. */
(function () {
  'use strict';
  const PDF_JS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js';
  const PDF_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js';
  const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/dist/transformers.min.js';
  const DEFAULT_MODEL = 'Xenova/nougat-small';

  let pdfLibP = null, ocrP = null;

  function post(msg) { parent.postMessage(msg, '*'); }
  function progress(id, p) { post({ __fp: 'res', id, progress: p }); }

  function loadPdf() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfLibP) return pdfLibP;
    pdfLibP = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDF_JS;
      s.onload = () => {
        const lib = window.pdfjsLib;
        if (!lib) { reject(Object.assign(new Error('pdf.js failed to init'), { code: 'PDF_INIT' })); return; }
        try { lib.GlobalWorkerOptions.workerSrc = PDF_WORKER; } catch (e) {}
        resolve(lib);
      };
      s.onerror = () => reject(Object.assign(new Error('Could not load PDF engine from CDN (offline?)'), { code: 'CDN_BLOCKED' }));
      document.head.appendChild(s);
    });
    return pdfLibP;
  }

  async function renderPdf(buffer, scale, id) {
    const lib = await loadPdf();
    const pdf = await lib.getDocument({ data: buffer }).promise;
    const s = scale || 2;
    const pages = []; let totalH = 0, maxW = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const pg = await pdf.getPage(i);
      const vp = pg.getViewport({ scale: s });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      pages.push(c); totalH += c.height; maxW = Math.max(maxW, c.width);
      progress(id, { status: 'render', page: i, total: pdf.numPages });
    }
    if (!pages.length) return null;
    const gap = 16;
    const out = document.createElement('canvas');
    out.width = maxW; out.height = totalH + gap * (pages.length - 1);
    const ctx = out.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
    let y = 0; for (const p of pages) { ctx.drawImage(p, Math.round((maxW - p.width) / 2), y); y += p.height + gap; }
    return out.toDataURL('image/png');
  }

  function loadOcr(model, id) {
    if (ocrP) return ocrP;
    ocrP = (async () => {
      let tf;
      try { tf = await import(TRANSFORMERS); }
      catch (e) { throw Object.assign(new Error('Could not load OCR engine from CDN (offline?)'), { code: 'CDN_BLOCKED' }); }
      if (tf.env) { tf.env.allowRemoteModels = true; tf.env.useBrowserCache = true; }
      return tf.pipeline('image-to-text', model || DEFAULT_MODEL, {
        quantized: true,
        progress_callback: (p) => progress(id, p)
      });
    })();
    return ocrP;
  }
  async function ocr(dataUrl, model, id) {
    const pipe = await loadOcr(model, id);
    const out = await pipe(dataUrl, { max_new_tokens: 512 });
    let t = '';
    if (Array.isArray(out) && out.length) t = out[0].generated_text || out[0].text || '';
    else if (out && typeof out === 'object') t = out.generated_text || out.text || '';
    return (t || '').trim();
  }

  window.addEventListener('message', async (e) => {
    const d = e.data || {};
    if (d.__fp !== 'req') return;
    try {
      if (d.type === 'pdf') { const url = await renderPdf(d.buffer, d.scale, d.id); post({ __fp: 'res', id: d.id, ok: true, dataUrl: url }); }
      else if (d.type === 'ocr') { const latex = await ocr(d.dataUrl, d.model, d.id); post({ __fp: 'res', id: d.id, ok: true, latex }); }
    } catch (err) {
      post({ __fp: 'res', id: d.id, ok: false, error: (err && err.message) || 'error', code: err && err.code });
    }
  });

  post({ __fp: 'ready' });
})();
