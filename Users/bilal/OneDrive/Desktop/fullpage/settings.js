/* SnapScroll Pro - settings (full options page). Stored locally, no API. */
(function () {
  const $ = (id) => document.getElementById(id);
  const DEFAULTS = { tileH: 1400, scale: 1, includeTranscript: true, defaultFormat: 'png' };

  function apply(s) {
    $('tileH').value = s.tileH; $('tileH-val').textContent = s.tileH;
    $('scale').value = s.scale; $('scale-val').textContent = s.scale + 'x';
    $('includeTranscript').checked = !!s.includeTranscript;
    $('defaultFormat').value = s.defaultFormat;
  }
  function read() {
    return {
      tileH: parseInt($('tileH').value, 10) || DEFAULTS.tileH,
      scale: parseFloat($('scale').value) || DEFAULTS.scale,
      includeTranscript: $('includeTranscript').checked,
      defaultFormat: $('defaultFormat').value
    };
  }
  function flashSaved() { const el = $('saved'); el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 1500); }

  $('tileH').addEventListener('input', () => ($('tileH-val').textContent = $('tileH').value));
  $('scale').addEventListener('input', () => ($('scale-val').textContent = $('scale').value + 'x'));
  $('save').addEventListener('click', () => { chrome.storage.local.set({ ss_settings: read() }, flashSaved); });
  $('reset').addEventListener('click', () => { apply(DEFAULTS); chrome.storage.local.set({ ss_settings: DEFAULTS }, flashSaved); });

  chrome.storage.local.get(['ss_settings'], (d) => { apply(Object.assign({}, DEFAULTS, (d && d.ss_settings) || {})); });
})();
