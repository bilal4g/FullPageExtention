/* FullPage Studio - editor engine (no external APIs). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const CAP_KEY = 'fp_last_capture';
  const SETTINGS_KEY = 'fp_settings';

  const emptyEl = $('empty');
  const host = $('canvas-host');
  const scaler = $('canvas-scaler');
  const stage = $('stage');
  const overlay = $('overlay');
  const textLayer = $('text-layer');
  const stageWrap = $('stage-wrap');
  const sctx = stage.getContext('2d');
  const octx = overlay.getContext('2d');

  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  let zoom = 1, tool = 'pan', history = [], redoStack = [], drag = null;
  let cropSel = null, cropAR = null, activeText = null;
  let equations = [], captureUrl = '';
  let exportScale = 2, exportFormat = 'png';

  const DRAW_TOOLS = ['pen', 'arrow', 'rect', 'ellipse', 'highlight', 'blur', 'redact'];
  const MAX_SIDE = 7680; // 8K cap

  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), 2200); }
  function opts() { return { stroke: $('opt-stroke').value, width: parseInt($('opt-width').value, 10) || 4, fill: $('opt-fill').checked, fillColor: $('opt-fillcolor').value }; }
  function coords(e) { const r = overlay.getBoundingClientRect(); const sx = work.width / r.width, sy = work.height / r.height; return { x: Math.max(0, Math.min(work.width, (e.clientX - r.left) * sx)), y: Math.max(0, Math.min(work.height, (e.clientY - r.top) * sy)) }; }
  function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }

  async function setFromSource(src) {
    const img = await loadImage(src);
    work.width = img.naturalWidth || img.width; work.height = img.naturalHeight || img.height;
    wctx.clearRect(0, 0, work.width, work.height); wctx.drawImage(img, 0, 0);
    emptyEl.hidden = true; host.hidden = false;
    syncSizes(); fitZoom(); redraw(); history = []; redoStack = []; pushHistory(); updateDims();
  }
  async function applySnapshot(url) { const img = await loadImage(url); work.width = img.width; work.height = img.height; wctx.clearRect(0, 0, work.width, work.height); wctx.drawImage(img, 0, 0); syncSizes(); redraw(); updateDims(); }

  // ---- Boot: load the capture from storage and stitch full-page frames ----
  async function stitchFrames(cap) {
    const dpr = (cap.page && cap.page.devicePixelRatio) || 1;
    const imgs = [];
    for (const f of cap.frames) imgs.push({ img: await loadImage(f.dataUrl), y: Math.round(f.scrollY * dpr) });
    if (imgs.length === 1) { return cap.frames[0].dataUrl; }
    let w = 0, bottom = 0;
    for (const it of imgs) { w = Math.max(w, it.img.width); bottom = Math.max(bottom, it.y + it.img.height); }
    const c = document.createElement('canvas'); c.width = w; c.height = bottom;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, bottom); ctx.imageSmoothingEnabled = false;
    for (const it of imgs) ctx.drawImage(it.img, 0, it.y);
    return c.toDataURL('image/png');
  }
  async function boot() {
    bind(); setTool('pan');
    chrome.storage.local.get([SETTINGS_KEY], (d) => {
      const s = d[SETTINGS_KEY] || {};
      if (s.exportScale) { exportScale = s.exportScale === 'max' ? 'max' : Number(s.exportScale); $('set-scale').value = String(s.exportScale); markScale(); }
      if (s.defaultFormat) { exportFormat = s.defaultFormat; $('set-format').value = s.defaultFormat; }
    });
    chrome.storage.local.get([CAP_KEY], async (d) => {
      const cap = d[CAP_KEY];
      if (!cap || !cap.frames || !cap.frames.length) return;
      captureUrl = (cap.tab && cap.tab.url) || '';
      equations = (cap.metadata && cap.metadata.math && cap.metadata.math.equations) || [];
      updateMathStatus();
      try { const stitched = await stitchFrames(cap); await setFromSource(stitched); }
      catch (e) { try { await setFromSource(cap.frames[0].dataUrl); } catch (_) {} }
    });
  }

  function syncSizes() { stage.width = work.width; stage.height = work.height; overlay.width = work.width; overlay.height = work.height; applyZoom(zoom, true); }
  function applyZoom(z, silent) {
    zoom = Math.max(0.1, Math.min(4, z));
    const w = Math.round(work.width * zoom), h = Math.round(work.height * zoom);
    stage.style.width = overlay.style.width = w + 'px'; stage.style.height = overlay.style.height = h + 'px';
    scaler.style.width = w + 'px'; scaler.style.height = h + 'px';
    $('zoom-label').textContent = Math.round(zoom * 100) + '%';
    if (!silent) $('zoom-range').value = Math.round(zoom * 100);
    repositionText();
  }
  function fitZoom() { const pad = 64; const z = Math.min((stageWrap.clientWidth - pad) / work.width, (stageWrap.clientHeight - pad) / work.height, 1); applyZoom(z > 0 ? z : 1); }
  function redraw() { sctx.clearRect(0, 0, stage.width, stage.height); sctx.drawImage(work, 0, 0); }
  function clearOverlay() { octx.clearRect(0, 0, overlay.width, overlay.height); }
  function updateDims() { $('status-dims').textContent = work.width + ' × ' + work.height + ' px'; }
  function updateMathStatus() { const n = equations.length; $('status-math').textContent = n ? (n + ' equation' + (n === 1 ? '' : 's') + ' detected') : ''; }

  function pushHistory() { try { history.push(work.toDataURL('image/png')); } catch (e) {} if (history.length > 30) history.shift(); redoStack = []; }
  async function undo() { if (history.length < 2) return; redoStack.push(history.pop()); await applySnapshot(history[history.length - 1]); }
  async function redo() { if (!redoStack.length) return; const d = redoStack.pop(); history.push(d); await applySnapshot(d); }

  function setTool(t) {
    if (activeText) applyText();
    tool = t;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    $('grp-crop').hidden = t !== 'crop'; $('grp-draw').hidden = !DRAW_TOOLS.includes(t); $('grp-text').hidden = t !== 'text';
    $('status-tool').textContent = ({ pan: 'Move', crop: 'Crop', text: 'Text', pen: 'Pen', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Ellipse', highlight: 'Highlighter', blur: 'Blur', redact: 'Redact' })[t] || t;
    overlay.style.cursor = t === 'pan' ? 'grab' : (t === 'text' ? 'text' : 'crosshair');
    if (t !== 'crop') { cropSel = null; clearOverlay(); }
  }

  function renderShape(ctx, t, a, b, pts, o) {
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = o.stroke; ctx.fillStyle = o.fill ? o.fillColor : o.stroke; ctx.lineWidth = o.width;
    if (t === 'pen') { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke(); }
    else if (t === 'highlight') { ctx.globalAlpha = 0.35; ctx.lineWidth = Math.max(o.width, 14); ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke(); }
    else if (t === 'arrow') { const ang = Math.atan2(b.y - a.y, b.x - a.x), head = Math.max(12, o.width * 3.2); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(ang - Math.PI / 7), b.y - head * Math.sin(ang - Math.PI / 7)); ctx.lineTo(b.x - head * Math.cos(ang + Math.PI / 7), b.y - head * Math.sin(ang + Math.PI / 7)); ctx.closePath(); ctx.fillStyle = o.stroke; ctx.fill(); }
    else if (t === 'rect') { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y); if (o.fill) ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); }
    else if (t === 'ellipse') { const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2; ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); if (o.fill) ctx.fill(); ctx.stroke(); }
    else if (t === 'redact') { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); ctx.fillStyle = '#000'; ctx.fillRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y)); }
    else if (t === 'blur') { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); ctx.globalAlpha = 0.25; ctx.fillStyle = '#6366f1'; ctx.fillRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y)); }
    ctx.restore();
  }
  function blurRegion(x, y, w, h) { if (w < 2 || h < 2) return; const tmp = document.createElement('canvas'); const s = 0.06; tmp.width = Math.max(1, Math.round(w * s)); tmp.height = Math.max(1, Math.round(h * s)); tmp.getContext('2d').drawImage(work, x, y, w, h, 0, 0, tmp.width, tmp.height); wctx.save(); wctx.imageSmoothingEnabled = true; wctx.imageSmoothingQuality = 'low'; wctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h); wctx.restore(); }

  function drawCropOverlay() {
    clearOverlay(); if (!cropSel) return; const { x, y, w, h } = cropSel;
    octx.save(); octx.fillStyle = 'rgba(0,0,0,0.5)'; octx.fillRect(0, 0, overlay.width, overlay.height); octx.clearRect(x, y, w, h);
    octx.strokeStyle = '#6366f1'; octx.lineWidth = 2 / zoom; octx.strokeRect(x, y, w, h);
    octx.fillStyle = '#6366f1'; [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([hx, hy]) => { const s = 8 / zoom; octx.fillRect(hx - s / 2, hy - s / 2, s, s); }); octx.restore();
  }
  function applyCrop() {
    if (!cropSel || cropSel.w < 4 || cropSel.h < 4) { toast('Draw a crop area first'); return; }
    const { x, y, w, h } = cropSel; const nc = document.createElement('canvas'); nc.width = Math.round(w); nc.height = Math.round(h);
    nc.getContext('2d').drawImage(work, x, y, w, h, 0, 0, nc.width, nc.height);
    work.width = nc.width; work.height = nc.height; wctx.clearRect(0, 0, work.width, work.height); wctx.drawImage(nc, 0, 0);
    cropSel = null; syncSizes(); fitZoom(); redraw(); clearOverlay(); pushHistory(); updateDims(); toast('Cropped');
  }
  function rotate(dir) { const nc = document.createElement('canvas'); nc.width = work.height; nc.height = work.width; const c = nc.getContext('2d'); c.translate(nc.width / 2, nc.height / 2); c.rotate((dir > 0 ? 90 : -90) * Math.PI / 180); c.drawImage(work, -work.width / 2, -work.height / 2); work.width = nc.width; work.height = nc.height; wctx.clearRect(0, 0, work.width, work.height); wctx.drawImage(nc, 0, 0); syncSizes(); fitZoom(); redraw(); pushHistory(); updateDims(); }
  function flip(axis) { const nc = document.createElement('canvas'); nc.width = work.width; nc.height = work.height; const c = nc.getContext('2d'); if (axis === 'h') { c.translate(nc.width, 0); c.scale(-1, 1); } else { c.translate(0, nc.height); c.scale(1, -1); } c.drawImage(work, 0, 0); wctx.clearRect(0, 0, work.width, work.height); wctx.drawImage(nc, 0, 0); redraw(); pushHistory(); }
  function resizeTo(w, h) { if (!w || !h) return; const nc = document.createElement('canvas'); nc.width = Math.round(w); nc.height = Math.round(h); const c = nc.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(work, 0, 0, nc.width, nc.height); work.width = nc.width; work.height = nc.height; wctx.clearRect(0, 0, work.width, work.height); wctx.drawImage(nc, 0, 0); syncSizes(); fitZoom(); redraw(); pushHistory(); updateDims(); }

  function createText(pt) { if (activeText) applyText(); const el = document.createElement('div'); el.className = 'text-edit'; el.contentEditable = 'true'; el.dataset.cx = pt.x; el.dataset.cy = pt.y; el.textContent = 'Text'; styleTextEl(el); textLayer.appendChild(el); activeText = el; positionTextEl(el); setTimeout(() => { el.focus(); const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }, 0); }
  function styleTextEl(el) { const size = parseInt($('opt-fontsize').value, 10) || 32; el.style.fontFamily = $('opt-font').value; el.style.fontSize = (size * zoom) + 'px'; el.style.color = $('opt-textcolor').value; el.style.fontWeight = $('opt-bold').checked ? '700' : '400'; el.style.background = $('opt-textbg').checked ? 'rgba(0,0,0,0.55)' : 'transparent'; }
  function positionTextEl(el) { el.style.left = (parseFloat(el.dataset.cx) * zoom) + 'px'; el.style.top = (parseFloat(el.dataset.cy) * zoom) + 'px'; }
  function repositionText() { if (activeText) { styleTextEl(activeText); positionTextEl(activeText); } }
  function applyText() {
    const el = activeText; if (!el) return; activeText = null;
    const txt = el.innerText.replace(/\u00a0/g, ' '); const cx = parseFloat(el.dataset.cx), cy = parseFloat(el.dataset.cy);
    const size = parseInt($('opt-fontsize').value, 10) || 32; const font = $('opt-font').value; const bold = $('opt-bold').checked ? 'bold ' : '';
    el.remove(); if (!txt.trim()) return;
    wctx.save(); wctx.textBaseline = 'top'; wctx.font = bold + size + 'px ' + font;
    const lines = txt.split('\n'), lh = size * 1.2;
    if ($('opt-textbg').checked) { let mw = 0; lines.forEach((l) => { mw = Math.max(mw, wctx.measureText(l).width); }); wctx.fillStyle = 'rgba(0,0,0,0.55)'; wctx.fillRect(cx - 4, cy - 2, mw + 8, lh * lines.length + 4); }
    wctx.fillStyle = $('opt-textcolor').value; lines.forEach((l, i) => wctx.fillText(l, cx, cy + i * lh)); wctx.restore(); redraw(); pushHistory();
  }
  function cancelText() { if (activeText) { activeText.remove(); activeText = null; } }

  overlay.addEventListener('pointerdown', (e) => {
    overlay.setPointerCapture(e.pointerId); const p = coords(e);
    if (tool === 'pan') { drag = { pan: true, sx: e.clientX, sy: e.clientY, sl: stageWrap.scrollLeft, st: stageWrap.scrollTop }; overlay.style.cursor = 'grabbing'; return; }
    if (tool === 'text') { createText(p); return; }
    if (tool === 'crop') { drag = { crop: true, a: p }; cropSel = { x: p.x, y: p.y, w: 0, h: 0 }; return; }
    if (DRAW_TOOLS.includes(tool)) { drag = { a: p, b: p, pts: [p], o: opts() }; }
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.pan) { stageWrap.scrollLeft = drag.sl - (e.clientX - drag.sx); stageWrap.scrollTop = drag.st - (e.clientY - drag.sy); return; }
    const p = coords(e);
    if (drag.crop) { let w = p.x - drag.a.x, h = p.y - drag.a.y; if (cropAR) { h = Math.sign(h || 1) * Math.abs(w) / cropAR; } cropSel = { x: Math.min(drag.a.x, drag.a.x + w), y: Math.min(drag.a.y, drag.a.y + h), w: Math.abs(w), h: Math.abs(h) }; drawCropOverlay(); return; }
    drag.b = p; drag.pts.push(p); clearOverlay(); renderShape(octx, tool, drag.a, drag.b, drag.pts, drag.o);
  });
  overlay.addEventListener('pointerup', (e) => {
    if (!drag) return;
    if (drag.pan) { drag = null; overlay.style.cursor = 'grab'; return; }
    if (drag.crop) { drag = null; return; }
    const p = coords(e); drag.b = p;
    if (tool === 'blur') { blurRegion(Math.min(drag.a.x, p.x), Math.min(drag.a.y, p.y), Math.abs(p.x - drag.a.x), Math.abs(p.y - drag.a.y)); }
    else { renderShape(wctx, tool, drag.a, drag.b, drag.pts, drag.o); }
    clearOverlay(); redraw(); pushHistory(); drag = null;
  });

  // ---- Export (with scale up to 8K) ----
  function scaledCanvas(bg) {
    let s = exportScale === 'max' ? Math.max(1, Math.min(MAX_SIDE / work.width, MAX_SIDE / work.height)) : exportScale;
    if (exportScale !== 'max') { const longest = Math.max(work.width, work.height) * s; if (longest > MAX_SIDE) s = MAX_SIDE / Math.max(work.width, work.height); }
    const nc = document.createElement('canvas'); nc.width = Math.round(work.width * s); nc.height = Math.round(work.height * s);
    const c = nc.getContext('2d'); c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    if (bg) { c.fillStyle = bg; c.fillRect(0, 0, nc.width, nc.height); }
    c.drawImage(work, 0, 0, nc.width, nc.height); return nc;
  }
  function download(url, name) { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); }
  function exportAs(type) {
    if (host.hidden) { toast('Load an image first'); return; }
    if (type === 'png') download(scaledCanvas().toDataURL('image/png'), 'fullpage.png');
    else if (type === 'jpg') download(scaledCanvas('#fff').toDataURL('image/jpeg', 0.92), 'fullpage.jpg');
    else if (type === 'webp') download(scaledCanvas().toDataURL('image/webp', 0.92), 'fullpage.webp');
    else if (type === 'pdf') { const bytes = makePdf(scaledCanvas('#fff')); download(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), 'fullpage.pdf'); }
    toast('Exported ' + type.toUpperCase() + (exportScale === 'max' ? ' (max)' : ' @' + exportScale + 'x'));
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
  function copyToClipboard() { work.toBlob(async (blob) => { try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Copied to clipboard'); } catch (e) { toast('Copy failed - try Export'); } }, 'image/png'); }

  // ---- Math for AI (no API) ----
  function buildBundle() {
    if (!equations.length) return '';
    const lines = ['The attached image is a screenshot. Its math equations, read directly from the page source, are listed below in reading order (LaTeX). Use these as the ground truth for any equation in the image.', ''];
    equations.forEach((e, i) => {
      const body = e.latex || e.text || '(equation ' + (i + 1) + ', see image)';
      lines.push((i + 1) + '. ' + (e.type === 'display' ? '[display] ' : '') + body);
    });
    return lines.join('\n');
  }
  function openMath() {
    const list = $('math-list'); list.innerHTML = '';
    if (!equations.length) {
      $('math-intro').textContent = 'No machine-readable math was found in this page\u2019s source (the equations may be baked into images). Best fallback: use Export at Max 8K so the AI can read the pixels, then send that image.';
      $('math-bundle').value = 'The attached image is a high-resolution screenshot. Please read the math equations directly from the image.';
    } else {
      $('math-intro').textContent = equations.length + ' equation' + (equations.length === 1 ? '' : 's') + ' pulled straight from the page source. No API, no limits. Copy the bundle and paste it with your image.';
      equations.forEach((e, i) => {
        const row = document.createElement('div'); row.className = 'eq-row';
        row.innerHTML = '<span class="eq-n">' + (i + 1) + '</span><code>' + escapeHtml(e.latex || e.text || '(see image)') + '</code>';
        list.appendChild(row);
      });
      $('math-bundle').value = buildBundle();
    }
    openModal('math-modal');
  }
  function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }
  function copyText(txt, msg) { navigator.clipboard.writeText(txt || '').then(() => toast(msg)).catch(() => toast('Copy failed')); }
  function markScale() { document.querySelectorAll('.scale-chip').forEach((c) => c.classList.toggle('active', c.dataset.scale === String(exportScale))); }

  function saveSettings() {
    const scale = $('set-scale').value; const format = $('set-format').value;
    exportScale = scale === 'max' ? 'max' : Number(scale); exportFormat = format; markScale();
    chrome.storage.local.set({ [SETTINGS_KEY]: { exportScale: scale, defaultFormat: format } }, () => { $('set-status').textContent = 'Saved.'; toast('Settings saved'); setTimeout(() => ($('set-status').textContent = ''), 1500); });
  }
  function readFile(file) { const fr = new FileReader(); fr.onload = () => setFromSource(fr.result); fr.readAsDataURL(file); }
  async function pasteFromClipboard() { try { const items = await navigator.clipboard.read(); for (const it of items) { const type = it.types.find((t) => t.indexOf('image') === 0); if (type) { readFile(await it.getType(type)); return; } } toast('No image in clipboard'); } catch (e) { toast('Paste blocked - use Ctrl+V'); } }

  function bind() {
    document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('btn-undo').onclick = undo; $('btn-redo').onclick = redo;
    $('btn-rotl').onclick = () => rotate(-1); $('btn-rotr').onclick = () => rotate(1);
    $('btn-fliph').onclick = () => flip('h'); $('btn-flipv').onclick = () => flip('v');
    $('btn-resize').onclick = () => { $('rz-w').value = work.width; $('rz-h').value = work.height; openModal('resize-modal'); };
    $('rz-w').addEventListener('input', () => { if ($('rz-lock').checked) $('rz-h').value = Math.round($('rz-w').value * work.height / work.width); });
    $('rz-h').addEventListener('input', () => { if ($('rz-lock').checked) $('rz-w').value = Math.round($('rz-h').value * work.width / work.height); });
    $('rz-apply').onclick = () => { resizeTo(parseInt($('rz-w').value, 10), parseInt($('rz-h').value, 10)); closeModal('resize-modal'); };
    $('btn-crop-apply').onclick = applyCrop; $('btn-crop-cancel').onclick = () => { cropSel = null; clearOverlay(); };
    document.querySelectorAll('#grp-crop .chip').forEach((c) => c.addEventListener('click', () => { document.querySelectorAll('#grp-crop .chip').forEach((x) => x.classList.remove('active')); c.classList.add('active'); const v = c.dataset.ar; cropAR = v === 'free' ? null : (v === 'a4' ? (210 / 297) : (() => { const [a, b] = v.split(':').map(Number); return a / b; })()); }));
    $('opt-width').addEventListener('input', () => ($('opt-width-val').textContent = $('opt-width').value));
    ['opt-font', 'opt-fontsize', 'opt-textcolor', 'opt-bold', 'opt-textbg'].forEach((id) => $(id).addEventListener('input', () => { if (activeText) styleTextEl(activeText); }));
    $('btn-text-apply').onclick = applyText; $('btn-text-cancel').onclick = cancelText;
    $('btn-fit').onclick = fitZoom; $('btn-100').onclick = () => applyZoom(1);
    $('zoom-range').addEventListener('input', () => applyZoom(parseInt($('zoom-range').value, 10) / 100, true));
    $('btn-open').onclick = () => $('file-input').click(); $('empty-open').onclick = () => $('file-input').click();
    $('file-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) readFile(f); });
    $('btn-paste').onclick = pasteFromClipboard; $('empty-paste').onclick = pasteFromClipboard;
    $('btn-math').onclick = openMath;
    $('math-copy-bundle').onclick = () => copyText($('math-bundle').value, 'Copied for AI');
    $('math-copy-latex').onclick = () => copyText(equations.map((e, i) => (i + 1) + '. ' + (e.latex || e.text || '')).join('\n'), 'LaTeX copied');
    $('btn-export').onclick = (e) => { e.stopPropagation(); $('export-menu').hidden = !$('export-menu').hidden; };
    document.querySelectorAll('.scale-chip').forEach((c) => c.addEventListener('click', (e) => { e.stopPropagation(); exportScale = c.dataset.scale === 'max' ? 'max' : Number(c.dataset.scale); markScale(); }));
    document.querySelectorAll('#export-menu button[data-exp]').forEach((b) => b.addEventListener('click', () => { exportAs(b.dataset.exp); $('export-menu').hidden = true; }));
    document.addEventListener('click', () => ($('export-menu').hidden = true));
    $('btn-copy').onclick = copyToClipboard;
    $('btn-settings').onclick = () => openModal('settings-modal'); $('set-save').onclick = saveSettings;
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
    ['dragover', 'dragenter'].forEach((ev) => stageWrap.addEventListener(ev, (e) => { e.preventDefault(); emptyEl.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => stageWrap.addEventListener(ev, (e) => { e.preventDefault(); emptyEl.classList.remove('dragover'); }));
    stageWrap.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) readFile(f); });
    document.addEventListener('paste', (e) => { const items = e.clipboardData && e.clipboardData.items; if (!items) return; for (const it of items) { if (it.type.indexOf('image') === 0) { readFile(it.getAsFile()); break; } } });
    document.addEventListener('keydown', (e) => {
      if (activeText || /input|textarea|select/i.test(e.target.tagName)) { if (e.key === 'Escape' && activeText) cancelText(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      const map = { v: 'pan', c: 'crop', t: 'text', p: 'pen', a: 'arrow', r: 'rect', o: 'ellipse', h: 'highlight', b: 'blur', x: 'redact' };
      if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
    });
    window.addEventListener('resize', () => { if (!host.hidden) fitZoom(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
