/* FullPage Studio - settings page (opens as a full browser tab). */
(function () {
  const $ = (id) => document.getElementById(id);
  const DEFAULTS = { theme: 'system', exportScale: 2, defaultFormat: 'png', aiMathMode: 'metadata+image', segmentation: 'auto' };

  function load() {
    chrome.storage.local.get(['studioSettings'], (d) => {
      const s = Object.assign({}, DEFAULTS, d.studioSettings || {});
      $('set-format').value = s.defaultFormat;
      $('set-scale').value = String(s.exportScale);
      $('set-theme').value = s.theme;
      $('set-mathmode').value = s.aiMathMode;
      $('set-seg').value = s.segmentation;
    });
  }

  function save() {
    const settings = {
      defaultFormat: $('set-format').value,
      exportScale: parseInt($('set-scale').value, 10),
      theme: $('set-theme').value,
      aiMathMode: $('set-mathmode').value,
      segmentation: $('set-seg').value
    };
    chrome.runtime.sendMessage({ type: 'studio:update-settings', settings }, () => {
      const el = $('save-status');
      el.textContent = 'Saved \u2713';
      setTimeout(() => (el.textContent = ''), 1800);
    });
  }

  $('save').addEventListener('click', save);
  load();
})();
