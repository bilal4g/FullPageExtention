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

  async function stitch(cap) {
    const dpr = (cap.page && cap.page.devicePixelRatio) || 1;
    if (!cap.frames || cap.frames.length <= 1) return cap.frames[0].dataUrl;
    const imgs = [];
    for (const f of cap.frames) imgs.push({ img: await loadImage(f.dataUrl), y: Math.round(f.scrollY * dpr) });
    let w = 0, bottom = 0;
    for (const it of imgs) { w = Math.max(w, it.img.width); bottom = Math.max(bottom, it.y + it.img.height); }
    const c = document.createElement('canvas'); c.width = w; c.height = bottom;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, bottom); ctx.imageSmoothingEnabled = false;
    for (const it of imgs) ctx.drawImage(it.img, 0, it.y);
    return c.toDataURL('image/png');
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
    show('view-progress');
    setStatus('prog-status', mode === 'full' ? 'Capturing full page… stitching, hang tight.' : 'Capturing…');
    chrome.runtime.sendMessage({ type: 'studio:capture', mode, tabId }, (res) => {
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
    const scale = await new Promise((r) => chrome.storage.local.get([SETTINGS_KEY], (d) => r((d[SETTINGS_KEY] && d[SETTINGS_KEY].exportScale) || 1)));
    if (format === 'png') { const c = await scaledCanvas(scale); download(c.toDataURL('image/png'), 'fullpage.png'); }
    else if (format === 'jpg') { const c = await scaledCanvas(scale, '#fff'); download(c.toDataURL('image/jpeg', 0.92), 'fullpage.jpg'); }
    else if (format === 'pdf') { const c = await scaledCanvas(scale, '#fff'); const bytes = makePdf(c); download(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), 'fullpage.pdf'); }
    setStatus('res-status', 'Exported ' + format.toUpperCase() + '.');
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

  // wire up
  $('cap-full').addEventListener('click', () => capture('full'));
  $('cap-visible').addEventListener('click', () => capture('visible'));
  $('open-settings').addEventListener('click', () => { if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage(); else chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }); });
  $('btn-again').addEventListener('click', () => { show('view-capture'); setStatus('cap-status', 'Pick a capture to start.'); });
  $('btn-studio').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('studio.html') }); window.close(); });
  $('btn-export').addEventListener('click', doExport);
  $('btn-copy').addEventListener('click', doCopy);
  document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => { document.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active')); b.classList.add('active'); format = b.dataset.fmt; }));
})();
