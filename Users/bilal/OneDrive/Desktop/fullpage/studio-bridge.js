/* SnapScroll Pro - Studio bridge (runs in the popup, after popup.js).
 * 1) Auto-opens the Studio in a browser tab with the capture the moment a
 *    shot finishes (the popup stays simple).
 * 2) Extracts real math/text from the page DOM at capture time - no API key,
 *    no cost, scales to unlimited users. */
(function () {
  var opened = false;

  // Injected into the captured page (all frames). Must be self-contained.
  function ssExtractMath() {
    try {
      var latex = [];
      var seen = {};
      function add(t) {
        if (!t) return;
        t = ('' + t).trim();
        if (!t || t.length > 4000 || seen[t]) return;
        seen[t] = 1; latex.push(t);
      }
      // KaTeX + MathJax TeX annotations (original LaTeX kept in the DOM)
      document.querySelectorAll('annotation[encoding="application/x-tex"]').forEach(function (a) { add(a.textContent); });
      // MathJax v2 script tags
      document.querySelectorAll('script[type^="math/tex"]').forEach(function (s) { add(s.textContent); });
      // Renderers that stash LaTeX in an attribute
      document.querySelectorAll('[data-latex]').forEach(function (el) { add(el.getAttribute('data-latex')); });
      // MathJax v3 accessible label
      document.querySelectorAll('mjx-container').forEach(function (c) { var l = c.getAttribute('aria-label'); if (l) add(l); });
      // Raw MathML blocks
      var mathml = [];
      document.querySelectorAll('math').forEach(function (m) { if (mathml.length < 300) mathml.push(m.outerHTML); });
      // Images that encode LaTeX (Wikipedia alt text, CodeCogs/QuickLaTeX src)
      document.querySelectorAll('img').forEach(function (img) {
        var alt = img.getAttribute('alt') || '';
        if (/\\(frac|sqrt|sum|int|alpha|beta|theta|cdot|times|left|right|begin)|[\^_]\{|\$\$?/.test(alt)) add(alt);
        var src = img.getAttribute('src') || '';
        try { var m = src.match(/(?:latex|tex)\?(?:[^=&]*=)?([^&]+)/i); if (m) add(decodeURIComponent(m[1].replace(/\+/g, ' '))); } catch (e) {}
      });
      // Readable page text for context
      var text = '';
      try {
        var main = document.querySelector('main, article, #content, .content, #mw-content-text') || document.body;
        text = (main.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
        if (text.length > 200000) text = text.slice(0, 200000);
      } catch (e) {}
      return { latex: latex, mathml: mathml, text: text, url: location.href, title: document.title || '' };
    } catch (e) { return { latex: [], mathml: [], text: '', error: String(e) }; }
  }

  function getActiveTab() {
    return new Promise(function (res) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) { res(tabs && tabs[0]); });
    });
  }

  async function extractMath() {
    try {
      var tab = await getActiveTab();
      if (!tab || !tab.id) return null;
      var results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: ssExtractMath });
      var latex = [], mathml = [], text = '', seen = {};
      (results || []).forEach(function (r) {
        var v = r && r.result; if (!v) return;
        (v.latex || []).forEach(function (t) { if (t && !seen[t]) { seen[t] = 1; latex.push(t); } });
        (v.mathml || []).forEach(function (m) { mathml.push(m); });
        if (v.text && v.text.length > text.length) text = v.text;
      });
      return { latex: latex, mathml: mathml, text: text, url: (tab.url || ''), title: (tab.title || '') };
    } catch (e) { return null; }
  }

  function grabDataUrl() {
    try { if (window.capturedCanvas && window.capturedCanvas.width) return window.capturedCanvas.toDataURL('image/png'); } catch (e) {}
    var c = document.getElementById('preview-canvas');
    if (c && c.width) { try { return c.toDataURL('image/png'); } catch (e) {} }
    return null;
  }

  async function openStudio(withCapture) {
    var payload = { ss_studio_ts: Date.now(), ss_studio_image: null, ss_studio_math: null };
    if (withCapture) {
      var d = grabDataUrl(); if (d) payload.ss_studio_image = d;
      var m = await extractMath(); if (m) payload.ss_studio_math = m;
    }
    chrome.storage.local.set(payload, function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
    });
  }

  // Manual buttons
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('#studio-btn, #open-editor-footer') : null;
    if (!t) return;
    e.preventDefault();
    openStudio(t.id === 'studio-btn');
  });

  // Auto-open Studio as soon as the capture result is shown
  var resultView = document.getElementById('result-view');
  var progressView = document.getElementById('progress-view');
  if (resultView) {
    new MutationObserver(function () {
      if (resultView.classList.contains('active') && !opened) {
        opened = true;
        setTimeout(function () { openStudio(true); }, 150);
      }
    }).observe(resultView, { attributes: true, attributeFilter: ['class'] });
  }
  if (progressView) {
    new MutationObserver(function () {
      if (progressView.classList.contains('active')) opened = false; // reset for the next capture
    }).observe(progressView, { attributes: true, attributeFilter: ['class'] });
  }
})();
