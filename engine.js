/* NS Leitor — motor de leitura da tabela do Oracle SQL Developer
 * Puro JS (browser e Node). Não acessa canvas nem tesseract diretamente:
 * recebe um "adapter" com recognizePage/recognizeCell.
 */
(function (root) {
  'use strict';

  const TARGET_W = 2400;

  // ---------- Pré-processamento (tons de cinza -> binário) ----------
  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Uint8ClampedArray(w * h);
    const d = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let acc = 0; const row = y * w;
      for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / d;
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / d;
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  function adaptiveThreshold(src, w, h, block, C) {
    const W1 = w + 1;
    const integ = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let rs = 0;
      for (let x = 0; x < w; x++) {
        rs += src[y * w + x];
        integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + rs;
      }
    }
    const half = block >> 1, out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - half), y1 = Math.min(h, y + half + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - half), x1 = Math.min(w, x + half + 1);
        const s = integ[y1 * W1 + x1] - integ[y0 * W1 + x1] - integ[y1 * W1 + x0] + integ[y0 * W1 + x0];
        const mean = s / ((y1 - y0) * (x1 - x0));
        out[y * w + x] = src[y * w + x] > mean - C ? 255 : 0;
      }
    }
    return out;
  }

  // Variantes testadas contra fotos de monitor (moiré). A primeira é a padrão.
  const VARIANTS = [
    { name: 'padrao', blur: [1, 1, 1], block: 51, C: 15 },
    { name: 'forte', blur: [2, 2, 1], block: 61, C: 13 },
    { name: 'leve', blur: [1], block: 41, C: 14 },
  ];

  function preprocess(gray, w, h, variant) {
    let g = gray;
    for (const r of variant.blur) g = boxBlur(g, w, h, r);
    return { blurred: g, bin: adaptiveThreshold(g, w, h, variant.block, variant.C) };
  }

  function rgbaToGray(rgba, w, h) {
    const g = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
    return g;
  }

  function rotateGray(g, w, h, deg) {
    if (deg === 0) return { g, w, h };
    const out = new Uint8ClampedArray(w * h);
    if (deg === 180) { for (let i = 0; i < g.length; i++) out[g.length - 1 - i] = g[i]; return { g: out, w, h }; }
    // 90 horário: (x,y) -> (h-1-y, x), nova largura = h
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = g[y * w + x];
      if (deg === 90) out[x * h + (h - 1 - y)] = v; else out[(w - 1 - x) * h + y] = v;
    }
    return { g: out, w: h, h: w };
  }

  // ---------- Texto ----------
  const norm = t => String(t || '').toUpperCase().replace(/[^A-Z0-9_/,.*]/g, '');

  const HEADER_KEYS = [
    { key: 'periodo', re: /^P[EF]R[I1L]?[O0]D/ },
    { key: 'dias', re: /^QUANT/ },
    { key: 'volume', re: /^V[O0]LU/ },
    { key: 'total', re: /^T[O0]TAL|^ATENDID/ },
    { key: 'ate', re: /^ATE.?[5S].?M/ },
    { key: 'ns', re: /^N[S5].?[5S].?M/ },
    { key: 'meta', re: /^META/ },
    { key: 'status', re: /^STAT/ },
    { key: 'tipo', re: /^T[I1L]P[O0]/ },
    { key: 'ordem', re: /^[O0]RD[EF]M/ },
  ];
  const COLS = ['periodo', 'dias', 'volume', 'total', 'ate', 'ns', 'meta', 'status', 'tipo', 'ordem'];
  // posição relativa (borda esquerda do rótulo) medida na tela de referência
  const REF_X = { periodo: 244, dias: 417, volume: 723, total: 877, ate: 1175, ns: 1369, meta: 1547, status: 1714, tipo: 1908, ordem: 2151 };

  const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

  function fitLine(pts) { // y = a + b x
    const n = pts.length; if (n < 2) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const den = n * sxx - sx * sx; if (Math.abs(den) < 1e-6) return null;
    const b = (n * sxy - sx * sy) / den; return { a: (sy - b * sx) / n, b };
  }

  function findHeader(words) {
    const hits = [];
    for (const w of words) {
      const t = norm(w.text); if (t.length < 2) continue;
      for (const k of HEADER_KEYS) if (k.re.test(t)) { hits.push({ key: k.key, w, cy: (w.y0 + w.y1) / 2, h: w.y1 - w.y0 }); break; }
    }
    if (!hits.length) return null;
    const hMed = median(hits.map(x => x.h)) || 20;
    let best = null;
    for (const a of hits) {
      const grp = hits.filter(b => Math.abs(b.cy - a.cy) < hMed * 1.6);
      const keys = {};
      for (const g of grp) if (!keys[g.key] || g.w.conf > keys[g.key].w.conf) keys[g.key] = g;
      const n = Object.keys(keys).length;
      if (!best || n > best.n) best = { n, keys };
    }
    if (!best || best.n < 3) return null;
    const keys = best.keys;
    // garante ordem horizontal coerente (descarta rótulos fora de ordem)
    const found = COLS.filter(c => keys[c]);
    for (let i = 1; i < found.length; i++) {
      if (keys[found[i]].w.x0 <= keys[found[i - 1]].w.x0) { delete keys[found[i]]; }
    }
    const fk = COLS.filter(c => keys[c]);
    if (fk.length < 3) return null;
    const h = median(fk.map(c => keys[c].h));
    const lineFit = fitLine(fk.map(c => [(keys[c].w.x0 + keys[c].w.x1) / 2, keys[c].cy]));
    let slope = lineFit ? lineFit.b : 0; if (Math.abs(slope) > 0.15) slope = 0;
    // posição de cada coluna: lida ou estimada por mapeamento linear da referência
    const map = fitLine(fk.map(c => [REF_X[c], keys[c].w.x0]));
    const xs = {}, est = {};
    for (const c of COLS) {
      if (keys[c]) xs[c] = keys[c].w.x0;
      else if (map) { xs[c] = map.a + map.b * REF_X[c]; est[c] = true; }
    }
    const xMid = median(fk.map(c => (keys[c].w.x0 + keys[c].w.x1) / 2));
    const yLine = lineFit ? lineFit.a + lineFit.b * xMid : median(fk.map(c => keys[c].cy));
    return { xs, est, h, slope, xMid, yLine, found: fk };
  }

  function columnOf(cx, hd) {
    const pad = 0.6 * hd.h;
    if (cx < hd.xs.periodo - 1.6 * hd.h) return null;
    for (let i = COLS.length - 1; i >= 0; i--) {
      const c = COLS[i];
      if (cx >= hd.xs[c] - pad) {
        if (c === 'ordem' && cx > hd.xs.ordem + (hd.xs.ordem - hd.xs.tipo) * 1.3) return null;
        return c;
      }
    }
    return 'periodo';
  }

  function colBounds(c, hd) {
    const i = COLS.indexOf(c), pad = 0.6 * hd.h;
    const left = i === 0 ? hd.xs.periodo - 1.6 * hd.h : hd.xs[c] - pad;
    const right = i === COLS.length - 1 ? hd.xs.ordem + (hd.xs.ordem - hd.xs.tipo) : hd.xs[COLS[i + 1]] - pad;
    return [left, right];
  }

  // ---------- Linhas ----------
  // Rastreia as linhas de cima para baixo: cada linha é uma reta y = a + b·x que pode
  // inclinar um pouco diferente da anterior (perspectiva da foto).
  function findRows(words, hd) {
    const toks = [];
    for (const w of words) {
      const t = String(w.text || '').trim(); if (!t || !/[0-9A-Za-z]/.test(t)) continue;
      const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2, hh = w.y1 - w.y0;
      if (hh > hd.h * 2.2 || hh < hd.h * 0.4) continue;
      const col = columnOf(cx, hd); if (!col) continue;
      const res = cy - (hd.yLine + hd.slope * (cx - hd.xMid));
      if (res < 0.8 * hd.h) continue;
      toks.push({ w, t, cx, cy, col, used: false });
    }
    const dataCols = ['volume', 'total', 'ate', 'ns'];
    const valid = rt => {
      const cols = new Set(rt.filter(k => /\d/.test(k.t)).map(k => k.col));
      const nData = dataCols.filter(x => cols.has(x)).length;
      const hasOrd = rt.some(k => k.col === 'ordem' && /^20\d{6}$/.test(k.t.replace(/\D/g, '')));
      const hasTipo = rt.some(k => k.col === 'tipo' && parseTipo(k.t));
      return nData >= 2 || hasOrd || (hasTipo && nData >= 1);
    };
    const fit = (rt, prevLine, off) => {
      const f = rt.length >= 3 ? fitLine(rt.map(k => [k.cx, k.cy])) : null;
      if (f && Math.abs(f.b - prevLine.b) < 0.02) return f;
      const b = prevLine.b;
      return { a: median(rt.map(k => k.cy - b * k.cx)), b };
    };
    const headLine = { a: hd.yLine - hd.slope * hd.xMid, b: hd.slope };
    // 1ª linha: menor grupo de resíduos acima do cabeçalho com >= 2 itens
    const resid = toks.map(k => ({ k, r: k.cy - (headLine.a + headLine.b * k.cx) })).sort((x, y) => x.r - y.r);
    let first = null;
    for (let i = 0; i < resid.length && !first; i++) {
      const grp = resid.filter(z => z.r >= resid[i].r && z.r - resid[i].r < 0.9 * hd.h).map(z => z.k);
      if (resid[i].r > 5 * hd.h) break;
      if (valid(grp)) first = grp;
    }
    const rows = [];
    if (!first) return { rows, pitch: hd.h * 2.2 };
    let line = fit(first, headLine), prev = headLine;
    first.forEach(k => k.used = true);
    rows.push({ toks: first, line });
    let pitch = Math.max(hd.h * 1.4, (line.a + line.b * hd.xMid) - (headLine.a + headLine.b * hd.xMid));
    let misses = 0;
    for (let guard = 0; guard < 40; guard++) {
      // previsão: mesma variação da linha anterior (ou um passo de "pitch")
      const step = rows.length >= 2 ? { a: line.a - prev.a, b: Math.max(-0.004, Math.min(0.004, line.b - prev.b)) } : { a: pitch, b: 0 };
      const k = misses + 1;
      const pred = { a: line.a + step.a * k, b: line.b + step.b * k };
      const win = 0.42 * Math.abs(step.a + step.b * hd.xMid || pitch);
      const got = toks.filter(t => !t.used && Math.abs(t.cy - (pred.a + pred.b * t.cx)) < win);
      if (!got.length || !valid(got)) { if (++misses > 1) break; continue; }
      got.forEach(t => t.used = true);
      const nl = fit(got, pred);
      prev = misses ? { a: line.a + step.a * misses, b: line.b + step.b * misses } : line;
      line = nl; misses = 0;
      rows.push({ toks: got, line });
    }
    const ys = rows.map(r => r.line.a + r.line.b * hd.xMid);
    const gaps = []; for (let i = 1; i < ys.length; i++) gaps.push(ys[i] - ys[i - 1]);
    pitch = median(gaps) || pitch;
    rows.forEach((r, i) => { r.p = ys[i]; r.yAt = x => r.line.a + r.line.b * x; });
    return { rows, pitch };
  }

  // ---------- Conversão de texto ----------
  const DIGIT_MAP = { O: '0', o: '0', Q: '0', D: '0', U: '0', I: '1', l: '1', '|': '1', '!': '1', i: '1', ']': '1', '[': '1', j: '1', J: '1', Z: '2', z: '2', S: '5', s: '5', $: '5', B: '8', G: '6', b: '6', g: '9', q: '9', T: '7', A: '4' };

  function toDigits(s) {
    return String(s || '').split('').map(c => DIGIT_MAP[c] !== undefined ? DIGIT_MAP[c] : c).join('').replace(/[^0-9]/g, '');
  }
  function parseIntCell(s) { const d = toDigits(s); return d && d.length <= 7 ? parseInt(d, 10) : null; }
  function parseNs(s) {
    let t = String(s || '').replace(/\s/g, '');
    t = t.split('').map(c => DIGIT_MAP[c] !== undefined ? DIGIT_MAP[c] : c).join('');
    t = t.replace(/[.;:]/g, ',').replace(/[^0-9,]/g, '');
    let m = t.match(/^([01]),(\d{1,4})/);
    if (m) return parseFloat(m[1] + '.' + m[2]);
    if (/^1,?0*$/.test(t)) return 1;
    m = t.match(/^0(\d{1,4})$/); // vírgula perdida: "06272"
    if (m) return parseFloat('0.' + m[1]);
    return null;
  }
  function parseStatus(s) {
    const t = norm(s);
    if (/VERM|ERMEL|MELH/.test(t)) return 'VERMELHO';
    if (/AMAR|MARE|RELO/.test(t)) return 'AMARELO';
    if (/VERD|ERDE/.test(t)) return 'VERDE';
    return null;
  }
  function parseTipo(s) { const t = norm(s); if (/^M.?[EF].?S/.test(t)) return 'MES'; if (/^D.?[I1L].?A/.test(t)) return 'DIA'; return null; }
  function parseOrdem(s) {
    const d = toDigits(s); if (d.length !== 8) return null;
    const y = +d.slice(0, 4), m = +d.slice(4, 6), dd = +d.slice(6, 8);
    if (y < 2000 || y > 2099 || m < 1 || m > 12 || dd > 31) return null;
    return d;
  }
  const MESES = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
  function parsePeriodo(s) {
    const t = norm(s).replace(/0UT/g, 'OUT').replace(/[0O]UT/g, 'OUT');
    let m = t.match(/(\d{2})\/?([A-Z0]{3})/) || t.match(/(\d{1,2})\/([A-Z0]{3})/);
    if (m) { const mi = MESES.findIndex(x => x === m[2].replace(/0/g, 'O')); if (mi >= 0) return { tipo: 'DIA', day: +m[1], month: mi + 1 }; }
    for (let i = 0; i < 12; i++) if (t.replace(/^\d{1,2}/, '').startsWith(MESES[i])) return { tipo: 'MES', month: i + 1, partial: t.includes('*') };
    return null;
  }


  // NS exibido com até 4 casas, zeros finais cortados ("0,495" = 0,4950)
  const ns4 = (ate, total) => total > 0 ? Math.round((ate / total) * 10000) / 10000 : null;
  const nsEq = (n, a, t) => n != null && a != null && t > 0 && a >= 0 && a <= t && ns4(a, t) === n;
  const uniq = a => [...new Set(a)];
  // true se outro ATE ou TOTAL vizinho daria o mesmo NS (checksum fraco)
  function nsWeak(n, a, t) {
    for (let d = -3; d <= 3; d++) {
      if (!d) continue;
      if (a + d >= 0 && a + d <= t && ns4(a + d, t) === n) return true;
      if (t + d >= a && t + d > 0 && ns4(a, t + d) === n) return true;
    }
    return false;
  }
  const NUMC = ['volume', 'total', 'ate', 'ns'];

  // Flags por célula:
  //  ok        confirmado por checksum independente (NS = ATE/TOTAL e/ou soma do mês)
  //  derivado  calculado a partir de valores confirmados (soma do mês)
  //  lido      lido de forma consistente, mas sem checksum possível (ex.: volume de mês fechado)
  //  conferir  dúvida — o usuário precisa olhar
  //  faltando  não consegui ler
  const TRUSTED = f => f === 'ok' || f === 'derivado';

  // ---------- Montagem ----------
  function readCells(rowsInfo) {
    return rowsInfo.rows.map(r => {
      const byCol = {};
      for (const k of [...r.toks].sort((a, b) => a.cx - b.cx)) (byCol[k.col] = byCol[k.col] || []).push(k.t);
      const txt = c => (byCol[c] || []).join(c === 'periodo' || c === 'status' ? ' ' : '');
      const reads = {
        volume: [parseIntCell(txt('volume'))], total: [parseIntCell(txt('total'))],
        ate: [parseIntCell(txt('ate'))], ns: [parseNs(txt('ns'))],
      };
      for (const c of NUMC) reads[c] = reads[c].filter(v => v != null);
      return {
        _row: r, raw: Object.fromEntries(COLS.map(c => [c, txt(c)])), reads,
        ordemLida: parseOrdem(txt('ordem')), tipoLido: parseTipo(txt('tipo')), periodoLido: parsePeriodo(txt('periodo')),
        statusLido: parseStatus(txt('status')), meta: parseNs(txt('meta')),
        diasReads: [parseIntCell(txt('dias'))].filter(v => v != null && v >= 1 && v <= 31),
      };
    });
  }

  function solveRow(r) {
    const f = r.flags = {};
    const T = uniq(r.reads.total), A = uniq(r.reads.ate), N = uniq(r.reads.ns);
    const tri = [];
    for (const t of T) for (const a of A) for (const n of N) if (nsEq(n, a, t) && !tri.some(x => x.t === t && x.a === a)) tri.push({ t, a, n });
    r.tri = tri;
    if (tri.length) {
      // ordena por quantas leituras independentes concordam
      const cnt = (arr, v) => arr.filter(x => x === v).length;
      tri.sort((x, y) => (cnt(r.reads.total, y.t) + cnt(r.reads.ate, y.a)) - (cnt(r.reads.total, x.t) + cnt(r.reads.ate, x.a)));
      const b = tri[0]; r.total = b.t; r.ate = b.a; r.ns = b.n;
      if (tri.length > 1) f.total = f.ate = f.ns = 'conferir';
      else if (nsWeak(b.n, b.a, b.t)) {
        // NS com 4 casas não distingue ±1..3 no ATE/TOTAL quando os números são grandes:
        // só confia se as leituras concordarem
        const agree = cnt(r.reads.total, b.t) >= 2 && cnt(r.reads.ate, b.a) >= 2;
        f.total = f.ate = agree ? 'lido' : 'conferir'; f.ns = 'ok';
      } else f.total = f.ate = f.ns = 'ok';
    } else {
      r.total = T[0] ?? null; r.ate = A[0] ?? null;
      const n0 = N[0] ?? null;
      if (r.total == null && r.ate != null && n0 > 0) { // palpite de total
        const lo = Math.ceil(r.ate / (n0 + 0.00005)), hi = Math.floor(r.ate / Math.max(1e-9, n0 - 0.00005));
        const s = [];
        if (n0 >= 0.01 && hi - lo <= 2000) for (let t = lo; t <= hi && s.length < 2; t++) if (nsEq(n0, r.ate, t)) s.push(t);
        if (s.length === 1) r.total = s[0];
      }
      if (r.ate == null && r.total != null && n0 != null) r.ate = Math.round(n0 * r.total); // palpite
      r.ns = r.total > 0 && r.ate != null && r.ate <= r.total ? ns4(r.ate, r.total) : n0;
      f.total = r.total == null ? 'faltando' : 'conferir';
      f.ate = r.ate == null ? 'faltando' : 'conferir';
      f.ns = r.ns == null ? 'faltando' : 'conferir';
    }
    const V = r.reads.volume;
    const okV = v => r.total == null || v >= r.total;
    const counts = {}; for (const v of V) counts[v] = (counts[v] || 0) + 1;
    const ranked = uniq(V).filter(okV).sort((a, b) => counts[b] - counts[a]);
    r.volume = ranked[0] ?? (V[0] ?? null);
    f.volume = r.volume == null ? 'faltando' : (okV(r.volume) && counts[r.volume] >= 2 ? 'lido' : 'conferir');
  }

  // ---------- ORDEM / período ----------
  function ymd(o) { return { y: +o.slice(0, 4), m: +o.slice(4, 6), d: +o.slice(6, 8) }; }
  const fmtOrd = (y, m, d) => `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
  const majority = arr => { const c = {}; let best = null; for (const v of arr) { c[v] = (c[v] || 0) + 1; if (best == null || c[v] > c[best]) best = v; } return best; };

  function resolveOrdem(rows) {
    const yrs = rows.map(r => r.ordemLida && ymd(r.ordemLida).y).filter(Boolean);
    const year0 = yrs.length ? +majority(yrs) : new Date().getFullYear();
    // tipo de cada linha
    for (const r of rows) {
      r.tipo = r.ordemLida ? (r.ordemLida.endsWith('00') ? 'MES' : 'DIA') : (r.tipoLido || (r.periodoLido && r.periodoLido.tipo) || null);
    }
    // estrutura: meses primeiro, depois dias
    // o ponto de virada (último mês -> primeiro dia) é escolhido pelo que mais concorda com as leituras
    let bestCut = 0, bestScore = -1;
    for (let cut = 0; cut <= rows.length; cut++) {
      let sc = 0; rows.forEach((r, i) => { const want = i < cut ? 'MES' : 'DIA'; if (r.tipo === want) sc++; });
      if (sc > bestScore) { bestScore = sc; bestCut = cut; }
    }
    rows.forEach((r, i) => { r.tipo = i < bestCut ? 'MES' : 'DIA'; });
    const days = rows.filter(r => r.tipo === 'DIA'), months = rows.filter(r => r.tipo === 'MES');
    // dias: dia = índice + k (maioria)
    let dayMonth = null, dayYear = year0;
    if (days.length) {
      const votes = [], mVotes = [];
      days.forEach((r, i) => {
        if (r.ordemLida) { const o = ymd(r.ordemLida); votes.push(o.d - i, o.d - i); mVotes.push(o.m, o.m); }
        if (r.periodoLido && r.periodoLido.tipo === 'DIA') { votes.push(r.periodoLido.day - i); mVotes.push(r.periodoLido.month); }
      });
      const k = Math.max(1, votes.length ? +majority(votes) : 1);
      dayMonth = mVotes.length ? +majority(mVotes) : null;
      const dy = days.map(r => r.ordemLida && ymd(r.ordemLida).y).filter(Boolean); if (dy.length) dayYear = +majority(dy);
      days.forEach((r, i) => {
        if (dayMonth == null) { r.ordem = null; return; }
        r.ordem = fmtOrd(dayYear, dayMonth, i + k);
        r.flags.ordem = r.ordemLida === r.ordem ? 'ok' : 'derivado';
      });
    }
    // meses: consecutivos; o último mês é o dos dias (quando há dias)
    if (months.length) {
      let endY, endM;
      if (dayMonth != null) { endY = dayYear; endM = dayMonth; }
      else {
        const votes = [];
        months.forEach((r, i) => {
          const back = months.length - 1 - i;
          const add = (y, m) => { let t = y * 12 + (m - 1) + back; votes.push(t, t); };
          if (r.ordemLida) { const o = ymd(r.ordemLida); add(o.y, o.m); }
          if (r.periodoLido && r.periodoLido.tipo === 'MES') { const t = year0 * 12 + r.periodoLido.month - 1 + back; votes.push(t); }
        });
        const t = votes.length ? +majority(votes) : null;
        if (t != null) { endY = Math.floor(t / 12); endM = t % 12 + 1; }
      }
      months.forEach((r, i) => {
        if (endY == null) { r.ordem = null; return; }
        const t = endY * 12 + endM - 1 - (months.length - 1 - i);
        r.ordem = fmtOrd(Math.floor(t / 12), t % 12 + 1, 0);
        r.flags.ordem = r.ordemLida === r.ordem ? 'ok' : 'derivado';
      });
    }
    for (const r of rows) if (!r.ordem) r.flags.ordem = 'faltando';
    // datas só são confiáveis se a maioria das linhas teve a ORDEM/PERIODO lida e batendo
    const agree = rows.filter(r => r.ordem && (r.ordemLida === r.ordem || (r.periodoLido && r.periodoLido.tipo === r.tipo &&
      r.periodoLido.month === +r.ordem.slice(4, 6) && (r.tipo === 'MES' || r.periodoLido.day === +r.ordem.slice(6, 8))))).length;
    const conf = rows.length ? agree / rows.length : 0;
    for (const r of rows) if (r.flags.ordem === 'derivado' && conf < 0.6) r.flags.ordem = 'conferir';
    rows.ordemConf = conf;
  }

  // ---------- Busca combinatória pela soma do mês ----------
  function optionsTA(r) {
    if (TRUSTED(r.flags.total) && TRUSTED(r.flags.ate)) return [{ t: r.total, a: r.ate, keep: true }];
    // só opções já verificadas pelo NS lido (evita "fechar" a soma com erros que se compensam)
    const opts = (r.tri || []).map(x => ({ t: x.t, a: x.a, n: x.n }));
    return opts.length ? opts : null;
  }
  function jointSearch(m, days, grp) {
    if (grp.every(r => TRUSTED(r.flags.total) && TRUSTED(r.flags.ate))) return;
    const opts = grp.map(optionsTA);
    if (opts.some(o => !o)) return;
    const combos = opts.reduce((p, o) => p * o.length, 1);
    if (combos > 200000 || combos <= 1) return;
    const sols = [];
    const pick = new Array(grp.length);
    (function dfs(i, sT, sA) {
      if (sols.length > 1) return;
      if (i === grp.length) {
        const M = pick[0];
        if (sT === M.t && sA === M.a) sols.push(pick.slice());
        return;
      }
      for (const o of opts[i]) { pick[i] = o; dfs(i + 1, i ? sT + o.t : 0, i ? sA + o.a : 0); }
    })(0, 0, 0);
    if (sols.length !== 1) return;
    sols[0].forEach((o, i) => {
      const r = grp[i]; if (o.keep) return;
      const changed = r.total !== o.t || r.ate !== o.a;
      r.total = o.t; r.ate = o.a; r.ns = ns4(o.a, o.t);
      // confirmado pelas duas somas; se o NS lido também bate, melhor ainda
      r.flags.total = r.flags.ate = 'ok';
      r.flags.ns = 'ok';
      r._sumFixed = changed;
    });
  }
  // ---------- Soma do mês parcial (Out* = soma dos dias) ----------
  function monthSums(rows) {
    for (const m of rows.filter(r => r.tipo === 'MES' && r.ordem)) {
      const ym = m.ordem.slice(0, 6);
      const days = rows.filter(r => r.tipo === 'DIA' && r.ordem && r.ordem.startsWith(ym));
      if (!days.length) continue;
      if (!days.every((d, i) => +d.ordem.slice(6) === i + 1)) continue;
      m.partial = true; m.dias = days.length;
      const grp = [m, ...days];
      const sumDays = c => days.reduce((s, d) => s + (d[c] == null ? NaN : d[c]), 0);

      // busca conjunta: escolhe, para cada linha em dúvida, uma leitura alternativa (total, ate)
      // tal que as DUAS somas do mês fechem exatamente. Só aceita se a solução for única.
      jointSearch(m, days, grp);
      for (const c of ['total', 'ate']) {
        if (grp.every(r => r[c] != null) && sumDays(c) === m[c]) {
          // soma bate: confirma também as linhas que estavam em dúvida (ambíguas ou palpites)
          for (const r of grp) if (r.flags[c] === 'conferir' || r.flags[c] === 'lido') r.flags[c] = 'ok';
          continue;
        }
        // tenta trocar UMA linha por outra leitura dela (de triplas verificadas) que feche a soma
        let fixed = false;
        for (const r of grp) {
          for (const alt of r.tri || []) {
            const v = c === 'total' ? alt.t : alt.a; if (v === r[c]) continue;
            const old = r[c]; r[c] = v;
            const ok = grp.every(x => x[c] != null) && sumDays(c) === m[c];
            r[c] = old;
            if (ok) { r.total = alt.t; r.ate = alt.a; r.ns = alt.n; r.flags.total = r.flags.ate = r.flags.ns = 'ok'; fixed = true; break; }
          }
          if (fixed) break;
        }
        if (fixed) continue;
        const unk = grp.filter(r => !TRUSTED(r.flags[c]));
        if (unk.length === 1) {
          const u = unk[0];
          const v = u === m ? sumDays(c) : m[c] - days.filter(d => d !== u).reduce((s, d) => s + d[c], 0);
          if (Number.isFinite(v) && v >= 0) { u[c] = v; u.flags[c] = 'derivado'; }
        } else if (unk.length === 0) {
          for (const r of grp) r.flags[c] = 'conferir'; // tudo "ok" mas soma não fecha: algo está errado
        }
      }
      // recalcula NS de quem teve total/ate derivado e confere com o NS lido
      for (const r of grp) {
        if ((r.flags.total === 'derivado' || r.flags.ate === 'derivado') && r.total > 0 && r.ate != null) {
          if (r.ate > r.total) { r.flags.total = r.flags.ate = 'conferir'; continue; }
          r.ns = ns4(r.ate, r.total);
          const nsLido = uniq(r.reads.ns).includes(r.ns);
          r.flags.ns = nsLido ? 'ok' : (TRUSTED(r.flags.total) && TRUSTED(r.flags.ate) ? 'derivado' : 'conferir');
          if (nsLido) { if (r.flags.total === 'conferir') r.flags.total = 'ok'; if (r.flags.ate === 'conferir') r.flags.ate = 'ok'; }
        }
      }
      // volume
      const c = 'volume';
      if (grp.every(r => r[c] != null) && sumDays(c) === m[c]) { for (const r of grp) r.flags[c] = 'ok'; continue; }
      // sem troca por leituras alternativas no volume: não há outro checksum para desempatar
      const unk = grp.filter(r => r.flags[c] !== 'lido');
      if (unk.length === 1) {
        const u = unk[0];
        const v = u === m ? sumDays(c) : m[c] - days.filter(d => d !== u).reduce((s, d) => s + d[c], 0);
        if (Number.isFinite(v) && v >= 0) u[c] = v;
      }
      for (const r of grp) r.flags[c] = 'conferir';
    }
  }

  function finalize(rows, meta) {
    const metaV = meta || 0.8;
    const lastMes = [...rows].reverse().find(r => r.tipo === 'MES' && r.ordem);
    for (const r of rows) {
      if (r.diasReads && r.diasReads.length) r.diasLido = +majority(r.diasReads);
      for (const c of NUMC) if (r[c] == null) r.flags[c] = 'faltando';
      if (r.volume != null && r.total != null && r.volume < r.total) r.flags.volume = 'conferir';
      // volume de dia só se confirma pela soma do mês; sem ela, fica para conferir
      if (r.tipo === 'DIA' && r.flags.volume === 'lido') r.flags.volume = 'conferir';
      r.status = r.ns == null ? null : (r.ns >= metaV ? 'VERDE' : r.ns >= 0.7 ? 'AMARELO' : 'VERMELHO');
      if (r.ordem) {
        const { y, m, d } = ymd(r.ordem);
        if (r.tipo === 'DIA') { r.label = `${String(d).padStart(2, '0')}/${MESES[m - 1]}`; r.dias = 1; r.flags.dias = 'ok'; }
        else {
          // QUANTIDADE_DIAS: o mês pode estar aberto. Esperado = nº de dias exibidos (mês com *)
          // ou dias do calendário (mês fechado). Lido = o que está na tela.
          const cal = new Date(y, m, 0).getDate();
          const lido = r.diasLido ?? null;
          if (r.flags.dias === 'user' && lido != null) { r.dias = lido; r.partial = r.partial || lido < cal; }
          else if (r.partial) {
            r.dias = r.dias || lido;
            r.flags.dias = lido == null ? 'derivado' : lido === r.dias ? 'ok' : 'conferir';
          } else if (lido != null && lido < cal && r === lastMes) {
            // mês sem linhas de dia, mas a tela diz que tem menos dias: está aberto
            r.dias = lido; r.partial = true; r.flags.dias = (r.periodoLido && r.periodoLido.partial) ? 'ok' : 'conferir';
          } else if (r !== lastMes) {
            // mês seguido de outro mês na tabela: está fechado, vale o calendário
            r.dias = cal;
            r.flags.dias = (r.diasReads || [lido]).includes(cal) ? 'ok' : 'derivado';
          } else {
            r.dias = cal;
            r.flags.dias = lido == null ? 'derivado' : (r.diasReads || [lido]).includes(cal) ? 'ok' : 'conferir';
          }
          r.label = MESES[m - 1].charAt(0) + MESES[m - 1].slice(1).toLowerCase() + (r.partial ? '*' : '');
        }
      } else r.label = (r.raw && r.raw.periodo) || '?';
    }
  }

  function publicRows(rows) {
    return rows.map(r => ({
      ordem: r.ordem, tipo: r.tipo, label: r.label, dias: r.dias ?? null, partial: !!r.partial,
      volume: r.volume, total: r.total, ate: r.ate, ns: r.ns, status: r.status,
      flags: { ...r.flags },
    }));
  }

  function solveAll(rows) { rows.forEach(solveRow); resolveOrdem(rows); monthSums(rows); }

  // ---------- Orquestração ----------
  async function readTable(adapter, opts = {}) {
    const log = opts.onProgress || (() => {});
    const t0 = Date.now();
    const full = rot => { const b = adapter.baseSize(rot); return { x: 0, y: 0, w: b.w, h: b.h }; };
    let page = null, hd = null, words = null, ri = null, rot = 0, textPx = null, pass2 = null, tableRoi = null;
    // 1ª passada: acha a tabela (tenta rotações e filtros)
    const tries = [[0, 0], [0, 1], [90, 0], [270, 0], [180, 0], [0, 2]];
    for (const [r, vi] of tries) {
      log({ stage: 'pagina', msg: `Procurando a tabela${r ? ` (girando ${r}°)` : ''}…`, frac: 0.05 });
      page = await adapter.preparePage({ rot: r, variant: VARIANTS[vi], roi: full(r), outW: TARGET_W });
      words = await adapter.recognizePage(page);
      hd = findHeader(words);
      if (hd) { ri = findRows(words, hd); if (ri.rows.length >= 2) { rot = r; break; } }
      hd = null;
    }
    if (!hd) throw new Error('Não encontrei o cabeçalho da tabela (PERIODO, VOLUME, TOTAL_ATENDIDAS…). Enquadre a tabela inteira, com o cabeçalho visível, e tente de novo.');

    // 2ª passada: recorta só a tabela e normaliza a altura da letra (~26 px)
    log({ stage: 'recorte', msg: 'Recortando a tabela…', frac: 0.35 });
    {
      const left = hd.xs.periodo - 3 * hd.h, right = hd.xs.ordem + (hd.xs.ordem - hd.xs.tipo) * 1.3;
      const yH = x => hd.yLine + hd.slope * (x - hd.xMid);
      const last = ri.rows[ri.rows.length - 1];
      const top = Math.min(yH(left), yH(right)) - 2.5 * hd.h;
      const bottom = Math.max(last.yAt(left), last.yAt(right)) + 1.6 * ri.pitch;
      const pr = { x: Math.max(0, left), y: Math.max(0, top) };
      pr.w = Math.min(page.w, right) - pr.x; pr.h = Math.min(page.h, bottom) - pr.y;
      const s = page.roi.w / page.w;
      const roi = { x: page.roi.x + pr.x * s, y: page.roi.y + pr.y * s, w: pr.w * s, h: pr.h * s };
      // escala pela distância entre linhas (mais estável que a altura das caixas): ~52 px por linha
      const pitch = ri.rows.length >= 3 ? ri.pitch : hd.h * 2.1;
      const outW = Math.round(Math.max(1000, Math.min(3600, pr.w * (52 / pitch))));
      textPx = (ri.rows.length >= 3 ? ri.pitch / 2.17 : hd.h) * s;
      const p2 = await adapter.preparePage({ rot, variant: VARIANTS[0], roi, outW });
      const w2 = await adapter.recognizePage(p2);
      // cabeçalho da 2ª passada: lido de novo, ou transportado da 1ª (às vezes o OCR não lê
      // os rótulos dentro das caixas do cabeçalho na nova escala)
      const k = p2.w / pr.w;
      const mapped = {
        ...hd, xs: Object.fromEntries(Object.entries(hd.xs).map(([c, x]) => [c, (x - pr.x) * k])),
        h: hd.h * k, xMid: (hd.xMid - pr.x) * k, yLine: (hd.yLine - pr.y) * k, slope: hd.slope, mapped: true,
      };
      let h2 = findHeader(w2);
      let r2 = h2 && findRows(w2, h2);
      const r2m = findRows(w2, mapped);
      if (!r2 || r2m.rows.length > r2.rows.length) { h2 = mapped; r2 = r2m; }
      tableRoi = roi;
      if (r2 && r2.rows.length >= 2) pass2 = { page: p2, hd: h2, ri: r2 };
    }
    // junta as leituras das duas passadas quando acham as mesmas linhas
    let rows = readCells(ri);
    const score = rs => { solveAll(rs); return rs.reduce((s, r) => s + NUMC.filter(c => TRUSTED(r.flags[c])).length, 0); };
    if (pass2) {
      const rows2 = readCells(pass2.ri);
      if (rows2.length === rows.length) {
        rows2.forEach((r, i) => {
          for (const c of NUMC) r.reads[c].push(...rows[i].reads[c]);
          r.diasReads.push(...rows[i].diasReads);
          r.ordemLida = r.ordemLida || rows[i].ordemLida; r.tipoLido = r.tipoLido || rows[i].tipoLido;
          r.periodoLido = r.periodoLido || rows[i].periodoLido; r.meta = r.meta ?? rows[i].meta;
        });
        rows = rows2; page = pass2.page; hd = pass2.hd; ri = pass2.ri;
      } else if ((s1 => { const s2 = score(rows2); return s2 > s1 || (s2 === s1 && rows2.length > rows.length); })(score(rows))) {
        rows = rows2; page = pass2.page; hd = pass2.hd; ri = pass2.ri;
      }
    }
    const metaRead = median(rows.map(r => r.meta).filter(x => x != null && x > 0 && x <= 1));
    solveAll(rows);

    // 3ª passada: relê células recortadas (volume sempre; demais só se duvidosas)
    if (adapter.recognizeCell || adapter.recognizeCells) {
      const jobs = [];
      for (const r of rows) for (const c of NUMC) if (c === 'volume' || r.flags[c] !== 'ok') jobs.push([r, c]);
      for (const r of rows) if (r.tipo === 'MES') jobs.push([r, 'dias']);
      const specs = jobs.map(([r, c]) => {
        const [x0, x1] = colBounds(c, hd);
        const cy = r._row.yAt((x0 + x1) / 2), half = ri.pitch * 0.5;
        return { rect: { x: Math.max(0, x0), y: Math.max(0, cy - half), w: x1 - Math.max(0, x0), h: half * 2 }, whitelist: c === 'ns' ? '0123456789,.' : '0123456789' };
      });
      let n = 0;
      const tick = () => log({ stage: 'celulas', msg: `Conferindo células (${++n}/${jobs.length})…`, frac: 0.45 + 0.5 * n / jobs.length });
      let results;
      if (adapter.recognizeCells) results = await adapter.recognizeCells(page, specs, tick);
      else { results = []; for (const sp of specs) { results.push(await adapter.recognizeCell(page, sp.rect, sp.whitelist)); tick(); } }
      jobs.forEach(([r, c], i) => {
        for (const t of results[i] || []) {
          const v = c === 'ns' ? parseNs(t) : parseIntCell(t);
          if (v == null) continue;
          if (c === 'dias') { if (v >= 1 && v <= 31) r.diasReads.push(v); } else r.reads[c].push(v);
        }
      });
      solveAll(rows);
    }
    finalize(rows, metaRead);
    if (textPx != null && textPx < 15) for (const r of rows) for (const c of NUMC) if (r.flags[c] === 'lido') r.flags[c] = 'conferir';
    const out = publicRows(rows);
    const trusted = out.reduce((s, r) => s + NUMC.filter(c => TRUSTED(r.flags[c])).length, 0);
    return {
      rows: out, meta: metaRead || 0.8,
      quality: { cells: out.length * 4, trusted, ms: Date.now() - t0, rotation: rot, columnsFound: hd.found, roi: tableRoi, textPx: textPx && Math.round(textPx), lowRes: textPx != null && textPx < 15 },
    };
  }

  // Revalida depois de edição manual. Mantém ORDEM como está (o usuário pode tê-la corrigido),
  // mantém as marcas anteriores das células não tocadas e refaz a conferência das somas do mês.
  // touched[i] = { volume:true, ... } para células que o usuário editou/confirmou.
  function revalidate(rowsIn, meta, touched = []) {
    const rows = rowsIn.map((r, i) => {
      const t = touched[i] || {};
      const x = { ...r, flags: { ...(r.flags || {}) }, raw: {}, partial: false };
      x.tipo = x.ordem && x.ordem.endsWith('00') ? 'MES' : 'DIA';
      x.ns = x.total > 0 && x.ate != null && x.ate <= x.total ? ns4(x.ate, x.total) : null;
      // QUANTIDADE_DIAS é reavaliada do zero a partir do valor atual (lido ou editado)
      x.diasLido = x.dias ?? null; x.dias = null; x.periodoLido = { partial: !!r.partial }; delete x.flags.dias;
      for (const c of ['volume', 'total', 'ate', 'ordem', 'dias']) if (t[c]) x.flags[c] = 'user';
      if (x.ns == null) x.flags.ns = 'faltando';
      else if (t.total || t.ate) x.flags.ns = 'user';
      return x;
    });
    const issues = [];
    for (const m of rows.filter(r => r.tipo === 'MES' && r.ordem)) {
      const ym = m.ordem.slice(0, 6);
      const days = rows.filter(r => r.tipo === 'DIA' && r.ordem && r.ordem.startsWith(ym)).sort((a, b) => a.ordem.localeCompare(b.ordem));
      if (!days.length || !days.every((d, i) => +d.ordem.slice(6) === i + 1)) continue;
      m.partial = true; m.dias = days.length;
      const grp = [m, ...days];
      for (const c of ['volume', 'total', 'ate']) {
        if (grp.some(r => r[c] == null)) continue;
        const sum = days.reduce((s, d) => s + d[c], 0);
        if (sum === m[c]) { for (const r of grp) if (r.flags[c] !== 'user') r.flags[c] = 'ok'; }
        else {
          issues.push({ ordem: m.ordem, col: c, soma: sum, mes: m[c] });
          for (const r of grp) if (r.flags[c] !== 'user') r.flags[c] = 'conferir';
        }
      }
    }
    finalize(rows, meta);
    const out = publicRows(rows);
    out.issues = issues;
    return out;
  }

  const api = { readTable, revalidate, preprocess, rgbaToGray, rotateGray, VARIANTS, TARGET_W, ns4, _t: { findHeader, findRows, parseNs, parseIntCell, parseOrdem, parsePeriodo, nsEq } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NSEngine = api;
})(typeof self !== 'undefined' ? self : this);
