/* FullPage Studio - background service worker.
 * Captures (visible or full-page frames) and persists the result to
 * chrome.storage.local. The popup renders the result inline; the Studio is
 * opened only when the user chooses to. No external APIs, no keys. */

const CAP_KEY = 'fp_last_capture';
const SETTINGS_KEY = 'fp_settings';
const DEFAULT_SETTINGS = {
  theme: 'dark',
  defaultFormat: 'png',
  exportScale: 'max',
  autoExtractMath: true,
  ocrEngine: 'gemini',
  geminiApiKey: '',
  sliceHeight: 1500,
  sliceEnabled: false
};

if (chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(SETTINGS_KEY, (d) => {
      if (!d[SETTINGS_KEY]) chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    });
  });
}

// Keyboard shortcuts capture and store the result; the user opens the toolbar
// popup to see it. Guarded because chrome.commands may be undefined at boot.
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    const mode = command === 'capture-full-page' ? 'full' : 'visible';
    try { await runCapture({ mode, tabId: tab.id }); } catch (e) { /* ignore */ }
  });
}

if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'studio:capture') {
      runCapture({ mode: message.mode || 'visible', tabId: message.tabId || (sender.tab && sender.tab.id) })
        .then((payload) => sendResponse({ ok: true, id: payload.id }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    return false;
  });
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function send(tabId, msg) { return new Promise((resolve) => { chrome.tabs.sendMessage(tabId, msg, (res) => { void chrome.runtime.lastError; resolve(res); }); }); }
async function ensureContentScript(tabId) {
  const ping = await send(tabId, { type: 'fp:ping' });
  if (ping && ping.ok) return;
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); await wait(150); } catch (e) {}
}

async function runCapture({ mode, tabId }) {
  if (!tabId) throw new Error('No active tab available for capture.');
  const tab = await chrome.tabs.get(tabId);
  await ensureContentScript(tabId);

  const notify = (status) => {
    try {
      chrome.runtime.sendMessage({ type: 'studio:capture_progress', status }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  };

  const metadata = (await send(tabId, { type: 'fp:metadata', mode })) || null;
  const info = (await send(tabId, { type: 'fp:getScrollInfo' })) || { viewportHeight: 0, totalHeight: 0, devicePixelRatio: 1 };

  let frames = [];
  if (mode === 'full' && info.totalHeight > info.viewportHeight + 20) {
    notify('Starting capture...');
    const origY = (await send(tabId, { type: 'fp:getScrollY' })) || 0;
    await send(tabId, { type: 'fp:prepare' });

    const step = Math.max(120, info.viewportHeight - 60); // 60px overlap for seamless stitching
    const maxFrames = 80;
    let y = 0, n = 0;
    let lastY = -1;

    while (y < info.totalHeight && n < maxFrames) {
      const scrollRes = await send(tabId, { type: 'fp:scrollTo', y });
      // 520ms perfectly respects Chromium's MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota (2 calls/sec)
      await wait(520);

      const dataUrl = await captureVisible(tab.windowId);
      const actualY = (scrollRes && scrollRes.y !== undefined) ? scrollRes.y : y;
      frames.push({ dataUrl, scrollY: actualY });

      // After first frame, hide slim fixed headers so they don't repeat
      if (n === 0) {
        await send(tabId, { type: 'fp:hideFixed' });
      }

      // Dynamic height update if content loaded on scroll (e.g. Canvas quiz questions)
      const latestInfo = await send(tabId, { type: 'fp:getScrollInfo' });
      if (latestInfo && latestInfo.totalHeight > info.totalHeight) {
        info.totalHeight = latestInfo.totalHeight;
      }

      const estTotal = Math.max(1, Math.ceil(info.totalHeight / step));
      notify(`Section ${frames.length} of ~${estTotal}...`);

      if (y > 0 && actualY <= lastY) {
        break; // Reached bottom
      }
      lastY = actualY;

      if (actualY + info.viewportHeight >= info.totalHeight) {
        break;
      }

      y = actualY + step;
      n += 1;
    }

    // Restore to original scroll position (NO double backup scrolling!)
    await send(tabId, { type: 'fp:restore', origY });
  } else {
    const dataUrl = await captureVisible(tab.windowId);
    frames.push({ dataUrl, scrollY: 0 });
  }

  const capture = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    mode, frames, page: info,
    tab: { id: tab.id, title: tab.title, url: tab.url },
    metadata
  };
  await chrome.storage.local.set({ [CAP_KEY]: capture });
  return capture;
}

function captureVisible(windowId) {
  return new Promise((resolve, reject) => {
    function attempt(retries) {
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          const err = chrome.runtime.lastError.message || '';
          if (err.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND') && retries > 0) {
            setTimeout(() => attempt(retries - 1), 600);
          } else {
            reject(new Error(err));
          }
        } else {
          resolve(dataUrl);
        }
      });
    }
    attempt(3);
  });
}
