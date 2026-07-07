(() => {
  if (window.__fullPageStudioInjected) return;
  window.__fullPageStudioInjected = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'studio:collect-page-metadata') {
      sendResponse(collectPageMetadata(message.mode || 'visible'));
    }
  });

  function collectPageMetadata(mode) {
    const equations = collectMathPayload();
    const page = {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    };

    const suggestedSegmentHeight = Math.max(window.innerHeight, 1600);
    const segmentCount = mode === 'full'
      ? Math.max(1, Math.ceil(page.scrollHeight / suggestedSegmentHeight))
      : 1;

    const segments = Array.from({ length: segmentCount }, (_, index) => ({
      index,
      y: index * suggestedSegmentHeight,
      height: Math.min(suggestedSegmentHeight, page.scrollHeight - index * suggestedSegmentHeight),
      label: `Segment ${index + 1}`,
      equationIds: equations
        .filter((equation) => equation.bounds.y >= index * suggestedSegmentHeight && equation.bounds.y < (index + 1) * suggestedSegmentHeight)
        .map((equation) => equation.id)
    }));

    return {
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      page,
      math: {
        count: equations.length,
        equations,
        summary: summarizeEquations(equations)
      },
      selection: readSelection(),
      segments,
      landmarks: collectLandmarks(),
      colors: collectThemeTokens(),
      headings: collectHeadings(),
      tables: collectTables(),
      images: collectImages()
    };
  }

  function collectMathPayload() {
    const equationSelectors = [
      'math',
      '.katex',
      '.MathJax',
      '[data-mathml]',
      '[data-latex]',
      '.mjx-container',
      '.katex-display',
      '.katex-inline',
      '[aria-label*="equation"]'
    ];

    const seen = new Set();
    return Array.from(document.querySelectorAll(equationSelectors.join(',')))
      .map((node, index) => {
        if (seen.has(node)) return null;
        seen.add(node);
        const rect = node.getBoundingClientRect();
        const text = clean(node.innerText || node.textContent || '');
        const mathMl = node.tagName.toLowerCase() === 'math'
          ? node.outerHTML
          : node.querySelector('math')?.outerHTML || node.getAttribute('data-mathml') || '';
        const latex = node.getAttribute('data-latex')
          || node.getAttribute('aria-label')
          || node.querySelector('annotation[encoding="application/x-tex"]')?.textContent
          || inferLatex(text);
        return {
          id: `eq-${index + 1}`,
          type: classifyEquation(node),
          text,
          latex,
          mathMl,
          confidence: calculateConfidence({ text, latex, mathMl }),
          bounds: {
            x: rect.left + window.scrollX,
            y: rect.top + window.scrollY,
            width: rect.width,
            height: rect.height
          },
          htmlSnippet: node.outerHTML.slice(0, 5000)
        };
      })
      .filter(Boolean);
  }

  function summarizeEquations(equations) {
    const displayCount = equations.filter((equation) => equation.type === 'display').length;
    const inlineCount = equations.length - displayCount;
    const lowConfidence = equations.filter((equation) => equation.confidence < 0.55).map((equation) => equation.id);
    return {
      displayCount,
      inlineCount,
      lowConfidence,
      recommendedWorkflow: equations.length > 12
        ? 'segment+metadata-export'
        : 'single-image+metadata-export'
    };
  }

  function classifyEquation(node) {
    if (node.matches('.katex-display, .MathJax_Display, .mjx-container[display="true"]')) return 'display';
    if (node.tagName.toLowerCase() === 'math') return node.getAttribute('display') === 'block' ? 'display' : 'inline';
    return 'inline';
  }

  function inferLatex(text) {
    if (!text) return '';
    return text
      .replace(/×/g, ' \\times ')
      .replace(/÷/g, ' \\div ')
      .replace(/≤/g, ' \\leq ')
      .replace(/≥/g, ' \\geq ')
      .replace(/√/g, ' \\sqrt{} ')
      .replace(/π/g, ' \\pi ')
      .replace(/∞/g, ' \\infty ')
      .replace(/∑/g, ' \\sum ')
      .replace(/∫/g, ' \\int ')
      .replace(/≈/g, ' \\approx ')
      .trim();
  }

  function calculateConfidence({ text, latex, mathMl }) {
    let score = 0.2;
    if (text?.length > 0) score += 0.2;
    if (latex?.length > 0) score += 0.25;
    if (mathMl?.length > 0) score += 0.35;
    if ((latex || '').includes('\\')) score += 0.1;
    return Math.min(1, Number(score.toFixed(2)));
  }

  function readSelection() {
    const selection = window.getSelection?.();
    return selection && String(selection).trim()
      ? {
          text: String(selection).trim(),
          rangeCount: selection.rangeCount
        }
      : null;
  }

  function collectLandmarks() {
    return Array.from(document.querySelectorAll('main, article, section, nav, aside, header, footer'))
      .slice(0, 50)
      .map((node, index) => ({
        id: `landmark-${index + 1}`,
        tag: node.tagName.toLowerCase(),
        label: clean(node.getAttribute('aria-label') || node.id || node.className || '')
      }));
  }

  function collectHeadings() {
    return Array.from(document.querySelectorAll('h1, h2, h3, h4'))
      .slice(0, 60)
      .map((node, index) => ({
        id: `heading-${index + 1}`,
        level: node.tagName.toLowerCase(),
        text: clean(node.textContent)
      }));
  }

  function collectTables() {
    return Array.from(document.querySelectorAll('table'))
      .slice(0, 20)
      .map((table, index) => ({
        id: `table-${index + 1}`,
        rows: table.rows.length,
        columns: table.rows[0]?.cells.length || 0,
        preview: clean(table.innerText).slice(0, 500)
      }));
  }

  function collectImages() {
    return Array.from(document.images)
      .slice(0, 30)
      .map((img, index) => ({
        id: `img-${index + 1}`,
        src: img.currentSrc || img.src,
        alt: img.alt || '',
        width: img.naturalWidth,
        height: img.naturalHeight
      }));
  }

  function collectThemeTokens() {
    const style = getComputedStyle(document.documentElement);
    const candidates = ['--background', '--foreground', '--primary', '--accent'];
    return candidates
      .map((name) => [name, style.getPropertyValue(name).trim()])
      .filter(([, value]) => value)
      .map(([name, value]) => ({ name, value }));
  }

  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }
})();
