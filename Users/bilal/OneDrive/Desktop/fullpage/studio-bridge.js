/* SnapScroll Pro - Studio bridge (runs in the popup, after popup.js).
 * When a capture finishes it: (1) grabs the full-res image, (2) asks the page
 * content script for the extracted math/text metadata (free, no API), then
 * stores both and auto-opens the Studio in a full browser tab.
 * Also wires the settings gear to the full options page. */
(function () {
  function getFullResImage() {
    // popup.js declares `capturedCanvas` at top level (shared global lexical scope).
    try { if (typeof capturedCanvas !== 'undefined' && capturedCanvas && capturedCanvas.width) return capturedCanvas.toDataURL('image/png'); } catch (e) {}
    var c = document.getElementById('preview-canvas');
    if (c && c.width) { try { return c.toDataURL('image/png'); } catch (e) {} }
    return null;
  }

  function collectMeta(cb) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var tab = tabs && tabs[0];
        if (!tab) { cb(null); return; }
        chrome.tabs.sendMessage(tab.id, { type: 'studio:collect-page-metadata', mode: 'full' }, function (resp) {
          if (chrome.runtime.lastError) { cb(null); return; }
          cb(resp || null);
        });
      });
    } catch (e) { cb(null); }
  }

  var launched = false;
  function launch() {
    if (launched) return;
    var img = getFullResImage();
    if (!img) return;
    launched = true;
    collectMeta(function (meta) {
      var payload = { ss_studio_image: img, ss_studio_ts: Date.now() };
      if (meta) payload.ss_studio_meta = meta;
      chrome.storage.local.set(payload, function () {
        chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
      });
    });
  }

  var result = document.getElementById('result-view');
  if (result) {
    var obs = new MutationObserver(function () { if (result.classList.contains('active')) launch(); });
    obs.observe(result, { attributes: true, attributeFilter: ['class'] });
    if (result.classList.contains('active')) launch();
  }

  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    if (e.target.closest('#studio-btn')) { e.preventDefault(); launched = false; launch(); }
    if (e.target.closest('#btn-settings')) { e.preventDefault(); if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage(); else chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') }); }
  });
})();
