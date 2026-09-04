/* FullPage Studio - settings page */
(function () {
  const KEY = 'fp_settings';
  const $ = (id) => document.getElementById(id);
  chrome.storage.local.get([KEY], (d) => {
    const s = d[KEY] || {};
    if (s.exportScale) $('scale').value = String(s.exportScale);
    if (s.defaultFormat) $('format').value = s.defaultFormat;
    
    $('ocrEngine').value = s.ocrEngine || 'gemini';
    $('geminiApiKey').value = s.geminiApiKey || '';
    $('ocrModel').value = s.ocrModel || '';
    $('sliceEnabled').checked = !!s.sliceEnabled;
    $('sliceHeight').value = s.sliceHeight || 1500;
  });
  $('save').addEventListener('click', () => {
    const settings = {
      exportScale: $('scale').value,
      defaultFormat: $('format').value,
      ocrEngine: $('ocrEngine').value,
      geminiApiKey: $('geminiApiKey').value.trim(),
      ocrModel: $('ocrModel').value.trim(),
      sliceEnabled: $('sliceEnabled').checked,
      sliceHeight: parseInt($('sliceHeight').value, 10) || 1500
    };
    chrome.storage.local.set({ [KEY]: settings }, () => {
      $('status').textContent = 'Saved.';
      setTimeout(() => ($('status').textContent = ''), 1600);
    });
  });
})();
