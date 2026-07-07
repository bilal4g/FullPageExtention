/* SnapScroll Studio - AI-Ready export (no API, no account, no cost).
 *
 * Why this exists: when you hand a giant full-page screenshot to an AI chat,
 * the AI tool downscales it, so small math turns to mush and the model can't
 * read the equations. This slices the capture into crisp, high-resolution
 * tiles (with overlap so nothing gets cut) that stay under typical AI image
 * limits, so equations remain legible. Optionally packs them into a
 * multi-page PDF. 100% client-side - scales to unlimited users. */
(function () {
  function scaleUp(src, scale) {
    if (!scale || scale <= 1) return src;
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * scale);
    c.height = Math.round(src.height * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  // Returns an array of canvases (tiles), left-to-right, top-to-bottom.
  function buildTiles(src, opts) {
    opts = opts || {};
    const maxTile = opts.maxTile || 1600;
    const overlap = opts.overlap || 90;
    const scaled = scaleUp(src, opts.scale || 1);
    const W = scaled.width, H = scaled.height;
    const tiles = [];
    const stepY = Math.max(1, maxTile - overlap);
    const stepX = Math.max(1, maxTile - overlap);
    for (let y = 0; y < H; y += stepY) {
      const h = Math.min(maxTile, H - y);
      for (let x = 0; x < W; x += stepX) {
        const w = Math.min(maxTile, W - x);
        const t = document.createElement('canvas');
        t.width = w; t.height = h;
        t.getContext('2d').drawImage(scaled, x, y, w, h, 0, 0, w, h);
        tiles.push(t);
        if (x + w >= W) break;
      }
      if (y + h >= H) break;
    }
    return tiles;
  }

  // Multi-page PDF, one tile per page. Returns a Uint8Array.
  function makePdf(canvases) {
    const parts = []; let len = 0;
    const enc = (s) => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff; return a; };
    const S = (s) => { const b = enc(s); parts.push(b); len += b.length; };
    const B = (b) => { parts.push(b); len += b.length; };
    const off = {};
    S('%PDF-1.4\n');
    const n = canvases.length;
    const meta = []; let num = 3;
    for (let i = 0; i < n; i++) meta.push({ page: num++, content: num++, img: num++, c: canvases[i] });
    off[1] = len; S('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    off[2] = len; S('2 0 obj\n<< /Type /Pages /Kids [' + meta.map((m) => m.page + ' 0 R').join(' ') + '] /Count ' + n + ' >>\nendobj\n');
    const pw = 595.28, mg = 24;
    for (const mt of meta) {
      const jpg = mt.c.toDataURL('image/jpeg', 0.95).split(',')[1];
      const bytes = enc(atob(jpg));
      const iW = mt.c.width, iH = mt.c.height, cw = pw - mg * 2, sc = cw / iW, ch = iH * sc, ph = ch + mg * 2;
      const stream = 'q ' + cw.toFixed(2) + ' 0 0 ' + ch.toFixed(2) + ' ' + mg + ' ' + mg + ' cm /Img Do Q';
      off[mt.page] = len; S(mt.page + ' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw.toFixed(2) + ' ' + ph.toFixed(2) + '] /Contents ' + mt.content + ' 0 R /Resources << /XObject << /Img ' + mt.img + ' 0 R >> >> >>\nendobj\n');
      off[mt.content] = len; S(mt.content + ' 0 obj\n<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream\nendobj\n');
      off[mt.img] = len; S(mt.img + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + iW + ' /Height ' + iH + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + bytes.length + ' >>\nstream\n'); B(bytes); S('\nendstream\nendobj\n');
    }
    const totalObjs = 2 + meta.length * 3;
    const xrefOff = len;
    let xref = 'xref\n0 ' + (totalObjs + 1) + '\n0000000000 65535 f \n';
    for (let i = 1; i <= totalObjs; i++) xref += String(off[i]).padStart(10, '0') + ' 00000 n \n';
    S(xref + 'trailer\n<< /Size ' + (totalObjs + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF');
    const out = new Uint8Array(len); let p = 0;
    for (const part of parts) { out.set(part, p); p += part.length; }
    return out;
  }

  window.SSAIReady = { buildTiles, makePdf, scaleUp };
})();
