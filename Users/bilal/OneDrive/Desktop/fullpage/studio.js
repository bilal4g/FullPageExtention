/* SnapScroll Studio - editor engine */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // ---- Elements ----
  const emptyEl = $('empty');
  const host = $('canvas-host');
  const scaler = $('canvas-scaler');
  const stage = $('stage');
  const overlay = $('overlay');
  const textLayer = $('text-layer');
  const stageWrap = $('stage-wrap');
  const sctx = stage.getContext('2d');
  const octx = overlay.getContext('2d');

  // ---- State ----
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  let zoom = 1;
  let tool = 'pan';
  let history = [];
  let redoStack = [];
  let drag = null;
  let cropSel = null;   // {x,y,w,h}
  let cropAR = null;    // aspect ratio number or null
  let activeText = null;

  const DRAW_TOOLS = ['pen', 'arrow', 'rect', 'ellipse', 'highlight', 'blur', 'redact'];

  // ---- Helpers ----
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), 2200);
  }
  function opts() {
    return {
      stroke: $('opt-stroke').value,
      width: parseInt($('opt-width').value, 10) || 4,
      fill: $('opt-fill').checked,
      fillColor: $('opt-fillcolor').value
    };
  }
  function coords(e) {
    const r = overlay.getBoundingClientRect();
    const sx = work.width / r.width;
    const sy = work.height / r.height;
    return {
      x: Math.max(0, Math.min(work.width, (e.clientX - r.left) * sx)),
      y: Math.max(0, Math.min(work.height, (e.clientY - r.top) * sy))
    };
  }

  // ---- Image loading ----
  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = src;
    });
  }
  async function setFromSource(src) {
    const img = await loadImage(src);
    work.width = img.naturalWidth || img.width;
    work.height = img.naturalHeight || img.height;
    wctx.clearRect(0, 0, work.width, work.height);
    wctx.drawImage(img, 0, 0);
    emptyEl.hidden = true;
    host.hidden = false;
    syncSizes();
    fitZoom();
    redraw();
    history = []; redoStack = [];
    pushHistory();
    updateDims();
  }
  async function applySnapshot(dataUrl) {
    const img = await loadImage(dataUrl);
    work.width = img.width; work.height = img.height;
    wctx.clearRect(0, 0, work.width, work.height);
    wctx.drawImage(img, 0, 0);
    syncSizes(); redraw(); updateDims();
  }

  // ---- Canvas sizing / zoom ----
  function syncSizes() {
    stage.width = work.width; stage.height = work.height;
    overlay.width = work.width; overlay.height = work.height;
    applyZoom(zoom, true);
  }
  function applyZoom(z, silent) {
    zoom = Math.max(0.1, Math.min(4, z));
    const w = Math.round(work.width * zoom);
    const h = Math.round(work.height * zoom);
    stage.style.width = overlay.style.width = w + 'px';
    stage.style.height = overlay.style.height = h + 'px';
    scaler.style.width = w + 'px';
    scaler.style.height = h + 'px';
    $('zoom-label').textContent = Math.round(zoom * 100) + '%';
    if (!silent) $('zoom-range').value = Math.round(zoom * 100);
    repositionText();
  }
  function fitZoom() {
    const pad = 64;
    const availW = stageWrap.clientWidth - pad;
    const availH = stageWrap.clientHeight - pad;
    const z = Math.min(availW / work.width, availH / work.height, 1);
    applyZoom(z > 0 ? z : 1);
  }
  function redraw() {
    sctx.clearRect(0, 0, stage.width, stage.height);
    sctx.drawImage(work, 0, 0);
  }
  function clearOverlay() { octx.clearRect(0, 0, overlay.width, overlay.height); }
  function updateDims() { $('status-dims').textContent = work.width + ' × ' + work.height + ' px'; }

  // ---- History ----
  function pushHistory() {
    try { history.push(work.toDataURL('image/png')); } catch (e) {}
    if (history.length > 30) history.shift();
    redoStack = [];
  }
  async function undo() {
    if (history.length < 2) return;
    redoStack.push(history.pop());
    await applySnapshot(history[history.length - 1]);
  }
  async function redo() {
    if (!redoStack.length) return;
    const d = redoStack.pop();
    history.push(d);
    await applySnapshot(d);
  }

  // ---- Tools ----
  function setTool(t) {
    if (activeText) applyText();
    tool = t;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    $('grp-crop').hidden = t !== 'crop';
    $('grp-draw').hidden = !DRAW_TOOLS.includes(t);
    $('grp-text').hidden = t !== 'text';
    $('status-tool').textContent = ({ pan: 'Move', crop: 'Crop', text: 'Text', pen: 'Pen', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Ellipse', highlight: 'Highlighter', blur: 'Blur', redact: 'Redact' })[t] || t;
    overlay.style.cursor = t === 'pan' ? 'grab' : (t === 'text' ? 'text' : 'crosshair');
    if (t !== 'crop') { cropSel = null; clearOverlay(); }
  }

  // ---- Shape rendering (used for live preview and final bake) ----
  function renderShape(ctx, t, a, b, pts, o) {
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = o.stroke; ctx.fillStyle = o.fill ? o.fillColor : o.stroke;
    ctx.lineWidth = o.width;
    if (t === 'pen') {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    } else if (t === 'highlight') {
      ctx.globalAlpha = 0.35; ctx.lineWidth = Math.max(o.width, 14);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    } else if (t === 'arrow') {
      const dx = b.x - a.x, dy = b.y - a.y, ang = Math.atan2(dy, dx);
      const head = Math.max(12, o.width * 3.2);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(ang - Math.PI / 7), b.y - head * Math.sin(ang - Math.PI / 7));
      ctx.lineTo(b.x - head * Math.cos(ang + Math.PI / 7), b.y - head * Math.sin(ang + Math.PI / 7));
      ctx.closePath(); ctx.fillStyle = o.stroke; ctx.fill();
    } else if (t === 'rect') {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      if (o.fill) ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    } else if (t === 'ellipse') {
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      if (o.fill) ctx.fill();
      ctx.stroke();
    } else if (t === 'redact') {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h);
    } else if (t === 'blur') {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      ctx.globalAlpha = 0.25; ctx.fillStyle = '#6366f1'; ctx.fillRect(x, y, w, h);
    }
    ctx.restore();
  }

  function blurRegion(x, y, w, h) {
    if (w < 2 || h < 2) return;
    const tmp = document.createElement('canvas');
    const scale = 0.06;
    tmp.width = Math.max(1, Math.round(w * scale));
    tmp.height = Math.max(1, Math.round(h * scale));
    const tctx = tmp.getContext('2d');
    tctx.drawImage(work, x, y, w, h, 0, 0, tmp.width, tmp.height);
    wctx.save();
    wctx.imageSmoothingEnabled = true; wctx.imageSmoothingQuality = 'low';
    wctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
    wctx.restore();
  }

  // ---- Crop ----
  function drawCropOverlay() {
    clearOverlay();
    if (!cropSel) return;
    const { x, y, w, h } = cropSel;
    octx.save();
    octx.fillStyle = 'rgba(0,0,0,0.5)';
    octx.fillRect(0, 0, overlay.width, overlay.height);
    octx.clearRect(x, y, w, h);
    octx.strokeStyle = '#6366f1'; octx.lineWidth = 2 / zoom;
    octx.strokeRect(x, y, w, h);
    octx.fillStyle = '#6366f1';
    [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([hx, hy]) => {
      const s = 8 / zoom; octx.fillRect(hx - s / 2, hy - s / 2, s, s);
    });
    octx.restore();
  }
  function applyCrop() {
    if (!cropSel || cropSel.w < 4 || cropSel.h < 4) { toast('Draw a crop area first'); return; }
    const { x, y, w, h } = cropSel;
    const nc = document.createElement('canvas');
    nc.width = Math.round(w); nc.height = Math.round(h);
    nc.getContext('2d').drawImage(work, x, y, w, h, 0, 0, nc.width, nc.height);
    work.width = nc.width; work.height = nc.height;
    wctx.clearRect(0, 0, work.width, work.height);
    wctx.drawImage(nc, 0, 0);
    cropSel = null; syncSizes(); fitZoom(); redraw(); clearOverlay(); pushHistory(); updateDims();
    toast('Cropped');
  }

  // ---- Transforms ----
  function rotate(dir) {
    const nc = document.createElement('canvas');
    nc.width = work.height; nc.height = work.width;
    const c = nc.getContext('2d');
    c.translate(nc.width / 2, nc.height / 2);
    c.rotate((dir > 0 ? 90 : -90) * Math.PI / 180);
    c.drawImage(work, -work.width / 2, -work.height / 2);
    work.width = nc.width; work.height = nc.height;
    wctx.clearRect(0, 0, work.width, work.height); wctx.drawImage(nc, 0, 0);
    syncSizes(); fitZoom(); redraw(); pushHistory(); updateDims();
  }
  function flip(axis) {
    const nc = document.createElement('canvas');
    nc.width = work.width; nc.height = work.height;
    const c = nc.getContext('2d');
    if (axis === 'h') { c.translate(nc.width, 0); c.scale(-1, 1); }
    else { c.translate(0, nc.height); c.scale(1, -1); }
    c.drawImage(work, 0, 0);
    wctx.clearRect(0, 0, work.width, work.height); wctx.drawImage(nc, 0, 0);
    redraw(); pushHistory();
  }
  function resizeTo(w, h) {
    if (!w || !h) return;
    const nc = document.createElement('canvas');
    nc.width = Math.round(w); nc.height = Math.round(h);
    const c = nc.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(work, 0, 0, nc.width, nc.height);
    work.width = nc.width; work.height = nc.height;
    wctx.clearRect(0, 0, work.width, work.height); wctx.drawImage(nc, 0, 0);
    syncSizes(); fitZoom(); redraw(); pushHistory(); updateDims();
  }

  // ---- Text ----
  function createText(pt) {
    if (activeText) applyText();
    const el = document.createElement('div');
    el.className = 'text-edit';
    el.contentEditable = 'true';
    el.dataset.cx = pt.x; el.dataset.cy = pt.y;
    el.textContent = 'Text';
    styleTextEl(el);
    textLayer.appendChild(el);
    activeText = el;
    positionTextEl(el);
    setTimeout(() => {
      el.focus();
      const range = document.createRange(); range.selectNodeContents(el);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    }, 0);
  }
  function styleTextEl(el) {
    const size = parseInt($('opt-fontsize').value, 10) || 32;
    el.style.fontFamily = $('opt-font').value;
    el.style.fontSize = (size * zoom) + 'px';
    el.style.color = $('opt-textcolor').value;
    el.style.fontWeight = $('opt-bold').checked ? '700' : '400';
    el.style.background = $('opt-textbg').checked ? 'rgba(0,0,0,0.55)' : 'transparent';
  }
  function positionTextEl(el) {
    el.style.left = (parseFloat(el.dataset.cx) * zoom) + 'px';
    el.style.top = (parseFloat(el.dataset.cy) * zoom) + 'px';
  }
  function repositionText() {
    if (activeText) { styleTextEl(activeText); positionTextEl(activeText); }
  }
  function applyText() {
    const el = activeText; if (!el) return;
    activeText = null;
    const txt = el.innerText.replace(/\u00a0/g, ' ');
    const cx = parseFloat(el.dataset.cx), cy = parseFloat(el.dataset.cy);
    const size = parseInt($('opt-fontsize').value, 10) || 32;
    const font = $('opt-font').value;
    const bold = $('opt-bold').checked ? 'bold ' : '';
    el.remove();
    if (!txt.trim()) return;
    wctx.save();
    wctx.textBaseline = 'top';
    wctx.font = bold + size + 'px ' + font;
    const lines = txt.split('\n');
    const lh = size * 1.2;
    if ($('opt-textbg').checked) {
      let maxW = 0;
      lines.forEach((l) => { maxW = Math.max(maxW, wctx.measureText(l).width); });
      wctx.fillStyle = 'rgba(0,0,0,0.55)';
      wctx.fillRect(cx - 4, cy - 2, maxW + 8, lh * lines.length + 4);
    }
    wctx.fillStyle = $('opt-textcolor').value;
    lines.forEach((l, i) => wctx.fillText(l, cx, cy + i * lh));
    wctx.restore();
    redraw(); pushHistory();
  }
  function cancelText() { if (activeText) { activeText.remove(); activeText = null; } }

  // ---- Pointer handling on overlay ----
  overlay.addEventListener('pointerdown', (e) => {
    overlay.setPointerCapture(e.pointerId);
    const p = coords(e);
    if (tool === 'pan') { drag = { pan: true, sx: e.clientX, sy: e.clientY, sl: stageWrap.scrollLeft, st: stageWrap.scrollTop }; overlay.style.cursor = 'grabbing'; return; }
    if (tool === 'text') { createText(p); return; }
    if (tool === 'crop') { drag = { crop: true, a: p }; cropSel = { x: p.x, y: p.y, w: 0, h: 0 }; return; }
    if (DRAW_TOOLS.includes(tool)) { drag = { a: p, b: p, pts: [p], o: opts() }; }
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.pan) {
      stageWrap.scrollLeft = drag.sl - (e.clientX - drag.sx);
      stageWrap.scrollTop = drag.st - (e.clientY - drag.sy);
      return;
    }
    const p = coords(e);
    if (drag.crop) {
      let w = p.x - drag.a.x, h = p.y - drag.a.y;
      if (cropAR) { h = Math.sign(h || 1) * Math.abs(w) / cropAR; }
      cropSel = { x: Math.min(drag.a.x, drag.a.x + w), y: Math.min(drag.a.y, drag.a.y + h), w: Math.abs(w), h: Math.abs(h) };
      drawCropOverlay();
      return;
    }
    drag.b = p; drag.pts.push(p);
    clearOverlay();
    renderShape(octx, tool, drag.a, drag.b, drag.pts, drag.o);
  });
  overlay.addEventListener('pointerup', (e) => {
    if (!drag) return;
    if (drag.pan) { drag = null; overlay.style.cursor = 'grab'; return; }
    if (drag.crop) { drag = null; return; }
    const p = coords(e);
    drag.b = p;
    if (tool === 'blur') {
      const x = Math.min(drag.a.x, p.x), y = Math.min(drag.a.y, p.y), w = Math.abs(p.x - drag.a.x), h = Math.abs(p.y - drag.a.y);
      blurRegion(x, y, w, h);
    } else {
      renderShape(wctx, tool, drag.a, drag.b, drag.pts, drag.o);
    }
    clearOverlay(); redraw(); pushHistory();
    drag = null;
  });

  // ---- Export ----
  function flatten(bg) {
    const nc = document.createElement('canvas');
    nc.width = work.width; nc.height = work.height;
    const c = nc.getContext('2d');
    if (bg) { c.fillStyle = bg; c.fillRect(0, 0, nc.width, nc.height); }
    c.drawImage(work, 0, 0);
    return nc;
  }
  function download(url, name) {
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  }
  function exportAs(type) {
    if (type === 'png') { download(work.toDataURL('image/png'), 'snapscroll.png'); }
    else if (type === 'jpg') { download(flatten('#fff').toDataURL('image/jpeg', 0.92), 'snapscroll.jpg'); }
    else if (type === 'webp') { download(work.toDataURL('image/webp', 0.92), 'snapscroll.webp'); }
    else if (type === 'pdf') { const bytes = makePdf(flatten('#fff')); const blob = new Blob([bytes], { type: 'application/pdf' }); download(URL.createObjectURL(blob), 'snapscroll.pdf'); }
    toast('Exported ' + type.toUpperCase());
  }
  function makePdf(canvas) {
    const imgData = canvas.toDataURL('image/jpeg', 0.92), imgBytes = atob(imgData.split(',')[1]);
    const iW = canvas.width, iH = canvas.height, pw = 595.28, m = 36, cw = pw - m * 2, sc = cw / iW, ch = iH * sc, ph = ch + m * 2;
    const sd = 'q ' + cw + ' 0 0 ' + ch + ' ' + m + ' ' + m + ' cm /Img Do Q';
    let pdf = '%PDF-1.4\n'; const off = [];
    off.push(pdf.length); pdf += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
    off.push(pdf.length); pdf += '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
    off.push(pdf.length); pdf += '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] /Contents 4 0 R /Resources << /XObject << /Img 5 0 R >> >> >>\nendobj\n';
    off.push(pdf.length); pdf += '4 0 obj\n<< /Length ' + sd.length + ' >>\nstream\n' + sd + '\nendstream\nendobj\n';
    const imgStream = imgBytes;
    off.push(pdf.length); pdf += '5 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + iW + ' /Height ' + iH + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + imgStream.length + ' >>\nstream\n';
    const before = pdf; pdf += '\nendstream\nendobj\n';
    const xrefOff = before.length + imgStream.length + ('\nendstream\nendobj\n').length;
    let xref = 'xref\n0 ' + (off.length + 1) + '\n0000000000 65535 f \n';
    off.forEach((o) => { xref += String(o).padStart(10, '0') + ' 00000 n \n'; });
    pdf += xref + 'trailer\n<< /Size ' + (off.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF';
    const arr = new Uint8Array(before.length + imgStream.length + (pdf.length - before.length));
    for (let i = 0; i < before.length; i++) arr[i] = before.charCodeAt(i);
    for (let i = 0; i < imgStream.length; i++) arr[before.length + i] = imgStream.charCodeAt(i);
    const after = pdf.slice(before.length);
    for (let i = 0; i < after.length; i++) arr[before.length + imgStream.length + i] = after.charCodeAt(i);
    return arr;
  }
  function copyToClipboard() {
    work.toBlob(async (blob) => {
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Copied to clipboard'); }
      catch (e) { toast('Copy failed - try Export'); }
    }, 'image/png');
  }

  // ---- OCR / Math ----
  function regionDataUrl() {
    if (cropSel && cropSel.w > 4 && cropSel.h > 4) {
      const nc = document.createElement('canvas');
      nc.width = Math.round(cropSel.w); nc.height = Math.round(cropSel.h);
      nc.getContext('2d').drawImage(work, cropSel.x, cropSel.y, cropSel.w, cropSel.h, 0, 0, nc.width, nc.height);
      return nc.toDataURL('image/png');
    }
    return work.toDataURL('image/png');
  }
  async function runOCR() {
    if (!host || host.hidden) { toast('Load an image first'); return; }
    openModal('ocr-modal');
    $('ocr-status').hidden = false; $('ocr-status').textContent = 'Reading the image…';
    $('ocr-result').hidden = true; $('ocr-nocreds').hidden = true;
    try {
      const r = await window.SSOCR.extract(regionDataUrl());
      $('ocr-status').hidden = true;
      $('ocr-result').hidden = false;
      $('ocr-latex').value = r.latex || '';
      $('ocr-text').value = r.text || '';
    } catch (err) {
      if (err && err.code === 'NO_CREDS') {
        $('ocr-status').hidden = true; $('ocr-nocreds').hidden = false;
      } else {
        $('ocr-status').textContent = 'Could not read the image (' + (err && err.code ? err.code : 'error') + '). Check your Mathpix keys in Settings.';
      }
    }
  }

  // ---- Modals ----
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  // ---- Settings ----
  function loadSettings() {
    chrome.storage.local.get(['ss_mathpix_id', 'ss_mathpix_key'], (d) => {
      $('set-id').value = d.ss_mathpix_id || '';
      $('set-key').value = d.ss_mathpix_key || '';
    });
  }
  function saveSettings() {
    chrome.storage.local.set({ ss_mathpix_id: $('set-id').value.trim(), ss_mathpix_key: $('set-key').value.trim() }, () => {
      $('set-status').textContent = 'Saved.'; toast('Settings saved');
      setTimeout(() => ($('set-status').textContent = ''), 1500);
    });
  }

  // ---- Wire up UI ----
  function bind() {
    document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

    $('btn-undo').onclick = undo;
    $('btn-redo').onclick = redo;
    $('btn-rotl').onclick = () => rotate(-1);
    $('btn-rotr').onclick = () => rotate(1);
    $('btn-fliph').onclick = () => flip('h');
    $('btn-flipv').onclick = () => flip('v');

    $('btn-resize').onclick = () => { $('rz-w').value = work.width; $('rz-h').value = work.height; openModal('resize-modal'); };
    $('rz-w').addEventListener('input', () => { if ($('rz-lock').checked) $('rz-h').value = Math.round($('rz-w').value * work.height / work.width); });
    $('rz-h').addEventListener('input', () => { if ($('rz-lock').checked) $('rz-w').value = Math.round($('rz-h').value * work.width / work.height); });
    $('rz-apply').onclick = () => { resizeTo(parseInt($('rz-w').value, 10), parseInt($('rz-h').value, 10)); closeModal('resize-modal'); };

    $('btn-crop-apply').onclick = applyCrop;
    $('btn-crop-cancel').onclick = () => { cropSel = null; clearOverlay(); };
    document.querySelectorAll('#grp-crop .chip').forEach((c) => c.addEventListener('click', () => {
      document.querySelectorAll('#grp-crop .chip').forEach((x) => x.classList.remove('active'));
      c.classList.add('active');
      const v = c.dataset.ar;
      cropAR = v === 'free' ? null : (v === 'a4' ? (210 / 297) : (() => { const [a, b] = v.split(':').map(Number); return a / b; })());
    }));

    $('opt-width').addEventListener('input', () => ($('opt-width-val').textContent = $('opt-width').value));
    ['opt-font', 'opt-fontsize', 'opt-textcolor', 'opt-bold', 'opt-textbg'].forEach((id) => $(id).addEventListener('input', () => { if (activeText) styleTextEl(activeText); }));
    $('btn-text-apply').onclick = applyText;
    $('btn-text-cancel').onclick = cancelText;

    $('btn-fit').onclick = fitZoom;
    $('btn-100').onclick = () => applyZoom(1);
    $('zoom-range').addEventListener('input', () => applyZoom(parseInt($('zoom-range').value, 10) / 100, true));

    $('btn-open').onclick = () => $('file-input').click();
    $('empty-open').onclick = () => $('file-input').click();
    $('file-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) readFile(f); });
    $('btn-paste').onclick = pasteFromClipboard;
    $('empty-paste').onclick = pasteFromClipboard;

    $('btn-ocr').onclick = runOCR;
    $('ocr-copy-latex').onclick = () => copyText($('ocr-latex').value, 'LaTeX copied');
    $('ocr-copy-text').onclick = () => copyText($('ocr-text').value, 'Text copied');
    $('ocr-copy-prompt').onclick = () => copyText('Solve the following. Math is written in LaTeX between $ signs.\n\n' + ($('ocr-latex').value || $('ocr-text').value), 'AI prompt copied');
    $('ocr-open-settings').onclick = () => { closeModal('ocr-modal'); openModal('settings-modal'); };

    $('btn-export').onclick = (e) => { e.stopPropagation(); $('export-menu').hidden = !$('export-menu').hidden; };
    document.querySelectorAll('#export-menu button').forEach((b) => b.addEventListener('click', () => { exportAs(b.dataset.exp); $('export-menu').hidden = true; }));
    document.addEventListener('click', () => ($('export-menu').hidden = true));
    $('btn-copy').onclick = copyToClipboard;

    $('btn-settings').onclick = () => { loadSettings(); openModal('settings-modal'); };
    $('set-save').onclick = saveSettings;
    $('set-clear').onclick = () => { $('set-id').value = ''; $('set-key').value = ''; chrome.storage.local.remove(['ss_mathpix_id', 'ss_mathpix_key']); toast('Cleared'); };

    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));

    // Drag & drop
    ['dragover', 'dragenter'].forEach((ev) => stageWrap.addEventListener(ev, (e) => { e.preventDefault(); emptyEl.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => stageWrap.addEventListener(ev, (e) => { e.preventDefault(); emptyEl.classList.remove('dragover'); }));
    stageWrap.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) readFile(f); });

    // Paste anywhere
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) { if (it.type.indexOf('image') === 0) { readFile(it.getAsFile()); break; } }
    });

    // Shortcuts
    document.addEventListener('keydown', (e) => {
      if (activeText || /input|textarea|select/i.test(e.target.tagName)) {
        if (e.key === 'Escape' && activeText) cancelText();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      const map = { v: 'pan', c: 'crop', t: 'text', p: 'pen', a: 'arrow', r: 'rect', o: 'ellipse', h: 'highlight', b: 'blur', x: 'redact' };
      if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
    });

    window.addEventListener('resize', () => { if (!host.hidden) fitZoom(); });
  }

  function copyText(txt, msg) {
    navigator.clipboard.writeText(txt || '').then(() => toast(msg)).catch(() => toast('Copy failed'));
  }
  function readFile(file) {
    const fr = new FileReader();
    fr.onload = () => setFromSource(fr.result);
    fr.readAsDataURL(file);
  }
  async function pasteFromClipboard() {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.indexOf('image') === 0);
        if (type) { const blob = await it.getType(type); readFile(blob); return; }
      }
      toast('No image in clipboard');
    } catch (e) { toast('Paste blocked - use Ctrl+V on the page'); }
  }

  // ---- Boot ----
  function boot() {
    bind();
    setTool('pan');
    chrome.storage.local.get(['ss_studio_image'], (d) => {
      if (d && d.ss_studio_image) {
        setFromSource(d.ss_studio_image);
        chrome.storage.local.remove('ss_studio_image');
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
