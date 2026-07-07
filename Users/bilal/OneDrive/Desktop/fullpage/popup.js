/* SnapScroll Pro - Popup Logic */
let selectedFormat = 'png';
let capturedCanvas = null;

const mainView = document.getElementById('main-view');
const progressView = document.getElementById('progress-view');
const resultView = document.getElementById('result-view');
const errorView = document.getElementById('error-view');
const captureBtn = document.getElementById('capture-btn');
const retryBtn = document.getElementById('retry-btn');
const backBtn = document.getElementById('back-btn');
const downloadBtn = document.getElementById('download-btn');
const downloadLabel = document.getElementById('download-label');
const progressFill = document.getElementById('progress-ring-fill');
const progressPercent = document.getElementById('progress-percent');
const progressStatus = document.getElementById('progress-status');
const errorMessage = document.getElementById('error-message');
const previewCanvas = document.getElementById('preview-canvas');
const resultInfo = document.getElementById('result-info');

document.querySelectorAll('.format-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedFormat = btn.dataset.format;
    downloadLabel.textContent = `Download ${selectedFormat.toUpperCase()}`;
  });
});

function showView(v) { document.querySelectorAll('.view').forEach(x=>x.classList.remove('active')); v.classList.add('active'); }
function delay(ms) { return new Promise(r=>setTimeout(r,ms)); }
function setProgress(p,s) {
  const c=2*Math.PI*42, o=c-(p/100)*c;
  progressFill.style.strokeDashoffset=o;
  progressPercent.textContent=Math.round(p)+'%';
  if(s) progressStatus.textContent=s;
}
function loadImage(u) { return new Promise((r,j)=>{ const i=new Image(); i.onload=()=>r(i); i.onerror=j; i.src=u; }); }
function sendMsg(id,m) { return new Promise((r,j)=>{ chrome.tabs.sendMessage(id,m,x=>{ if(chrome.runtime.lastError) j(new Error(chrome.runtime.lastError.message)); else r(x); }); }); }

function trimTrailingWhite(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const width = canvas.width;
  const height = canvas.height;
  const maxScan = Math.min(600, height);
  let trimCount = 0;
  
  const bgPixel = ctx.getImageData(0, height - 1, 1, 1).data;
  const bgR = bgPixel[0];
  const bgG = bgPixel[1];
  const bgB = bgPixel[2];
  const bgA = bgPixel[3];
  
  for (let y = height - 1; y >= height - maxScan; y--) {
    const rowData = ctx.getImageData(0, y, width, 1).data;
    let isAllBg = true;
    for (let x = 0; x < rowData.length; x += 4) {
      const r = rowData[x];
      const g = rowData[x+1];
      const b = rowData[x+2];
      const a = rowData[x+3];
      
      const matchesBg = Math.abs(r - bgR) <= 3 && Math.abs(g - bgG) <= 3 && Math.abs(b - bgB) <= 3 && Math.abs(a - bgA) <= 3;
      const isWhite = a > 0 && r >= 253 && g >= 253 && b >= 253;
      
      if (!matchesBg && !isWhite) {
        isAllBg = false;
        break;
      }
    }
    if (isAllBg) {
      trimCount++;
    } else {
      break;
    }
  }
  
  if (trimCount > 0 && trimCount < height) {
    const trimmed = document.createElement('canvas');
    trimmed.width = width;
    trimmed.height = height - trimCount;
    const tCtx = trimmed.getContext('2d', { willReadFrequently: true });
    tCtx.drawImage(canvas, 0, 0);
    return trimmed;
  }
  return canvas;
}

// ── Stitching ──
async function stitchFull(res) {
  const d = res.devicePixelRatio;
  const loaded = [];
  let maxW = 0;
  
  for (let i = 0; i < res.captures.length; i++) {
    const img = await loadImage(res.captures[i].dataUrl);
    const drawY = Math.round(res.captures[i].scrollY * d);
    loaded.push({ img, drawY });
    if (img.width > maxW) maxW = img.width;
    setProgress(30 + (i / res.captures.length) * 30, 'Loading frames...');
  }

  let maxBottom = 0;
  for (const item of loaded) {
    const bottom = item.drawY + item.img.height;
    if (bottom > maxBottom) maxBottom = bottom;
  }

  const cw = maxW || Math.round(res.totalWidth * d);
  const ch = maxBottom || Math.round(res.totalHeight * d);
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingEnabled = false;

  for (let i = 0; i < loaded.length; i++) {
    const item = loaded[i];
    ctx.drawImage(item.img, 0, item.drawY);
    setProgress(60 + (i / loaded.length) * 30, 'Stitching...');
  }
  return trimTrailingWhite(c);
}

