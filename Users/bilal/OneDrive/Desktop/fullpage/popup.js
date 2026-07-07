/* FullPage Studio - simple popup. Drives capture via the background worker,
 * then opens the Studio (full browser tab) with the capture loaded. */
(function () {
  const $ = (id) => document.getElementById(id);
  const status = $('status');

  function setStatus(msg) { status.textContent = msg; }
  function disableAll(v) { document.querySelectorAll('button').forEach((b) => (b.disabled = v)); }

  async function activeTabId() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab && tab.id;
  }

  function openStudio() { chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') }); }

  async function capture(mode) {
    const tabId = await activeTabId();
    if (!tabId) { setStatus('No active tab to capture.'); return; }
    disableAll(true);
    setStatus(mode === 'full' ? 'Capturing full page\u2026 (stitching, hang tight)' : 'Capturing\u2026');
    chrome.runtime.sendMessage({ type: 'studio:capture', mode, tabId }, (res) => {
      disableAll(false);
      if (res && res.ok) { openStudio(); window.close(); }
      else { setStatus('Capture failed: ' + ((res && res.error) || 'unknown error') + '. Try reloading the page.'); }
    });
  }

  $('cap-full').addEventListener('click', () => capture('full'));
  $('cap-visible').addEventListener('click', () => capture('visible'));
  $('open-studio').addEventListener('click', openStudio);
  $('open-settings').addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
  });
})();
