/* SnapScroll Pro - settings page logic. Stores prefs in chrome.storage.local. */
(function () {
  const $ = (id) => document.getElementById(id);
  const DEFAULTS = { scale: 2, tile: 1600, overlap: 90, delay: 400, autostudio: 1 };

  function load() {
    chrome.storage.local.get('ss_settings', (d) => {
      const s = Object.assign({}, DEFAULTS, (d && d.ss_settings) || {});
      $('opt-scale').value = String(s.scale);
      $('opt-tile').value = s.tile;
      $('opt-overlap').value = s.overlap;
      $('opt-delay').value = s.delay;
      $('opt-autostudio').value = String(s.autostudio);
    });
  }
  function save() {
    const s = {
      scale: parseInt($('opt-scale').value, 10) || DEFAULTS.scale,
      tile: parseInt($('opt-tile').value, 10) || DEFAULTS.tile,
      overlap: parseInt($('opt-overlap').value, 10) || DEFAULTS.overlap,
      delay: parseInt($('opt-delay').value, 10) || 0,
      autostudio: parseInt($('opt-autostudio').value, 10)
    };
    chrome.storage.local.set({ ss_settings: s }, () => {
      const el = $('saved'); el.textContent = 'Saved.';
      setTimeout(() => (el.textContent = ''), 1600);
    });
  }
  document.addEventListener('DOMContentLoaded', () => { load(); $('save').onclick = save; });
})();
