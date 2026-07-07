/* FullPage Studio - background service worker.
 * Captures (visible or full-page stitched), extracts free DOM math metadata,
 * and hands everything to the Studio via chrome.storage. No external APIs. */

const runtimeState = { lastCapture: null, pendingRequestId: 0 };

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['studioSettings'], (d) => {
    if (!d.studioSettings) {
      chrome.storage.local.set({
        studioSettings: {
          theme: 'system',
          exportScale: 2,
          defaultFormat: 'png',
          copyBehavior: 'clipboard+download',
          onboardingSeen: false,
          aiMathMode: 'metadata+image',
          segmentation: 'auto'
        }
      });
    }
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  if (command === 'capture-visible') { await launchStudio({ mode: 'visible', tabId: tab.id }); openStudioTab(); }
  if (command === 'capture-full-page') { await launchStudio({ mode: 'full', tabId: tab.id }); openStudioTab(); }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  if (type === 'studio:capture') {
    launchStudio({ mode: message.mode || 'visible', tabId: message.tabId || (sender.tab && sender.tab.id) })
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (type === 'studio:get-last-capture') {
    if (runtimeState.lastCapture) { sendResponse({ ok: true, capture: runtimeState.lastCapture }); return; }
    chrome.storage.local.get(['ss_last_capture'], (d) => sendResponse({ ok: true, capture: d.ss_last_capture || null }));
    return true;
  }
  if (type === 'studio:update-settings') {
    chrome.storage.local.set({ studioSettings: message.settings || {} }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

function openStudioTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') });
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function sendTab(tabId, msg) { return chrome.tabs.sendMessage(tabId, msg).catch(() => null); }

async function launchStudio({ mode = 'visible', tabId }) {
  if (!tabId) throw new Error('No active tab available for capture.');
  const tab = await chrome.tabs.get(tabId);

  const metrics = await sendTab(tabId, { type: 'studio:collect-page-metadata', mode }) || {
    url: tab.url,
    title: tab.title,
    page: { scrollWidth: 0, scrollHeight: 0, viewportWidth: 0, viewportHeight: 0, devicePixelRatio: 1 },
    math: { equations: [], count: 0, summary: { displayCount: 0, inlineCount: 0, lowConfidence: [], recommendedWorkflow: 'single-image+metadata-export' } },
    selection: null, segments: [], landmarks: [], headings: [], tables: [], images: []
  };

  let dataUrl;
  if (mode === 'full' && metrics.page && metrics.page.scrollHeight > metrics.page.viewportHeight + 20) {
    try { dataUrl = await captureFullPage(tab, metrics.page); }
    catch (e) { dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }); }
  } else {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  }

  runtimeState.pendingRequestId += 1;
  runtimeState.lastCapture = {
    id: runtimeState.pendingRequestId,
    createdAt: new Date().toISOString(),
    mode,
    image: dataUrl,
    tab: { id: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl },
    metadata: metrics,
    aiAssist: buildAiAssist(metrics)
  };
  try { await chrome.storage.local.set({ ss_last_capture: runtimeState.lastCapture }); } catch (e) {}
  return runtimeState.lastCapture;
}

async function captureFullPage(tab, page) {
  const dpr = page.devicePixelRatio || 1;
  const viewH = page.viewportHeight || 800;
  const totalH = page.scrollHeight || viewH;
  await sendTab(tab.id, { type: 'studio:prepare-capture' });
  const shots = [];
  const step = Math.max(100, viewH - 40);
  let y = 0;
  let guard = 0;
  while (y < totalH && guard < 200) {
    guard += 1;
    const pos = await sendTab(tab.id, { type: 'studio:scroll-to', y });
    await delay(360); // stay under captureVisibleTab rate limit
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const realY = pos && typeof pos.y === 'number' ? pos.y : y;
    shots.push({ dataUrl: shot, y: realY });
    if (y > 0 && realY < y - 2) break; // hit the bottom
    y += step;
  }
  await sendTab(tab.id, { type: 'studio:restore' });

  const canvasW = Math.round((page.viewportWidth || 0) * dpr) || null;
  const canvasH = Math.round(totalH * dpr);
  let maxW = canvasW || 0;
  const bitmaps = [];
  for (const s of shots) {
    const bmp = await createImageBitmap(await (await fetch(s.dataUrl)).blob());
    if (bmp.width > maxW) maxW = bmp.width;
    bitmaps.push({ bmp, y: s.y });
  }
  const oc = new OffscreenCanvas(maxW || 1200, canvasH || 1600);
  const ctx = oc.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, oc.width, oc.height);
  ctx.imageSmoothingEnabled = false;
  for (const b of bitmaps) {
    ctx.drawImage(b.bmp, 0, Math.round(b.y * dpr));
    if (b.bmp.close) b.bmp.close();
  }
  const blob = await oc.convertToBlob({ type: 'image/png' });
  return blobToDataURL(blob);
}

async function blobToDataURL(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return 'data:image/png;base64,' + btoa(binary);
}

function buildAiAssist(metrics) {
  const summary = (metrics && metrics.math && metrics.math.summary) || {};
  return {
    recommendedPrompt: [
      'The equations below were extracted directly from the page HTML (MathML / LaTeX), so treat them as the accurate source of the math shown in the image.',
      summary.lowConfidence && summary.lowConfidence.length
        ? `Lower-confidence equations to double-check: ${summary.lowConfidence.join(', ')}.`
        : 'Equation confidence is high for the detected math markup.',
      `Recommended workflow: ${summary.recommendedWorkflow || 'single-image+metadata-export'}.`
    ].join(' '),
    segmentationHint: metrics && metrics.segments && metrics.segments.length > 1
      ? `This page is long; process ${metrics.segments.length} image segments in order.`
      : 'Single image processing is sufficient.'
  };
}
