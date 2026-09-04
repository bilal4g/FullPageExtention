/* FullPage Studio - math OCR (supports Cloud Gemini API and offline transformers.js).
 * Exposes: window.FPOCR.run(dataUrl, onProgress) -> Promise<{ latex }> */
(function () {
  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['fp_settings'], (d) => {
        resolve(d.fp_settings || {});
      });
    });
  }

  async function runGeminiOcr(dataUrl, apiKey, onProgress) {
    if (onProgress) onProgress({ status: 'Connecting to Gemini Cloud...' });
    
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid image data URL');
    const mimeType = match[1];
    const base64Data = match[2];
    
    // Call gemini-2.5-flash which is very fast and precise for OCR/math transcription
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              text: "You are an expert Math OCR assistant. Read the math equations and text in this image and transcribe it exactly to clean LaTeX. Return ONLY the transcribed text/LaTeX equations in reading order. Do not wrap your response in markdown code blocks (like ```latex or ```) or include extra conversational text or headers. Just return the raw text with LaTeX inline/display equations."
            },
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Data
              }
            }
          ]
        }],
        generationConfig: {
          temperature: 0.1
        }
      })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      let errMsg = response.statusText;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.error && errJson.error.message) errMsg = errJson.error.message;
      } catch (e) {}
      throw new Error(`Gemini API Error: ${response.status} - ${errMsg}`);
    }
    
    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('Gemini API returned an empty response.');
    }
    return text.trim();
  }

  async function run(dataUrl, onProgress) {
    const s = await getSettings();
    const apiKey = s.geminiApiKey || '';
    
    if (!apiKey) {
      throw new Error('No Gemini API Key found. Please open Settings and enter a Gemini API Key to read math with Gemini Cloud AI.');
    }
    
    const latex = await runGeminiOcr(dataUrl, apiKey, onProgress);
    return { latex };
  }

  window.FPOCR = { run };
})();
