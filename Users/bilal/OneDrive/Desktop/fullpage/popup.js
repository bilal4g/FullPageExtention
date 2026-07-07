const state = {
  activeTool: 'select',
  theme: 'dark',
  capture: null,
  history: [],
  future: [],
  overlays: [],
  selectedOverlayId: null,
  settings: {
    exportFormat: 'png',
    exportScale: 2,
    strokeColor: '#7c3aed',
    fillColor: '#22c55e',
    fontFamily: 'Inter',
    fontSize: 20,
    cropPreset: 'free'
  }
};

const els = {
  shell: document.getElementById('appShell'),
  canvas: document.getElementById('editorCanvas'),
  emptyState: document.getElementById('emptyState'),
  propertyList: document.getElementById('propertyList'),
  mathPanel: document.getElementById('mathPanel'),
  historyList: document.getElementById('historyList'),
  workspaceTitle: document.getElementById('workspaceTitle'),
  mathCountBadge: document.getElementById('mathCountBadge'),
  segmentCountBadge: document.getElementById('segmentCountBadge'),
  captureModeBadge: document.getElementById('captureModeBadge'),
  shortcutsDialog: document.getElementById('shortcutsDialog')
};
const ctx = els.canvas.getContext('2d');
const image = new Image();

boot();

async function boot() {
  bindUI();
  await restoreCapture();
  render();
}

function bindUI() {
  document.querySelectorAll('[data-capture]').forEach((button) => {
    button.addEventListener('click', () => requestCapture(button.dataset.capture));
  });

  document.querySelectorAll('[data-tool]').forEach((button) => {
    button.addEventListener('click', () => setTool(button.dataset.tool));
  });

  document.getElementById('strokeColor').addEventListener('input', (e) => {
    state.settings.strokeColor = e.target.value;
    pushHistory(`Changed stroke color to ${e.target.value}`);
    render();
  });
  document.getElementById('fillColor').addEventListener('input', (e) => {
    state.settings.fillColor = e.target.value;
    pushHistory(`Changed fill color to ${e.target.value}`);
    render();
  });
  document.getElementById('fontFamily').addEventListener('change', (e) => {
    state.settings.fontFamily = e.target.value;
    pushHistory(`Selected ${e.target.value} font`);
    renderProperties();
  });
  document.getElementById('fontSize').addEventListener('input', (e) => {
    state.settings.fontSize = Number(e.target.value);
    pushHistory(`Set text size to ${e.target.value}px`);
    renderProperties();
  });
  document.getElementById('cropPreset').addEventListener('change', (e) => {
    state.settings.cropPreset = e.target.value;
    pushHistory(`Crop preset: ${e.target.value}`);
    renderProperties();
  });
  document.getElementById('exportFormat').addEventListener('change', (e) => {
    state.settings.exportFormat = e.target.value;
  });
  document.getElementById('exportScale').addEventListener('change', (e) => {
    state.settings.exportScale = Number(e.target.value);
  });

  document.getElementById('downloadBtn').addEventListener('click', exportResult);
  document.getElementById('exportBtn').addEventListener('click', exportResult);
  document.getElementById('copyBtn').addEventListener('click', copyImage);
  document.getElementById('shareBtn').addEventListener('click', shareResult);
  document.getElementById('metadataBtn').addEventListener('click', exportMathMetadata);
  document.getElementById('undoBtn').addEventListener('click', undo);
  document.getElementById('redoBtn').addEventListener('click', redo);
  document.getElementById('themeToggleBtn').addEventListener('click', toggleTheme);
  document.getElementById('resetBtn').addEventListener('click', resetEditor);
  document.getElementById('onboardingBtn').addEventListener('click', () => els.shortcutsDialog.showModal());
  document.getElementById('closeShortcutsBtn').addEventListener('click', () => els.shortcutsDialog.close());

  els.canvas.addEventListener('click', handleCanvasClick);
  document.addEventListener('keydown', handleKeyboardShortcuts);
}

async function restoreCapture() {
  const response = await chrome.runtime.sendMessage({ type: 'studio:get-last-capture' }).catch(() => null);
  if (response?.capture) {
    await applyCapture(response.capture);
  }
}

async function requestCapture(mode) {
  setBusy(`Capturing ${mode === 'full' ? 'full page' : 'visible area'}...`);
  const response = await chrome.runtime.sendMessage({ type: 'studio:capture', mode });
  if (!response?.ok) {
    setBusy('Capture failed');
    return;
  }
  await applyCapture(response.payload);
  pushHistory(`Captured ${mode === 'full' ? 'full page' : 'visible area'}`);
  clearBusy();
}

async function applyCapture(capture) {
  state.capture = capture;
  state.overlays = buildSuggestedOverlays(capture);
  state.future = [];
  image.src = capture.image;
  await image.decode();
  resizeCanvasToImage();
  render();
}

function resizeCanvasToImage() {
  const ratio = image.width / image.height || 16 / 10;
  const maxWidth = 1000;
  const maxHeight = 620;
  let width = maxWidth;
  let height = width / ratio;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * ratio;
  }
  els.canvas.width = Math.round(width * window.devicePixelRatio);
  els.canvas.height = Math.round(height * window.devicePixelRatio);
  els.canvas.style.width = `${Math.round(width)}px`;
  els.canvas.style.height = `${Math.round(height)}px`;
}

