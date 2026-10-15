/* NS Painel — Problemas sistêmicos (matriz sistemas × períodos, lista e detalhe dos chamados) */
(function () {
  'use strict';
  const VERSAO = '3.7.2';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const HORA_INI = 8, HORA_FIM = 20, EXP = (HORA_FIM - HORA_INI) * 3600e3;   // expediente 08:00–20:00
  const WD = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
  const MES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const MES_EXT = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  // ---------------- leitura do arquivo (sistemas.txt do SQL Developer) ----------------
  // datas do Oracle: "14/10/26 08:00:00,000000000" (também aceita 14/10/2026 08:00)
  function data(s) {
    const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const d = new Date(y, +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
    return d.getDate() === +m[1] && d.getMonth() === +m[2] - 1 ? d : null;
  }
  const limpa = v => { const t = String(v ?? '').trim(); return /^(undefined|null|nan)$/i.test(t) ? '' : t; };
  function ler(texto) {
    const res = { itens: [], erros: [], avisos: [] };
    const linhas = String(texto).replace(/^﻿/, '').split(/\r\n|\n|\r/);
    const hi = linhas.findIndex(l => l.trim());
    if (hi < 0) { res.erros.push('Arquivo vazio.'); return res; }
    const sep = linhas[hi].includes('\t') ? '\t' : ';';
    const H = linhas[hi].split(sep).map(h => h.trim().toUpperCase());
    const ix = c => H.indexOf(c);
    const falta = ['SISTEMA', 'DATA_INICIO', 'DATA_FIM'].filter(c => ix(c) < 0);
    if (falta.length) { res.erros.push('Faltam colunas: ' + falta.join(', ')); return res; }
    const ids = new Set();
    for (let i = hi + 1; i < linhas.length; i++) {
      if (!linhas[i].trim()) continue;
      const c = linhas[i].split(sep), g = n => ix(n) < 0 ? '' : limpa(c[ix(n)]);
      const ini = data(g('DATA_INICIO')), fimTxt = g('DATA_FIM'), fim = fimTxt ? data(fimTxt) : null;
      let id = g('ID') || '#' + (i + 1);
      if (!g('SISTEMA')) { res.erros.push(`Linha ${i + 1}: SISTEMA vazio`); continue; }
      if (!ini) { res.erros.push(`Linha ${i + 1} (ID ${id}): DATA_INICIO inválida "${g('DATA_INICIO')}"`); continue; }
      if (fimTxt && !fim) { res.erros.push(`Linha ${i + 1} (ID ${id}): DATA_FIM inválida "${fimTxt}"`); continue; }
      if (fim && fim < ini) { res.erros.push(`Linha ${i + 1} (ID ${id}): DATA_FIM antes da DATA_INICIO`); continue; }
      if (ids.has(id)) { res.avisos.push(`ID ${id} repetido (linha ${i + 1})`); id = id + ' (linha ' + (i + 1) + ')'; }
      ids.add(id);
      const status = g('STATUS').toUpperCase();
      res.itens.push({
        id, sistema: g('SISTEMA').replace(/\s+/g, ' '), chamado: g('CHAMADO').replace(/\s+/g, ' '), status,
        tipo: g('TIPO_FALHA').toUpperCase(), ini, fim, aberto: !fim, indevido: status === 'INDEVIDO',
        atualizado: [data(g('DATA_ATUALIZACAO')), data(g('DADO_ATUALIZADO'))].filter(Boolean),
        raw: Object.fromEntries(H.map((h, k) => [h, limpa(c[k])])),   // todas as colunas, para o detalhe
      });
    }
    if (!res.itens.length && !res.erros.length) res.erros.push('Nenhuma linha de dados.');
    // "agora" = momento mais recente do arquivo (início, fim e atualização dos dados): é até onde vai o
    // chamado sem DATA_FIM e onde termina a cobertura do arquivo
    const tudo = res.itens.flatMap(x => [x.ini, x.fim, ...x.atualizado]).filter(Boolean);
    res.agora = tudo.length ? new Date(Math.max(...tudo)) : null;
    res.inicio = res.itens.length ? new Date(Math.min(...res.itens.map(x => x.ini))) : null;
    for (const x of res.itens) x.fimCalc = x.aberto ? res.agora : x.fim;
    return res;
  }

  // ---------------- datas / períodos ----------------
  const dia0 = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addD = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const pad = n => String(n).padStart(2, '0');
  const ddmm = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  const fmtDH = d => d ? `${ddmm(d)}/${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '—';
  const fmtH = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${pad(m % 60)}`; };
  const fmtHc = ms => { const m = Math.round(ms / 60000); return m === 0 ? '' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? pad(m % 60) : ''}`; };

  // colunas = os mesmos períodos dos gráficos de NS (linhas do data.txt já filtradas pelo painel)
  // r.inicio "AAAA-MM-DD", r.diasPeriodo (1 / 7 / dias do mês), r.completo
  function colunas(items, dados) {
    return items.map(r => {
      const [y, m, d] = r.inicio.split('-').map(Number);
      const ini = new Date(y, m - 1, d), dias = r.diasPeriodo || (r.tipo === 'DIA' ? 1 : r.tipo === 'SEMANA' ? 7 : new Date(y, m, 0).getDate());
      const p = { ordem: r.ordem, tipo: r.tipo, ini, dias, fim: addD(ini, dias), andamento: r.tipo !== 'DIA' && !r.completo };
      // sem cobertura: período todo antes do 1º chamado do arquivo ou depois da última atualização
      p.semDados = !dados || !dados.inicio || p.fim <= dia0(dados.inicio) || p.ini > dados.agora;
      return p;
    });
  }
  // trechos de um chamado dentro do expediente (08–20) de um período: [{x0, x1} em fração da coluna, ms]
  function trechos(c, p) {
    const out = [];
    for (let i = 0; i < p.dias; i++) {
      const d = addD(p.ini, i);
      const a = new Date(d.getFullYear(), d.getMonth(), d.getDate(), HORA_INI), b = new Date(d.getFullYear(), d.getMonth(), d.getDate(), HORA_FIM);
      const s = Math.max(c.ini, a), e = Math.min(c.fimCalc, b);
      if (e > s) out.push({ x0: (i + (s - a) / EXP) / p.dias, x1: (i + (e - a) / EXP) / p.dias, ms: e - s });
    }
    return out;
  }
  // chamado que acontece no período (mesmo que inteiramente fora do expediente)
  const noPeriodo = (c, p) => c.ini < p.fim && c.fimCalc >= p.ini;
  const COR = t => /TOTAL/.test(t) ? 'var(--fTotal)' : /PARCIAL/.test(t) ? 'var(--fParcial)' : /INTERMIT/.test(t) ? 'var(--fInterm)' : /LENTID/.test(t) ? 'var(--fLent)' : 'var(--fOutro)';
  const NOME_TIPO = t => /TOTAL/.test(t) ? 'Indisp. total' : /PARCIAL/.test(t) ? 'Indisp. parcial' : /INTERMIT/.test(t) ? 'Intermitência' : /LENTID/.test(t) ? 'Lentidão' : (t || 'Outro');
  const rot = p => p.tipo === 'DIA' ? ddmm(p.ini) : p.tipo === 'SEMANA' ? `${ddmm(p.ini)} a ${ddmm(addD(p.fim, -1))}` : `${MES_EXT[p.ini.getMonth()]}/${String(p.ini.getFullYear()).slice(2)}`;
  const rotFolha = p => `${p.tipo === 'DIA' ? WD[p.ini.getDay()].toLowerCase() + ', ' : p.tipo === 'SEMANA' ? 'semana ' : ''}${rot(p)}${p.andamento ? '*' : ''}`;
  // representatividade: tempo no expediente ÷ expediente do período inteiro (dia = 12h, semana = 7 × 12h,
  // mês = dias do mês × 12h), mesmo no período em andamento — bate com o preenchimento da célula
  const baseMs = p => p.dias * EXP;
  const pctTxt = (ms, p) => { const b = baseMs(p); if (!b) return '—'; const v = ms / b * 100; return v > 0 && v < 0.05 ? '<0,1%' : v.toFixed(1).replace('.', ',') + '%'; };
  const nomeBase = t => t === 'DIA' ? 'do dia' : t === 'SEMANA' ? 'da semana' : 'do mês';
  const uniao = tr => { const v = [...tr].sort((a, b) => a.x0 - b.x0), out = []; for (const t of v) { const u = out[out.length - 1]; if (u && t.x0 <= u.x1) u.x1 = Math.max(u.x1, t.x1); else out.push({ x0: t.x0, x1: t.x1 }); } return out; };
  // tempo afetado no período (sobreposição conta uma vez), sem o indevido
  const uniaoMs = (itens, p) => uniao(itens.filter(c => !c.indevido).flatMap(c => trechos(c, p))).reduce((a, t) => a + (t.x1 - t.x0), 0) * p.dias * EXP;

  // ---------------- estado (só enquanto o app está aberto) ----------------
  let aberto = false;      // o card sempre começa fechado (só a linha Total)
  let celSel = null;       // célula com a lista aberta: {ordem, sis} (sis null = Total)
  let ctx = null;          // {rerender, toggleSel} do painel

  // ---------------- card ----------------
  // opts: {modo, sel (ORDEM selecionada no painel), filtro (texto do filtro de dia da semana, ou null), erros}
  function card(dados, items, opts) {
    const ps = colunas(items, dados), modo = opts.modo, sel = opts.sel;
    if (celSel && !ps.some(p => p.ordem === celSel.ordem)) celSel = null;
    const validos = dados ? dados.itens : [];
    const mapa = new Map();
    for (const c of validos) {
      ps.forEach((p, ci) => {
        if (p.semDados) return;
        const tr = trechos(c, p), fora = !tr.length && noPeriodo(c, p);
        if (!tr.length && !fora) return;
        if (!mapa.has(c.sistema)) mapa.set(c.sistema, { nome: c.sistema, cols: ps.map(() => []), ms: 0, n: new Set() });
        const s = mapa.get(c.sistema);
        s.cols[ci].push({ c, tr, fora });
        if (!c.indevido) { s.ms += tr.reduce((a, t) => a + t.ms, 0); s.n.add(c.id); }
      });
    }
    const sis = [...mapa.values()].sort((a, b) => b.ms - a.ms || a.nome.localeCompare(b.nome, 'pt-BR'));
    const titulo = !aberto ? 'Problemas sistêmicos' : modo === 'DIA' ? (opts.filtro ? `Problemas sistêmicos · ${opts.filtro}` : 'Problemas sistêmicos por dia') : modo === 'SEMANA' ? 'Problemas sistêmicos por semana' : 'Problemas sistêmicos por mês';
    // linha Total: todos os sistemas juntos, só o preenchimento (sobreposição conta uma vez), sem o indevido
    const totCols = ps.map(p => p.semDados ? [] : uniao(validos.filter(c => !c.indevido).flatMap(c => trechos(c, p))));
    const totMs = totCols.reduce((a, u, ci) => a + u.reduce((x, t) => x + (t.x1 - t.x0) * ps[ci].dias * EXP, 0), 0);
    const temNaCol = ci => !ps[ci].semDados && validos.some(c => noPeriodo(c, ps[ci]));
    const cab = ps.map((p, ci) => {
      const d = p.ini, dom = modo === 'DIA' && d.getDay() === 0, mesMin = MES[d.getMonth()].toLowerCase();
      const t = modo === 'MES' ? MES[d.getMonth()] : pad(d.getDate());
      const s = modo === 'DIA' ? (opts.filtro ? mesMin : WD[d.getDay()]) : modo === 'SEMANA' ? mesMin : String(d.getFullYear());
      return `<button class="hd${dom ? ' dom' : ''}${sel === p.ordem ? ' sel' : ''}${p.andamento ? ' and' : ''}${p.semDados ? ' sd' : ''}" data-ordem="${p.ordem}" aria-label="Selecionar ${esc(rot(p))}" aria-pressed="${sel === p.ordem}">${t}${p.andamento ? '*' : ''}<small>${s}</small></button>`;
    }).join('');
    const divisoes = () => modo === 'DIA' ? `<span class="dv" style="left:50%"></span>` : modo === 'SEMANA' ? [1, 2, 3, 4, 5, 6].map(i => `<span class="dv" style="left:${(i / 7 * 100).toFixed(2)}%"></span>`).join('') : '';
    const clsCel = (p, tem, marcada) => `cel${p.semDados ? ' sd' : tem ? ' tem' : ''}${marcada ? ' sel' : sel === p.ordem ? ' colsel' : ''}`;
    const linhas = sis.map(s => `<div class="sys${celSel && celSel.sis === s.nome ? ' sel' : ''}" title="${esc(s.nome)}">${esc(s.nome)}</div>` + s.cols.map((cs, ci) => {
      const p = ps[ci], marcada = celSel && celSel.ordem === p.ordem && celSel.sis === s.nome;
      const bars = cs.flatMap(({ c, tr, fora }) => fora
        ? [`<span class="fora" style="left:${c.ini.getHours() < HORA_INI ? 0 : 'calc(100% - 6px)'}"></span>`]
        : tr.map(t => `<span class="bar${c.indevido ? ' indev' : ''}" style="left:${(t.x0 * 100).toFixed(2)}%;width:${((t.x1 - t.x0) * 100).toFixed(2)}%;background:${COR(c.tipo)}"></span>`)).join('');
      return `<button class="${clsCel(p, cs.length, marcada)}" data-ordem="${p.ordem}" data-sis="${esc(s.nome)}" aria-label="${esc(s.nome)} · ${esc(rot(p))}${p.semDados ? ' · sem dados' : ''}">${p.semDados ? '' : divisoes()}${bars}</button>`;
    }).join('') + `<div class="tot">${fmtHc(s.ms) || (s.n.size ? '0' : '')}</div>`).join('');
    const linhaTot = `<div class="sys totl">Total</div>` + totCols.map((u, ci) => {
      const p = ps[ci], marcada = celSel && celSel.ordem === p.ordem && celSel.sis == null;
      return `<button class="${clsCel(p, temNaCol(ci), marcada)} tcel" data-ordem="${p.ordem}" data-tot="1" aria-label="Todos os sistemas · ${esc(rot(p))}${p.semDados ? ' · sem dados' : ''}">${p.semDados ? '' : divisoes()}${u.map(t => `<span class="bar tot" style="left:${(t.x0 * 100).toFixed(2)}%;width:${((t.x1 - t.x0) * 100).toFixed(2)}%"></span>`).join('')}</button>`;
    }).join('') + `<div class="tot tt">${fmtHc(totMs) || ''}</div>`;
    const temSd = ps.some(p => p.semDados);
    const pSel = sel ? ps.find(p => p.ordem === sel) : null;
    let capSel = '';
    if (pSel) {
      const its = validos.filter(c => noPeriodo(c, pSel)), n = its.filter(c => !c.indevido).length, ms = uniaoMs(its, pSel);
      capSel = pSel.semDados ? `${esc(rotFolha(pSel))} · sem dados de sistemas` : !n ? `${esc(rotFolha(pSel))} · nenhum chamado` : `${esc(rotFolha(pSel))} · ${n} chamado${n > 1 ? 's' : ''} · ${fmtH(ms)} (${pctTxt(ms, pSel)}) no expediente`;
    }
    const sub = modo === 'DIA' ? 'Cada coluna = expediente das 08h às 20h (linha no meio = 14h).' : modo === 'SEMANA' ? 'Cada coluna = 7 dias (seg a dom), cada dia das 08h às 20h.' : 'Cada coluna = os dias do mês, cada dia das 08h às 20h.';
    const lab = aberto ? (window.innerWidth < 380 ? 92 : 112) + 'px' : 'max-content';
    return `<div class="card mxcard ${aberto ? 'mx-on' : 'mx-off'}" id="cardSis">
      <button class="mxhead" id="bMx" aria-expanded="${aberto}" aria-label="${aberto ? 'Fechar' : 'Abrir'} o gráfico de problemas sistêmicos"><h2>${titulo}</h2><span class="seta" data-dir="${aberto ? 'cima' : 'baixo'}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="${aberto ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'}"/></svg></span></button>
      ${aberto ? `<div class="mxsub">${sub} Horas = no expediente; no Total, tempo com algum sistema com problema.</div>` : ''}
      ${opts.erros && opts.erros.length ? `<div class="banner bad small mxerr"><b>sistemas: ${opts.erros.length} linha(s) ignorada(s)</b><ul>${opts.erros.slice(0, 8).map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
      ${opts.aviso ? `<div class="banner bad small mxerr">${esc(opts.aviso)}</div>` : ''}
      ${opts.avisos && opts.avisos.length ? `<div class="banner warn small mxerr">${opts.avisos.slice(0, 5).map(esc).join('<br>')}</div>` : ''}
      <div class="mx" style="--n:${ps.length};--lab:${lab}"><div class="corner">${aberto ? 'Sistema' : ''}</div>${cab}<div class="tot hd2">Horas</div>${aberto ? linhas + (sis.length ? '<div class="sep"></div>' : '') : ''}${linhaTot}</div>
      ${aberto && !sis.length ? `<div class="vazio">Nenhum sistema com chamado ${modo === 'DIA' && opts.filtro ? 'nas ' + esc(opts.filtro) + ' da tela' : 'nesse período'}.</div>` : ''}
      <div class="legend">
        ${aberto ? `<span><i style="background:var(--fTotal)"></i>Indisp. total</span><span><i style="background:var(--fParcial)"></i>Indisp. parcial</span>
        <span><i style="background:var(--fInterm)"></i>Intermitência</span><span><i style="background:var(--fLent)"></i>Lentidão</span>
        <span><i class="fora"></i>fora do expediente</span><span><i class="indev"></i>indevido</span>` : ''}
        <span><i style="background:var(--tot)"></i>Total: todos os sistemas juntos</span>
        ${temSd ? '<span><i class="sd"></i>sem dados de sistemas</span>' : ''}
      </div>
      ${pSel ? `<div class="cap capsel" id="capSis">${capSel}</div>` : aberto ? `<div class="cap" id="capSis">Toque numa célula com chamado para ver a lista · toque no cabeçalho da coluna para selecionar o período.</div>` : ''}
    </div>`;
  }

  // liga os toques do card; c = {dados, items, rerender, toggleSel}
  function ligar(root, c) {
    ctx = c;
    const el = root.querySelector('#cardSis'); if (!el) return;
    const ps = colunas(c.items, c.dados);
    el.querySelector('#bMx').onclick = () => { aberto = !aberto; if (!aberto && celSel && celSel.sis) celSel = null; c.rerender(); };
    el.querySelectorAll('.mx .hd').forEach(b => b.onclick = () => c.toggleSel(b.dataset.ordem));
    // célula com chamado: destaca e abre a lista do container (sistema + período)
    el.querySelectorAll('.mx .cel').forEach(b => b.onclick = () => {
      const p = ps.find(q => q.ordem === b.dataset.ordem); if (!p || p.semDados || !c.dados) return;
      const tot = !!b.dataset.tot, s = tot ? null : b.dataset.sis;
      const itens = c.dados.itens.filter(x => (tot || x.sistema === s) && noPeriodo(x, p)).sort((a, b2) => a.ini - b2.ini);
      if (!itens.length) return;
      celSel = { ordem: p.ordem, sis: s }; c.rerender();
      abrirLista(tot ? 'Todos os sistemas' : s, rotFolha(p), itens, p);
    });
  }

  // ---------------- folhas: lista do container → detalhe do chamado ----------------
  const fmtDHc = d => d ? fmtDH(d) : '—';
  const msExpTotal = c => { let ms = 0; for (let d = dia0(c.ini); d <= c.fimCalc; d = addD(d, 1)) ms += trechos(c, { ini: d, dias: 1 }).reduce((a, t) => a + t.ms, 0); return ms; };
  // cápsula do tipo de falha, na cor do gráfico (texto escuro onde a cor é clara)
  const pillTipo = c => `<span class="pill ptipo" style="background:${c.indevido ? 'var(--ink3)' : COR(c.tipo)};color:${!c.indevido && /PARCIAL|LENTID/.test(c.tipo) ? '#2b1a00' : '#fff'}">${esc(c.tipo || '—')}</span>`;
  const extrasPill = c => `${c.indevido ? '<span class="pill lt">INDEVIDO</span>' : ''}${c.aberto ? '<span class="pill lt">EM ABERTO</span>' : ''}`;
  const cabFolha = (titulo, sub, comVoltar) => `<div class="sh-cab"><div class="sh-top"><h3>${esc(titulo)}</h3><div class="sh-acoes">${comVoltar ? '<button class="sh-volta" aria-label="Voltar à lista">‹ Voltar</button>' : ''}<button class="sh-x" aria-label="Fechar">✕ Fechar</button></div></div><div class="sh-sub">${sub}</div></div>`;
  let folha = null;   // { el, lista: {sistema, periodoTxt, itens, p} | null, detalhe }
  function fecharFolha() {
    if (!folha) return;
    folha.el.remove(); folha = null;
    document.removeEventListener('keydown', escFolha);
    if (celSel) { celSel = null; if (ctx) ctx.rerender(); }   // fechou a lista: tira o destaque da célula
  }
  function escFolha(e) { if (e.key === 'Escape') { if (folha && folha.lista && folha.detalhe) mostrarLista(); else fecharFolha(); } }
  function montarFolha() {
    if (folha) return folha;
    const bg = document.createElement('div'); bg.className = 'sheet-bg shs';
    bg.innerHTML = '<div class="sheet shs" role="dialog" aria-modal="true"></div>';
    bg.addEventListener('click', e => { if (e.target === bg) fecharFolha(); });
    document.body.appendChild(bg);
    document.addEventListener('keydown', escFolha);
    folha = { el: bg, lista: null, detalhe: null };
    return folha;
  }
  function abrirLista(sistema, periodoTxt, itens, p) {
    const f = montarFolha();
    f.lista = { sistema, periodoTxt, itens, p }; f.detalhe = null;
    mostrarLista();
  }
  function mostrarLista() {
    const f = folha, { sistema, periodoTxt, itens, p } = f.lista; f.detalhe = null;
    const sh = f.el.querySelector('.sheet');
    const tot = uniaoMs(itens, p);
    sh.innerHTML = cabFolha(sistema, `<span class="sh-per">${esc(periodoTxt)}</span> · ${itens.length} chamado${itens.length > 1 ? 's' : ''} · ${fmtH(tot)} (${pctTxt(tot, p)}) no expediente`, false) + `<div class="sh-corpo">
      ${itens.map(c => {
        const dur = c.fimCalc - c.ini, noP = trechos(c, p).reduce((a, t) => a + t.ms, 0);
        return `<button class="li" data-id="${esc(c.id)}"><span class="bx">
          <span class="l1"><span>${esc(c.sistema)}</span><span class="id">ID ${esc(c.id)}</span></span>
          <span class="l2">${pillTipo(c)}${extrasPill(c)}</span>
          <span class="l3"><b>Início</b><span>${fmtDHc(c.ini)}</span><b>Fim</b><span>${c.aberto ? 'em aberto' : fmtDHc(c.fim)}</span><b>No Expediente:</b><span>${fmtH(noP)} (${pctTxt(noP, p)})${noP !== dur ? ` - Duração Total: ${fmtH(dur)}` : ''}</span></span>
        </span><span class="seta" aria-hidden="true">›</span></button>`;
      }).join('')}</div>`;
    sh.querySelector('.sh-x').onclick = fecharFolha;
    sh.querySelectorAll('.li').forEach(b => b.onclick = () => abrirDetalhe(itens.find(c => c.id === b.dataset.id), f.lista));
  }
  // detalhe completo de um chamado (todas as colunas do arquivo)
  const ROT = { ID: 'ID', SISTEMA: 'Sistema', CHAMADO: 'Chamado', STATUS: 'Status', CRITICIDADE: 'Criticidade', EVOLUCAO: 'Evolução', SEGMENTO: 'Segmento',
    IMPACTO_OPERACIONAL: 'Impacto operacional', DATA_INICIO: 'Início', DATA_FIM: 'Fim', TIPO_FALHA: 'Tipo de falha', GRUPOS_RESPONSAVEIS: 'Grupos responsáveis',
    GRUPOS_IMPACTADOS: 'Grupos impactados', AREA_ACIONADA: 'Área acionada', ALERTA_ENVIADO: 'Alerta enviado', DATA_ATUALIZACAO: 'Data de atualização',
    DADO_ATUALIZADO: 'Dado atualizado em', TEMPO_DECORRIDO: 'Tempo decorrido (arquivo)', FLAG: 'Flag' };
  const GRUPOS = [['Chamado', ['ID', 'SISTEMA', 'CHAMADO', 'STATUS', 'EVOLUCAO', 'CRITICIDADE']], ['Falha', ['TIPO_FALHA', 'SEGMENTO', 'IMPACTO_OPERACIONAL']],
    ['Tempo', ['DATA_INICIO', 'DATA_FIM', '__DUR', '__EXP', 'TEMPO_DECORRIDO']], ['Equipes', ['GRUPOS_RESPONSAVEIS', 'GRUPOS_IMPACTADOS', 'AREA_ACIONADA', 'ALERTA_ENVIADO']],
    ['Registro', ['DATA_ATUALIZACAO', 'DADO_ATUALIZADO', 'FLAG']]];
  function abrirDetalhe(c, lista) {
    if (!c) return;
    const f = montarFolha(); f.lista = lista; f.detalhe = c;
    const cx = lista ? { p: lista.p, periodoTxt: lista.periodoTxt } : null;
    const noP = cx ? trechos(c, cx.p).reduce((a, t) => a + t.ms, 0) : 0, base = cx ? ` ${nomeBase(cx.p.tipo)}` : '';
    const sh = f.el.querySelector('.sheet'), raw = c.raw || {};
    const val = k => {
      if (k === '__DUR') { const d = c.fimCalc - c.ini; return fmtH(d) + (cx && noP === d && d ? ` (${pctTxt(d, cx.p)}${base})` : '') + (c.aberto ? ' · até a última atualização' : ''); }
      if (k === '__EXP') {
        const ms = msExpTotal(c);
        if (!ms) return 'fora do expediente';
        if (!cx) return fmtH(ms);
        return noP === ms ? `${fmtH(ms)} (${pctTxt(ms, cx.p)}${base})` : `${fmtH(ms)} · ${noP ? `${fmtH(noP)} neste período (${pctTxt(noP, cx.p)}${base})` : 'nada neste período'}`;
      }
      if (k === 'DATA_INICIO') return fmtDHc(c.ini);
      if (k === 'DATA_FIM') return c.aberto ? 'em aberto' : fmtDHc(c.fim);
      if (k === 'DATA_ATUALIZACAO' || k === 'DADO_ATUALIZADO') { const d = data(raw[k]); return d ? fmtDH(d) : esc(raw[k] || '—'); }
      if (k === 'TIPO_FALHA') return raw[k] ? pillTipo(c) + extrasPill(c) : '—';
      if (k === 'ALERTA_ENVIADO') return raw[k] === '1' ? 'Sim' : raw[k] === '0' ? 'Não' : esc(raw[k] || '—');
      if (k === 'TEMPO_DECORRIDO') { const m = String(raw[k] || '').match(/^\+?(\d+) (\d\d):(\d\d):(\d\d)/); return m ? `${+m[1] ? m[1] + 'd ' : ''}${+m[2]}h${m[3]}` : esc(raw[k] || '—'); }
      return esc(raw[k] || '—');
    };
    const rotulo = k => k === '__DUR' ? 'Duração' : k === '__EXP' ? 'No expediente (08h–20h)' : ROT[k] || k;
    const usadas = new Set(GRUPOS.flatMap(g => g[1]));
    const extras = Object.keys(raw).filter(k => !usadas.has(k));
    const linhas = GRUPOS.map(([g, ks]) => `<div class="grp">${g}</div>` + ks.filter(k => k.startsWith('__') || k in raw).map(k => `<dt>${esc(rotulo(k))}</dt><dd>${val(k)}</dd>`).join('')).join('')
      + (extras.length ? `<div class="grp">Outras colunas</div>` + extras.map(k => `<dt>${esc(k)}</dt><dd>${esc(raw[k] || '—')}</dd>`).join('') : '');
    // abaixo do sistema: o período e o tempo do chamado no expediente desse período (% do dia/semana/mês)
    const sub = cx ? `<span class="sh-per">${esc(cx.periodoTxt)}</span> · <span class="sh-exp">${noP ? `${fmtH(noP)} (${pctTxt(noP, cx.p)}${base}) no expediente` : 'fora do expediente'}</span>`
      : (() => { const ms = msExpTotal(c); return ms ? `${fmtH(ms)} no expediente` : 'fora do expediente'; })();
    sh.innerHTML = cabFolha(c.sistema, sub, !!lista) + `<div class="sh-corpo"><dl class="det">${linhas}</dl></div>`;
    sh.querySelector('.sh-x').onclick = fecharFolha;
    if (lista) sh.querySelector('.sh-volta').onclick = mostrarLista;
  }

  window.NSSistemas = {
    versao: VERSAO, ler, card, ligar, fecharFolha, colunas, trechos,
    estado: () => ({ aberto, celSel, folha: folha ? (folha.detalhe ? 'detalhe' : 'lista') : null }),
  };
})();
