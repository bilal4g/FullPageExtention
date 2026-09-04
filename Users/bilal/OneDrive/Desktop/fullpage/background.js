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

  const metadata = (await send(tabId, { type: 'fp:metadata', mode })) || null;
  let frames = [];
  let info = {};

  if (mode === 'full') {
    try {
      const res = await cdpCapture(tab.id);
      frames = res.captures;
      info = {
        totalHeight: res.totalHeight || res.totalScrollHeight || res.viewportHeight,
        totalWidth: res.totalWidth || res.viewportWidth,
        viewportHeight: res.viewportHeight,
        viewportWidth: res.viewportWidth,
        devicePixelRatio: res.devicePixelRatio,
        captureMode: res.mode, // 'element' or 'fullpage'
        elementRect: res.elementRect,
        elementClientHeight: res.elementClientHeight
      };
    } catch (err) {
      console.error('CDP failed, falling back to basic capture:', err);
      const dataUrl = await captureVisible(tab.windowId);
      frames.push({ dataUrl, scrollY: 0 });
      info = { viewportHeight: 0, totalHeight: 0, devicePixelRatio: 1 };
    }
  } else {
    const dataUrl = await captureVisible(tab.windowId);
    frames.push({ dataUrl, scrollY: 0 });
    info = (await send(tabId, { type: 'fp:getScrollInfo' })) || { viewportHeight: 0, totalHeight: 0, devicePixelRatio: 1 };
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
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(dataUrl);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// CHROME DEBUGGER (CDP) CAPTURE SYSTEM
// ═══════════════════════════════════════════════════════════════

function cdpCmd(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

function cdpAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        if (chrome.runtime.lastError.message.includes('already attached')) {
          resolve();
        } else {
          reject(new Error(chrome.runtime.lastError.message));
        }
      } else {
        resolve();
      }
    });
  });
}

function cdpDetach(tabId) {
  return new Promise((resolve) => { chrome.debugger.detach({ tabId }, () => resolve()); });
}

