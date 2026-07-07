/* SnapScroll Pro - options page */
(function () {
  'use strict';
  var DEFAULTS = { format: 'png', hidpi: true, autostudio: true, math: true, theme: 'dark' };
  var $ = function (id) { return document.getElementById(id); };
  var saved = $('saved');

  function flash(msg) { saved.textContent = msg || 'Saved'; clearTimeout(flash._t); flash._t = setTimeout(function () { saved.textContent = ''; }, 1400); }

  function load() {
    chrome.storage.local.get(Object.keys(DEFAULTS).map(function (k) { return 'ss_opt_' + k; }), function (d) {
      $('opt-format').value = d.ss_opt_format || DEFAULTS.format;
      $('opt-hidpi').checked = d.ss_opt_hidpi != null ? d.ss_opt_hidpi : DEFAULTS.hidpi;
      $('opt-autostudio').checked = d.ss_opt_autostudio != null ? d.ss_opt_autostudio : DEFAULTS.autostudio;
      $('opt-math').checked = d.ss_opt_math != null ? d.ss_opt_math : DEFAULTS.math;
      $('opt-theme').value = d.ss_opt_theme || DEFAULTS.theme;
    });
  }

  function save() {
    chrome.storage.local.set({
      ss_opt_format: $('opt-format').value,
      ss_opt_hidpi: $('opt-hidpi').checked,
      ss_opt_autostudio: $('opt-autostudio').checked,
      ss_opt_math: $('opt-math').checked,
      ss_opt_theme: $('opt-theme').value
    }, function () { flash('Saved'); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    load();
    ['opt-format', 'opt-hidpi', 'opt-autostudio', 'opt-math', 'opt-theme'].forEach(function (id) {
      $(id).addEventListener('change', save);
    });
  });
})();
