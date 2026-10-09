/* NS Painel — leitura e validação do TXT exportado do Oracle SQL Developer.
 * Puro JS (navegador e Node). Lê as colunas PELO NOME do cabeçalho: colunas novas
 * em qualquer posição são guardadas em "extras" e não quebram nada.
 */
(function (root) {
  'use strict';

  const OBRIG = ['PERIODO', 'QUANTIDADE_DIAS', 'VOLUME', 'TOTAL_ATENDIDAS', 'ATE_5_MIN', 'TIPO_PERIODO', 'ORDEM'];
  const OPC = ['NS_5_MIN', 'META_NS', 'STATUS_NS', 'STATUS_PERIODO'];
  const CONHECIDAS = new Set([...OBRIG, ...OPC]);
  const TIPOS = { 1: 'MES', 2: 'SEMANA', 3: 'DIA' };
  const MESES = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];

  // ---------- texto ----------
  function decode(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'UTF-8' }; }
    catch (e) { return { text: new TextDecoder('windows-1252').decode(u8), encoding: 'Windows-1252' }; }
  }
  const semAcento = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const normCol = s => semAcento(String(s).replace(/^﻿/, '').replace(/^"|"$/g, '')).trim().toUpperCase().replace(/[\s\-]+/g, '_');
  const normTxt = s => semAcento(String(s ?? '')).trim().toUpperCase();

  function hash(text) {
    const t = String(text).replace(/^﻿/, '').split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean).join('\n');
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  function splitLine(line, d) {
    if (d === '\t') return line.split('\t').map(x => x.trim());
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === d) { out.push(cur.trim()); cur = ''; } else cur += c;
    }
    out.push(cur.trim());
    return out;
  }

  // ---------- datas ----------
  const pad = n => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const diasNoMes = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  function addDias(isoDate, n) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  const ddmm = isoDate => isoDate.slice(8, 10) + '/' + isoDate.slice(5, 7);

  // ---------- números ----------
  function inteiro(v) {
    const s = String(v ?? '').trim();
    if (s === '') return { erro: 'vazio' };
    if (/^\d+$/.test(s)) return { v: parseInt(s, 10) };
    if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return { erro: `"${s}" parece ter separador de milhar — exporte sem separador` };
    if (/^\d+[.,]0+$/.test(s)) return { v: parseInt(s, 10) };
    return { erro: `"${s}" não é um número inteiro` };
  }
  function decimal(v) {
    const s = String(v ?? '').trim();
    if (s === '') return { v: null };
    if (/^\d+([.,]\d+)?$/.test(s)) return { v: parseFloat(s.replace(',', '.')) };
    if (/^[.,]\d+$/.test(s)) return { v: parseFloat('0' + s.replace(',', '.')) };
    return { erro: `"${s}" não é um número decimal` };
  }
  const ns4 = (a, t) => t > 0 ? Math.round((a / t) * 10000) / 10000 : null;
  const statusDe = (ns, meta) => ns == null ? null : ns >= meta ? 'VERDE' : ns >= 0.7 ? 'AMARELO' : 'VERMELHO';

  // ---------- entrada: TXT (tab, ;) ou o JSON exportado (aceito também) ----------
  function tabela(text) {
    let t = String(text).replace(/^﻿/, '');
    const tt = t.trim();
    if (/^"?\s*\[/.test(tt)) {
      let j = tt;
      if (j.startsWith('"') && j.endsWith('"')) j = j.slice(1, -1); // JSON exportado "como texto"
      let arr;
      try { arr = JSON.parse(j); } catch (e) { return { erroGeral: 'Parece JSON, mas não consegui ler: ' + e.message }; }
      if (!Array.isArray(arr) || !arr.length || typeof arr[0] !== 'object') return { erroGeral: 'JSON sem a lista de linhas esperada.' };
      const header = Object.keys(arr[0]);
      const rows = arr.map(o => header.map(h => o[h] == null ? '' : String(o[h])));
      return { header, rows, formato: 'JSON', linhaBase: 2 };
    }
    const lines = t.split(/\r\n|\n|\r/);
    let hi = lines.findIndex(l => l.trim());
    if (hi < 0) return { erroGeral: 'O arquivo está vazio.' };
    const h = lines[hi];
    const cnt = c => h.split(c).length - 1;
    const d = cnt('\t') >= 3 ? '\t' : cnt(';') >= 3 ? ';' : cnt(',') >= 3 ? ',' : null;
    if (!d) return { erroGeral: 'Não achei as colunas na primeira linha. O TXT deve ter o cabeçalho (PERIODO, QUANTIDADE_DIAS, …) separado por tabulação.' };
    const header = splitLine(h, d);
    const rows = [], linhas = [];
    for (let i = hi + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      rows.push(splitLine(lines[i], d)); linhas.push(i + 1);
    }
    return { header, rows, linhas, formato: d === '\t' ? 'TXT (tabulação)' : d === ';' ? 'CSV (;)' : 'CSV (,)', delim: d };
  }

  // ---------- leitura + validação ----------
  function parse(text) {
    const res = { rows: [], erros: [], avisos: [], info: [], colunasExtras: [], formato: null, resumo: {} };
    const tb = tabela(text);
    if (tb.erroGeral) { res.erros.push({ msg: tb.erroGeral }); return res; }
    res.formato = tb.formato;
    const cols = tb.header.map(normCol);
    const idx = {}; cols.forEach((c, i) => { if (c && idx[c] == null) idx[c] = i; });
    const dup = cols.filter((c, i) => c && cols.indexOf(c) !== i);
    if (dup.length) res.erros.push({ msg: `Coluna repetida no cabeçalho: ${[...new Set(dup)].join(', ')}` });
    const falt = OBRIG.filter(c => idx[c] == null);
    if (falt.length) { res.erros.push({ msg: `Faltam colunas obrigatórias: ${falt.join(', ')}` }); return res; }
    res.colunasExtras = cols.filter(c => c && !CONHECIDAS.has(c));
    if (tb.delim === ',') res.avisos.push({ msg: 'Arquivo separado por vírgula: confira se os decimais usam ponto.' });
    if (!tb.rows.length) { res.erros.push({ msg: 'O arquivo tem cabeçalho mas nenhuma linha de dados.' }); return res; }

    const vistos = new Map();
    tb.rows.forEach((cells, k) => {
      const linha = tb.linhas ? tb.linhas[k] : k + tb.linhaBase;
      const E = (col, msg) => res.erros.push({ linha, col, msg });
      const W = (col, msg) => res.avisos.push({ linha, col, msg });
      const get = c => idx[c] == null ? '' : (cells[idx[c]] ?? '').trim();
      if (cells.length !== cols.length) W(null, `tem ${cells.length} colunas e o cabeçalho tem ${cols.length}`);
      const r = { linha, periodo: get('PERIODO'), extras: {} };

      // ORDEM: tipo (1 mês, 2 semana, 3 dia) + AAAAMMDD
      const ord = get('ORDEM');
      const m = ord.match(/^([123])(\d{4})(\d{2})(\d{2})$/);
      const tipoCol = normTxt(get('TIPO_PERIODO')).replace(/^MES$/, 'MES');
      if (!m) { E('ORDEM', `"${ord}" inválida — esperado 9 dígitos: 1/2/3 + AAAAMMDD (ex.: 120261001)`); return; }
      const [, p, ys, ms, ds] = m; const y = +ys, mo = +ms, d = +ds;
      r.ordem = ord; r.tipo = TIPOS[p];
      if (!['MES', 'SEMANA', 'DIA'].includes(tipoCol)) E('TIPO_PERIODO', `"${get('TIPO_PERIODO')}" — esperado MES, SEMANA ou DIA`);
      else if (tipoCol !== r.tipo) E('TIPO_PERIODO', `${tipoCol} não combina com a ORDEM ${ord} (prefixo ${p} = ${r.tipo})`);
      if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > diasNoMes(y, mo)) { E('ORDEM', `data inválida em ${ord}`); return; }
      if (r.tipo === 'MES' && d !== 1) E('ORDEM', `mês deve começar no dia 01 (${ord})`);
      r.inicio = iso(y, mo, d);
      if (vistos.has(ord)) E('ORDEM', `${ord} repetida (também na linha ${vistos.get(ord)})`); else vistos.set(ord, linha);

      // números
      for (const [c, k2] of [['QUANTIDADE_DIAS', 'dias'], ['VOLUME', 'volume'], ['TOTAL_ATENDIDAS', 'total'], ['ATE_5_MIN', 'ate']]) {
        const n = inteiro(get(c)); if (n.erro) E(c, n.erro); else r[k2] = n.v;
      }
      if ([r.dias, r.volume, r.total, r.ate].some(v => v == null)) return;
      if (r.total > r.volume) E('TOTAL_ATENDIDAS', `${r.total} maior que VOLUME ${r.volume}`);
      if (r.ate > r.total) E('ATE_5_MIN', `${r.ate} maior que TOTAL_ATENDIDAS ${r.total}`);

      // dias / completo
      const cap = r.tipo === 'DIA' ? 1 : r.tipo === 'SEMANA' ? 7 : diasNoMes(y, mo);
      if (r.dias < 1 || r.dias > cap) E('QUANTIDADE_DIAS', `${r.dias} fora do esperado para ${r.tipo} (1 a ${cap})`);
      r.diasPeriodo = cap;
      r.fim = addDias(r.inicio, cap - 1);
      const sp = normTxt(get('STATUS_PERIODO'));
      r.statusPeriodo = get('STATUS_PERIODO');
      if (r.tipo === 'DIA') r.completo = true;
      else if (idx.STATUS_PERIODO != null && sp) {
        const inc = /^INCOMPLET/.test(sp), comp = /^COMPLET/.test(sp);
        if (!inc && !comp) E('STATUS_PERIODO', `"${r.statusPeriodo}" — esperado COMPLETO/COMPLETA ou INCOMPLETO/INCOMPLETA`);
        r.completo = comp;
        const nd = sp.match(/(\d+)\s*DIA/);
        if (nd && +nd[1] !== r.dias) E('STATUS_PERIODO', `diz ${nd[1]} dias mas QUANTIDADE_DIAS é ${r.dias}`);
        if (comp && r.dias !== cap) E('STATUS_PERIODO', `COMPLETO com ${r.dias} de ${cap} dias`);
        if (inc && r.dias === cap) W('STATUS_PERIODO', `INCOMPLETO mas já tem os ${cap} dias`);
      } else r.completo = r.dias === cap;
      const temAst = /\*\s*$/.test(r.periodo);
      if (r.tipo !== 'DIA' && temAst === r.completo) W('PERIODO', `"${r.periodo}" ${temAst ? 'tem' : 'não tem'} * mas o período está ${r.completo ? 'completo' : 'incompleto'}`);

      // NS / meta / status
      r.ns = ns4(r.ate, r.total);
      if (r.ns == null) W('TOTAL_ATENDIDAS', 'zero atendimentos — NS indefinido');
      const nsA = decimal(get('NS_5_MIN'));
      if (nsA.erro) E('NS_5_MIN', nsA.erro);
      else if (nsA.v != null && r.ns != null) {
        r.nsArquivo = nsA.v;
        const diff = Math.abs(nsA.v - r.ns);
        if (diff > 0.00011) E('NS_5_MIN', `${get('NS_5_MIN')} não bate com ATE_5_MIN ÷ TOTAL_ATENDIDAS = ${String(r.ns).replace('.', ',')}`);
        else if (diff > 1e-9) W('NS_5_MIN', `arredondamento diferente (${get('NS_5_MIN')} × ${String(r.ns).replace('.', ',')})`);
      }
      const mt = decimal(get('META_NS'));
      if (mt.erro) E('META_NS', mt.erro);
      r.meta = mt.v != null ? mt.v : 0.8;
      if (r.meta <= 0 || r.meta > 1) E('META_NS', `meta ${get('META_NS')} fora de 0–1`);
      const stA = normTxt(get('STATUS_NS'));
      const stC = statusDe(r.ns, r.meta);
      r.status = ['VERDE', 'AMARELO', 'VERMELHO'].includes(stA) ? stA : stC;
      if (stA && stA !== stC && r.ns != null) W('STATUS_NS', `arquivo diz ${stA}, a regra (meta ${r.meta}, amarelo ≥ 0,7) daria ${stC}`);

      // rótulo confere com a ORDEM?
      const pn = normTxt(r.periodo);
      if (r.tipo === 'DIA') { const mm = pn.match(/(\d{2})\/([A-Z]{3})/); if (mm && (+mm[1] !== d || MESES.indexOf(mm[2]) + 1 !== mo)) W('PERIODO', `"${r.periodo}" não bate com a ORDEM ${ord}`); }
      if (r.tipo === 'MES') { if (!pn.startsWith(MESES[mo - 1])) W('PERIODO', `"${r.periodo}" não bate com a ORDEM ${ord}`); }
      if (r.tipo === 'SEMANA') {
        const mm = pn.match(/(\d{2})\/(\d{2})\s*A\s*(\d{2})\/(\d{2})/);
        if (mm && (`${mm[1]}/${mm[2]}` !== ddmm(r.inicio) || `${mm[3]}/${mm[4]}` !== ddmm(r.fim))) W('PERIODO', `"${r.periodo}" não bate com ${ddmm(r.inicio)} a ${ddmm(r.fim)} (ORDEM ${ord})`);
      }

      // colunas novas: guardadas como vieram (e como número quando der)
      for (const c of res.colunasExtras) {
        const raw = idx[c] == null ? '' : (cells[idx[c]] ?? '').trim();
        const dn = decimal(raw);
        r.extras[c] = dn.v != null && !dn.erro ? dn.v : raw;
      }
      res.rows.push(r);
    });

    // somas: mês/semana = soma dos dias, quando todos os dias do período estão no arquivo
    const diasPorData = new Map(res.rows.filter(r => r.tipo === 'DIA').map(r => [r.inicio, r]));
    let somasOk = 0;
    for (const r of res.rows.filter(x => x.tipo !== 'DIA')) {
      const ds = []; for (let i = 0; i < r.dias; i++) { const dd = diasPorData.get(addDias(r.inicio, i)); if (dd) ds.push(dd); }
      if (ds.length !== r.dias) continue;
      let ok = true;
      for (const [c, nome] of [['volume', 'VOLUME'], ['total', 'TOTAL_ATENDIDAS'], ['ate', 'ATE_5_MIN']]) {
        const s = ds.reduce((a, x) => a + x[c], 0);
        if (s !== r[c]) { ok = false; res.erros.push({ linha: r.linha, col: nome, msg: `${r.periodo}: ${r[c]} mas a soma dos ${r.dias} dias dá ${s}` }); }
      }
      if (ok) { somasOk++; r.conferidoSoma = true; }
    }
    if (somasOk) res.info.push(`${somasOk} período(s) conferido(s) pela soma dos dias.`);

    // ordem do arquivo e resumo
    res.rows.sort((a, b) => a.ordem.localeCompare(b.ordem));
    for (const t of ['MES', 'SEMANA', 'DIA']) res.resumo[t] = res.rows.filter(r => r.tipo === t).length;
    for (const t of ['MES', 'SEMANA']) {
      const inc = res.rows.filter(r => r.tipo === t && !r.completo);
      if (inc.length > 1) res.avisos.push({ msg: `${inc.length} ${t === 'MES' ? 'meses' : 'semanas'} incompletos — normalmente só o último está aberto` });
      if (inc.length === 1 && inc[0] !== res.rows.filter(r => r.tipo === t).slice(-1)[0]) res.avisos.push({ linha: inc[0].linha, msg: `${inc[0].periodo} está incompleto mas não é o último` });
    }
    const metas = [...new Set(res.rows.map(r => r.meta))];
    if (metas.length > 1) res.avisos.push({ msg: `META_NS diferente entre linhas: ${metas.join(' / ')}` });
    const ultDia = res.rows.filter(r => r.tipo === 'DIA').slice(-1)[0];
    res.dataRef = ultDia ? ultDia.inicio : (res.rows.length ? res.rows.map(r => r.fim).sort().slice(-1)[0] : null);
    return res;
  }

  // compara com o que já está salvo: períodos fechados que mudaram de valor
  function compara(rows, anteriores) {
    const out = [];
    for (const r of rows) {
      const o = anteriores.get(r.ordem);
      if (!o || !o.completo) continue;
      for (const [c, nome] of [['volume', 'VOLUME'], ['total', 'TOTAL_ATENDIDAS'], ['ate', 'ATE_5_MIN'], ['dias', 'QUANTIDADE_DIAS']])
        if (o[c] !== r[c]) out.push({ ordem: r.ordem, periodo: r.periodo, col: nome, antes: o[c], agora: r[c] });
      if (!r.completo) out.push({ ordem: r.ordem, periodo: r.periodo, col: 'STATUS_PERIODO', antes: 'COMPLETO', agora: 'INCOMPLETO' });
    }
    return out;
  }

  // rótulos para tela/gráfico
  function rotulo(r, curto) {
    const [y, m, d] = r.inicio.split('-').map(Number);
    const ast = r.completo ? '' : '*';
    if (r.tipo === 'MES') { const n = MESES[m - 1]; return (n[0] + n.slice(1).toLowerCase()) + (curto ? '' : '/' + String(y).slice(2)) + ast; }
    if (r.tipo === 'SEMANA') return curto ? ddmm(r.inicio) + ast : `${ddmm(r.inicio)} a ${ddmm(r.fim)}${ast}`;
    return curto ? String(d) : `${pad(d)}/${MESES[m - 1]}`;
  }

  const api = { decode, parse, compara, hash, rotulo, ns4, statusDe, diasNoMes, addDias, OBRIG, OPC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NSData = api;
})(typeof self !== 'undefined' ? self : this);
