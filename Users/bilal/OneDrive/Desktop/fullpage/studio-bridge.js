/* SnapScroll Pro - Popup bridge.
 * 1) 'More settings' opens the full options page.
 * 2) When a capture finishes (result view appears), automatically:
 *    - grab the full-res screenshot from the preview canvas
 *    - extract equations from the live page DOM (no API, on-device)
 *    - stash both and open the Studio in a new tab with the capture loaded.
 * The capture engine in popup.js is left completely untouched. */
(function () {
  'use strict';

  // Injected into the captured page. Pulls exact equation source that sites
  // already ship in their DOM (KaTeX/MathJax/MathML). No network, no solving.
  function ssExtractMathInject() {
    try {
      var out = { latex: [], mathml: [], text: [] };
      var seen = {};
      function push(kind, v) {
        if (!v) return; v = String(v).trim(); if (!v) return;
        var key = kind + '|' + v; if (seen[key]) return; seen[key] = 1;
        out[kind].push(v);
      }
      // KaTeX + LaTeX->MathML converters store TeX in <annotation encoding="application/x-tex">
      document.querySelectorAll('annotation[encoding="application/x-tex"]').forEach(function (a) { push('latex', a.textContent); });
      // MathJax v2/v3 keep original TeX in <script type="math/tex">
      document.querySelectorAll('script[type="math/tex"], script[type="math/tex; mode=display"]').forEach(function (s) { push('latex', s.textContent); });
      // MathJax v3 accessible label as a fallback when no TeX source is present
      document.querySelectorAll('mjx-container[aria-label], .MathJax[aria-label]').forEach(function (m) { push('text', m.getAttribute('aria-label')); });
      // Raw MathML blocks
      document.querySelectorAll('math').forEach(function (m) { push('mathml', m.outerHTML); });
      // Wikipedia and similar: LaTeX is the img alt on math images
      document.querySelectorAll('img[alt]').forEach(function (img) {
        var alt = img.getAttribute('alt') || '';
        var cls = (img.className || '') + '';
        if (alt.length > 2 && /math|tex|equation/i.test(cls)) push('latex', alt);
      });
      return out;
    } catch (e) { return { latex: [], mathml: [], text: [], error: String(e) }; }
  }

  function grabImage() {
    var c = document.getElementById('preview-canvas');
    if (c && c.width) { try { return c.toDataURL('image/png'); } catch (e) {} }
    return null;
  }

  async function extractMath() {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || !tabs[0]) return null;
      var res = await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: ssExtractMathInject });
      if (res && res[0]) return res[0].result;
    } catch (e) {}
    return null;
  }

  async function openStudio() {
    var image = grabImage();
    var math = await extractMath();
    var payload = { ss_studio_ts: Date.now(), ss_studio_math: math || { latex: [], mathml: [], text: [] } };
    if (image) payload.ss_studio_image = image;
    chrome.storage.local.set(payload, function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
    });
  }

  var opened = false;

  function watchResult() {
    var result = document.getElementById('result-view');
    var progress = document.getElementById('progress-view');
    var main = document.getElementById('main-view');
    if (!result) return;
    var obs = new MutationObserver(function () {
      if (progress && progress.classList.contains('active')) opened = false; // new capture in progress
      if (main && main.classList.contains('active')) opened = false;
      if (result.classList.contains('active') && !opened) {
        opened = true;
        // Let popup.js finish drawing the preview canvas first.
        setTimeout(openStudio, 120);
      }
    });
    obs.observe(result, { attributes: true, attributeFilter: ['class'] });
    if (progress) obs.observe(progress, { attributes: true, attributeFilter: ['class'] });
    if (main) obs.observe(main, { attributes: true, attributeFilter: ['class'] });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var more = document.getElementById('more-btn');
    if (more) more.addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
    var studioBtn = document.getElementById('studio-btn');
    if (studioBtn) studioBtn.addEventListener('click', function (e) { e.preventDefault(); opened = true; openStudio(); });
    watchResult();
  });
})();
