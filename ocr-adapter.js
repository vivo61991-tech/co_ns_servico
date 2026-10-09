/* Adaptador do motor para o navegador: canvas + Tesseract.js (arquivos locais em vendor/) */
(function (root) {
  'use strict';
  const E = root.NSEngine;
  const VENDOR = new URL('vendor/', root.location.href).href;
  let pool = null;

  async function getPool(onStatus) {
    if (pool) return pool;
    const opts = {
      workerPath: VENDOR + 'worker.min.js',
      corePath: VENDOR,
      langPath: VENDOR,
      gzip: true,
      logger: m => { if (onStatus && m.status && /load|init/i.test(m.status)) onStatus(m); },
    };
    const n = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
    const ws = [];
    for (let i = 0; i < n; i++) ws.push(await root.Tesseract.createWorker('eng', 1, opts));
    pool = { ws, busy: ws.map(() => Promise.resolve()) };
    return pool;
  }

  // executa fn(worker) no próximo worker livre, sem misturar parâmetros entre tarefas
  function run(p, i, fn) {
    const job = p.busy[i].then(() => fn(p.ws[i]));
    p.busy[i] = job.catch(() => {});
    return job;
  }

  function grayCanvas(arr, w, h, x = 0, y = 0, cw = w, ch = h, scale = 1, pad = 0) {
    const src = document.createElement('canvas'); src.width = cw; src.height = ch;
    const sctx = src.getContext('2d');
    const im = sctx.createImageData(cw, ch);
    for (let yy = 0; yy < ch; yy++) for (let xx = 0; xx < cw; xx++) {
      const v = arr[(y + yy) * w + (x + xx)], j = (yy * cw + xx) * 4;
      im.data[j] = im.data[j + 1] = im.data[j + 2] = v; im.data[j + 3] = 255;
    }
    sctx.putImageData(im, 0, 0);
    if (scale === 1 && !pad) return src;
    const out = document.createElement('canvas');
    out.width = Math.round(cw * scale) + 2 * pad; out.height = Math.round(ch * scale) + 2 * pad;
    const o = out.getContext('2d');
    o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height);
    o.imageSmoothingEnabled = true; o.imageSmoothingQuality = 'high';
    o.drawImage(src, pad, pad, Math.round(cw * scale), Math.round(ch * scale));
    return out;
  }

  function wordsFrom(data) {
    const out = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words)
      out.push({ text: w.text, conf: w.confidence, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
    return out;
  }

  async function loadBitmap(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image(); img.decoding = 'async'; img.src = url; await img.decode(); return img;
      } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
    }
  }

  async function makeAdapter(file, onStatus) {
    const bmp = await loadBitmap(file);
    const bw = bmp.width || bmp.naturalWidth, bh = bmp.height || bmp.naturalHeight;
    if (!bw || !bh) throw new Error('Não consegui abrir a imagem.');
    const s = Math.min(1, 4096 / Math.max(bw, bh));
    const W = Math.round(bw * s), H = Math.round(bh * s);
    const c0 = document.createElement('canvas'); c0.width = W; c0.height = H;
    c0.getContext('2d').drawImage(bmp, 0, 0, W, H);
    if (bmp.close) bmp.close();
    const bases = { 0: c0 };
    const base = rot => {
      if (bases[rot]) return bases[rot];
      const c = document.createElement('canvas');
      const swap = rot === 90 || rot === 270;
      c.width = swap ? H : W; c.height = swap ? W : H;
      const x = c.getContext('2d');
      x.translate(c.width / 2, c.height / 2); x.rotate(rot * Math.PI / 180); x.drawImage(c0, -W / 2, -H / 2);
      return (bases[rot] = c);
    };
    const p = await getPool(onStatus);
    return {
      baseCanvas: base,
      baseSize(rot) { const b = base(rot); return { w: b.width, h: b.height }; },
      async preparePage({ rot, variant, roi, outW }) {
        const b = base(rot);
        const x = Math.max(0, Math.round(roi.x)), y = Math.max(0, Math.round(roi.y));
        const w = Math.max(1, Math.round(Math.min(roi.w, b.width - x))), h = Math.max(1, Math.round(Math.min(roi.h, b.height - y)));
        const ow = Math.round(outW), oh = Math.max(1, Math.round(h * ow / w));
        const c = document.createElement('canvas'); c.width = ow; c.height = oh;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(b, x, y, w, h, 0, 0, ow, oh);
        const g = E.rgbaToGray(ctx.getImageData(0, 0, ow, oh).data, ow, oh);
        await new Promise(r => setTimeout(r, 0)); // deixa a tela respirar
        const p1 = E.preprocess(g, ow, oh, variant);
        const p2 = E.preprocess(g, ow, oh, E.VARIANTS[1]);
        return { bin: p1.bin, blurred: p1.blurred, bin2: p2.bin, w: ow, h: oh, roi: { x, y, w, h } };
      },
      async recognizePage(page) {
        const cv = grayCanvas(page.bin, page.w, page.h);
        return run(p, 0, async wk => {
          await wk.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
          const r = await wk.recognize(cv, {}, { blocks: true, text: false });
          return wordsFrom(r.data);
        });
      },
      async recognizeCells(page, specs, tick) {
        let next = 0;
        const results = new Array(specs.length);
        const lane = async i => {
          while (next < specs.length) {
            const k = next++;
            const { rect, whitelist } = specs[k];
            const x = Math.max(0, Math.round(rect.x)), y = Math.max(0, Math.round(rect.y));
            const w = Math.min(page.w - x, Math.round(rect.w)), h = Math.min(page.h - y, Math.round(rect.h));
            if (w < 4 || h < 4) { results[k] = []; tick && tick(); continue; }
            const outs = [];
            await run(p, i, async wk => {
              await wk.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: whitelist });
              for (const src of [page.bin, page.bin2, page.blurred]) {
                const r = await wk.recognize(grayCanvas(src, page.w, page.h, x, y, w, h, 2, 10));
                outs.push((r.data.text || '').trim());
              }
            });
            results[k] = outs; tick && tick();
          }
        };
        await Promise.all(p.ws.map((_, i) => lane(i)));
        return results;
      },
    };
  }

  root.NSOcr = { makeAdapter, warmup: getPool };
})(self);
