/* FullPage Studio - background service worker.
 * Captures (visible or full-page frames) and persists the result to
 * chrome.storage.local so the Studio tab can load + stitch it.
 * No external APIs, no keys. */

const CAP_KEY = 'fp_last_capture';
const SETTINGS_KEY = 'fp_settings';
const DEFAULT_SETTINGS = { theme: 'dark', defaultFormat: 'png', exportScale: 2, autoExtractMath: true };

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(SETTINGS_KEY, (d) => {
    if (!d[SETTINGS_KEY]) chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  const mode = command === 'capture-full-page' ? 'full' : 'visible';
  try {
    await runCapture({ mode, tabId: tab.id });
    chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
  } catch (e) { /* ignore */ }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'studio:capture') {
    runCapture({ mode: message.mode || 'visible', tabId: message.tabId || (sender.tab && sender.tab.id) })
      .then((payload) => sendResponse({ ok: true, id: payload.id }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function send(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => { void chrome.runtime.lastError; resolve(res); });
  });
}
async function ensureContentScript(tabId) {
  const ping = await send(tabId, { type: 'fp:ping' });
  if (ping && ping.ok) return;
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); await wait(150); } catch (e) {}
}

async function runCapture({ mode, tabId }) {
  if (!tabId) throw new Error('No active tab available for capture.');
  const tab = await chrome.tabs.get(tabId);
  await ensureContentScript(tabId);

  const metadata = (await send(tabId, { type: 'fp:metadata', mode })) || null;
  const info = (await send(tabId, { type: 'fp:getScrollInfo' })) || { viewportHeight: 0, totalHeight: 0, devicePixelRatio: 1 };

  let frames = [];
  if (mode === 'full' && info.totalHeight > info.viewportHeight + 4) {
    await send(tabId, { type: 'fp:prepare' });
    const step = Math.max(100, info.viewportHeight - 40);
    const maxFrames = 60;
    let y = 0, n = 0;
    while (y < info.totalHeight && n < maxFrames) {
      await send(tabId, { type: 'fp:scrollTo', y });
      await wait(380); // let lazy content settle + respect capture rate limit
      const dataUrl = await captureVisible(tab.windowId);
      frames.push({ dataUrl, scrollY: y });
      if (y + info.viewportHeight >= info.totalHeight) break;
      y += step; n += 1;
    }
    await send(tabId, { type: 'fp:restore' });
  } else {
    const dataUrl = await captureVisible(tab.windowId);
    frames.push({ dataUrl, scrollY: 0 });
  }

  const capture = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    mode,
    frames,
    page: info,
    tab: { id: tab.id, title: tab.title, url: tab.url },
    metadata
  };
  await chrome.storage.local.set({ [CAP_KEY]: capture });
  return capture;
}

function captureVisible(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(dataUrl);
    });
  });
}
