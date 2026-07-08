/* FullPage Studio - bridge between the Studio page and the sandboxed frame. */
(function () {
  'use strict';
  let ready = false; const queue = []; const pending = {}; let seq = 1;
  function frame() { return document.getElementById('fp-sandbox'); }

  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.__fp === 'ready') { ready = true; queue.splice(0).forEach((fn) => fn()); return; }
    if (d.__fp === 'res') {
      const p = pending[d.id]; if (!p) return;
      if (d.progress) { if (p.onProgress) p.onProgress(d.progress); return; }
      delete pending[d.id];
      if (d.ok) p.res(d); else p.rej(Object.assign(new Error(d.error || 'error'), { code: d.code }));
    }
  });

  function request(msg, transfer, onProgress) {
    return new Promise((res, rej) => {
      const id = seq++; pending[id] = { res, rej, onProgress };
      const post = () => { const f = frame(); if (!f || !f.contentWindow) { rej(new Error('sandbox missing')); return; } f.contentWindow.postMessage(Object.assign({ __fp: 'req', id }, msg), '*', transfer || []); };
      ready ? post() : queue.push(post);
      setTimeout(() => { if (pending[id]) { delete pending[id]; rej(new Error('timed out')); } }, 180000);
    });
  }
  window.FPSandbox = { request };
})();
