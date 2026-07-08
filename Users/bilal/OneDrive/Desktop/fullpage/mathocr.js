/* FullPage Studio - offline math OCR.
 * Reads math baked into images (screenshots, photos, scans) and returns LaTeX,
 * running an AI model fully in the browser via transformers.js. The model is
 * downloaded once and cached by the browser; there is NO API key and NO server,
 * so it scales to any number of users at zero marginal cost.
 *
 * Requires transformers.js dropped into lib/ (see lib/README.md):
 *   lib/transformers.min.js
 * The default model can be changed in Settings (fp_settings.ocrModel).
 * Exposes: window.FPOCR.run(dataUrl, onProgress) -> Promise<{ latex }>
 */
(function () {
  const DEFAULT_MODEL = 'Xenova/nougat-small'; // document+math OCR; override in Settings
  let pipePromise = null;

  async function getModelId() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['fp_settings'], (d) => {
        const s = d.fp_settings || {};
        resolve(s.ocrModel || DEFAULT_MODEL);
      });
    });
  }

  async function loadPipeline(onProgress) {
    if (pipePromise) return pipePromise;
    pipePromise = (async () => {
      let tf;
      try {
        tf = await import(chrome.runtime.getURL('lib/transformers.min.js'));
      } catch (e) {
        const err = new Error('MISSING_LIB'); err.code = 'MISSING_LIB'; throw err;
      }
      // Cache models in-browser; allow remote download once.
      if (tf.env) { tf.env.allowRemoteModels = true; tf.env.useBrowserCache = true; }
      const model = await getModelId();
      return tf.pipeline('image-to-text', model, {
        quantized: true,
        progress_callback: (p) => { if (onProgress && p && p.status) onProgress(p); }
      });
    })();
    return pipePromise;
  }

  async function run(dataUrl, onProgress) {
    const pipe = await loadPipeline(onProgress);
    const out = await pipe(dataUrl, { max_new_tokens: 512 });
    let text = '';
    if (Array.isArray(out) && out.length) text = out[0].generated_text || out[0].text || '';
    else if (out && typeof out === 'object') text = out.generated_text || out.text || '';
    return { latex: (text || '').trim() };
  }

  window.FPOCR = { run };
})();
