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

// Direct page height query - doesn't need content.js messaging
async function getPageHeightDirect(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const de = document.documentElement;
        const b = document.body;
        let h = Math.max(
          de.scrollHeight || 0, de.offsetHeight || 0,
          b ? b.scrollHeight : 0, b ? b.offsetHeight : 0
        );
        // Also check inner elements for SPA/Canvas-style containers
        const all = document.querySelectorAll('div, main, section, article');
        for (let i = 0; i < all.length; i++) {
          if (all[i].scrollHeight > h && all[i].clientWidth >= 200) {
            h = all[i].scrollHeight;
          }
        }
        return {
          totalHeight: h,
          viewportHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1
        };
      }
    });
    if (results && results[0] && results[0].result) return results[0].result;
  } catch (e) {}
  return null;
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
  let info = (await send(tabId, { type: 'fp:getScrollInfo' })) || null;

  // FALLBACK: If content.js didn't respond, get dimensions directly
  if (!info || !info.totalHeight) {
    info = await getPageHeightDirect(tabId);
  }
  if (!info) info = { viewportHeight: 0, totalHeight: 0, devicePixelRatio: 1 };

  let frames = [];
  if (mode === 'full' && info.totalHeight > info.viewportHeight + 20) {
    notify('Starting capture...');

    // Save original scroll position directly
    let origY = 0;
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.scrollY || document.documentElement.scrollTop || 0
      });
      if (r && r[0]) origY = r[0].result || 0;
    } catch (e) {}

    await send(tabId, { type: 'fp:prepare' });

    const step = Math.max(120, info.viewportHeight - 60);
    const maxFrames = 80;
    let y = 0, n = 0;
    let lastActualY = -1;
    let stuckCount = 0;

    while (y < info.totalHeight && n < maxFrames) {
      // Scroll via content.js OR direct executeScript
      let actualY = y;
      const scrollRes = await send(tabId, { type: 'fp:scrollTo', y });
      if (scrollRes && scrollRes.y !== undefined) {
        actualY = scrollRes.y;
      } else {
        // Direct fallback scroll
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            func: (targetY) => {
              window.scrollTo(0, targetY);
              document.documentElement.scrollTop = targetY;
              if (document.body) document.body.scrollTop = targetY;
              return window.scrollY || document.documentElement.scrollTop || 0;
            },
            args: [y]
          });
          if (r && r[0]) actualY = r[0].result || 0;
        } catch (e) {}
      }

      // 520ms respects Chromium's MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota
      await wait(520);

      const dataUrl = await captureVisible(tab.windowId);
      frames.push({ dataUrl, scrollY: actualY });

      // After first frame, hide fixed headers
      if (n === 0) {
        await send(tabId, { type: 'fp:hideFixed' });
      }

      // Dynamic height update (for lazy-loaded content)
      const latestInfo = (await send(tabId, { type: 'fp:getScrollInfo' })) || (await getPageHeightDirect(tabId));
      if (latestInfo && latestInfo.totalHeight > info.totalHeight) {
        info.totalHeight = latestInfo.totalHeight;
      }

      const estTotal = Math.max(1, Math.ceil(info.totalHeight / step));
      notify(`Section ${frames.length} of ~${estTotal}...`);

      // Bottom detection: if scroll position didn't change, we're stuck
      if (actualY <= lastActualY && n > 0) {
        stuckCount++;
        if (stuckCount >= 2) break;
      } else {
        stuckCount = 0;
      }
      lastActualY = actualY;

      // Check if we've reached the bottom
      if (actualY + info.viewportHeight >= info.totalHeight - 5) {
        break;
      }

      y = actualY + step;
      n += 1;
    }

    // Restore original scroll position
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
