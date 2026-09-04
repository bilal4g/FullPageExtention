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
  
  var body = document.body;
  
  // Fast candidate selector for headers, navs, sticky bars, overlays
  var candidates = document.querySelectorAll('header, nav, aside, footer, [class*="header"], [class*="nav"], [class*="sticky"], [class*="fixed"], [class*="banner"], [class*="bar"], [style*="fixed"], [style*="sticky"]');
  var seen = new Set();
  function checkEl(el) {
    if (!el || seen.has(el) || el === document.documentElement || el === document.body) return;
    seen.add(el);
    try {
      var style = window.getComputedStyle(el);
      var pos = style.position;
      
      if (pos === 'fixed') {
        window.__ss_restorers.push({
          el: el,
          type: 'fixed',
          origVisibility: el.style.visibility
        });
      }
      
      if (pos === 'sticky') {
        window.__ss_restorers.push({
          el: el,
          type: 'sticky',
          origPosition: el.style.position
        });
        el.style.position = 'static';
      }
      
      if (style.backgroundAttachment === 'fixed') {
        window.__ss_restorers.push({
          el: el,
          type: 'background',
          origAttachment: el.style.backgroundAttachment
        });
        el.style.backgroundAttachment = 'scroll';
      }
    } catch(e) {}
  }

  if (body) {
    for (var j = 0; j < body.children.length; j++) checkEl(body.children[j]);
  }
  for (var i = 0; i < candidates.length; i++) checkEl(candidates[i]);
})()`;

const hideFixedJS = `(function() {
  if (!window.__ss_restorers) return;
  for (var i = 0; i < window.__ss_restorers.length; i++) {
    var item = window.__ss_restorers[i];
    if (item.type === 'fixed') {
      try {
        item.el.style.visibility = 'hidden';
      } catch(e) {}
    }
  }
})()`;

const restoreAllJS = `(function() {
  if (!window.__ss_prepared) return;
  window.__ss_prepared = false;
  if (window.__ss_restorers) {
    for (var i = 0; i < window.__ss_restorers.length; i++) {
      var item = window.__ss_restorers[i];
      try {
        if (item.type === 'sticky') {
          item.el.style.position = item.origPosition;
        } else if (item.type === 'fixed') {
          item.el.style.visibility = item.origVisibility;
        } else if (item.type === 'background') {
          item.el.style.backgroundAttachment = item.origAttachment;
        }
      } catch(e) {}
    }
    window.__ss_restorers = [];
  }
})()`;

const findScrollableJS = `(function(){
  var vw = window.innerWidth, vh = window.innerHeight;
  var docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  var origDocY = window.scrollY || document.documentElement.scrollTop || 0;

  // Fast-path: If main page is scrollable, use document scrolling directly without DOM scanning
  if (docH > vh + 50) {
    window.__ss_origScroll = origDocY;
    return JSON.stringify({
      found: true, docScroll: true, frame: 'main',
      tag: 'DOCUMENT', id: '', cls: '',
      rect: { top: 0, left: 0, width: vw, height: vh },
      scrollHeight: docH, clientHeight: vh,
      vw: vw, vh: vh, dpr: window.devicePixelRatio
    });
  }

  function isInvalidTarget(el) {
    try {
      var cs = getComputedStyle(el);
      var pos = cs.position;
      if (pos === 'fixed' || pos === 'sticky') return true;
      if (el.clientWidth < vw * 0.4 || el.clientHeight < vh * 0.4) return true;
    } catch(e) {}
    return false;
  }

  function canScroll(el) {
    var old = el.scrollTop;
    el.scrollTop = old + 10;
    if (el.scrollTop !== old) { el.scrollTop = old; return true; }
    el.scrollTop = old - 10;
    if (el.scrollTop !== old) { el.scrollTop = old; return true; }
    return false;
  }

  function hasScrollableAncestor(el) {
    var p = el.parentElement;
    while (p && p !== document.documentElement && p !== document.body) {
      try {
        var cs = getComputedStyle(p);
        var oy = cs.overflowY, o = cs.overflow;
        if ((oy==='auto'||oy==='scroll'||oy==='overlay'||o==='auto'||o==='scroll'||o==='overlay')
            && p.scrollHeight > p.clientHeight + 5) {
          return true;
        }
      } catch(e){}
      p = p.parentElement;
    }
    return false;
  }

  var candidates = document.querySelectorAll('main, [role="main"], article, section, [class*="content"], [class*="scroll"], [class*="body"], [class*="container"], [class*="pane"], div');
  var best = null, bestArea = 0;
  for (var i = 0; i < candidates.length; i++) {
    var el = candidates[i];
    if (el === document.documentElement || el === document.body) continue;
    if (el.scrollHeight <= el.clientHeight + 10 || el.clientHeight < 50 || el.clientWidth < 100) continue;
    if (isInvalidTarget(el)) continue;
    try {
      var cs = getComputedStyle(el);
      var oy = cs.overflowY, o = cs.overflow;
      if (oy==='auto'||oy==='scroll'||oy==='overlay'||o==='auto'||o==='scroll'||o==='overlay') {
        var area = el.clientWidth * el.clientHeight;
        if (area > bestArea && canScroll(el) && !hasScrollableAncestor(el)) {
          bestArea = area;
          best = el;
        }
      }
    } catch(e){}
  }

  if (best) {
    window.__ss_el = best;
    window.__ss_origScroll = best.scrollTop;
    var r = best.getBoundingClientRect();
    return JSON.stringify({
      found: true, docScroll: false, frame: 'main',
      tag: best.tagName, id: best.id || '', cls: (best.className || '').toString().slice(0, 60),
      rect: { top: r.top, left: r.left, width: r.width, height: r.height },
      scrollHeight: best.scrollHeight, clientHeight: best.clientHeight,
      vw: vw, vh: vh, dpr: window.devicePixelRatio
    });
  }

  window.__ss_origScroll = origDocY;
  return JSON.stringify({
    found: true, docScroll: true, frame: 'main',
    tag: 'DOCUMENT', id: '', cls: '',
    rect: { top: 0, left: 0, width: vw, height: vh },
    scrollHeight: docH, clientHeight: vh,
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
        if(Date.now() - window.__ss_lastPing > 2000) {
           clearInterval(window.__ss_interval);
           window.__ss_interval = null;
           var e = document.getElementById('__ss_hide'); if(e) e.remove();
           if(window.__ss_el && window.__ss_origScroll !== undefined) window.__ss_el.scrollTop = window.__ss_origScroll;
           else if(window.__ss_origScroll !== undefined) window.scrollTo(0, window.__ss_origScroll);
           
           if (window.__ss_prepared && window.__ss_restorers) {
             for (var i = 0; i < window.__ss_restorers.length; i++) {
               var item = window.__ss_restorers[i];
               try {
                 if (item.type === 'sticky') {
                   item.el.style.position = item.origPosition;
                 } else if (item.type === 'fixed') {
                   item.el.style.visibility = item.origVisibility;
                 } else if (item.type === 'background') {
                   item.el.style.backgroundAttachment = item.origAttachment;
                 }
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
    chrome.runtime.sendMessage({ type: 'studio:capture_progress', status });
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

    // Only probe child frames if the main document is NOT scrollable
    if ((!bestTarget || (bestTarget.docScroll && mainInfo.scrollH <= mainInfo.clientH + 50)) &&
        frameTree && frameTree.frameTree && frameTree.frameTree.childFrames) {
      for (var cf of frameTree.frameTree.childFrames) {
        try {
          var world = await cdpCmd(tabId, 'Page.createIsolatedWorld', { frameId: cf.frame.id, worldName: 'snapscroll' });
          var ctxId = world.executionContextId;
          var iframeResStr = await cdpCmd(tabId, 'Runtime.evaluate', { expression: findScrollableJS, contextId: ctxId, returnByValue: true });
          
          if (iframeResStr.result && iframeResStr.result.value) {
             var parsed = JSON.parse(iframeResStr.result.value);
             if (parsed.found) {
                if (!bestTarget || parsed.scrollHeight > bestTarget.scrollHeight) {
                   bestTarget = parsed;
                   bestTarget.contextId = ctxId;
                   bestTarget.isIframe = true;
                   bestTarget.frameId = cf.frame.id;
                }
             }
          }
        } catch(e){}
      }
    }

    var elInfo = bestTarget || { found: false };

    if (elInfo.found && elInfo.isIframe) {
        useIframe = true;
        iframeContextId = elInfo.contextId;
        elInfo.frame = 'iframe:' + elInfo.frameId;
        
        try {
          await cdpCmd(tabId, 'DOM.enable');
          await cdpCmd(tabId, 'DOM.getDocument', {depth: -1});
          var owner = await cdpCmd(tabId, 'DOM.getFrameOwner', { frameId: elInfo.frameId });
          var box = await cdpCmd(tabId, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
          var ifX = box.model.border[0];
          var ifY = box.model.border[1];
          var ifW = box.model.border[2] - box.model.border[0];
          var ifH = box.model.border[5] - box.model.border[1];
          
          elInfo.rect.left += ifX;
          elInfo.rect.top += ifY;
          
          if (elInfo.docScroll) {
            elInfo.rect = { left: ifX, top: ifY, width: ifW, height: ifH };
            elInfo.clientHeight = ifH;
            elInfo.vw = ifW;
          }
        } catch(e) {}
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
      var isDoc = si.docScroll;
      
      var visibleTop = Math.max(0, si.rect.top);
      var maxVisibleHeight = mainInfo.vh - visibleTop;
      si.clientHeight = Math.floor(Math.min(si.clientHeight, maxVisibleHeight));
      
      notify('Starting scroll capture...');
      await wait(100);

      // Save user's original scroll position to restore when done
      var origScroll = await evalInFrame(isDoc
        ? `window.scrollY || document.documentElement.scrollTop || 0`
        : `window.__ss_el ? window.__ss_el.scrollTop : 0`);

      // Prepare fixed/sticky element states
      await cdpEval(tabId, prepareCaptureJS);
      if (useIframe) {
        await evalInFrame(prepareCaptureJS);
      }

      var step = Math.max(100, si.clientHeight - 120); // 120px overlap for seamless stitching
      var y = 0;
      var lastCapturedY = -1;

      // FAST SINGLE-PASS CAPTURE (Zero pre-scroll pass, zero backup scroll!)
      while (true) {
        if (isDoc) {
          await evalInFrame(`window.scrollTo(0, ${y})`);
        } else {
          await evalInFrame(`if (window.__ss_el) window.__ss_el.scrollTop = ${y}`);
        }

        // 120ms compositing delay (optimal with scroll-behavior: auto)
        await wait(120);

        var actualY = await evalInFrame(isDoc
          ? `Math.round(window.scrollY || window.pageYOffset || 0)`
          : `window.__ss_el ? Math.round(window.__ss_el.scrollTop) : 0`);

        // Check if we hit the bottom boundary and scrolling didn't advance
        if (y > 0 && actualY === lastCapturedY) {
          var checkH = await evalInFrame(isDoc
            ? `Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`
            : `window.__ss_el ? window.__ss_el.scrollHeight : 0`);
          if (checkH > si.scrollHeight + 10) {
            si.scrollHeight = checkH;
            if (isDoc) await evalInFrame(`window.scrollTo(0, ${y})`);
            else await evalInFrame(`if (window.__ss_el) window.__ss_el.scrollTop = ${y}`);
            await wait(100);
            actualY = await evalInFrame(isDoc
              ? `Math.round(window.scrollY || window.pageYOffset || 0)`
              : `window.__ss_el ? Math.round(window.__ss_el.scrollTop) : 0`);
            if (actualY === lastCapturedY) break; // Truly at bottom
          } else {
            break; // Truly at bottom
          }
        }

        var sshot = await cdpCmd(tabId, 'Page.captureScreenshot', { format: 'png' });
        captures.push({ dataUrl: 'data:image/png;base64,' + sshot.data, scrollY: actualY });
        lastCapturedY = actualY;

        // Dynamic height growth check
        var currentH = await evalInFrame(isDoc
          ? `Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`
          : `window.__ss_el ? window.__ss_el.scrollHeight : 0`);
        if (currentH > si.scrollHeight) {
          si.scrollHeight = currentH;
        }

        // After frame 0, hide fixed headers/overlays so they don't repeat in later slices
        if (captures.length === 1) {
          await cdpEval(tabId, hideFixedJS);
          if (useIframe) await evalInFrame(hideFixedJS);
        }

        var estTotal = Math.max(1, Math.ceil(si.scrollHeight / step));
        notify(`Section ${captures.length} of ~${estTotal}...`);

        // If actual viewport reached or passed document bottom, we are done!
        if (actualY + si.clientHeight >= si.scrollHeight) {
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
      if (isDoc) {
        await evalInFrame(`(function(){ window.scrollTo(0, ${origScroll});
          var e=document.getElementById('__ss_hide'); if(e)e.remove(); 
          if(window.__ss_interval) { clearInterval(window.__ss_interval); window.__ss_interval=null; } })()`);
      } else {
        await evalInFrame(`(function(){ if(window.__ss_el) window.__ss_el.scrollTop = ${origScroll};
          var e=document.getElementById('__ss_hide'); if(e)e.remove();
          if(window.__ss_interval) { clearInterval(window.__ss_interval); window.__ss_interval=null; } })()`);
      }
      if (useIframe) {
        await cdpEval(tabId, `(function(){ var e=document.getElementById('__ss_hide'); if(e)e.remove();
          if(window.__ss_interval) { clearInterval(window.__ss_interval); window.__ss_interval=null; } })()`);
      }

      var finalHeight = si.scrollHeight;
      if (captures.length > 0) {
        var last = captures[captures.length - 1];
        finalHeight = last.scrollY + si.clientHeight;
      }

      if (isDoc && !useIframe) {
        return {mode:'fullpage', captures, viewportWidth:si.vw, viewportHeight:si.vh,
          totalHeight:finalHeight, totalWidth:si.vw, devicePixelRatio:si.dpr};
      }
      return {mode:'element', captures, elementRect:si.rect,
        elementClientHeight:si.clientHeight, totalScrollHeight:finalHeight,
        viewportWidth:si.vw, viewportHeight:si.vh, devicePixelRatio:si.dpr};
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