async function stitchEl(res) {
  const d = res.devicePixelRatio, r = res.elementRect;
  const ew = Math.round(r.width * d);
  
  const sx = Math.round(r.left * d);
  const sy = Math.round(r.top * d);
  const sliceH = Math.round(res.elementClientHeight * d);

  const loaded = [];
  for (let i = 0; i < res.captures.length; i++) {
    const img = await loadImage(res.captures[i].dataUrl);
    const dy = Math.round(res.captures[i].scrollY * d);
    loaded.push({ img, dy });
    setProgress(30 + (i / res.captures.length) * 30, 'Loading frames...');
  }

  let maxBottom = 0;
  for (const item of loaded) {
    const bottom = item.dy + sliceH;
    if (bottom > maxBottom) maxBottom = bottom;
  }

  const c = document.createElement('canvas');
  c.width = ew; c.height = maxBottom;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, ew, maxBottom);
  ctx.imageSmoothingEnabled = false;

  for (let i = 0; i < loaded.length; i++) {
    const item = loaded[i];
    ctx.drawImage(item.img, sx, sy, ew, sliceH, 0, item.dy, ew, sliceH);
    setProgress(60 + (i / loaded.length) * 30, 'Stitching...');
  }
  return trimTrailingWhite(c);
}

// ── PDF ──
function generatePDF(canvas) {
  const imgData=canvas.toDataURL('image/jpeg',0.92), imgBytes=atob(imgData.split(',')[1]);
  const iW=canvas.width,iH=canvas.height,pw=595.28,m=36,cw=pw-m*2,sc=cw/iW,ch=iH*sc,ph=ch+m*2;
  const sd=`q ${cw} 0 0 ${ch} ${m} ${m} cm /Img Do Q`;
  let pdf='%PDF-1.4\n'; const off=[];
  off.push(pdf.length); pdf+='1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  off.push(pdf.length); pdf+='2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  off.push(pdf.length); pdf+=`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Contents 4 0 R /Resources << /XObject << /Img 5 0 R >> >> >>\nendobj\n`;
  off.push(pdf.length); pdf+=`4 0 obj\n<< /Length ${sd.length} >>\nstream\n${sd}\nendstream\nendobj\n`;
  const imgStream=imgBytes; let hex='';
  for(let i=0;i<imgStream.length;i++) hex+=String.fromCharCode(imgStream.charCodeAt(i));
  off.push(pdf.length); pdf+=`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${iW} /Height ${iH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgStream.length} >>\nstream\n`;
  const before=pdf; pdf+=`\nendstream\nendobj\n`;
  const xrefOff=before.length+imgStream.length+('\nendstream\nendobj\n').length;
  let xref=`xref\n0 ${off.length+1}\n0000000000 65535 f \n`;
  off.forEach(o=>{ xref+=String(o).padStart(10,'0')+' 00000 n \n'; });
  pdf+=xref+`trailer\n<< /Size ${off.length+1} /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF`;
  const arr=new Uint8Array(before.length+imgStream.length+(pdf.length-before.length));
  for(let i=0;i<before.length;i++) arr[i]=before.charCodeAt(i);
  for(let i=0;i<imgStream.length;i++) arr[before.length+i]=imgStream.charCodeAt(i);
  const after=pdf.slice(before.length+0);
  for(let i=0;i<after.length;i++) arr[before.length+imgStream.length+i]=after.charCodeAt(i);
  return arr;
}
function downloadFile(data,name,type) {
  const b=new Blob([data],{type}), u=URL.createObjectURL(b), a=document.createElement('a');
  a.href=u; a.download=name; a.click(); URL.revokeObjectURL(u);
}