async function cdpEval(tabId, expr) {
  const res = await cdpCmd(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  if (res.exceptionDetails) throw new Error('JS error: ' + JSON.stringify(res.exceptionDetails));
  return res.result.value;
}

// JS Snippets for capture styling and scroll target detection
const prepareCaptureJS = `(function() {
  if (window.__ss_prepared) return;
  window.__ss_prepared = true;
  window.__ss_restorers = [];
  
  var vh = window.innerHeight;
  var vw = window.innerWidth;
  
  // Only target slim fixed headers/banners (height <= 140px, top <= 10 or bottom >= vh - 10)
  // NEVER sidebars, NEVER main content wrappers, NEVER sticky elements (to avoid breaking layout)
  var candidates = document.querySelectorAll('header, [class*="header"], [class*="banner"], [class*="bar"], [style*="fixed"]');
  var seen = new Set();
  
  for (var i = 0; i < candidates.length; i++) {
    var el = candidates[i];
    if (!el || seen.has(el) || el === document.documentElement || el === document.body) continue;
    seen.add(el);
    try {
      var style = window.getComputedStyle(el);
      if (style.position === 'fixed') {
        var r = el.getBoundingClientRect();
        if (r.height > 0 && r.height <= 140 && (r.top <= 10 || r.bottom >= vh - 10)) {
          // Verify it does not contain main exam/page content
          if (!el.querySelector('main, article, form, [class*="content"], [class*="question"]')) {
            window.__ss_restorers.push({
              el: el,
              origVisibility: el.style.visibility
            });
          }
        }
      }
    } catch(e) {}
  }
})()`;

const hideFixedJS = `(function() {
  if (!window.__ss_restorers) return;
  for (var i = 0; i < window.__ss_restorers.length; i++) {
    try {
      window.__ss_restorers[i].el.style.visibility = 'hidden';
    } catch(e) {}
  }
})()`;

const restoreAllJS = `(function() {
  if (!window.__ss_prepared) return;
  window.__ss_prepared = false;
  if (window.__ss_restorers) {
    for (var i = 0; i < window.__ss_restorers.length; i++) {
      try {
        window.__ss_restorers[i].el.style.visibility = window.__ss_restorers[i].origVisibility;
      } catch(e) {}
    }
    window.__ss_restorers = [];
  }
})()`;

const findScrollableJS = `(function(){
  var vw = window.innerWidth, vh = window.innerHeight;

  // 1. Calculate standard document scroll metrics
  var docH = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
    document.documentElement.offsetHeight,
    document.body ? document.body.offsetHeight : 0
  );

  var origDocY = window.scrollY || (document.scrollingElement ? document.scrollingElement.scrollTop : 0) || document.documentElement.scrollTop || (document.body ? document.body.scrollTop : 0) || 0;

  // 2. Scan ALL DOM elements to find maximum content height (e.g. Canvas quiz questions, feeds, SPAs)
  var all = document.querySelectorAll('*');
  var maxContentH = docH;
  var maxContentEl = null;

  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el === document.documentElement || el === document.body) continue;
    if (el.clientWidth < vw * 0.25 || el.clientHeight < 100) continue;
    if (el.scrollHeight > maxContentH + 50) {
      maxContentH = el.scrollHeight;
      maxContentEl = el;
    }
  }

  // 3. Find candidate scroll container
  var bestEl = null;
  if (maxContentEl && maxContentH > docH + 50) {
    // Trace up from maxContentEl to find the scrollable container or use maxContentEl directly
    var cur = maxContentEl;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      var cs = window.getComputedStyle(cur);
      var oy = cs.overflowY, o = cs.overflow;
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay' || o === 'auto' || o === 'scroll' || o === 'overlay' || cur.scrollHeight > cur.clientHeight + 50) {
        bestEl = cur;
        break;
      }
      cur = cur.parentElement;
    }
    if (!bestEl) bestEl = maxContentEl;
  } else {
    // Check for standard inner scrollables with overflow
    var maxDiff = 60;
    for (var j = 0; j < all.length; j++) {
      var e = all[j];
      if (e === document.documentElement || e === document.body) continue;
      if (e.clientHeight < 150 || e.clientWidth < 200) continue;
      if (e.scrollHeight <= e.clientHeight + maxDiff) continue;
      try {
        var style = window.getComputedStyle(e);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        var yFlow = style.overflowY, allFlow = style.overflow;
        if (yFlow === 'auto' || yFlow === 'scroll' || yFlow === 'overlay' || allFlow === 'auto' || allFlow === 'scroll' || allFlow === 'overlay') {
          var diff = e.scrollHeight - e.clientHeight;
          if (diff > maxDiff) {
            bestEl = e;
            maxDiff = diff;
            maxContentH = Math.max(maxContentH, e.scrollHeight);
          }
        }
      } catch(err) {}
    }
  }

  if (bestEl) {
    window.__ss_el = bestEl;
    window.__ss_origScroll = bestEl.scrollTop;
    return JSON.stringify({
      found: true,
      hasInner: true,
      docScroll: true,
      scrollHeight: maxContentH,
      clientHeight: vh,
      vw: vw, vh: vh, dpr: window.devicePixelRatio
    });
  }

  window.__ss_origScroll = origDocY;
  return JSON.stringify({
    found: true,
    hasInner: false,
    docScroll: true,
    scrollHeight: docH,
    clientHeight: vh,
    vw: vw, vh: vh, dpr: window.devicePixelRatio
  });
})()`;

const injectHideAndMonitor = `(function(){
  if(!document.getElementById('__ss_hide')){
     var s=document.createElement('style'); s.id='__ss_hide';
     s.textContent = '*::-webkit-scrollbar{display:none!important}*{scrollbar-width:none!important;scroll-behavior:auto!important}';
     document.head.appendChild(s);
  }
  window.__ss_lastPing = Date.now();
  if(!window.__ss_interval){
     window.__ss_interval = setInterval(function(){
        if(Date.now() - window.__ss_lastPing > 3000) {
           clearInterval(window.__ss_interval);
           window.__ss_interval = null;
           var e = document.getElementById('__ss_hide'); if(e) e.remove();
           if(window.__ss_el && window.__ss_origScroll !== undefined) window.__ss_el.scrollTop = window.__ss_origScroll;
           else if(window.__ss_origScroll !== undefined) window.scrollTo(0, window.__ss_origScroll);
           
           if (window.__ss_prepared && window.__ss_restorers) {
             for (var i = 0; i < window.__ss_restorers.length; i++) {
               try {
                 window.__ss_restorers[i].el.style.visibility = window.__ss_restorers[i].origVisibility;
               } catch(e) {}
             }
             window.__ss_restorers = [];
             window.__ss_prepared = false;
           }
        }
     }, 1000);
  }
})()`;

async function cdpCapture(tabId) {
  const notify = (status) => {
    try {
      chrome.runtime.sendMessage({ type: 'studio:capture_progress', status }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  };

  notify('Attaching debugger...');
  await cdpAttach(tabId);
  try {
    notify('Analyzing page structure...');
    var frameTree;
    try { frameTree = await cdpCmd(tabId, 'Page.getFrameTree'); } catch(e) { frameTree = null; }

    await cdpCmd(tabId, 'Runtime.enable');
    
    var mainCtx = await cdpCmd(tabId, 'Runtime.evaluate', {
      expression: `JSON.stringify({
        url: location.href,
        scrollH: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
        clientH: window.innerHeight,
        vw: window.innerWidth,
        vh: window.innerHeight,
        dpr: window.devicePixelRatio
      })`,
      returnByValue: true
    });
    var mainInfo = JSON.parse(mainCtx.result.value);

    var bestTarget = null;
    try {
      var mainResStr = await cdpCmd(tabId, 'Runtime.evaluate', { expression: findScrollableJS, returnByValue: true });
      if(mainResStr.result && mainResStr.result.value) {
         var mainRes = JSON.parse(mainResStr.result.value);
         if(mainRes.found) {
            bestTarget = mainRes;
            bestTarget.contextId = null;
            bestTarget.isIframe = false;
         }
      }
    } catch(e) {}

    var useIframe = false;
    var iframeContextId = null;

    // RECURSIVELY check ALL child frames to see if an iframe has more scrollable content (e.g. Canvas LMS, SpeedGrader, LTI quizzes)
    async function inspectFrames(frames) {
      if (!frames || !frames.length) return;
      for (var cf of frames) {
        try {
          var world = await cdpCmd(tabId, 'Page.createIsolatedWorld', { frameId: cf.frame.id, worldName: 'snapscroll' });
          var ctxId = world.executionContextId;
          var iframeResStr = await cdpCmd(tabId, 'Runtime.evaluate', { expression: findScrollableJS, contextId: ctxId, returnByValue: true });
          if (iframeResStr.result && iframeResStr.result.value) {
            var parsed = JSON.parse(iframeResStr.result.value);
            if (parsed.found && (!bestTarget || parsed.scrollHeight > bestTarget.scrollHeight)) {
              bestTarget = parsed;
              bestTarget.contextId = ctxId;
              bestTarget.isIframe = true;
              bestTarget.frameId = cf.frame.id;
            }
          }
        } catch(e) {}
        if (cf.childFrames && cf.childFrames.length) {
          await inspectFrames(cf.childFrames);
        }
      }
    }

    if (frameTree && frameTree.frameTree && frameTree.frameTree.childFrames) {
      await inspectFrames(frameTree.frameTree.childFrames);
    }

    var elInfo = bestTarget || {
      found: true,
      docScroll: true,
      scrollHeight: mainInfo.scrollH,
      clientHeight: mainInfo.vh,
      vw: mainInfo.vw,
      vh: mainInfo.vh,
      dpr: mainInfo.dpr
    };

    if (elInfo.isIframe) {
        useIframe = true;
        iframeContextId = elInfo.contextId;
    }

    async function evalInFrame(js) {
      if (useIframe && iframeContextId) {
        var r = await cdpCmd(tabId, 'Runtime.evaluate', {
          expression: js, contextId: iframeContextId, returnByValue: true
        });
        if (r.exceptionDetails) throw new Error('iframe JS error');
        return r.result.value;
      }
      return await cdpEval(tabId, js);
    }

    await cdpEval(tabId, injectHideAndMonitor);
    if (useIframe) {
      await evalInFrame(injectHideAndMonitor);
    }

    var pingInterval = setInterval(async () => {
       try {
         await cdpEval(tabId, `window.__ss_lastPing = Date.now();`);
         if(useIframe) await evalInFrame(`window.__ss_lastPing = Date.now();`);
       } catch(e){}
    }, 500);

    var captures = [];

    if (elInfo.found) {
      var si = elInfo;
      
      notify('Starting scroll capture...');
      await wait(100);

      // Save user's original scroll position to restore when done
      var origScroll = await evalInFrame(`(function(){
        return window.scrollY || (document.scrollingElement ? document.scrollingElement.scrollTop : 0) || document.documentElement.scrollTop || (document.body ? document.body.scrollTop : 0) || 0;
      })()`);

      // Prepare fixed element states (only slim headers/banners)
      await cdpEval(tabId, prepareCaptureJS);
      if (useIframe) {
        await evalInFrame(prepareCaptureJS);
      }

      var step = Math.max(150, si.clientHeight - 120); // 120px overlap for seamless stitching
      var y = 0;
      var lastCapturedY = -1;
      var stuckCount = 0;

      // FAST SINGLE-PASS DUAL-SCROLL CAPTURE
      while (true) {
        // Scroll both document and inner element if present
        await evalInFrame(`(function(){
          var targetY = ${y};
          window.scrollTo(0, targetY);
          if (document.scrollingElement) document.scrollingElement.scrollTop = targetY;
          if (document.documentElement) document.documentElement.scrollTop = targetY;
          if (document.body) document.body.scrollTop = targetY;
          if (window.__ss_el) {
            window.__ss_el.scrollTop = targetY;
            if (window.__ss_el.parentElement) window.__ss_el.parentElement.scrollTop = targetY;
          }
        })()`);

        if (useIframe) {
          try {
            await cdpEval(tabId, `window.scrollTo(0, ${y}); if (document.scrollingElement) document.scrollingElement.scrollTop = ${y}; if (document.documentElement) document.documentElement.scrollTop = ${y};`);
          } catch(e) {}
        }

        // 140ms compositing delay (optimal for DOM updates & MathJax/KaTeX layout)
        await wait(140);

        var actualY = await evalInFrame(`(function(){
          var docY = window.scrollY || (document.scrollingElement ? document.scrollingElement.scrollTop : 0) || document.documentElement.scrollTop || (document.body ? document.body.scrollTop : 0) || 0;
          var elY = window.__ss_el ? window.__ss_el.scrollTop : 0;
          var parentY = (window.__ss_el && window.__ss_el.parentElement) ? window.__ss_el.parentElement.scrollTop : 0;
          return Math.round(Math.max(docY, elY, parentY));
        })()`);

        // Dynamic height check (for pages that load questions or images on scroll)
        var currentH = await evalInFrame(`(function(){
          var docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
          var elH = window.__ss_el ? window.__ss_el.scrollHeight : 0;
          var maxH = Math.max(docH, elH);
          var all = document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            if (all[i].scrollHeight > maxH) maxH = all[i].scrollHeight;
          }
          return maxH;
        })()`);
        if (currentH > si.scrollHeight) {
          si.scrollHeight = currentH;
        }

        // Check if we hit the bottom boundary or scrolling didn't advance
        if (y > 0 && actualY <= lastCapturedY) {
          // Fallback: try relative scrollBy
          await evalInFrame(`(function(){
            window.scrollBy(0, ${step});
            if (window.__ss_el) window.__ss_el.scrollBy(0, ${step});
          })()`);
          await wait(100);
          actualY = await evalInFrame(`(function(){
            var docY = window.scrollY || (document.scrollingElement ? document.scrollingElement.scrollTop : 0) || document.documentElement.scrollTop || (document.body ? document.body.scrollTop : 0) || 0;
            var elY = window.__ss_el ? window.__ss_el.scrollTop : 0;
            return Math.round(Math.max(docY, elY));
          })()`);

          if (actualY <= lastCapturedY) {
            stuckCount++;
            if (stuckCount >= 2) {
              break; // Truly at bottom
            }
          } else {
            stuckCount = 0;
          }
        } else {
          stuckCount = 0;
        }

        var sshot = await cdpCmd(tabId, 'Page.captureScreenshot', { format: 'png' });
        captures.push({ dataUrl: 'data:image/png;base64,' + sshot.data, scrollY: actualY });
        lastCapturedY = actualY;

        // After frame 0, hide slim fixed headers so they don't repeat in later slices
        if (captures.length === 1) {
          await cdpEval(tabId, hideFixedJS);
          if (useIframe) await evalInFrame(hideFixedJS);
        }

        var estTotal = Math.max(1, Math.ceil(si.scrollHeight / step));
        notify(`Section ${captures.length} of ~${estTotal}...`);

        // If actual viewport reached or passed document bottom, we are done!
        if (actualY > 0 && actualY + si.clientHeight >= si.scrollHeight) {
          break;
        }

        y = actualY + step;
      }

      clearInterval(pingInterval);
      
      try {
        await cdpEval(tabId, restoreAllJS);
        if (useIframe) {
          await evalInFrame(restoreAllJS);
        }
      } catch(e) {}

      // Restore user's original scroll position
      await evalInFrame(`(function(){
        window.scrollTo(0, ${origScroll});
        if (window.__ss_el && window.__ss_origScroll !== undefined) {
          window.__ss_el.scrollTop = window.__ss_origScroll;
        }
        var e = document.getElementById('__ss_hide'); if(e) e.remove(); 
        if(window.__ss_interval) { clearInterval(window.__ss_interval); window.__ss_interval = null; }
      })()`);

      if (useIframe) {
        await cdpEval(tabId, `(function(){ var e=document.getElementById('__ss_hide'); if(e)e.remove();
          if(window.__ss_interval) { clearInterval(window.__ss_interval); window.__ss_interval=null; } })()`);
      }

      var finalHeight = si.scrollHeight;
      if (captures.length > 0) {
        var last = captures[captures.length - 1];
        finalHeight = Math.max(finalHeight, last.scrollY + si.clientHeight);
      }

      return {
        mode: 'fullpage',
        captures,
        viewportWidth: si.vw,
        viewportHeight: si.vh,
        totalHeight: finalHeight,
        totalWidth: si.vw,
        devicePixelRatio: si.dpr
      };
    } else {
      var sshot = await cdpCmd(tabId, 'Page.captureScreenshot', {format:'png'});
      captures.push({dataUrl:'data:image/png;base64,'+sshot.data, scrollY:0});
      return {mode:'visible', captures, viewportWidth:mainInfo.vw, viewportHeight:mainInfo.vh,
        totalHeight:mainInfo.vh, totalWidth:mainInfo.vw, devicePixelRatio:mainInfo.dpr};
    }
  } finally {
    try { await cdpDetach(tabId); } catch(e){}
  }
}
