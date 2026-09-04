/* FullPage Studio - popup.
 * Captures via the background worker, then shows the result INLINE in the
 * popup (preview + Export + Copy). Studio is opt-in via a button. */
(function () {
  const $ = (id) => document.getElementById(id);
  const CAP_KEY = 'fp_last_capture';
  const SETTINGS_KEY = 'fp_settings';
  const MAX_SIDE = 7680;

  let stitchedUrl = null;   // full-res data URL of the capture
  let dims = { w: 0, h: 0 };
  let format = 'png';

  function show(view) { document.querySelectorAll('.view').forEach((v) => v.classList.remove('active')); $(view).classList.add('active'); }
  function setStatus(id, msg) { $(id).textContent = msg || ''; }
  function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }

  async function activeTabId() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return tab && tab.id; }

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

  async function stitchEl(cap) {
    const d = (cap.page && cap.page.devicePixelRatio) || 1;
    const r = cap.page.elementRect;
    const ew = Math.round(r.width * d);
    const sx = Math.round(r.left * d);
    const sy = Math.round(r.top * d);
    const sliceH = Math.round(cap.page.elementClientHeight * d);

    const loaded = [];
    for (let i = 0; i < cap.frames.length; i++) {
      const img = await loadImage(cap.frames[i].dataUrl);
      const dy = Math.round(cap.frames[i].scrollY * d);
      loaded.push({ img, dy });
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
    }
    return trimTrailingWhite(c);
  }

  async function stitch(cap) {
    const dpr = (cap.page && cap.page.devicePixelRatio) || 1;
    if (!cap.frames || cap.frames.length === 0) return '';
    if (cap.frames.length === 1) return cap.frames[0].dataUrl;
    
    if (cap.page && cap.page.captureMode === 'element' && cap.page.elementRect) {
      const elCanvas = await stitchEl(cap);
      return elCanvas.toDataURL('image/png');
    }
    
    const imgs = [];
    for (const f of cap.frames) imgs.push({ img: await loadImage(f.dataUrl), y: Math.round(f.scrollY * dpr) });
    let w = 0, bottom = 0;
    for (const it of imgs) { w = Math.max(w, it.img.width); bottom = Math.max(bottom, it.y + it.img.height); }
    const c = document.createElement('canvas'); c.width = w; c.height = bottom;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, bottom); ctx.imageSmoothingEnabled = false;
    for (const it of imgs) ctx.drawImage(it.img, 0, it.y);
    return trimTrailingWhite(c).toDataURL('image/png');
  }

  async function showResult(cap) {
    stitchedUrl = await stitch(cap);
    const img = await loadImage(stitchedUrl);
    dims = { w: img.naturalWidth, h: img.naturalHeight };
    $('preview-img').src = stitchedUrl;
    const eqs = (cap.metadata && cap.metadata.math && cap.metadata.math.count) || 0;
    $('result-meta').textContent = dims.w + ' × ' + dims.h + ' px' + (eqs ? '  ·  ' + eqs + ' equation' + (eqs === 1 ? '' : 's') + ' detected' : '');
    show('view-result');
  }

  async function capture(mode) {
    const tabId = await activeTabId();
    if (!tabId) { setStatus('cap-status', 'No active tab to capture.'); return; }
    if (mode === 'full' && !chrome.debugger) {
      show('view-capture');
      setStatus('cap-status', 'Error: Debugger API is missing. You MUST go to chrome://extensions and click "Reload" on FullPage Studio to apply the new permissions!');
      return;
    }
    show('view-progress');
    setStatus('prog-status', mode === 'full' ? 'Starting capture...' : 'Capturing…');

    const progressListener = (msg) => {
      if (msg && msg.type === 'studio:capture_progress' && msg.status) {
        setStatus('prog-status', msg.status);
      }
    };
    chrome.runtime.onMessage.addListener(progressListener);

    chrome.runtime.sendMessage({ type: 'studio:capture', mode, tabId }, (res) => {
      chrome.runtime.onMessage.removeListener(progressListener);
      if (chrome.runtime.lastError) { show('view-capture'); setStatus('cap-status', 'Capture failed: ' + chrome.runtime.lastError.message); return; }
      if (res && res.ok) {
        chrome.storage.local.get([CAP_KEY], async (d) => {
          try { await showResult(d[CAP_KEY]); }
          catch (e) { show('view-capture'); setStatus('cap-status', 'Could not render capture. Try again.'); }
        });
      } else { show('view-capture'); setStatus('cap-status', 'Capture failed: ' + ((res && res.error) || 'unknown') + '. Try reloading the page.'); }
    });
  }

  function scaledCanvas(scale, bg) {
    let s = scale === 'max' ? Math.max(1, Math.min(MAX_SIDE / dims.w, MAX_SIDE / dims.h)) : (scale || 1);
    const longest = Math.max(dims.w, dims.h) * s; if (longest > MAX_SIDE) s = MAX_SIDE / Math.max(dims.w, dims.h);
    return loadImage(stitchedUrl).then((img) => {
      const c = document.createElement('canvas'); c.width = Math.round(dims.w * s); c.height = Math.round(dims.h * s);
      const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
      ctx.drawImage(img, 0, 0, c.width, c.height); return c;
    });
  }
  function download(url, name) { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); }

  async function doExport() {
    if (!stitchedUrl) return;
    const settings = await new Promise((r) => chrome.storage.local.get([SETTINGS_KEY], (d) => r(d[SETTINGS_KEY] || {})));
    const scale = settings.exportScale || 1;
    const sliceHeight = parseInt(settings.sliceHeight, 10) || 1500;
    const sliceEnabled = $('slice-enabled').checked;

    const baseCanvas = await scaledCanvas(scale, (format === 'jpg' || format === 'pdf') ? '#fff' : null);
    const w = baseCanvas.width;
    const h = baseCanvas.height;

    if (sliceEnabled && h > sliceHeight) {
      if (format === 'pdf') {
        const slices = [];
        let y = 0;
        while (y < h) {
          const sh = Math.min(sliceHeight, h - y);
          const sliceCanvas = document.createElement('canvas');
          sliceCanvas.width = w;
          sliceCanvas.height = sh;
          sliceCanvas.getContext('2d').drawImage(baseCanvas, 0, y, w, sh, 0, 0, w, sh);
          slices.push(sliceCanvas);
          y += sh;
        }
        const bytes = makeMultiPagePdf(slices);
        download(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), 'fullpage_sliced.pdf');
        setStatus('res-status', 'Exported PDF (sliced).');
      } else {
        let y = 0;
        let part = 1;
        while (y < h) {
          const sh = Math.min(sliceHeight, h - y);
          const sliceCanvas = document.createElement('canvas');
          sliceCanvas.width = w;
          sliceCanvas.height = sh;
          sliceCanvas.getContext('2d').drawImage(baseCanvas, 0, y, w, sh, 0, 0, w, sh);
          
          const mime = format === 'webp' ? 'image/webp' : (format === 'jpg' ? 'image/jpeg' : 'image/png');
          download(sliceCanvas.toDataURL(mime, 0.92), `fullpage_part${part}.${format}`);
          y += sh;
          part++;
          await new Promise(r => setTimeout(r, 250));
        }
        setStatus('res-status', `Exported ${part - 1} slices.`);
      }
    } else {
      if (format === 'png') { download(baseCanvas.toDataURL('image/png'), 'fullpage.png'); }
      else if (format === 'jpg') { download(baseCanvas.toDataURL('image/jpeg', 0.92), 'fullpage.jpg'); }
      else if (format === 'pdf') { const bytes = makePdf(baseCanvas); download(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), 'fullpage.pdf'); }
      setStatus('res-status', 'Exported ' + format.toUpperCase() + '.');
    }
  }

  async function doCopy() {
    if (!stitchedUrl) return;
    try { const c = await scaledCanvas(1); const blob = await new Promise((r) => c.toBlob(r, 'image/png')); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); setStatus('res-status', 'Copied to clipboard.'); }
    catch (e) { setStatus('res-status', 'Copy failed — try Export.'); }
  }

  function makePdf(canvas) {
    const imgBytes = atob(canvas.toDataURL('image/jpeg', 0.92).split(',')[1]);
    const iW = canvas.width, iH = canvas.height, pw = 595.28, m = 36, cw = pw - m * 2, sc = cw / iW, ch = iH * sc, ph = ch + m * 2;
    const sd = 'q ' + cw + ' 0 0 ' + ch + ' ' + m + ' ' + m + ' cm /Img Do Q';
    let pdf = '%PDF-1.4\n'; const off = [];
    off.push(pdf.length); pdf += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
    off.push(pdf.length); pdf += '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
    off.push(pdf.length); pdf += '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] /Contents 4 0 R /Resources << /XObject << /Img 5 0 R >> >> >>\nendobj\n';
    off.push(pdf.length); pdf += '4 0 obj\n<< /Length ' + sd.length + ' >>\nstream\n' + sd + '\nendstream\nendobj\n';
    off.push(pdf.length); pdf += '5 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + iW + ' /Height ' + iH + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + imgBytes.length + ' >>\nstream\n';
    const before = pdf; pdf += '\nendstream\nendobj\n';
    const xrefOff = before.length + imgBytes.length + ('\nendstream\nendobj\n').length;
    let xref = 'xref\n0 ' + (off.length + 1) + '\n0000000000 65535 f \n'; off.forEach((o) => { xref += String(o).padStart(10, '0') + ' 00000 n \n'; });
    pdf += xref + 'trailer\n<< /Size ' + (off.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF';
    const arr = new Uint8Array(before.length + imgBytes.length + (pdf.length - before.length));
    for (let i = 0; i < before.length; i++) arr[i] = before.charCodeAt(i);
    for (let i = 0; i < imgBytes.length; i++) arr[before.length + i] = imgBytes.charCodeAt(i);
    const after = pdf.slice(before.length); for (let i = 0; i < after.length; i++) arr[before.length + imgBytes.length + i] = after.charCodeAt(i);
    return arr;
  }

  function makeMultiPagePdf(slices) {
    const pw = 595.28;
    const m = 36;
    const cw = pw - m * 2;
    
    const imageInfos = slices.map(canvas => {
      const imgDataUrl = canvas.toDataURL('image/jpeg', 0.92);
      const imgBytes = atob(imgDataUrl.split(',')[1]);
      const iW = canvas.width;
      const iH = canvas.height;
      const sc = cw / iW;
      const ch = iH * sc;
      const ph = ch + m * 2;
      return { bytes: imgBytes, w: iW, h: iH, ch, ph };
    });
    
    const off = [];
    const parts = [];
    let currentOffset = 0;
    
    function writeText(str) {
      parts.push({ type: 'text', val: str });
      currentOffset += str.length;
    }
    function writeBinary(str) {
      parts.push({ type: 'binary', val: str });
      currentOffset += str.length;
    }
    
    writeText('%PDF-1.4\n');
    
    // Catalog
    off.push(currentOffset);
    writeText('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    
    // Page list references
    const pageRefs = imageInfos.map((_, idx) => `${3 + idx * 3} 0 R`).join(' ');
    
    // Pages
    off.push(currentOffset);
    writeText(`2 0 obj\n<< /Type /Pages /Kids [${pageRefs}] /Count ${imageInfos.length} >>\nendobj\n`);
    
    // Write pages
    for (let j = 0; j < imageInfos.length; j++) {
      const info = imageInfos[j];
      const pageId = 3 + j * 3;
      const contentsId = 4 + j * 3;
      const imgId = 5 + j * 3;
      
      const drawCmd = `q ${cw.toFixed(2)} 0 0 ${info.ch.toFixed(2)} ${m} ${m} cm /Img Do Q`;
      
      // Page object
      off.push(currentOffset);
      writeText(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${info.ph.toFixed(2)}] /Contents ${contentsId} 0 R /Resources << /XObject << /Img ${imgId} 0 R >> >> >>\nendobj\n`);
      
      // Contents object
      off.push(currentOffset);
      writeText(`${contentsId} 0 obj\n<< /Length ${drawCmd.length} >>\nstream\n${drawCmd}\nendstream\nendobj\n`);
      
      // Image object
      off.push(currentOffset);
      writeText(`${imgId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${info.w} /Height ${info.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${info.bytes.length} >>\nstream\n`);
      
      writeBinary(info.bytes);
      
      writeText('\nendstream\nendobj\n');
    }
    
    // xref table
    const xrefOffset = currentOffset;
    let xrefText = 'xref\n0 ' + (off.length + 1) + '\n0000000000 65535 f \n';
    off.forEach((o) => {
      xrefText += String(o).padStart(10, '0') + ' 00000 n \n';
    });
    
    writeText(xrefText);
    writeText(`trailer\n<< /Size ${off.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
    
    const totalLength = parts.reduce((acc, p) => acc + p.val.length, 0);
    const arr = new Uint8Array(totalLength);
    let ptr = 0;
    for (const p of parts) {
      for (let i = 0; i < p.val.length; i++) {
        arr[ptr++] = p.val.charCodeAt(i);
      }
    }
    return arr;
  }

  // wire up
  $('cap-full').addEventListener('click', () => capture('full'));
  $('cap-visible').addEventListener('click', () => capture('visible'));
  $('open-settings').addEventListener('click', () => { if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage(); else chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }); });
  $('btn-again').addEventListener('click', () => { show('view-capture'); setStatus('cap-status', 'Pick a capture to start.'); });
  $('btn-studio').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') }); window.close(); });
  $('btn-export').addEventListener('click', doExport);
  $('btn-copy').addEventListener('click', doCopy);
  document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => { document.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active')); b.classList.add('active'); format = b.dataset.fmt; }));

  // Initialize slice checkbox state from settings
  const sliceEl = $('slice-enabled');
  if (sliceEl) {
    chrome.storage.local.get([SETTINGS_KEY], (d) => {
      const s = d[SETTINGS_KEY] || {};
      sliceEl.checked = !!s.sliceEnabled;
    });

    // Save slice preference when changed
    sliceEl.addEventListener('change', () => {
      chrome.storage.local.get([SETTINGS_KEY], (d) => {
        const s = d[SETTINGS_KEY] || {};
        s.sliceEnabled = sliceEl.checked;
        chrome.storage.local.set({ [SETTINGS_KEY]: s });
      });
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'studio:capture_progress') {
      setStatus('prog-status', msg.status);
    }
  });
})();
