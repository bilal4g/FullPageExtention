/* SnapScroll Pro - Background Service Worker */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'captureTab') {
    chrome.tabs.captureVisibleTab(message.windowId || null, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) sendResponse({ error: chrome.runtime.lastError.message });
      else sendResponse({ dataUrl });
    });
    return true;
  }
  if (message.action === 'getStreamId') {
    chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId }, (streamId) => {
      if (chrome.runtime.lastError) sendResponse({ error: chrome.runtime.lastError.message });
      else sendResponse({ streamId });
    });
    return true;
  }
});