function buildSuggestedOverlays(capture) {
  const overlays = [];
  capture.metadata?.math?.equations?.slice(0, 12).forEach((equation, index) => {
    overlays.push({
      id: `math-${index + 1}`,
      type: 'number',
      label: String(index + 1),
      x: 48,
      y: 48 + index * 32,
      color: '#f59e0b',
      meta: equation
    });
  });
  return overlays;
}

function render() {
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  if (!state.capture) {
    els.emptyState.hidden = false;
    renderProperties();
    renderMathPanel();
    renderHistory();
    return;
  }

  els.emptyState.hidden = true;
  ctx.save();
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  ctx.drawImage(image, 0, 0, parseFloat(els.canvas.style.width), parseFloat(els.canvas.style.height));
  drawOverlays();
  ctx.restore();

  els.workspaceTitle.textContent = state.capture.tab?.title || 'Editing capture';
  els.captureModeBadge.textContent = state.capture.mode === 'full' ? 'Full-page capture' : 'Visible capture';
  els.mathCountBadge.textContent = `${state.capture.metadata?.math?.count || 0} equations detected`;
  els.segmentCountBadge.textContent = `${state.capture.metadata?.segments?.length || 0} segments`;

  renderProperties();
  renderMathPanel();
  renderHistory();
}

function drawOverlays() {
  state.overlays.forEach((overlay) => {
    if (overlay.type === 'number') {
      ctx.fillStyle = overlay.color || state.settings.strokeColor;
      ctx.beginPath();
      ctx.arc(overlay.x, overlay.y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px Inter';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(overlay.label, overlay.x, overlay.y + 1);
    }
    if (overlay.type === 'text') {
      ctx.fillStyle = overlay.color || state.settings.strokeColor;
      ctx.font = `${overlay.size || state.settings.fontSize}px ${overlay.font || state.settings.fontFamily}`;
      ctx.fillText(overlay.text, overlay.x, overlay.y);
    }
    if (overlay.type === 'shape') {
      ctx.strokeStyle = overlay.color || state.settings.strokeColor;
      ctx.lineWidth = 3;
      ctx.strokeRect(overlay.x, overlay.y, overlay.width, overlay.height);
    }
    if (overlay.type === 'highlight') {
      ctx.fillStyle = 'rgba(250, 204, 21, 0.28)';
      ctx.fillRect(overlay.x, overlay.y, overlay.width, overlay.height);
    }
    if (overlay.type === 'redact') {
      ctx.fillStyle = '#111827';
      ctx.fillRect(overlay.x, overlay.y, overlay.width, overlay.height);
    }
  });
}

function renderProperties() {
  const properties = [
    ['Active tool', titleCase(state.activeTool)],
    ['Crop preset', state.settings.cropPreset],
    ['Stroke color', state.settings.strokeColor],
    ['Fill color', state.settings.fillColor],
    ['Font', `${state.settings.fontFamily} ${state.settings.fontSize}px`],
    ['Export', `${state.settings.exportFormat.toUpperCase()} @ ${state.settings.exportScale}x`],
    ['Undo depth', String(state.history.length)]
  ];

  if (state.capture) {
    properties.unshift(
      ['Page URL', state.capture.tab?.url || 'Unknown'],
      ['Page size', `${state.capture.metadata?.page?.scrollWidth || 0} × ${state.capture.metadata?.page?.scrollHeight || 0}`]
    );
  }

  els.propertyList.innerHTML = properties.map(([label, value]) => `
    <div class="property-item">
      <strong>${label}</strong>
      <div>${escapeHtml(value)}</div>
    </div>
  `).join('');
}

function renderMathPanel() {
  const equations = state.capture?.metadata?.math?.equations || [];
  if (!equations.length) {
    els.mathPanel.innerHTML = '<div class="math-item">No math markup detected yet. Full-page captures still export structured metadata and page segments.</div>';
    return;
  }

  els.mathPanel.innerHTML = equations.slice(0, 10).map((equation, index) => `
    <div class="math-item">
      <strong>Equation ${index + 1}</strong>
      <div>${escapeHtml(equation.text || equation.latex || 'Untitled equation')}</div>
      ${equation.latex ? `<code>${escapeHtml(equation.latex.slice(0, 120))}</code>` : ''}
    </div>
  `).join('');
}

function renderHistory() {
  els.historyList.innerHTML = state.history.slice().reverse().map((entry) => `<li>${escapeHtml(entry.label)}</li>`).join('');
}

function setTool(tool) {
  state.activeTool = tool;
  document.querySelectorAll('[data-tool]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tool === tool);
  });
  pushHistory(`Switched to ${titleCase(tool)} tool`);
  renderProperties();
}

function handleCanvasClick(event) {
  if (!state.capture) return;
  const rect = els.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  const overlay = makeOverlayFromCurrentTool(x, y);
  if (!overlay) return;
  state.overlays.push(overlay);
  state.future = [];
  pushHistory(`Added ${state.activeTool} annotation`);
  render();
}

