/* FullPage Studio - content script.
 * 1) Drives full-page capture: scroll stepping + fixed/sticky handling.
 * 2) Collects AI-readable math straight from the DOM (no API): MathML,
 *    KaTeX, MathJax and LaTeX annotations are already in the page HTML. */
(() => {
  if (window.__fpStudioInjected) return;
  window.__fpStudioInjected = true;

  let restorers = [];

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'fp:ping': sendResponse({ ok: true }); break;
      case 'fp:getScrollInfo': sendResponse(getScrollInfo()); break;
      case 'fp:prepare': prepare(); sendResponse({ ok: true }); break;
      case 'fp:scrollTo': window.scrollTo(0, msg.y || 0); sendResponse({ y: window.scrollY }); break;
      case 'fp:restore': restore(); sendResponse({ ok: true }); break;
      case 'fp:metadata': sendResponse(collectMetadata(msg.mode || 'visible')); break;
      default: break;
    }
    return true;
  });

  function getScrollInfo() {
    const de = document.documentElement;
    return {
      totalHeight: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0),
      totalWidth: Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio || 1
    };
  }

  function prepare() {
    restorers = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      let cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (cs.position === 'fixed') {
        restorers.push({ el, prop: 'visibility', val: el.style.visibility });
        el.style.visibility = 'hidden';
      } else if (cs.position === 'sticky') {
        restorers.push({ el, prop: 'position', val: el.style.position });
        el.style.position = 'static';
      }
    }
  }
  function restore() {
    for (const r of restorers) { try { r.el.style[r.prop] = r.val; } catch (e) {} }
    restorers = [];
    window.scrollTo(0, 0);
  }

  // ---------- Math (no API) ----------
  function collectMetadata(mode) {
    const equations = collectMath();
    return {
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      page: getScrollInfo(),
      math: { count: equations.length, equations, summary: summarize(equations) }
    };
  }

  function collectMath() {
    const selectors = ['math', '.katex', '.MathJax', 'mjx-container', '.mjx-container',
      '[data-mathml]', '[data-latex]', '.katex-display', 'annotation[encoding="application/x-tex"]'];
    const nodes = new Set();
    document.querySelectorAll(selectors.join(',')).forEach((n) => {
      // climb to a sensible container so we don't double count inner spans
      let top = n;
      const container = n.closest('mjx-container, .katex, .MathJax, math, [data-mathml], [data-latex]');
      if (container) top = container;
      nodes.add(top);
    });
    const out = [];
    let i = 0;
    nodes.forEach((node) => {
      const rect = node.getBoundingClientRect();
      const latex = readLatex(node);
      const mathMl = readMathMl(node);
      const text = clean(node.textContent || '');
      if (!latex && !mathMl && !text) return;
      i += 1;
      out.push({
        id: 'eq-' + i,
        type: isDisplay(node) ? 'display' : 'inline',
        latex, mathMl, text,
        confidence: score({ latex, mathMl, text }),
        bounds: { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height }
      });
    });
    // sort top-to-bottom so equation order matches reading order
    out.sort((a, b) => a.bounds.y - b.bounds.y);
    out.forEach((e, idx) => (e.id = 'eq-' + (idx + 1)));
    return out;
  }

  function readLatex(node) {
    const ann = node.querySelector && node.querySelector('annotation[encoding="application/x-tex"]');
    if (ann && ann.textContent) return clean(ann.textContent);
    if (node.tagName && node.tagName.toLowerCase() === 'annotation' && node.textContent) return clean(node.textContent);
    const dl = node.getAttribute && node.getAttribute('data-latex');
    if (dl) return clean(dl);
    // Wikipedia and many sites store LaTeX in the image alt text
    const img = node.querySelector && node.querySelector('img[alt]');
    if (img && /[\\^_{}]/.test(img.alt)) return clean(img.alt);
    const al = node.getAttribute && node.getAttribute('aria-label');
    if (al && /[\\^_{}]/.test(al)) return clean(al);
    return '';
  }
  function readMathMl(node) {
    if (node.tagName && node.tagName.toLowerCase() === 'math') return node.outerHTML.slice(0, 8000);
    const m = node.querySelector && node.querySelector('math');
    if (m) return m.outerHTML.slice(0, 8000);
    const dm = node.getAttribute && node.getAttribute('data-mathml');
    return dm ? dm.slice(0, 8000) : '';
  }
  function isDisplay(node) {
    if (node.matches && node.matches('.katex-display, mjx-container[display="true"], .MathJax_Display')) return true;
    if (node.tagName && node.tagName.toLowerCase() === 'math') return node.getAttribute('display') === 'block';
    return false;
  }
  function score({ latex, mathMl, text }) {
    let s = 0.2;
    if (text) s += 0.15;
    if (mathMl) s += 0.35;
    if (latex) s += 0.3;
    if ((latex || '').includes('\\')) s += 0.1;
    return Math.min(1, Number(s.toFixed(2)));
  }
  function summarize(eqs) {
    const display = eqs.filter((e) => e.type === 'display').length;
    return {
      displayCount: display,
      inlineCount: eqs.length - display,
      lowConfidence: eqs.filter((e) => e.confidence < 0.55).map((e) => e.id),
      hasDomMath: eqs.some((e) => e.latex || e.mathMl)
    };
  }
  function clean(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }
})();
