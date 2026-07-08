/* FullPage Studio v2 - object-based editor (Canva-style, no external APIs). */
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

  // Base (flattened) image lives on `work`. Objects render on top, live.
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });

  let zoom = 1, tool = 'select';
  let objects = [];       // live editable objects
  let selId = null;       // selected object id
  let uid = 1;
  let drag = null;        // active drag state
  let cropSel = null, cropAR = null;
  let editingText = null; // DOM node while editing text
  let history = [], redoStack = [];
  let equations = [], exportScale = 2, exportFormat = 'png';
  const MAX_SIDE = 7680;
  const HANDLE = 9;

  const SHAPE_TOOLS = ['pen', 'arrow', 'line', 'rect', 'ellipse', 'highlight', 'blur', 'redact'];

  function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), 2200); }
  function newStyle() { return { stroke: $('opt-stroke').value, width: parseInt($('opt-width').value, 10) || 4, fill: $('opt-fill').checked, fillColor: $('opt-fillcolor').value }; }
  function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
  function coords(e) { const r = overlay.getBoundingClientRect(); return { x: (e.clientX - r.left) * (work.width / r.width), y: (e.clientY - r.top) * (work.height / r.height) }; }
  function sel() { return objects.find((o) => o.id === selId) || null; }

  // ---------- load ----------
  async function setBase(src, keepObjects) {
    const img = await loadImage(src);
    work.width = img.naturalWidth || img.width; work.height = img.naturalHeight || img.height;
    wctx.clearRect(0, 0, work.width, work.height); wctx.drawImage(img, 0, 0);
    if (!keepObjects) { objects = []; selId = null; }
    emptyEl.hidden = true; host.hidden = false;
    syncSizes(); fitZoom(); render(); history = []; redoStack = []; snapshot(); updateDims();
  }
  async function stitchFrames(cap) {
    const dpr = (cap.page && cap.page.devicePixelRatio) || 1;
    const imgs = [];
    for (const f of cap.frames) imgs.push({ img: await loadImage(f.dataUrl), y: Math.round(f.scrollY * dpr) });
    if (imgs.length === 1) return cap.frames[0].dataUrl;
    let w = 0, bottom = 0;
    for (const it of imgs) { w = Math.max(w, it.img.width); bottom = Math.max(bottom, it.y + it.img.height); }
    const c = document.createElement('canvas'); c.width = w; c.height = bottom;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, bottom); ctx.imageSmoothingEnabled = false;
    for (const it of imgs) ctx.drawImage(it.img, 0, it.y);
    return c.toDataURL('image/png');
  }
  async function boot() {
    bind(); setTool('select');
    chrome.storage.local.get([SETTINGS_KEY], (d) => {
      const s = d[SETTINGS_KEY] || {};
      if (s.exportScale) { exportScale = s.exportScale === 'max' ? 'max' : Number(s.exportScale); $('set-scale').value = String(s.exportScale); markScale(); }
      if (s.defaultFormat) { exportFormat = s.defaultFormat; $('set-format').value = s.defaultFormat; }
      if (s.ocrModel) $('set-ocr').value = s.ocrModel;
    });
    chrome.storage.local.get([CAP_KEY], async (d) => {
      const cap = d[CAP_KEY]; if (!cap || !cap.frames || !cap.frames.length) return;
      equations = (cap.metadata && cap.metadata.math && cap.metadata.math.equations) || [];
      updateMathStatus();
      try { await setBase(await stitchFrames(cap)); } catch (e) { try { await setBase(cap.frames[0].dataUrl); } catch (_) {} }
    });
  }

  // ---------- sizing / zoom ----------
  function syncSizes() { stage.width = work.width; stage.height = work.height; overlay.width = work.width; overlay.height = work.height; applyZoom(zoom, true); }
  function applyZoom(z, silent) {
    zoom = Math.max(0.1, Math.min(4, z));
    const w = Math.round(work.width * zoom), h = Math.round(work.height * zoom);
    stage.style.width = overlay.style.width = scaler.style.width = w + 'px';
    stage.style.height = overlay.style.height = scaler.style.height = h + 'px';
    $('zoom-label').textContent = Math.round(zoom * 100) + '%';
    if (!silent) $('zoom-range').value = Math.round(zoom * 100);
  }
  function fitZoom() { const pad = 72; applyZoom(Math.min((stageWrap.clientWidth - pad) / work.width, (stageWrap.clientHeight - pad) / work.height, 1) || 1); }
  function updateDims() { $('status-dims').textContent = work.width + ' \u00d7 ' + work.height + ' px'; }
  function updateMathStatus() { const n = equations.length; $('status-math').textContent = n ? (n + ' equation' + (n === 1 ? '' : 's') + ' detected') : ''; }

  // ---------- object drawing ----------
  function drawObject(ctx, o) {
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = o.stroke || '#ef4444'; ctx.lineWidth = o.width || 4;
    ctx.fillStyle = o.fill ? (o.fillColor || '#6366f1') : (o.stroke || '#ef4444');
    const x = o.x, y = o.y, w = o.w, h = o.h;
    if (o.type === 'rect') { if (o.fill) ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); }
    else if (o.type === 'ellipse') { ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2); if (o.fill) ctx.fill(); ctx.stroke(); }
    else if (o.type === 'line' || o.type === 'arrow') {
      const ax = x, ay = y, bx = x + w, by = y + h;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      if (o.type === 'arrow') { const ang = Math.atan2(by - ay, bx - ax), hd = Math.max(12, (o.width || 4) * 3.2); ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - hd * Math.cos(ang - Math.PI / 7), by - hd * Math.sin(ang - Math.PI / 7)); ctx.lineTo(bx - hd * Math.cos(ang + Math.PI / 7), by - hd * Math.sin(ang + Math.PI / 7)); ctx.closePath(); ctx.fill(); }
    }
    else if (o.type === 'pen' || o.type === 'highlight') {
      if (o.type === 'highlight') { ctx.globalAlpha = 0.35; ctx.lineWidth = Math.max(o.width || 14, 14); }
      ctx.beginPath(); (o.pts || []).forEach((p, i) => (i ? ctx.lineTo(x + p.x, y + p.y) : ctx.moveTo(x + p.x, y + p.y))); ctx.stroke();
    }
    else if (o.type === 'redact') { ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h); }
    else if (o.type === 'blur') { drawBlur(ctx, o); }
    else if (o.type === 'text') { drawText(ctx, o); }
    ctx.restore();
  }
  function drawBlur(ctx, o) {
    const x = Math.min(o.x, o.x + o.w), y = Math.min(o.y, o.y + o.h), w = Math.abs(o.w), h = Math.abs(o.h);
    if (w < 2 || h < 2) return;
    const tmp = document.createElement('canvas'); const s = 0.06;
    tmp.width = Math.max(1, Math.round(w * s)); tmp.height = Math.max(1, Math.round(h * s));
    tmp.getContext('2d').drawImage(work, x, y, w, h, 0, 0, tmp.width, tmp.height);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
  }
  function drawText(ctx, o) {
    const size = o.size || 32; const font = o.font || 'Inter, sans-serif'; const bold = o.bold ? 'bold ' : '';
    ctx.textBaseline = 'top'; ctx.font = bold + size + 'px ' + font;
    const lines = (o.text || '').split('\n'); const lh = size * 1.2;
    let mw = 0; lines.forEach((l) => { mw = Math.max(mw, ctx.measureText(l).width); });
    o.w = mw + 8; o.h = lh * lines.length + 4;
    if (o.bg) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(o.x - 4, o.y - 2, o.w, o.h); }
    ctx.fillStyle = o.color || '#ffffff'; lines.forEach((l, i) => ctx.fillText(l, o.x, o.y + i * lh));
  }
  function bbox(o) {
    if (o.type === 'line' || o.type === 'arrow') return { x: Math.min(o.x, o.x + o.w), y: Math.min(o.y, o.y + o.h), w: Math.abs(o.w), h: Math.abs(o.h) };
    return { x: Math.min(o.x, o.x + o.w), y: Math.min(o.y, o.y + o.h), w: Math.abs(o.w), h: Math.abs(o.h) };
  }

  function render() {
    sctx.clearRect(0, 0, stage.width, stage.height);
    sctx.drawImage(work, 0, 0);
    for (const o of objects) drawObject(sctx, o);
    drawSelection();
  }
  function drawSelection() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (cropSel) { drawCropOverlay(); return; }
    const o = sel(); if (!o) return;
    const b = bbox(o); const s = HANDLE / zoom;
    octx.save(); octx.strokeStyle = '#6366f1'; octx.lineWidth = 1.5 / zoom; octx.setLineDash([4 / zoom, 3 / zoom]);
    octx.strokeRect(b.x, b.y, b.w, b.h); octx.setLineDash([]);
    octx.fillStyle = '#fff'; octx.strokeStyle = '#6366f1';
    handlePoints(b).forEach((p) => { octx.beginPath(); octx.rect(p.x - s / 2, p.y - s / 2, s, s); octx.fill(); octx.stroke(); });
    octx.restore();
  }
  function handlePoints(b) { return [ { k: 'nw', x: b.x, y: b.y }, { k: 'ne', x: b.x + b.w, y: b.y }, { k: 'sw', x: b.x, y: b.y + b.h }, { k: 'se', x: b.x + b.w, y: b.y + b.h } ]; }
  function hitHandle(o, p) { const b = bbox(o); const s = (HANDLE + 4) / zoom; return handlePoints(b).find((hp) => Math.abs(p.x - hp.x) <= s && Math.abs(p.y - hp.y) <= s) || null; }
  function hitObject(p) {
    for (let i = objects.length - 1; i >= 0; i--) { const b = bbox(objects[i]); const pad = 6 / zoom; if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) return objects[i]; }
    return null;
  }

  // ---------- history ----------
  function snapshot() { try { history.push(JSON.stringify({ base: work.toDataURL('image/png'), objects })); } catch (e) {} if (history.length > 25) history.shift(); redoStack = []; }
  async function restore(json) { const st = JSON.parse(json); objects = st.objects || []; selId = null; await setBaseSilent(st.base); render(); refreshInspector(); }
  async function setBaseSilent(src) { const img = await loadImage(src); work.width = img.width; work.height = img.height; wctx.clearRect(0, 0, work.width, work.height); wctx.drawImage(img, 0, 0); syncSizes(); updateDims(); }
  async function undo() { if (history.length < 2) return; redoStack.push(history.pop()); await restore(history[history.length - 1]); }
  async function redo() { if (!redoStack.length) return; const j = redoStack.pop(); history.push(j); await restore(j); }

  // ---------- tools ----------
  function setTool(t) {
    commitText();
    tool = t;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    $('grp-crop').hidden = t !== 'crop';
    $('status-tool').textContent = ({ select: 'Select', crop: 'Crop', text: 'Text', pen: 'Pen', arrow: 'Arrow', line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse', highlight: 'Highlight', blur: 'Blur', redact: 'Redact' })[t] || t;
    overlay.style.cursor = t === 'select' ? 'default' : (t === 'text' ? 'text' : 'crosshair');
    if (t !== 'crop') { cropSel = null; }
    if (t !== 'select') { selId = null; refreshInspector(); }
    render();
  }

  // ---------- pointer ----------
  overlay.addEventListener('pointerdown', (e) => {
    overlay.setPointerCapture(e.pointerId); const p = coords(e);
    if (tool === 'crop') { drag = { crop: true, a: p }; cropSel = { x: p.x, y: p.y, w: 0, h: 0 }; return; }
    if (tool === 'text') { addText(p); return; }
    if (tool === 'select') {
      const o = sel();
      if (o) { const hp = hitHandle(o, p); if (hp) { drag = { resize: true, o, k: hp.k, start: p, o0: { x: o.x, y: o.y, w: o.w, h: o.h } }; return; } }
      const hit = hitObject(p);
      if (hit) { selId = hit.id; refreshInspector(); drag = { move: true, o: hit, start: p, o0: { x: hit.x, y: hit.y } }; render(); }
      else { selId = null; refreshInspector(); drag = { pan: true, sx: e.clientX, sy: e.clientY, sl: stageWrap.scrollLeft, st: stageWrap.scrollTop }; render(); }
      return;
    }
    // shape tools: start a new object
    if (SHAPE_TOOLS.includes(tool)) {
      const st = newStyle();
      const o = { id: uid++, type: tool, x: p.x, y: p.y, w: 0, h: 0, stroke: st.stroke, width: st.width, fill: st.fill, fillColor: st.fillColor };
      if (tool === 'pen' || tool === 'highlight') o.pts = [{ x: 0, y: 0 }];
      objects.push(o); selId = o.id; drag = { create: true, o, start: p };
    }
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return; const p = coords(e);
    if (drag.pan) { stageWrap.scrollLeft = drag.sl - (e.clientX - drag.sx); stageWrap.scrollTop = drag.st - (e.clientY - drag.sy); return; }
    if (drag.crop) { let w = p.x - drag.a.x, h = p.y - drag.a.y; if (cropAR) h = Math.sign(h || 1) * Math.abs(w) / cropAR; cropSel = { x: Math.min(drag.a.x, drag.a.x + w), y: Math.min(drag.a.y, drag.a.y + h), w: Math.abs(w), h: Math.abs(h) }; drawSelection(); return; }
    if (drag.create) { const o = drag.o; if (o.pts) { o.pts.push({ x: p.x - o.x, y: p.y - o.y }); } else { o.w = p.x - o.x; o.h = p.y - o.y; } render(); return; }
    if (drag.move) { const o = drag.o; o.x = drag.o0.x + (p.x - drag.start.x); o.y = drag.o0.y + (p.y - drag.start.y); render(); return; }
    if (drag.resize) { resizeObj(drag, p); render(); return; }
  });
  overlay.addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.create) { const o = drag.o; if (!o.pts && Math.abs(o.w) < 3 && Math.abs(o.h) < 3) { objects = objects.filter((x) => x !== o); selId = null; } else { setTool('select'); selId = o.id; } refreshInspector(); snapshot(); }
    else if (drag.move || drag.resize) { snapshot(); }
    else if (drag.crop) { drag = null; return; }
    drag = null; render();
  });
  function resizeObj(d, p) {
    const o = d.o, s0 = d.o0; let x = s0.x, y = s0.y, w = s0.w, h = s0.h;
    const right = x + w, bottom = y + h;
    if (d.k.includes('e')) w = p.x - x; if (d.k.includes('s')) h = p.y - y;
    if (d.k.includes('w')) { o.x = p.x; w = right - p.x; } else o.x = x;
    if (d.k.includes('n')) { o.y = p.y; h = bottom - p.y; } else o.y = y;
    o.w = w; o.h = h;
  }

  // ---------- text ----------
  function addText(p) {
    commitText();
    const st = newStyle();
    const o = { id: uid++, type: 'text', x: p.x, y: p.y, w: 60, h: 40, text: 'Text', size: parseInt($('opt-width').value, 10) > 0 ? 32 : 32, font: 'Inter, sans-serif', color: st.stroke, bold: false, bg: false };
    objects.push(o); selId = o.id; setTool('select'); refreshInspector(); startTextEdit(o); snapshot();
  }
  function startTextEdit(o) {
    commitText();
    const el = document.createElement('div'); el.className = 'text-edit'; el.contentEditable = 'true'; el.textContent = o.text;
    el.style.left = (o.x * zoom) + 'px'; el.style.top = (o.y * zoom) + 'px';
    el.style.fontFamily = o.font; el.style.fontSize = (o.size * zoom) + 'px'; el.style.color = o.color; el.style.fontWeight = o.bold ? '700' : '400';
    el.style.background = o.bg ? 'rgba(0,0,0,0.55)' : 'transparent';
    textLayer.appendChild(el); editingText = { el, o };
    o._hidden = true; render();
    setTimeout(() => { el.focus(); const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }, 0);
    el.addEventListener('blur', commitText);
  }
  function commitText() {
    if (!editingText) return; const { el, o } = editingText; editingText = null;
    o.text = el.innerText.replace(/\u00a0/g, ' '); o._hidden = false; el.remove();
    if (!o.text.trim()) { objects = objects.filter((x) => x !== o); if (selId === o.id) selId = null; }
    render(); refreshInspector();
  }
  // hide text object while its DOM editor is open
  const _drawObject = drawObject;
  drawObject = function (ctx, o) { if (o._hidden) return; _drawObject(ctx, o); };

  overlay.addEventListener('dblclick', (e) => { if (tool !== 'select') return; const o = hitObject(coords(e)); if (o && o.type === 'text') { selId = o.id; startTextEdit(o); } });

  // ---------- inspector ----------
  function refreshInspector() {
    const o = sel();
    $('grp-inspector').hidden = !o; $('grp-newstyle').hidden = !!o;
    if (!o) return;
    const isText = o.type === 'text'; const isShape = ['rect', 'ellipse'].includes(o.type); const hasStroke = !['blur', 'redact', 'text'].includes(o.type);
    $('insp-text-block').hidden = !isText;
    $('insp-stroke-wrap').style.display = (isText || hasStroke) ? '' : 'none';
    $('insp-width-wrap').style.display = hasStroke ? '' : 'none';
    $('insp-fill-wrap').style.display = isShape ? '' : 'none';
    $('insp-fillcolor-wrap').style.display = isShape ? '' : 'none';
    if (isText) { $('insp-stroke').value = o.color || '#ffffff'; $('insp-font').value = o.font; $('insp-fontsize').value = o.size; $('insp-bold').checked = !!o.bold; $('insp-textbg').checked = !!o.bg; }
    else { $('insp-stroke').value = o.stroke || '#ef4444'; $('insp-width').value = o.width || 4; $('insp-width-val').textContent = o.width || 4; $('insp-fill').checked = !!o.fill; $('insp-fillcolor').value = o.fillColor || '#6366f1'; }
  }
  function inspEdit(fn) { const o = sel(); if (!o) return; fn(o); render(); }

  // ---------- crop / transform (re-bake base) ----------
  function drawCropOverlay() {
    if (!cropSel) return; const { x, y, w, h } = cropSel;
    octx.save(); octx.fillStyle = 'rgba(0,0,0,0.5)'; octx.fillRect(0, 0, overlay.width, overlay.height); octx.clearRect(x, y, w, h);
    octx.strokeStyle = '#6366f1'; octx.lineWidth = 2 / zoom; octx.strokeRect(x, y, w, h); octx.restore();
  }
  function flattenToBase() { const c = document.createElement('canvas'); c.width = work.width; c.height = work.height; const ctx = c.getContext('2d'); ctx.drawImage(work, 0, 0); for (const o of objects) drawObject(ctx, o); return c; }
  function applyCrop() {
    if (!cropSel || cropSel.w < 4 || cropSel.h < 4) { toast('Draw a crop area first'); return; }
    const flat = flattenToBase(); const { x, y, w, h } = cropSel;
    const nc = document.createElement('canvas'); nc.width = Math.round(w); nc.height = Math.round(h);
    nc.getContext('2d').drawImage(flat, x, y, w, h, 0, 0, nc.width, nc.height);
    objects = []; selId = null; cropSel = null;
    setBaseFromCanvas(nc); toast('Cropped');
  }
  function setBaseFromCanvas(c) { work.width = c.width; work.height = c.height; wctx.clearRect(0, 0, work.width, work.height); wctx.drawImage(c, 0, 0); syncSizes(); fitZoom(); render(); snapshot(); updateDims(); }
  function rotate(dir) { const flat = flattenToBase(); const nc = document.createElement('canvas'); nc.width = flat.height; nc.height = flat.width; const c = nc.getContext('2d'); c.translate(nc.width / 2, nc.height / 2); c.rotate((dir > 0 ? 90 : -90) * Math.PI / 180); c.drawImage(flat, -flat.width / 2, -flat.height / 2); objects = []; selId = null; setBaseFromCanvas(nc); }
  function flip(axis) { const flat = flattenToBase(); const nc = document.createElement('canvas'); nc.width = flat.width; nc.height = flat.height; const c = nc.getContext('2d'); if (axis === 'h') { c.translate(nc.width, 0); c.scale(-1, 1); } else { c.translate(0, nc.height); c.scale(1, -1); } c.drawImage(flat, 0, 0); objects = []; selId = null; setBaseFromCanvas(nc); }
  function resizeTo(w, h) { if (!w || !h) return; const flat = flattenToBase(); const nc = document.createElement('canvas'); nc.width = Math.round(w); nc.height = Math.round(h); const c = nc.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(flat, 0, 0, nc.width, nc.height); objects = []; selId = null; setBaseFromCanvas(nc); }

  // ---------- export ----------
  function scaledCanvas(bg) {
    const flat = flattenToBase();
    let s = exportScale === 'max' ? Math.max(1, Math.min(MAX_SIDE / flat.width, MAX_SIDE / flat.height)) : exportScale;
    if (exportScale !== 'max') { const longest = Math.max(flat.width, flat.height) * s; if (longest > MAX_SIDE) s = MAX_SIDE / Math.max(flat.width, flat.height); }
    const nc = document.createElement('canvas'); nc.width = Math.round(flat.width * s); nc.height = Math.round(flat.height * s);
    const c = nc.getContext('2d'); c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    if (bg) { c.fillStyle = bg; c.fillRect(0, 0, nc.width, nc.height); }
    c.drawImage(flat, 0, 0, nc.width, nc.height); return nc;
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
  function copyToClipboard() { flattenToBase().toBlob(async (blob) => { try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Copied to clipboard'); } catch (e) { toast('Copy failed - try Export'); } }, 'image/png'); }

  // ---------- math for AI ----------
  function buildBundle() {
    if (!equations.length) return '';
    const lines = ['You are given a screenshot plus the exact math it contains, transcribed as LaTeX directly from the page source (ground truth \u2014 trust it over the image).', 'Read every equation, solve each, show working step by step and give a clear final answer. For multiple choice, state the chosen option.', '', 'Equations, in reading order:'];
    equations.forEach((e, i) => lines.push((i + 1) + '. ' + (e.type === 'display' ? '[display] ' : '') + (e.latex || e.text || '(see image)')));
    return lines.join('\n');
  }
  function openMath() {
    const list = $('math-list'); list.innerHTML = ''; $('math-ocr-status').textContent = '';
    if (!equations.length) {
      $('math-intro').textContent = 'No machine-readable math found in the page source. Use \u201cRead image with offline AI\u201d to OCR it into LaTeX, or Export at Max 8K and send the sharp image with the prompt.';
      $('math-bundle').value = ['The attached image is a high-resolution screenshot containing math questions.', 'Read each equation exactly (symbols, exponents, fractions, subscripts, operators), then solve each showing your working and a clear final answer.'].join('\n');
    } else { $('math-intro').textContent = equations.length + ' equation(s) from the page source \u2014 no API, no limits.'; renderEqList(); $('math-bundle').value = buildBundle(); }
    openModal('math-modal');
  }
  function renderEqList() { const list = $('math-list'); list.innerHTML = ''; equations.forEach((e, i) => { const r = document.createElement('div'); r.className = 'eq-row'; r.innerHTML = '<span class="eq-n">' + (i + 1) + '</span><code>' + escapeHtml(e.latex || e.text || '(see image)') + '</code>'; list.appendChild(r); }); }
  function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function regionDataUrl() { const flat = flattenToBase(); if (cropSel && cropSel.w > 4 && cropSel.h > 4) { const nc = document.createElement('canvas'); nc.width = Math.round(cropSel.w); nc.height = Math.round(cropSel.h); nc.getContext('2d').drawImage(flat, cropSel.x, cropSel.y, cropSel.w, cropSel.h, 0, 0, nc.width, nc.height); return nc.toDataURL('image/png'); } return flat.toDataURL('image/png'); }
  async function runImageOcr() {
    if (host.hidden) { toast('Load an image first'); return; }
    if (!window.FPOCR) { $('math-ocr-status').textContent = 'OCR engine not installed yet.'; return; }
    const st = $('math-ocr-status'); st.textContent = 'Loading model\u2026 first run downloads it once.';
    try {
      const res = await window.FPOCR.run(regionDataUrl(), (p) => { if (p.status === 'progress' && p.file) st.textContent = 'Downloading ' + p.file + ' ' + (p.progress ? Math.round(p.progress) + '%' : ''); else if (p.status) st.textContent = p.status + '\u2026'; });
      const latex = (res && res.latex) || ''; if (!latex) { st.textContent = 'No math detected.'; return; }
      st.textContent = 'Done.'; equations.push({ id: 'eq-ocr', type: 'display', latex, text: latex, confidence: 0.7 }); updateMathStatus(); renderEqList(); $('math-bundle').value = buildBundle();
    } catch (err) { st.textContent = (err && err.code === 'MISSING_LIB') ? 'OCR library not installed yet.' : ('OCR failed: ' + ((err && err.message) || 'error')); }
  }

  function openModal(id) { $(id).hidden = false; } function closeModal(id) { $(id).hidden = true; }
  function copyText(t, m) { navigator.clipboard.writeText(t || '').then(() => toast(m)).catch(() => toast('Copy failed')); }
  function markScale() { document.querySelectorAll('.scale-chip').forEach((c) => c.classList.toggle('active', c.dataset.scale === String(exportScale))); }
  function saveSettings() { const scale = $('set-scale').value, format = $('set-format').value, ocrModel = $('set-ocr').value.trim(); exportScale = scale === 'max' ? 'max' : Number(scale); exportFormat = format; markScale(); const payload = { exportScale: scale, defaultFormat: format }; if (ocrModel) payload.ocrModel = ocrModel; chrome.storage.local.set({ [SETTINGS_KEY]: payload }, () => { $('set-status').textContent = 'Saved.'; toast('Settings saved'); setTimeout(() => ($('set-status').textContent = ''), 1500); }); }

  async function handleFile(file) {
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    if (isPdf) { if (!window.FPPDF) { toast('PDF engine not installed yet'); return; } toast('Rendering PDF\u2026'); try { const url = await window.FPPDF.fileToImage(file, 2); if (url) { equations = []; updateMathStatus(); await setBase(url); toast('PDF loaded'); } else toast('Empty PDF'); } catch (e) { toast(e && e.message === 'MISSING_LIB' ? 'PDF engine not installed yet' : 'Could not render PDF'); } return; }
    const fr = new FileReader(); fr.onload = () => { equations = []; updateMathStatus(); setBase(fr.result); }; fr.readAsDataURL(file);
  }
  async function pasteClip() { try { const items = await navigator.clipboard.read(); for (const it of items) { const t = it.types.find((x) => x.indexOf('image') === 0); if (t) { handleFile(await it.getType(t)); return; } } toast('No image in clipboard'); } catch (e) { toast('Paste blocked - use Ctrl+V'); } }

  // ---------- bind ----------
  function bind() {
    document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('btn-undo').onclick = undo; $('btn-redo').onclick = redo;
    $('btn-rotl').onclick = () => rotate(-1); $('btn-rotr').onclick = () => rotate(1);
    $('btn-fliph').onclick = () => flip('h'); $('btn-flipv').onclick = () => flip('v');
    $('btn-resize').onclick = () => { $('rz-w').value = work.width; $('rz-h').value = work.height; openModal('resize-modal'); };
    $('rz-w').addEventListener('input', () => { if ($('rz-lock').checked) $('rz-h').value = Math.round($('rz-w').value * work.height / work.width); });
    $('rz-h').addEventListener('input', () => { if ($('rz-lock').checked) $('rz-w').value = Math.round($('rz-h').value * work.width / work.height); });
    $('rz-apply').onclick = () => { resizeTo(parseInt($('rz-w').value, 10), parseInt($('rz-h').value, 10)); closeModal('resize-modal'); };
    $('btn-crop-apply').onclick = applyCrop; $('btn-crop-cancel').onclick = () => { cropSel = null; setTool('select'); };
    document.querySelectorAll('#grp-crop .chip').forEach((c) => c.addEventListener('click', () => { document.querySelectorAll('#grp-crop .chip').forEach((x) => x.classList.remove('active')); c.classList.add('active'); const v = c.dataset.ar; cropAR = v === 'free' ? null : (v === 'a4' ? (210 / 297) : (() => { const [a, b] = v.split(':').map(Number); return a / b; })()); }));
    $('opt-width').addEventListener('input', () => ($('opt-width-val').textContent = $('opt-width').value));
    // inspector edits
    $('insp-stroke').addEventListener('input', () => inspEdit((o) => { if (o.type === 'text') o.color = $('insp-stroke').value; else o.stroke = $('insp-stroke').value; }));
    $('insp-width').addEventListener('input', () => inspEdit((o) => { o.width = parseInt($('insp-width').value, 10); $('insp-width-val').textContent = o.width; }));
    $('insp-fill').addEventListener('input', () => inspEdit((o) => { o.fill = $('insp-fill').checked; }));
    $('insp-fillcolor').addEventListener('input', () => inspEdit((o) => { o.fillColor = $('insp-fillcolor').value; }));
    $('insp-font').addEventListener('input', () => inspEdit((o) => { o.font = $('insp-font').value; }));
    $('insp-fontsize').addEventListener('input', () => inspEdit((o) => { o.size = parseInt($('insp-fontsize').value, 10) || 32; }));
    $('insp-bold').addEventListener('input', () => inspEdit((o) => { o.bold = $('insp-bold').checked; }));
    $('insp-textbg').addEventListener('input', () => inspEdit((o) => { o.bg = $('insp-textbg').checked; }));
    $('insp-del').onclick = () => { const o = sel(); if (!o) return; objects = objects.filter((x) => x !== o); selId = null; refreshInspector(); render(); snapshot(); };
    $('insp-dup').onclick = () => { const o = sel(); if (!o) return; const c = JSON.parse(JSON.stringify(o)); c.id = uid++; c.x += 16; c.y += 16; objects.push(c); selId = c.id; refreshInspector(); render(); snapshot(); };
    $('insp-forward').onclick = () => { const o = sel(); if (!o) return; const i = objects.indexOf(o); if (i < objects.length - 1) { objects.splice(i, 1); objects.push(o); render(); snapshot(); } };
    $('insp-back').onclick = () => { const o = sel(); if (!o) return; const i = objects.indexOf(o); if (i > 0) { objects.splice(i, 1); objects.unshift(o); render(); snapshot(); } };
    $('btn-fit').onclick = fitZoom; $('btn-100').onclick = () => applyZoom(1);
    $('zoom-range').addEventListener('input', () => applyZoom(parseInt($('zoom-range').value, 10) / 100, true));
    $('btn-open').onclick = () => $('file-input').click(); $('empty-open').onclick = () => $('file-input').click();
    $('file-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) handleFile(f); e.target.value = ''; });
    $('btn-paste').onclick = pasteClip; $('empty-paste').onclick = pasteClip;
    $('btn-math').onclick = openMath; $('math-ocr-run').onclick = runImageOcr;
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
    stageWrap.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
    document.addEventListener('paste', (e) => { const items = e.clipboardData && e.clipboardData.items; if (!items) return; for (const it of items) { if (it.type.indexOf('image') === 0) { handleFile(it.getAsFile()); break; } } });
    document.addEventListener('keydown', (e) => {
      if (editingText || /input|textarea|select/i.test(e.target.tagName)) { if (e.key === 'Escape' && editingText) commitText(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel()) { e.preventDefault(); const o = sel(); objects = objects.filter((x) => x !== o); selId = null; refreshInspector(); render(); snapshot(); return; }
      if (sel() && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); const o = sel(); const d = e.shiftKey ? 10 : 1; if (e.key === 'ArrowUp') o.y -= d; if (e.key === 'ArrowDown') o.y += d; if (e.key === 'ArrowLeft') o.x -= d; if (e.key === 'ArrowRight') o.x += d; render(); return; }
      const map = { v: 'select', c: 'crop', t: 'text', p: 'pen', a: 'arrow', l: 'line', r: 'rect', o: 'ellipse', h: 'highlight', b: 'blur', x: 'redact' };
      if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
    });
    window.addEventListener('resize', () => { if (!host.hidden) fitZoom(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