function makeOverlayFromCurrentTool(x, y) {
  switch (state.activeTool) {
    case 'text':
      return {
        id: crypto.randomUUID(),
        type: 'text',
        x,
        y,
        text: 'Rich text',
        color: state.settings.strokeColor,
        font: state.settings.fontFamily,
        size: state.settings.fontSize
      };
    case 'highlight':
      return { id: crypto.randomUUID(), type: 'highlight', x, y, width: 220, height: 48 };
    case 'redact':
      return { id: crypto.randomUUID(), type: 'redact', x, y, width: 200, height: 36 };
    case 'shape':
    case 'crop':
    case 'resize':
      return { id: crypto.randomUUID(), type: 'shape', x, y, width: 220, height: 120, color: state.settings.strokeColor };
    case 'number':
      return { id: crypto.randomUUID(), type: 'number', x, y, label: String(state.overlays.filter((item) => item.type === 'number').length + 1), color: state.settings.strokeColor };
    case 'blur':
      return { id: crypto.randomUUID(), type: 'shape', x, y, width: 180, height: 60, color: '#60a5fa' };
    case 'arrow':
      return { id: crypto.randomUUID(), type: 'text', x, y, text: '➜', color: state.settings.strokeColor, size: 42 };
    default:
      return null;
  }
}

function pushHistory(label) {
  state.history.push({ label, snapshot: snapshotState() });
  if (state.history.length > 100) state.history.shift();
  renderHistory();
}

function snapshotState() {
  return JSON.stringify({
    activeTool: state.activeTool,
    overlays: state.overlays,
    settings: state.settings,
    capture: state.capture
  });
}

function undo() {
  if (state.history.length < 2) return;
  const current = state.history.pop();
  state.future.push(current);
  const previous = state.history[state.history.length - 1];
  restoreSnapshot(previous.snapshot);
}

function redo() {
  const next = state.future.pop();
  if (!next) return;
  state.history.push(next);
  restoreSnapshot(next.snapshot);
}

function restoreSnapshot(snapshot) {
  const parsed = JSON.parse(snapshot);
  state.activeTool = parsed.activeTool;
  state.overlays = parsed.overlays;
  state.settings = parsed.settings;
  state.capture = parsed.capture;
  document.querySelectorAll('[data-tool]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tool === state.activeTool);
  });
  if (state.capture) {
    image.src = state.capture.image;
    image.decode().then(() => {
      resizeCanvasToImage();
      render();
    });
  } else {
    render();
  }
}

async function exportResult() {
  if (!state.capture) return;
  if (state.settings.exportFormat === 'json') {
    return exportMathMetadata();
  }
  const format = state.settings.exportFormat;
  const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  const link = document.createElement('a');
  link.href = els.canvas.toDataURL(mime, 0.96);
  link.download = `fullpage-studio-${Date.now()}.${format === 'jpeg' ? 'jpg' : format}`;
  link.click();
  pushHistory(`Exported ${format.toUpperCase()} image`);
}

async function exportMathMetadata() {
  if (!state.capture) return;
  const payload = {
    capture: {
      title: state.capture.tab?.title,
      url: state.capture.tab?.url,
      mode: state.capture.mode,
      createdAt: state.capture.createdAt
    },
    metadata: state.capture.metadata,
    overlays: state.overlays
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `fullpage-math-metadata-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  pushHistory('Exported math metadata JSON');
}

async function copyImage() {
  if (!state.capture || !navigator.clipboard?.write) return exportResult();
  const blob = await (await fetch(els.canvas.toDataURL('image/png'))).blob();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  pushHistory('Copied image to clipboard');
}

async function shareResult() {
  if (!state.capture) return;
  const payload = {
    title: state.capture.tab?.title || 'FullPage Studio capture',
    text: `Annotated capture from ${state.capture.tab?.url}`,
    url: state.capture.tab?.url
  };
  if (navigator.share) {
    try {
      await navigator.share(payload);
      pushHistory('Opened native share flow');
      return;
    } catch (_) {}
  }
  await navigator.clipboard.writeText(`${payload.title}\n${payload.url}`);
  pushHistory('Copied share link to clipboard');
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  pushHistory(`Switched to ${state.theme} theme`);
}

function resetEditor() {
  state.overlays = buildSuggestedOverlays(state.capture || { metadata: { math: { equations: [] } } });
  state.future = [];
  pushHistory('Reset editor annotations');
  render();
}

function setBusy(label) {
  els.workspaceTitle.textContent = label;
}

function clearBusy() {
  render();
}

function handleKeyboardShortcuts(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
    event.preventDefault();
    undo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && event.shiftKey) {
    event.preventDefault();
    redo();
    return;
  }
  const toolMap = {
    v: 'select',
    c: 'crop',
    b: 'blur',
    h: 'highlight',
    r: 'redact',
    t: 'text'
  };
  const tool = toolMap[event.key.toLowerCase()];
  if (tool) {
    setTool(tool);
  }
}

function titleCase(value) {
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
