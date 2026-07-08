/* FullPage Studio - offline image->LaTeX math OCR.
 * Runs a small vision model fully client-side via Transformers.js + ONNX
 * Runtime Web (WASM). No API key, no server, no per-user cost.
 *
 * The model + library binaries are large, so they live in ./vendor and are
 * fetched once by setup-models.cmd / setup-models.sh. If they're missing, this
 * module reports NO_MODEL so the UI can guide the user, and the DOM-based math
 * (content.js) plus 8K export still work as before. */
(function () {
  'use strict';

  const MODEL_ID = 'Xenova/texify';           // image->LaTeX, ONNX (Transformers.js)
  const LIB = 'vendor/transformers.min.js';   // Transformers.js UMD bundle
  let pipe = null;
  let loadingPromise = null;
  let transformers = null;

  function fileExists(url) {
    return fetch(url, { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
  }

  async function ensureLib() {
    if (transformers) return transformers;
    const libUrl = chrome.runtime.getURL(LIB);
    if (!(await fileExists(libUrl))) { const e = new Error('NO_MODEL'); e.code = 'NO_MODEL'; throw e; }
    // Import the local UMD/ESM bundle. Configured to load everything locally.
    transformers = await import(libUrl);
    const env = transformers.env;
    env.allowRemoteModels = false;               // never hit the network
    env.allowLocalModels = true;
    env.localModelPath = chrome.runtime.getURL('vendor/models/');
    if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
      env.backends.onnx.wasm.numThreads = 1;     // safe default inside extensions
    }
    return transformers;
  }

  async function load(onProgress) {
    if (pipe) return pipe;
    if (loadingPromise) return loadingPromise;
    loadingPromise = (async () => {
      const t = await ensureLib();
      pipe = await t.pipeline('image-to-text', MODEL_ID, {
        quantized: true,
        progress_callback: (p) => { if (onProgress && p && p.status) onProgress(p); }
      });
      return pipe;
    })();
    return loadingPromise;
  }

  // Recognize LaTeX from a dataURL. Returns { latex }.
  async function recognize(dataUrl, onProgress) {
    const p = await load(onProgress);
    const out = await p(dataUrl, { max_new_tokens: 512 });
    const text = Array.isArray(out) ? (out[0] && (out[0].generated_text || out[0].text)) : (out.generated_text || out.text || '');
    return { latex: cleanLatex(text || '') };
  }

  function cleanLatex(s) {
    return String(s)
      .replace(/^\s*```(?:latex)?/i, '').replace(/```\s*$/,'')
      .replace(/\r/g, '')
      .trim();
  }

  async function isAvailable() { return fileExists(chrome.runtime.getURL(LIB)); }

  window.FPMathOCR = { recognize, load, isAvailable };
})();
