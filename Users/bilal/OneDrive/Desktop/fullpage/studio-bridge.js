/* SnapScroll Pro - Studio bridge (runs in popup, after popup.js).
 * Hands the captured screenshot off to the Studio editor without touching
 * the capture engine. Reads the full-res result from the popup and opens
 * studio.html in a new tab. */
(function () {
  function grabDataUrl() {
    // Prefer a full-resolution canvas if popup.js exposes one on window.
    try {
      if (window.capturedCanvas && window.capturedCanvas.width) {
        return window.capturedCanvas.toDataURL('image/png');
      }
    } catch (e) {}
    // Fall back to the on-screen preview canvas (backing store is full-res).
    var c = document.getElementById('preview-canvas');
    if (c && c.width) {
      try { return c.toDataURL('image/png'); } catch (e) {}
    }
    return null;
  }

  function openStudio(dataUrl) {
    var payload = { ss_studio_ts: Date.now() };
    if (dataUrl) payload.ss_studio_image = dataUrl;
    chrome.storage.local.set(payload, function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
    });
  }

  // Event delegation so it works even though the button starts in a hidden view.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('#studio-btn') : null;
    if (!btn) return;
    e.preventDefault();
    openStudio(grabDataUrl());
  });
})();
