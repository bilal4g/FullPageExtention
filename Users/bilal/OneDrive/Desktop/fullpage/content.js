/* SnapScroll Pro - Content Script */
let lastMouseX = 0, lastMouseY = 0;
let lastScrollX = -1, lastScrollY = -1;
let captureTargetElement = null, originalScrollTop = 0;

// Track mouse movement
document.addEventListener('mousemove', (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
}, { passive: true });

// Track where user clicks — store on dataset so CDP (page world) can also read it
document.addEventListener('mousedown', (e) => {
  lastScrollX = e.clientX;
  lastScrollY = e.clientY;
  document.documentElement.dataset.ssClickX = e.clientX;
  document.documentElement.dataset.ssClickY = e.clientY;
}, { passive: true });

// Track scroll events — the element the user scrolled is almost certainly what they want
document.addEventListener('scroll', (e) => {
  const el = e.target;
  if (el && el !== document && el !== document.documentElement && el !== document.body) {
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    lastScrollX = cx;
    lastScrollY = cy;
    document.documentElement.dataset.ssClickX = cx;
    document.documentElement.dataset.ssClickY = cy;
  }
}, { passive: true, capture: true });

// --- Helpers ---

// Returns true if an element is actually scrollable (not just styled as scrollable)
function canActuallyScroll(el) {
  const old = el.scrollTop;
  el.scrollTop = old + 10;
  if (el.scrollTop !== old) { el.scrollTop = old; return true; }
  el.scrollTop = old - 10;
  if (el.scrollTop !== old) { el.scrollTop = old; return true; }
  return false;
}

// Returns true if element should be skipped (fixed/sticky, too small, or not scrollable)
function isInvalidScrollTarget(el) {
  try {
    const cs = window.getComputedStyle(el);
    const pos = cs.position;
    // Skip fixed/sticky elements — they're nav/sidebars, not content
    if (pos === 'fixed' || pos === 'sticky') return true;
    // Skip elements smaller than 40% of viewport (likely a small widget, not main content)
    const vw = window.innerWidth, vh = window.innerHeight;
    if (el.clientWidth < vw * 0.4 || el.clientHeight < vh * 0.4) return true;
  } catch(e) {}
  return false;
}

function findMainScrollableElement() {
  const allElements = document.querySelectorAll('*');
  let bestElement = null, bestArea = 0;
  for (const el of allElements) {
    if (el === document.documentElement || el === document.body) continue;
    if (isInvalidScrollTarget(el)) continue;
    try {
      const style = window.getComputedStyle(el);
      const oy = style.overflowY, o = style.overflow;
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay' || o === 'auto' || o === 'scroll' || o === 'overlay') {
        if (el.scrollHeight > el.clientHeight + 5 && canActuallyScroll(el)) {
          const area = el.clientWidth * el.clientHeight;
          if (area > bestArea) { bestArea = area; bestElement = el; }
        }
      }
    } catch(e) {}
  }
  return bestElement;
}

function findScrollableAt(x, y) {
  let el = document.elementFromPoint(x, y);
  while (el && el !== document.documentElement && el !== document.body) {
    if (!isInvalidScrollTarget(el)) {
      try {
        const style = window.getComputedStyle(el);
        const oy = style.overflowY, o = style.overflow;
        if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay' || o === 'auto' || o === 'scroll' || o === 'overlay')
            && el.scrollHeight > el.clientHeight + 5
            && canActuallyScroll(el)) {
          return el;
        }
      } catch(e) {}
    }
    el = el.parentElement;
  }
  return null;
}

function getScrollInfo() {
  let target = null;

  // Priority 1: element at last scroll/click position
  if (lastScrollX >= 0 && lastScrollY >= 0) {
    target = findScrollableAt(lastScrollX, lastScrollY);
  }
  // Priority 2: element at last mouse position
  if (!target && lastMouseX >= 0 && lastMouseY >= 0) {
    target = findScrollableAt(lastMouseX, lastMouseY);
  }
  // Priority 3: largest scrollable element (excluding fixed/sticky/small)
  if (!target) {
    target = findMainScrollableElement();
  }

  if (target) {
    captureTargetElement = target;
    originalScrollTop = target.scrollTop;
    const rect = target.getBoundingClientRect();
    return {
      mode: 'element',
      element: {
        scrollHeight: target.scrollHeight,
        clientHeight: target.clientHeight,
        scrollTop: target.scrollTop,
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
      },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio
    };
  }

  // Fallback: full page scroll
  return {
    mode: 'fullpage',
    totalHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    totalWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio
  };
}

function scrollTo(y, mode) {
  if (mode === 'element' && captureTargetElement) {
    captureTargetElement.scrollTop = y;
    return { scrollY: captureTargetElement.scrollTop };
  }
  window.scrollTo(0, y);
  return { scrollY: window.scrollY };
}

function getScrollPosition(mode) {
  if (mode === 'element' && captureTargetElement) return { scrollY: captureTargetElement.scrollTop };
  return { scrollY: window.scrollY };
}

function hideScrollbars() {
  if (!document.getElementById('__snapscroll-hide-scrollbars')) {
    const s = document.createElement('style');
    s.id = '__snapscroll-hide-scrollbars';
    s.textContent = '*::-webkit-scrollbar{display:none!important}*{scrollbar-width:none!important;scroll-behavior:auto!important}';
    document.head.appendChild(s);
  }
}

function showScrollbars() {
  const s = document.getElementById('__snapscroll-hide-scrollbars');
  if (s) s.remove();
  if (captureTargetElement) captureTargetElement.scrollTop = originalScrollTop;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    switch (message.action) {
      case 'ping': sendResponse({ ok: true }); break;
      case 'getScrollInfo': sendResponse(getScrollInfo()); break;
      case 'scrollTo': sendResponse(scrollTo(message.y, message.mode)); break;
      case 'getScrollPosition': sendResponse(getScrollPosition(message.mode)); break;
      case 'hideScrollbars': hideScrollbars(); sendResponse({ ok: true }); break;
      case 'showScrollbars': showScrollbars(); sendResponse({ ok: true }); break;
      default: sendResponse({ error: 'Unknown action' });
    }
  } catch(err) { sendResponse({ error: err.message }); }
  return true;
});
