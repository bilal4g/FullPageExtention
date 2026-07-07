/* FullPage Studio - settings page */
(function () {
  const KEY = 'fp_settings';
  const $ = (id) => document.getElementById(id);
  chrome.storage.local.get([KEY], (d) => {
    const s = d[KEY] || {};
    if (s.exportScale) $('scale').value = String(s.exportScale);
    if (s.defaultFormat) $('format').value = s.defaultFormat;
  });
  $('save').addEventListener('click', () => {
    chrome.storage.local.set({ [KEY]: { exportScale: $('scale').value, defaultFormat: $('format').value } }, () => {
      $('status').textContent = 'Saved.';
      setTimeout(() => ($('status').textContent = ''), 1600);
    });
  });
})();
