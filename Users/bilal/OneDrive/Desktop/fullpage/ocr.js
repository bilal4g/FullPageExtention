/* SnapScroll Studio - Math-aware OCR via Mathpix.
 * Extracts equations/text from an image into LaTeX + plain text so an AI
 * can read the actual math instead of guessing from pixels.
 * No secrets are stored in this file - credentials live in chrome.storage.local
 * (set them in Studio > Settings). */
(function () {
  const ENDPOINT = 'https://api.mathpix.com/v3/text';

  function getCreds() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['ss_mathpix_id', 'ss_mathpix_key'], (d) => {
        resolve({ id: d.ss_mathpix_id || '', key: d.ss_mathpix_key || '' });
      });
    });
  }

  async function extract(dataUrl) {
    const { id, key } = await getCreds();
    if (!id || !key) {
      const err = new Error('NO_CREDS');
      err.code = 'NO_CREDS';
      throw err;
    }
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        app_id: id,
        app_key: key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        src: dataUrl,
        formats: ['text', 'latex_styled'],
        math_inline_delimiters: ['$', '$'],
        math_display_delimiters: ['$$', '$$'],
        rm_spaces: true
      })
    });
    if (!res.ok) {
      const err = new Error('HTTP_' + res.status);
      err.code = 'HTTP_' + res.status;
      throw err;
    }
    const j = await res.json();
    if (j.error) {
      const err = new Error(j.error);
      err.code = 'API_ERROR';
      throw err;
    }
    return {
      text: j.text || '',
      latex: j.latex_styled || j.text || '',
      confidence: typeof j.confidence === 'number' ? j.confidence : null
    };
  }

  window.SSOCR = { extract, getCreds, hasProvider: true };
})();
