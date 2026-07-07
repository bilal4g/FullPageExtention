/* FullPage Studio - local, key-less math helper (window.SSMath).
 * Builds an AI-ready prompt from equations extracted from the page HTML and
 * slices a capture into readable segments. No network, no API keys, so it
 * scales to any number of users at zero cost. */
(function () {
  function buildPrompt(math, aiAssist) {
    const eqs = (math && math.equations) || [];
    const lines = [];
    lines.push((aiAssist && aiAssist.recommendedPrompt) ||
      'The equations below were extracted directly from the page HTML, so treat them as the accurate source of the math in the image.');
    lines.push('');
    if (!eqs.length) {
      lines.push('(No machine-readable equations were found in the page markup. Use the attached image segments instead.)');
    } else {
      eqs.forEach((e, i) => {
        const body = (e.latex && e.latex.trim()) || (e.text && e.text.trim()) || '(empty)';
        lines.push(`${i + 1}. [${e.type || 'inline'}] ${body}`);
      });
    }
    if (aiAssist && aiAssist.segmentationHint) { lines.push(''); lines.push(aiAssist.segmentationHint); }
    return lines.join('\n');
  }

  function buildLatex(math) {
    const eqs = (math && math.equations) || [];
    return eqs.map((e) => (e.latex && e.latex.trim()) || (e.text && e.text.trim()) || '').filter(Boolean).join('\n');
  }

  function buildText(math) {
    const eqs = (math && math.equations) || [];
    return eqs.map((e) => (e.text && e.text.trim()) || '').filter(Boolean).join('\n');
  }

  /* Slice a source canvas into vertical segments sized to page metadata.
   * Returns [{ name, dataUrl }]. scale upsamples for extra sharpness. */
  function sliceCanvas(source, segments, page, scale) {
    const s = scale || 1;
    const out = [];
    const pageH = (page && page.scrollHeight) || source.height;
    const list = (segments && segments.length) ? segments : [{ index: 0, y: 0, height: pageH }];
    list.forEach((seg) => {
      const y = Math.round((seg.y / pageH) * source.height);
      const h = Math.max(1, Math.round((seg.height / pageH) * source.height));
      const c = document.createElement('canvas');
      c.width = Math.round(source.width * s);
      c.height = Math.round(h * s);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, y, source.width, h, 0, 0, c.width, c.height);
      out.push({ name: `segment-${(seg.index || 0) + 1}.png`, dataUrl: c.toDataURL('image/png') });
    });
    return out;
  }

  window.SSMath = { buildPrompt, buildLatex, buildText, sliceCanvas, hasProvider: false };
})();
