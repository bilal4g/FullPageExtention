/* SnapScroll Pro - popup bridge.
 * 1) When a capture finishes (result view becomes active), automatically open
 *    the Studio in a new tab WITH the captured image loaded.
 * 2) Wires the popup's More/Studio buttons.
 * Runs in the popup after popup.js. Does NOT touch the capture engine. */
(function () {
  var opened = false;

  function grabDataUrl() {
    try {
      if (window.capturedCanvas && window.capturedCanvas.width) {
        return window.capturedCanvas.toDataURL('image/png');
      }
    } catch (e) {}
    var c = document.getElementById('preview-canvas');
    if (c && c.width) { try { return c.toDataURL('image/png'); } catch (e) {} }
    return null;
  }

  function openStudio(dataUrl) {
    var payload = { ss_studio_ts: Date.now() };
    if (dataUrl) payload.ss_studio_image = dataUrl;
    chrome.storage.local.set(payload, function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
      window.close();
    });
  }

  function openSettings() {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }

  // Auto-open Studio the moment the result view becomes active.
  var result = document.getElementById('result-view');
  if (result) {
    var obs = new MutationObserver(function () {
      var active = result.classList.contains('active');
      if (active && !opened) {
        var url = grabDataUrl();
        if (url) { opened = true; openStudio(url); }
      }
      if (!active) opened = false;
    });
    obs.observe(result, { attributes: true, attributeFilter: ['class'] });
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target : null;
    if (!t) return;
    if (t.closest('#studio-btn')) { e.preventDefault(); openStudio(grabDataUrl()); }
    else if (t.closest('#more-btn')) { e.preventDefault(); openSettings(); }
  });
})();
