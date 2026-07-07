const runtimeState = {
  lastCapture: null,
  pendingRequestId: 0
};

chrome.runtime.onInstalled.addListener(() => {
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
});

chrome.action.onClicked.addListener(async (tab) => {
  await launchStudio({ mode: 'visible', tabId: tab.id });
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === 'capture-visible') {
    await launchStudio({ mode: 'visible', tabId: tab.id });
  }
  if (command === 'capture-full-page') {
    await launchStudio({ mode: 'full', tabId: tab.id });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'studio:capture') {
    launchStudio({ mode: message.mode || 'visible', tabId: sender.tab?.id || message.tabId })
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'studio:get-last-capture') {
    sendResponse({ ok: true, capture: runtimeState.lastCapture });
  }

  if (message?.type === 'studio:update-settings') {
    chrome.storage.local.set({ studioSettings: message.settings || {} }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
});

async function launchStudio({ mode = 'visible', tabId }) {
  if (!tabId) throw new Error('No active tab available for capture.');
  const tab = await chrome.tabs.get(tabId);
  const metrics = await chrome.tabs.sendMessage(tabId, {
    type: 'studio:collect-page-metadata',
    mode
  }).catch(() => ({
    url: tab.url,
    title: tab.title,
    page: {
      scrollWidth: 0,
      scrollHeight: 0,
      viewportWidth: 0,
      viewportHeight: 0,
      devicePixelRatio: 1
    },
    math: { equations: [], count: 0, summary: { displayCount: 0, inlineCount: 0, lowConfidence: [], recommendedWorkflow: 'single-image+metadata-export' } },
    selection: null,
    segments: [],
    landmarks: [],
    headings: [],
    tables: [],
    images: []
  }));

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  runtimeState.pendingRequestId += 1;
  runtimeState.lastCapture = {
    id: runtimeState.pendingRequestId,
    createdAt: new Date().toISOString(),
    mode,
    image: dataUrl,
    tab: {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl
    },
    metadata: metrics,
    aiAssist: buildAiAssist(metrics)
  };

  return runtimeState.lastCapture;
}

function buildAiAssist(metrics) {
  const summary = metrics?.math?.summary || {};
  return {
    recommendedPrompt: [
      'Use the structured metadata alongside the screenshot.',
      summary.lowConfidence?.length
        ? `Pay extra attention to low-confidence equations: ${summary.lowConfidence.join(', ')}.`
        : 'Equation confidence is high for the detected math markup.',
      `Recommended workflow: ${summary.recommendedWorkflow || 'single-image+metadata-export'}.`
    ].join(' '),
    segmentationHint: metrics?.segments?.length > 1
      ? `This page is long; process ${metrics.segments.length} image segments in order.`
      : 'Single image processing is sufficient.'
  };
}
