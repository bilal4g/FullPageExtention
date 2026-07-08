/* FullPage Studio - content script.
 * 1) Drives full-page capture: scroll stepping + fixed/sticky handling.
 * 2) Collects AI-readable math straight from the DOM (no API):
 *    KaTeX, MathJax (v2/v3), MathML, LaTeX annotations and img.alt LaTeX.
 *    MathML is converted to real LaTeX by a built-in recursive converter so
 *    even MathML-only pages produce clean, complete equations. */
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
      let cs; try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (cs.position === 'fixed') { restorers.push({ el, prop: 'visibility', val: el.style.visibility }); el.style.visibility = 'hidden'; }
      else if (cs.position === 'sticky') { restorers.push({ el, prop: 'position', val: el.style.position }); el.style.position = 'static'; }
    }
  }
  function restore() { for (const r of restorers) { try { r.el.style[r.prop] = r.val; } catch (e) {} } restorers = []; window.scrollTo(0, 0); }

  // ================= Math (no API) =================
  function collectMetadata(mode) {
    const equations = collectMath();
    return {
      url: location.href, title: document.title, capturedAt: new Date().toISOString(),
      page: getScrollInfo(),
      math: { count: equations.length, equations, summary: summarize(equations) }
    };
  }

  function collectMath() {
    const selectors = [
      'math', '.katex', '.MathJax', 'mjx-container', '.mjx-container', '.MathJax_Display',
      '[data-mathml]', '[data-latex]', '.katex-display', 'annotation[encoding="application/x-tex"]',
      'script[type="math/tex"]', '[role="math"]'
    ];
    const nodes = new Set();
    document.querySelectorAll(selectors.join(',')).forEach((n) => {
      const container = n.closest('mjx-container, .katex, .MathJax, .MathJax_Display, math, [data-mathml], [data-latex], [role="math"]');
      nodes.add(container || n);
    });
    // drop nodes that are contained within another candidate (avoid double counting)
    const list = Array.from(nodes);
    const filtered = list.filter((n) => !list.some((other) => other !== n && other.contains(n)));

    const out = [];
    filtered.forEach((node) => {
      const rect = node.getBoundingClientRect();
      const latex = bestLatex(node);
      const mathMl = readMathMlString(node);
      const text = clean(node.textContent || '');
      if (!latex && !mathMl && !text) return;
      out.push({
        type: isDisplay(node) ? 'display' : 'inline',
        latex, mathMl, text,
        confidence: score({ latex, mathMl, text }),
        bounds: { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height }
      });
    });
    out.sort((a, b) => (a.bounds.y - b.bounds.y) || (a.bounds.x - b.bounds.x));
    out.forEach((e, i) => (e.id = 'eq-' + (i + 1)));
    return out;
  }

  // Pick the best LaTeX we can get: real TeX annotation > converted MathML > alt/aria/data.
  function bestLatex(node) {
    const ann = node.querySelector && node.querySelector('annotation[encoding="application/x-tex"]');
    if (ann && ann.textContent.trim()) return clean(ann.textContent);
    if (node.tagName && node.tagName.toLowerCase() === 'annotation' && node.textContent.trim()) return clean(node.textContent);
    const dl = node.getAttribute && node.getAttribute('data-latex');
    if (dl && dl.trim()) return clean(dl);
    const scriptTex = node.tagName && node.tagName.toLowerCase() === 'script' && /math\/tex/.test(node.type || '') ? node.textContent : '';
    if (scriptTex && scriptTex.trim()) return clean(scriptTex);
    // Convert MathML if present
    const mathEl = (node.tagName && node.tagName.toLowerCase() === 'math') ? node : (node.querySelector && node.querySelector('math'));
    if (mathEl) { const tex = mathmlToLatex(mathEl); if (tex && tex.trim()) return clean(tex); }
    const dm = node.getAttribute && node.getAttribute('data-mathml');
    if (dm) { try { const doc = new DOMParser().parseFromString(dm, 'text/html'); const m = doc.querySelector('math'); if (m) { const tex = mathmlToLatex(m); if (tex.trim()) return clean(tex); } } catch (e) {} }
    const img = node.querySelector && node.querySelector('img[alt]');
    if (img && /[\\^_{}=+\-]/.test(img.alt)) return clean(img.alt);
    const al = node.getAttribute && node.getAttribute('aria-label');
    if (al && /[\\^_{}=]/.test(al)) return clean(al);
    return '';
  }
  function readMathMlString(node) {
    if (node.tagName && node.tagName.toLowerCase() === 'math') return node.outerHTML.slice(0, 8000);
    const m = node.querySelector && node.querySelector('math');
    if (m) return m.outerHTML.slice(0, 8000);
    const dm = node.getAttribute && node.getAttribute('data-mathml');
    return dm ? dm.slice(0, 8000) : '';
  }

  // ---------- MathML -> LaTeX ----------
  const OP_MAP = {
    '\u00d7': '\\times', '\u00f7': '\\div', '\u00b1': '\\pm', '\u2213': '\\mp',
    '\u2264': '\\leq', '\u2265': '\\geq', '\u2260': '\\neq', '\u2248': '\\approx', '\u2261': '\\equiv',
    '\u221a': '\\sqrt', '\u03c0': '\\pi', '\u221e': '\\infty', '\u2211': '\\sum', '\u220f': '\\prod',
    '\u222b': '\\int', '\u2202': '\\partial', '\u2207': '\\nabla', '\u2208': '\\in', '\u2209': '\\notin',
    '\u2282': '\\subset', '\u2286': '\\subseteq', '\u222a': '\\cup', '\u2229': '\\cap',
    '\u2192': '\\to', '\u21d2': '\\Rightarrow', '\u21d4': '\\Leftrightarrow', '\u2200': '\\forall', '\u2203': '\\exists',
    '\u22c5': '\\cdot', '\u2026': '\\dots', '\u00b7': '\\cdot',
    '\u03b1': '\\alpha', '\u03b2': '\\beta', '\u03b3': '\\gamma', '\u03b4': '\\delta', '\u03b5': '\\epsilon',
    '\u03b8': '\\theta', '\u03bb': '\\lambda', '\u03bc': '\\mu', '\u03c3': '\\sigma', '\u03c6': '\\phi', '\u03c9': '\\omega',
    '\u0394': '\\Delta', '\u03a3': '\\Sigma', '\u03a9': '\\Omega'
  };
  function mapText(t) {
    if (!t) return '';
    let out = '';
    for (const ch of t) out += (OP_MAP[ch] ? OP_MAP[ch] + ' ' : ch);
    return out;
  }
  function kids(el) { return Array.from(el.children); }
  function conv(node) {
    if (!node) return '';
    if (node.nodeType === 3) return mapText(node.nodeValue.trim());
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase().replace(/^m:/, '');
    const ch = kids(node);
    switch (tag) {
      case 'math': case 'mrow': case 'mstyle': case 'mpadded': case 'semantics': return ch.map(conv).join('');
      case 'mi': case 'mn': return mapText(node.textContent.trim());
      case 'mo': return ' ' + mapText(node.textContent.trim()) + ' ';
      case 'mtext': return '\\text{' + node.textContent + '}';
      case 'mspace': return ' ';
      case 'mfrac': return '\\frac{' + conv(ch[0]) + '}{' + conv(ch[1]) + '}';
      case 'msqrt': return '\\sqrt{' + ch.map(conv).join('') + '}';
      case 'mroot': return '\\sqrt[' + conv(ch[1]) + ']{' + conv(ch[0]) + '}';
      case 'msup': return '{' + conv(ch[0]) + '}^{' + conv(ch[1]) + '}';
      case 'msub': return '{' + conv(ch[0]) + '}_{' + conv(ch[1]) + '}';
      case 'msubsup': return '{' + conv(ch[0]) + '}_{' + conv(ch[1]) + '}^{' + conv(ch[2]) + '}';
      case 'munder': return '\\underset{' + conv(ch[1]) + '}{' + conv(ch[0]) + '}';
      case 'mover': return '\\overset{' + conv(ch[1]) + '}{' + conv(ch[0]) + '}';
      case 'munderover': return conv(ch[0]) + '_{' + conv(ch[1]) + '}^{' + conv(ch[2]) + '}';
      case 'mfenced': {
        const open = node.getAttribute('open') || '('; const close = node.getAttribute('close') || ')';
        return open + ch.map(conv).join(node.getAttribute('separators') || ',') + close;
      }
      case 'mtable': return '\\begin{matrix}' + ch.map(conv).join(' \\\\ ') + '\\end{matrix}';
      case 'mtr': return ch.map(conv).join(' & ');
      case 'mtd': return ch.map(conv).join('');
      default: return ch.length ? ch.map(conv).join('') : mapText(node.textContent.trim());
    }
  }
  function mathmlToLatex(mathEl) { try { return conv(mathEl).replace(/\s+/g, ' ').trim(); } catch (e) { return ''; } }

  function isDisplay(node) {
    if (node.matches && node.matches('.katex-display, mjx-container[display="true"], .MathJax_Display')) return true;
    if (node.tagName && node.tagName.toLowerCase() === 'math') return node.getAttribute('display') === 'block';
    return false;
  }
  function score({ latex, mathMl, text }) {
    let s = 0.2; if (text) s += 0.15; if (mathMl) s += 0.3; if (latex) s += 0.35; if ((latex || '').includes('\\')) s += 0.1;
    return Math.min(1, Number(s.toFixed(2)));
  }
  function summarize(eqs) {
    const display = eqs.filter((e) => e.type === 'display').length;
    return { displayCount: display, inlineCount: eqs.length - display, lowConfidence: eqs.filter((e) => e.confidence < 0.55).map((e) => e.id), hasDomMath: eqs.some((e) => e.latex || e.mathMl) };
  }
  function clean(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }
})();