// ── Content Script helpers ──
async function ensureCS(tab) {
  try { await sendMsg(tab.id,{action:'ping'}); return true; } catch(e) {}
  try { await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']}); await delay(200); return true; } catch(e) { return false; }
}
async function csCapture(tab) {
  const info = await sendMsg(tab.id,{action:'getScrollInfo'});
  await sendMsg(tab.id,{action:'hideScrollbars'}); await delay(300);
  const captures=[];

  if(info.mode==='element') {
    // Capture a scrollable element section by section
    const el = info.element;
    const rect = el.rect;
    let y = 0;
    while(y < el.scrollHeight) {
      await sendMsg(tab.id,{action:'scrollTo',y,mode:'element'}); await delay(400);
      const pos = await sendMsg(tab.id,{action:'getScrollPosition',mode:'element'});
      const dataUrl = await new Promise((r,j)=>chrome.tabs.captureVisibleTab({format:'png'},d=>{if(chrome.runtime.lastError)j(new Error(chrome.runtime.lastError.message));else r(d);}));
      captures.push({dataUrl, scrollY:pos.scrollY});
      if(y>0 && pos.scrollY < y-2) break;
      y += Math.max(100, el.clientHeight - 40);
    }
    await sendMsg(tab.id,{action:'showScrollbars'});
    return {
      mode:'element', captures,
      elementRect: rect,
      elementClientHeight: el.clientHeight,
      totalScrollHeight: el.scrollHeight,
      viewportWidth: info.viewportWidth,
      viewportHeight: info.viewportHeight,
      devicePixelRatio: info.devicePixelRatio
    };
  }

  if(info.mode==='fullpage') {
    let y=0;
    while(y<info.totalHeight) {
      await sendMsg(tab.id,{action:'scrollTo',y,mode:'fullpage'}); await delay(400);
      const pos=await sendMsg(tab.id,{action:'getScrollPosition',mode:'fullpage'});
      const dataUrl=await new Promise((r,j)=>chrome.tabs.captureVisibleTab({format:'png'},d=>{if(chrome.runtime.lastError)j(new Error(chrome.runtime.lastError.message));else r(d);}));
      captures.push({dataUrl,scrollY:pos.scrollY});
      if(y>0&&pos.scrollY<y-2)break;
      y += Math.max(100, info.viewportHeight - 40);
    }
    await sendMsg(tab.id,{action:'showScrollbars'});
    return {mode:'fullpage',captures,viewportWidth:info.viewportWidth,viewportHeight:info.viewportHeight,totalHeight:info.totalHeight,totalWidth:info.totalWidth,devicePixelRatio:info.devicePixelRatio};
  }

  return null;
}

// ── CDP helpers ──
function cdpCmd(tabId,method,params={}) {
  return new Promise((r,j)=>{
    chrome.debugger.sendCommand({tabId},method,params,(res)=>{
      if(chrome.runtime.lastError) j(new Error(chrome.runtime.lastError.message)); else r(res);
    });
  });
}
function cdpAttach(tabId) {
  return new Promise((r,j)=>{
    chrome.debugger.attach({tabId},'1.3',()=>{
      if(chrome.runtime.lastError) {
        if (chrome.runtime.lastError.message.includes('already attached')) {
          r();
        } else {
          j(new Error(chrome.runtime.lastError.message));
        }
      } else {
        r();
      }
    });
  });
}
function cdpDetach(tabId) {
  return new Promise(r=>{ chrome.debugger.detach({tabId},()=>r()); });
}
async function cdpEval(tabId, expr) {
  const res = await cdpCmd(tabId,'Runtime.evaluate',{expression:expr,returnByValue:true});
  if(res.exceptionDetails) throw new Error('JS error: '+JSON.stringify(res.exceptionDetails));
  return res.result.value;
}

const prepareCaptureJS = `(function() {
  if (window.__ss_prepared) return;
  window.__ss_prepared = true;
  window.__ss_restorers = [];
  
  var body = document.body;
  if (body) {
    window.__ss_restorers.push({
      el: body,
      type: 'padding',
      origPaddingBottom: body.style.paddingBottom
    });
    var currentPadding = parseFloat(window.getComputedStyle(body).paddingBottom) || 0;
    body.style.paddingBottom = (currentPadding + 300) + 'px';
  }
  
  if (window.__ss_el && window.__ss_el !== document.documentElement && window.__ss_el !== document.body) {
    window.__ss_restorers.push({
      el: window.__ss_el,
      type: 'padding',
      origPaddingBottom: window.__ss_el.style.paddingBottom
    });
    var currentPadding = parseFloat(window.getComputedStyle(window.__ss_el).paddingBottom) || 0;
    window.__ss_el.style.paddingBottom = (currentPadding + 300) + 'px';
  }
  
  var els = document.querySelectorAll('*');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    try {
      var style = window.getComputedStyle(el);
      var pos = style.position;
      
      if (pos === 'fixed') {
        window.__ss_restorers.push({
          el: el,
          type: 'fixed',
          origDisplay: el.style.display
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
})()`;

const hideFixedJS = `(function() {
  if (!window.__ss_restorers) return;
  for (var i = 0; i < window.__ss_restorers.length; i++) {
    var item = window.__ss_restorers[i];
    if (item.type === 'fixed') {
      try {
        item.el.style.display = 'none';
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
          item.el.style.display = item.origDisplay;
        } else if (item.type === 'background') {
          item.el.style.backgroundAttachment = item.origAttachment;
        } else if (item.type === 'padding') {
          item.el.style.paddingBottom = item.origPaddingBottom;
        }
      } catch(e) {}
    }
    window.__ss_restorers = [];
  }
})()`;

async function cdpCapture(tab) {
  const tabId = tab.id;
  await cdpAttach(tabId);
  try {
    setProgress(15,'Analyzing page frames...');

    var frameTree;
    try { frameTree = await cdpCmd(tabId, 'Page.getFrameTree'); } catch(e) { frameTree = null; }

    await cdpCmd(tabId, 'Runtime.enable');
    
    var mainCtx = await cdpCmd(tabId, 'Runtime.evaluate', {
      expression: `JSON.stringify({
        url: location.href,
        scrollH: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) + 150,
        clientH: window.innerHeight,
        vw: window.innerWidth,
        vh: window.innerHeight,
        dpr: window.devicePixelRatio
      })`,
      returnByValue: true
    });
    var mainInfo = JSON.parse(mainCtx.result.value);

    setProgress(20,'Searching for scrollable content...');
    
    var findScrollableJS = `(function(){
      var vw = window.innerWidth, vh = window.innerHeight;

      function isInvalidTarget(el) {
        try {
          var cs = getComputedStyle(el);
          var pos = cs.position;
          if (pos === 'fixed' || pos === 'sticky') return true;
          if (el.clientWidth < vw * 0.4 || el.clientHeight < vh * 0.4) return true;
        } catch(e) {}
        return false;
      }

      function findScrollableParent(el) {
        while (el && el !== document.documentElement && el !== document.body) {
          if (!isInvalidTarget(el)) {
            try {
              var cs = getComputedStyle(el);
              var oy = cs.overflowY, o = cs.overflow;
              if ((oy==='auto'||oy==='scroll'||oy==='overlay'||o==='auto'||o==='scroll'||o==='overlay')
                  && el.scrollHeight > el.clientHeight + 5
                  && canScroll(el)) {
                return el;
              }
            } catch(e){}
          }
          el = el.parentElement;
        }
        return null;
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

      var target = null;

      var clickX = parseFloat(document.documentElement.dataset.ssClickX);
      var clickY = parseFloat(document.documentElement.dataset.ssClickY);

      if (!isNaN(clickX) && !isNaN(clickY) && clickX >= 0 && clickY >= 0) {
        var elAtPos = document.elementFromPoint(clickX, clickY);
        if (elAtPos) {
          var found = findScrollableParent(elAtPos);
          if (found && canScroll(found)) target = found;
        }
      }

      if (!target) {
        var allEls = document.querySelectorAll('*');
        var best = null, bestArea = 0;
        for (var i = 0; i < allEls.length; i++) {
          var el = allEls[i];
          if (el === document.documentElement || el === document.body) continue;
          if (isInvalidTarget(el)) continue;
          try {
            var cs = getComputedStyle(el);
            var oy = cs.overflowY, o = cs.overflow;
            if ((oy==='auto'||oy==='scroll'||oy==='overlay'||o==='auto'||o==='scroll'||o==='overlay')
                && el.scrollHeight > el.clientHeight + 10
                && el.clientHeight >= 50 && el.clientWidth >= 100) {
              var area = el.clientWidth * el.clientHeight;
              if (area > bestArea && canScroll(el) && !hasScrollableAncestor(el)) {
                bestArea = area;
                best = el;
              }
            }
          } catch(e){}
        }
        if (best) target = best;
      }

      if (target) {
        window.__ss_el = target;
        window.__ss_origScroll = target.scrollTop;
        var r = target.getBoundingClientRect();
        return JSON.stringify({found:true, docScroll:false, frame:'main',
          tag:target.tagName, id:target.id||'', cls:(target.className||'').toString().slice(0,60),
          rect:{top:r.top,left:r.left,width:r.width,height:r.height},
          scrollHeight:target.scrollHeight + 150, clientHeight:target.clientHeight,
          vw:window.innerWidth, vh:window.innerHeight, dpr:window.devicePixelRatio});
      }

      var origDocY = window.scrollY || document.documentElement.scrollTop;
      window.scrollBy(0, 10);
      var newDocY = window.scrollY || document.documentElement.scrollTop;
      if (newDocY === origDocY) {
        window.scrollBy(0, -10);
        newDocY = window.scrollY || document.documentElement.scrollTop;
        if (newDocY !== origDocY) window.scrollBy(0, 10);
      } else {
        window.scrollBy(0, -10);
      }

      if (newDocY !== origDocY) {
        var docH = Math.max(document.documentElement.scrollHeight, document.body?document.body.scrollHeight:0);
        var winH = window.innerHeight;
        window.__ss_origScroll = origDocY;
        return JSON.stringify({found:true, docScroll:true, frame:'main',
          tag:'DOCUMENT', id:'', cls:'',
          rect:{top:0,left:0,width:window.innerWidth,height:winH},
          scrollHeight:docH + 150, clientHeight:winH,
          vw:window.innerWidth, vh:winH, dpr:window.devicePixelRatio});
      }

      return JSON.stringify({found:false});
    })()`;

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

    if (frameTree && frameTree.frameTree && frameTree.frameTree.childFrames) {
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
        } catch(e) {
          console.warn('Failed to get iframe bounds:', e.message);
        }
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

    var injectHideAndMonitor = `(function(){
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
                       item.el.style.display = item.origDisplay;
                     } else if (item.type === 'background') {
                       item.el.style.backgroundAttachment = item.origAttachment;
                     } else if (item.type === 'padding') {
                       item.el.style.paddingBottom = item.origPaddingBottom;
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
      
      setProgress(22, `Found: ${si.tag}#${si.id} (${si.scrollHeight}px in ${si.frame})`);
      
      progressStatus.innerHTML += '<br><b style="color:red; font-size:14px; background:#fff0f0; padding:4px; border:1px solid red; display:block; margin-top:8px;">⚠️ DO NOT CLICK OUTSIDE THIS BOX! ⚠️<br>Processing will stop if this window closes!</b>';
      
      await delay(500);

      if (isDoc) {
        var y = 0;
        while(y < si.scrollHeight) {
           await evalInFrame(`window.scrollTo(0,${y})`);
           await delay(200);
           setProgress(25+((y/si.scrollHeight)*15), 'Scrolling down...');
           
           var currentH = await evalInFrame(`Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`);
           if (currentH + 150 > si.scrollHeight) {
             si.scrollHeight = currentH + 150;
           }
           y += si.clientHeight;
        }
        await evalInFrame(`window.scrollTo(0,0)`);
        await delay(350);
        
        await cdpEval(tabId, prepareCaptureJS);
        if (useIframe) {
          await evalInFrame(prepareCaptureJS);
        }
        
        var y = 0;
        var lastCapturedY = -1;
        while (y < si.scrollHeight) {
            await evalInFrame(`window.scrollTo(0,${y})`);
            await delay(400);
            var actualY = await evalInFrame(`window.scrollY||window.pageYOffset||0`);
            
            if (y > 0 && actualY === lastCapturedY) {
                // We reached the bottom. Wait 750ms to see if dynamic content loads
                await delay(750);
                var checkH = await evalInFrame(`Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`);
                if (checkH + 150 > si.scrollHeight) {
                    si.scrollHeight = checkH + 150;
                    await evalInFrame(`window.scrollTo(0,${y})`);
                    actualY = await evalInFrame(`window.scrollY||window.pageYOffset||0`);
                }
                
                if (actualY === lastCapturedY) {
                    break;
                }
            }
            
            var sshot = await cdpCmd(tabId, 'Page.captureScreenshot', {format:'png'});
            captures.push({dataUrl:'data:image/png;base64,'+sshot.data, scrollY:actualY});
            lastCapturedY = actualY;
            
            var currentH = await evalInFrame(`Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`);
            if (currentH + 150 > si.scrollHeight) {
              si.scrollHeight = currentH + 150;
            }

            if (y === 0) {
              await cdpEval(tabId, hideFixedJS);
              if (useIframe) {
                await evalInFrame(hideFixedJS);
              }
            }

            var estTotal = Math.ceil(si.scrollHeight / Math.max(100, si.clientHeight - 150));
            setProgress(25+((y/si.scrollHeight)*55), `Section ${captures.length} of ~${estTotal}...`);
            y = actualY + Math.max(100, si.clientHeight - 150);
        }
      } else {
        await cdpEval(tabId, prepareCaptureJS);
        if (useIframe) {
          await evalInFrame(prepareCaptureJS);
        }
        
        var y = 0;
        var lastCapturedY = -1;
        while (y < si.scrollHeight) {
          await evalInFrame(`window.__ss_el.scrollTop=${y}`);
          await delay(350);
          var actualY = await evalInFrame(`window.__ss_el.scrollTop`);
          
          if (y > 0 && actualY === lastCapturedY) {
             // We reached the bottom. Wait 750ms to see if dynamic content loads
             await delay(750);
             var checkH = await evalInFrame(`window.__ss_el.scrollHeight`);
             if (checkH + 150 > si.scrollHeight) {
                si.scrollHeight = checkH + 150;
                await evalInFrame(`window.__ss_el.scrollTop=${y}`);
                actualY = await evalInFrame(`window.__ss_el.scrollTop`);
             }
             if (actualY === lastCapturedY) {
                break;
             }
          }
          
          var shot = await cdpCmd(tabId, 'Page.captureScreenshot', {format:'png'});
          captures.push({dataUrl:'data:image/png;base64,'+shot.data, scrollY:actualY});
          lastCapturedY = actualY;
          
          var currentH = await evalInFrame(`window.__ss_el.scrollHeight`);
          if (currentH + 150 > si.scrollHeight) {
            si.scrollHeight = currentH + 150;
          }

          if (y === 0) {
            await cdpEval(tabId, hideFixedJS);
            if (useIframe) {
              await evalInFrame(hideFixedJS);
            }
          }

          var estTotal = Math.ceil(si.scrollHeight / Math.max(100, si.clientHeight - 150));
          setProgress(25+((y/si.scrollHeight)*55), `Section ${captures.length} of ~${estTotal}...`);
          y = actualY + Math.max(100, si.clientHeight - 150);
        }
      }

      // Restore styles and scroll positions
      clearInterval(pingInterval);
      
      try {
        await cdpEval(tabId, restoreAllJS);
        if (useIframe) {
          await evalInFrame(restoreAllJS);
        }
      } catch(e) {}

      if (isDoc) {
        await evalInFrame(`(function(){ window.scrollTo(0,window.__ss_origScroll||0);
          var e=document.getElementById('__ss_hide'); if(e)e.remove(); 
          if(window.__ss_interval) { clearInterval(window.__ss_interval); window.__ss_interval=null; } })()`);
      } else {
        await evalInFrame(`(function(){ window.__ss_el.scrollTop=window.__ss_origScroll;
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
      // FULL PAGE SCROLL MODE
      setProgress(22, `Full page: ${mainInfo.scrollH}px tall`);
      await delay(300);

      await cdpEval(tabId, `window.__ss_origY=window.scrollY`);
      var y = 0;
      while (y < mainInfo.scrollH) {
        await cdpEval(tabId, `window.scrollTo(0,${y})`);
        await delay(200);
        setProgress(25+((y/mainInfo.scrollH)*15), 'Scrolling down...');
        
        var currentH = await cdpEval(tabId, `Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`);
        if (currentH + 150 > mainInfo.scrollH) {
          mainInfo.scrollH = currentH + 150;
        }
        y += mainInfo.vh;
      }
      await cdpEval(tabId, `window.scrollTo(0,0)`);
      await delay(350);

      try {
        await cdpEval(tabId, prepareCaptureJS);
      } catch(e) {}

      var y = 0;
      var lastCapturedY = -1;
      while (y < mainInfo.scrollH) {
        await cdpEval(tabId, `window.scrollTo(0,${y})`);
        await delay(400);
        var actualY = await cdpEval(tabId, `window.scrollY`);
        
        if (y > 0 && actualY === lastCapturedY) {
           // We reached the bottom. Wait 750ms to see if dynamic content loads
           await delay(750);
           var checkH = await cdpEval(tabId, `Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`);
           if (checkH + 150 > mainInfo.scrollH) {
              mainInfo.scrollH = checkH + 150;
              await cdpEval(tabId, `window.scrollTo(0,${y})`);
              actualY = await cdpEval(tabId, `window.scrollY`);
           }
           if (actualY === lastCapturedY) {
              break;
           }
        }
        
        var sshot = await cdpCmd(tabId, 'Page.captureScreenshot', {format:'png'});
        captures.push({dataUrl:'data:image/png;base64,'+sshot.data, scrollY:actualY});
        lastCapturedY = actualY;
        
        var currentH = await cdpEval(tabId, `Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`);
        if (currentH + 150 > mainInfo.scrollH) {
          mainInfo.scrollH = currentH + 150;
        }

        if (y === 0) {
          try {
            await cdpEval(tabId, hideFixedJS);
          } catch(e) {}
        }

        setProgress(25+((y/mainInfo.scrollH)*55), `Section ${captures.length}...`);
        y = actualY + Math.max(100, mainInfo.vh - 150);
      }

      try {
        await cdpEval(tabId, restoreAllJS);
      } catch(e) {}

      await cdpEval(tabId, `(function(){ window.scrollTo(0,window.__ss_origY||0);
        var e=document.getElementById('__ss_hide'); if(e)e.remove(); })()`);

      var finalHeight = mainInfo.scrollH;
      if (captures.length > 0) {
        var last = captures[captures.length - 1];
        finalHeight = last.scrollY + mainInfo.vh;
      }

      return {mode:'fullpage', captures, viewportWidth:mainInfo.vw, viewportHeight:mainInfo.vh,
        totalHeight:finalHeight, totalWidth:mainInfo.vw, devicePixelRatio:mainInfo.dpr};
    }
  } finally {
    try { await cdpDetach(tabId); } catch(e){}
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN FLOW
// ═══════════════════════════════════════════════════════════════

async function startCapture() {
  showView(progressView);
  setProgress(5,'Preparing...');
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab) throw new Error('No active tab');

    let result = null;

    // Always use CDP — reliable for all pages, handles scroll/no-scroll, iframes, etc.
    try {
      setProgress(10,'Capturing page...');
      result = await cdpCapture(tab);
    } catch(e) {
      console.error('CDP failed:',e.message);
      throw new Error('Capture failed: '+e.message);
    }

    let canvas = null;
    if (result) {
      setProgress(80,'Stitching...');
      if (result.mode==='fullpage') {
        canvas = await stitchFull(result);
      } else if (result.mode==='element') {
        canvas = await stitchEl(result);
      } else if (result.captures && result.captures.length > 0) {
        canvas=document.createElement('canvas');
        const img=await loadImage(result.captures[0].dataUrl);
        canvas.width=img.width; canvas.height=img.height;
        canvas.getContext('2d').drawImage(img,0,0);
      }
    }

    if (!canvas) throw new Error("Capture produced no image data.");

    capturedCanvas=canvas;
    setProgress(95,'Finalizing...');
    previewCanvas.width=canvas.width; previewCanvas.height=canvas.height;
    previewCanvas.getContext('2d').drawImage(canvas,0,0);
    const kb=Math.round(canvas.toDataURL('image/png').length*0.75/1024);
    resultInfo.textContent=`${canvas.width} × ${canvas.height}px · ~${kb>1024?(kb/1024).toFixed(1)+' MB':kb+' KB'}`;
    downloadLabel.textContent=`Download ${selectedFormat.toUpperCase()}`;
    setProgress(100,'Done!'); await delay(400);
    showView(resultView);
  } catch(err) {
    console.error(err);
    const m=(err.message||'Unknown').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
    errorMessage.innerHTML=`<b>Error</b><br><br><div style="text-align:left;font-size:11px;line-height:1.6;background:rgba(0,0,0,.3);padding:12px;border-radius:8px;word-break:break-word">${m}</div>`;
    showView(errorView);
  }
}

downloadBtn.addEventListener('click',()=>{
  if(!capturedCanvas) return;
  const ts=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19), fn=`screenshot-${ts}`;
  if(selectedFormat==='png') {
    capturedCanvas.toBlob(b=>{ const u=URL.createObjectURL(b),a=document.createElement('a'); a.href=u;a.download=fn+'.png';a.click();URL.revokeObjectURL(u); },'image/png');
  } else { downloadFile(generatePDF(capturedCanvas),fn+'.pdf','application/pdf'); }
});

captureBtn.addEventListener('click',startCapture);
retryBtn.addEventListener('click',()=>{ showView(mainView); setTimeout(startCapture,100); });
backBtn.addEventListener('click',()=>showView(mainView));
