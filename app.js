/* NS Painel — app (v2: dados por TXT) */
(function () {
  'use strict';
  const APP_VERSION = '2.0.0';
  const P = window.NSData;
  const $ = s => document.querySelector(s);
  const main = $('#main');
  $('#ver').textContent = 'v' + APP_VERSION;

  // ---------------- Banco (IndexedDB) ----------------
  const DB_NAME = 'ns-painel', STORE = 'snapshots';
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => { const d = rq.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' }); };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error || new Error('Falha ao abrir o banco'));
      rq.onblocked = () => rej(new Error('Banco bloqueado por outra aba do app. Feche as outras abas.'));
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, mode), st = t.objectStore(STORE);
      let out; const r = fn(st);
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error || new Error('Erro na transação'));
      t.onabort = () => rej(t.error || new Error('Transação abortada (espaço cheio?)'));
    });
  }
  const dbAll = () => tx('readonly', st => st.getAll());
  const dbGet = id => tx('readonly', st => st.get(id));
  const dbPut = obj => tx('readwrite', st => st.put(obj));
  const dbDel = id => tx('readwrite', st => st.delete(id));

  // grava e confere lendo de volta — erro de gravação nunca passa em silêncio
  async function salvarSnapshot(snap) {
    await dbPut(snap);
    const back = await dbGet(snap.id);
    if (!back || JSON.stringify(back.rows) !== JSON.stringify(snap.rows)) throw new Error('A conferência depois de gravar não bateu.');
  }

  // ---------------- Estado ----------------
  let snaps = [];          // mais recente (pelos dados) primeiro
  let view = 'painel';
  let preview = null;      // importação aguardando confirmação
  let pubStatus = null;    // situação do data.txt publicado
  let modo = (() => { try { const m = localStorage.getItem('ns-modo'); return ['DIA', 'SEMANA', 'MES'].includes(m) ? m : 'DIA'; } catch (e) { return 'DIA'; } })();

  async function reload() {
    snaps = (await dbAll()).sort((a, b) => (b.dataRef || '').localeCompare(a.dataRef || '') || b.id - a.id);
  }
  // valor vigente de cada período = o do arquivo com dados mais recentes que o contém
  function periodos() {
    const map = new Map();
    for (const s of snaps) for (const r of s.rows) if (!map.has(r.ordem)) map.set(r.ordem, r);
    return map;
  }

  // ---------------- Utilidades ----------------
  const fmtInt = v => v == null ? '—' : Math.round(v).toLocaleString('pt-BR');
  const fmtNs = v => v == null ? '—' : String(+v.toFixed(4)).replace('.', ',');
  const fmtPct = v => v == null ? '—' : (v * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
  const fmtDT = ts => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  const fmtData = isoD => isoD ? isoD.slice(8, 10) + '/' + isoD.slice(5, 7) + '/' + isoD.slice(2, 4) : '—';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const NOME = { DIA: 'Dia', SEMANA: 'Semana', MES: 'Mês' };
  function toast(msg, ms = 2600) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // ---------------- Navegação ----------------
  $('#nav').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (preview && b.dataset.v !== 'dados') {
      if (!window.confirm('Há uma importação não salva. Sair e descartar?')) return;
      preview = null;
    }
    go(b.dataset.v);
  });
  function go(v) {
    view = v;
    document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    render(); window.scrollTo(0, 0);
  }
  function render() {
    if (view === 'painel') renderPainel();
    else if (view === 'dados') preview ? renderPreview() : renderDados();
    else renderHist();
  }

  // ---------------- data.txt publicado (GitHub Pages) ----------------
  async function buscarPublicado(manual) {
    if (location.protocol === 'file:') return;
    try { await buscarPublicado2(manual); }
    finally { if (view === 'dados' && !preview) renderDados(); }
  }
  async function buscarPublicado2(manual) {
    let res;
    try { res = await fetch('data.txt', { cache: 'no-store' }); }
    catch (e) { pubStatus = { estado: 'offline', em: Date.now() }; if (manual) toast('Sem conexão — usando os dados já salvos.'); return; }
    if (res.status === 404) { pubStatus = { estado: 'ausente', em: Date.now() }; if (manual) toast('Não há data.txt publicado no site.'); return; }
    if (!res.ok) { pubStatus = { estado: 'erro', msg: 'HTTP ' + res.status, em: Date.now() }; return; }
    const { text } = P.decode(new Uint8Array(await res.arrayBuffer()));
    const pr = P.parse(text);
    const lm = res.headers.get('Last-Modified');
    if (pr.erros.length) { pubStatus = { estado: 'invalido', erros: pr.erros, em: Date.now() }; if (view === 'painel') renderPainel(); return; }
    const h = P.hash(text);
    pubStatus = { estado: 'ok', hash: h, publicadoEm: lm ? Date.parse(lm) : null, dataRef: pr.dataRef, em: Date.now() };
    if (snaps.some(s => s.hash === h)) { if (manual) toast('Os dados publicados já estão em dia.'); return; }
    const snap = montarSnap(pr, h, 'publicado', 'data.txt', lm ? Date.parse(lm) : null);
    try {
      await salvarSnapshot(snap);
      await reload();
      toast('Dados atualizados: até ' + fmtData(pr.dataRef));
      if (!preview) { if (view === 'dados' && snaps.length === 1) go('painel'); else if (view !== 'dados') render(); }
    } catch (e) {
      alert('ERRO AO GRAVAR os dados publicados — nada foi alterado.\n\n' + e.message);
    }
  }
  function montarSnap(pr, h, origem, arquivo, publicadoEm) {
    return {
      id: Date.now(), origem, arquivo, hash: h, formato: pr.formato, dataRef: pr.dataRef,
      publicadoEm: publicadoEm || null, colunasExtras: pr.colunasExtras, avisos: pr.avisos.length, app: APP_VERSION,
      rows: pr.rows.map(r => ({
        ordem: r.ordem, tipo: r.tipo, periodo: r.periodo, inicio: r.inicio, fim: r.fim, dias: r.dias, diasPeriodo: r.diasPeriodo,
        completo: r.completo, volume: r.volume, total: r.total, ate: r.ate, ns: r.ns, meta: r.meta, status: r.status, extras: r.extras,
      })),
    };
  }

  // ---------------- Dados (importação) ----------------
  function renderDados() {
    const ps = pubStatus;
    const pubTxt = !ps ? 'Verificando…'
      : ps.estado === 'ok' ? `Publicado: dados até <b>${fmtData(ps.dataRef)}</b>${ps.publicadoEm ? ` · enviado em ${fmtDT(ps.publicadoEm)}` : ''} ✓`
      : ps.estado === 'ausente' ? 'Ainda não há <code>data.txt</code> publicado no site.'
      : ps.estado === 'offline' ? 'Sem conexão agora — usando os dados salvos no aparelho.'
      : ps.estado === 'invalido' ? `<span style="color:var(--bad)">O <code>data.txt</code> publicado tem ${ps.erros.length} erro(s) e foi ignorado.</span>`
      : 'Não consegui verificar (' + esc(ps.msg) + ').';
    main.innerHTML = `
      <div class="card"><h2>Importar TXT</h2>
        <div class="small muted" style="margin-bottom:10px">Arquivo exportado do SQL Developer (colunas separadas por tabulação, com o cabeçalho na 1ª linha). Nada é salvo antes de você conferir.</div>
        <div class="row" style="flex-direction:column;gap:10px">
          <button class="btn" id="bArq">Escolher arquivo .txt</button>
          <button class="btn sec" id="bColar">Colar o conteúdo</button>
        </div>
        <div id="colarBox" hidden style="margin-top:10px">
          <textarea id="txtColar" placeholder="Cole aqui (com a linha do cabeçalho)" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
          <button class="btn" id="bConferir" style="margin-top:8px">Conferir</button>
        </div>
      </div>
      <div class="card"><h2>Dados publicados no site</h2>
        <div class="small" id="pubTxt">${pubTxt}</div>
        ${ps && ps.estado === 'invalido' ? `<ul class="list-msg err">${ps.erros.slice(0, 6).map(msgLi).join('')}</ul>` : ''}
        <button class="btn sec" id="bPub" style="margin-top:10px">Verificar agora</button>
        <div class="small muted" style="margin-top:10px">Para todos verem os dados novos: no repositório do GitHub, substitua o arquivo <code>data.txt</code> (mesmo nome, na mesma pasta do app). Quem abrir o app recebe os dados na hora; o arquivo é conferido do mesmo jeito que na importação.</div>
      </div>`;
    $('#bArq').onclick = () => $('#fileTxt').click();
    $('#bColar').onclick = () => { $('#colarBox').hidden = false; $('#txtColar').focus(); };
    $('#bConferir').onclick = () => { const t = $('#txtColar').value; if (!t.trim()) { toast('Cole o conteúdo primeiro.'); return; } abrirPrevia(t, 'texto colado', 'UTF-8'); };
    $('#bPub').onclick = async () => { $('#pubTxt').textContent = 'Verificando…'; await buscarPublicado(true); renderDados(); };
  }
  $('#fileTxt').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      if (f.size > 5 * 1024 * 1024) throw new Error('Arquivo grande demais (máx. 5 MB).');
      const { text, encoding } = P.decode(new Uint8Array(await f.arrayBuffer()));
      abrirPrevia(text, f.name, encoding);
    } catch (err) { alert('Não consegui abrir o arquivo: ' + err.message); }
  });

  function abrirPrevia(text, arquivo, encoding) {
    const pr = P.parse(text);
    const h = P.hash(text);
    preview = { pr, hash: h, arquivo, encoding, mudancas: P.compara(pr.rows, periodos()), dup: snaps.find(s => s.hash === h) || null, aceito: false };
    view = 'dados'; renderPreview(); window.scrollTo(0, 0);
  }
  const msgLi = m => `<li>${m.linha ? `<b>Linha ${m.linha}</b> · ` : ''}${m.col ? `<b>${esc(m.col)}</b>: ` : ''}${esc(m.msg)}</li>`;

  function renderPreview() {
    const { pr, mudancas, dup } = preview;
    const bloqueia = pr.erros.length > 0 || !!dup || (mudancas.length > 0 && !preview.aceito);
    const tabelaTipo = t => {
      const rs = pr.rows.filter(r => r.tipo === t); if (!rs.length) return '';
      return `<h3 class="sub">${NOME[t]} (${rs.length})</h3><div style="overflow-x:auto"><table class="conf" style="cursor:default">
        <thead><tr><th>PERÍODO</th><th>DIAS</th><th>VOLUME</th><th>ATEND.</th><th>≤5MIN</th><th>NS</th></tr></thead><tbody>
        ${rs.map(r => `<tr style="cursor:default"><td>${esc(P.rotulo(r))}</td><td class="${r.completo ? '' : 'dias-aberto'}">${r.tipo === 'DIA' ? '1' : r.completo ? r.dias : r.dias + '/' + r.diasPeriodo}</td>
          <td>${r.volume}</td><td>${r.total}</td><td>${r.ate}</td><td><span class="pill ${r.status}">${fmtNs(r.ns)}</span></td></tr>`).join('')}
        </tbody></table></div>`;
    };
    main.innerHTML = `
      <div class="card"><h2>Conferir importação</h2>
        <div class="small muted">${esc(preview.arquivo)} · ${esc(pr.formato || '?')}${preview.encoding ? ' · ' + preview.encoding : ''}</div>
        ${pr.rows.length ? `<div class="chips"><span class="chip">${pr.resumo.MES} meses</span><span class="chip">${pr.resumo.SEMANA} semanas</span><span class="chip">${pr.resumo.DIA} dias</span><span class="chip">dados até ${fmtData(pr.dataRef)}</span></div>` : ''}
        ${pr.erros.length ? `<div class="banner bad" style="margin-top:8px"><b>${pr.erros.length} erro(s) — corrija o arquivo e importe de novo.</b> Nada foi salvo.</div><ul class="list-msg err">${pr.erros.map(msgLi).join('')}</ul>` : ''}
        ${dup ? `<div class="banner info" style="margin-top:8px">Este arquivo já foi importado em ${fmtDT(dup.id)} — não há nada novo para salvar.</div>` : ''}
        ${!pr.erros.length && !dup ? `<div class="banner ok" style="margin-top:8px"><b>Arquivo conferido.</b> ${pr.rows.length} linhas válidas: NS = ATE_5_MIN ÷ TOTAL_ATENDIDAS em todas${pr.info.length ? ' · ' + esc(pr.info.join(' ')) : '.'}</div>` : ''}
        ${pr.colunasExtras.length ? `<div class="banner info small">Colunas novas encontradas: <b>${pr.colunasExtras.map(esc).join(', ')}</b>. Ficam guardadas e aparecem no detalhe de cada período.</div>` : ''}
        ${pr.avisos.length ? `<h3 class="sub">Avisos (não impedem salvar)</h3><ul class="list-msg warn">${pr.avisos.map(msgLi).join('')}</ul>` : ''}
        ${mudancas.length ? `<h3 class="sub">Mudou em período fechado</h3><ul class="list-msg warn">${mudancas.map(m => `<li><b>${esc(m.periodo)}</b> · ${m.col}: salvo ${m.antes} → arquivo ${m.agora}</li>`).join('')}</ul>
          <label class="chk"><input type="checkbox" id="chkMud" ${preview.aceito ? 'checked' : ''}> Confirmo que esses valores mudaram na origem e o arquivo novo está certo.</label>` : ''}
        ${tabelaTipo('MES')}${tabelaTipo('SEMANA')}${tabelaTipo('DIA')}
      </div>
      <div class="row">
        <button class="btn sec" id="bDesc">${pr.erros.length || dup ? 'Voltar' : 'Descartar'}</button>
        <button class="btn" id="bSalvar" ${bloqueia ? 'disabled' : ''}>Salvar ${pr.rows.length} linhas</button>
      </div>`;
    $('#bDesc').onclick = () => { preview = null; renderDados(); };
    if ($('#chkMud')) $('#chkMud').onchange = e => { preview.aceito = e.target.checked; renderPreview(); };
    $('#bSalvar').onclick = salvarPrevia;
  }

  async function salvarPrevia() {
    const { pr, mudancas, dup } = preview;
    if (pr.erros.length || dup || (mudancas.length && !preview.aceito)) return;
    const btn = $('#bSalvar'); btn.disabled = true; btn.textContent = 'Salvando…';
    const snap = montarSnap(pr, preview.hash, 'importado', preview.arquivo, null);
    snap.mudancasAceitas = mudancas;
    try {
      await salvarSnapshot(snap);
      preview = null;
      await reload();
      toast(`Salvo ✓ ${snap.rows.length} linhas (até ${fmtData(snap.dataRef)})`);
      go('painel');
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Tentar salvar de novo';
      alert('ERRO AO SALVAR — os dados NÃO foram gravados.\n\n' + (e.message || e) + '\n\nA importação continua na tela; tente de novo. Se persistir, exporte um backup no Histórico.');
    }
  }

  // ---------------- Painel ----------------
  const setModo = m => { modo = m; try { localStorage.setItem('ns-modo', m); } catch (e) {} renderPainel(); };
  const LIMITE = { DIA: 14, SEMANA: 12, MES: 12 };
  function metaFalta(tot, ate, meta) {
    const ns = tot > 0 ? ate / tot : null;
    return { ns, falta: ns != null && ns < meta ? Math.ceil(meta * tot - ate - 1e-9) : 0, folga: ns != null && ns >= meta ? Math.floor(ate / meta - tot + 1e-9) : 0 };
  }
  const nomeCur = r => r.tipo === 'MES' ? P.rotulo(r).replace('*', '') : r.tipo === 'SEMANA' ? 'Semana ' + P.rotulo(r).replace('*', '') : P.rotulo(r);
  const diasTxt = r => r.completo ? `${r.dias} dias` : `${r.dias} de ${r.diasPeriodo} dias`;
  const pp = v => (v >= 0 ? '+' : '') + v.toFixed(1).replace('.', ',') + ' p.p.';
  const pc = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1).replace('.', ',') + '%';

  function renderPainel() {
    const per = periodos();
    const pubErr = pubStatus && pubStatus.estado === 'invalido' ? `<div class="banner bad small">O <code>data.txt</code> publicado tem erros e foi ignorado — mostrando os últimos dados válidos.</div>` : '';
    if (!per.size) {
      main.innerHTML = `${pubErr}<div class="card empty"><div style="font-size:40px">📊</div><p>Nenhum dado ainda.</p>
        <button class="btn" id="bGo">Importar o TXT</button></div>`;
      $('#bGo').onclick = () => go('dados'); return;
    }
    const all = [...per.values()].sort((a, b) => a.ordem.localeCompare(b.ordem));
    const por = t => all.filter(r => r.tipo === t);
    if (!por(modo).length) modo = ['DIA', 'SEMANA', 'MES'].find(t => por(t).length);
    const items = por(modo).slice(-LIMITE[modo]);
    const s0 = snaps[0];
    main.innerHTML = `${pubErr}
      <div class="card topbar">
        <div class="seg" role="tablist" aria-label="TIPO_PERIODO">
          ${['DIA', 'SEMANA', 'MES'].map(t => `<button role="tab" data-m="${t}" class="${modo === t ? 'on' : ''}" ${por(t).length ? '' : 'disabled'}>${NOME[t]}</button>`).join('')}
        </div>
        <div class="meta-line" style="margin-top:10px"><span>Dados até <b>${fmtData(s0.dataRef)}</b></span><span>${s0.origem === 'publicado' ? 'publicado' : 'importado'} ${fmtDT(s0.publicadoEm || s0.id)}</span></div>
      </div>
      ${painelTipo(modo, items, all)}`;
    main.querySelectorAll('.seg button').forEach(b => b.onclick = () => { if (b.dataset.m !== modo) setModo(b.dataset.m); });
    bindTaps(items);
  }

  function painelTipo(t, items, all) {
    const cur = items[items.length - 1], prev = items.length > 1 ? items[items.length - 2] : null;
    const meta = cur.meta || 0.8;
    const dPP = prev && cur.ns != null && prev.ns != null ? (cur.ns - prev.ns) * 100 : null;
    let k = '';
    if (t === 'DIA') {
      const mesAberto = all.filter(r => r.tipo === 'MES' && !r.completo).slice(-1)[0] || all.filter(r => r.tipo === 'MES').slice(-1)[0];
      const f = mesAberto ? metaFalta(mesAberto.total, mesAberto.ate, mesAberto.meta) : null;
      const dVol = prev ? cur.volume / prev.volume - 1 : null;
      k = `
        <div class="kpi wide"><div class="l">Último dia · ${esc(P.rotulo(cur))}</div><div class="v">${fmtPct(cur.ns)}</div>
          <div class="s"><span class="pill ${cur.status}">${cur.status}</span> meta ${fmtPct(meta)}${dPP == null ? '' : ' · ' + pp(dPP) + ' vs dia anterior'}</div></div>
        ${f ? `<div class="kpi"><div class="l">${f.falta ? 'Faltam p/ meta' : 'Folga na meta'} · ${esc(P.rotulo(mesAberto, true))}</div><div class="v">${fmtInt(f.falta || f.folga)}</div><div class="s">${f.falta ? 'atend. em até 5 min' : 'atend. podem passar de 5 min'} · NS ${fmtPct(f.ns)}</div></div>` : ''}
        <div class="kpi"><div class="l">Dias na meta</div><div class="v">${items.filter(d => d.ns >= d.meta).length}/${items.length}</div><div class="s">últimos ${items.length} dias</div></div>
        <div class="kpi wide"><div class="l">Volume do dia</div><div class="v">${fmtInt(cur.volume)}</div><div class="s">${fmtInt(cur.total)} atendidas (${fmtPct(cur.total / cur.volume)})${dVol == null ? '' : ' · ' + pc(dVol) + ' vs dia anterior'}</div></div>`;
    } else {
      const f = metaFalta(cur.total, cur.ate, meta);
      const vd = r => r.volume / r.dias;
      const dVol = prev ? vd(cur) / vd(prev) - 1 : null;
      const ab = t === 'MES' ? 'mês aberto' : 'semana aberta', fe = t === 'MES' ? 'fechado' : 'fechada';
      k = `
        <div class="kpi wide"><div class="l">${esc(nomeCur(cur))} ${cur.completo ? `<span class="fechado">${fe}</span>` : `<span class="aberto">${ab}</span>`}</div>
          <div class="v">${fmtPct(cur.ns)}</div>
          <div class="s"><span class="pill ${cur.status}">${cur.status}</span> meta ${fmtPct(meta)} · <b class="dias">${diasTxt(cur)}</b></div></div>
        <div class="kpi"><div class="l">${f.falta ? 'Faltam p/ meta' : 'Folga na meta'}</div><div class="v">${fmtInt(f.falta || f.folga)}</div><div class="s">${f.falta ? 'atend. em até 5 min' : 'atend. podem passar de 5 min'}${cur.completo ? '' : ` · com ${cur.dias} dias`}</div></div>
        <div class="kpi"><div class="l">vs ${prev ? esc(P.rotulo(prev, true).replace('*', '')) : 'anterior'}</div><div class="v">${dPP == null ? '—' : pp(dPP)}</div><div class="s">NS ${prev ? fmtPct(prev.ns) : '—'}</div></div>
        <div class="kpi wide"><div class="l">Volume médio por dia</div><div class="v">${fmtInt(vd(cur))}</div>
          <div class="s">${fmtInt(cur.volume)} em ${diasTxt(cur)}${dVol == null ? '' : ` · ${pc(dVol)} vs ${esc(P.rotulo(prev, true).replace('*', ''))}`}</div></div>`;
    }
    const tituloNS = t === 'DIA' ? 'NS por dia' : t === 'SEMANA' ? 'NS por semana' : 'NS por mês';
    const legNS = `<div class="legend"><span><i style="background:var(--verde)"></i>≥ meta</span><span><i style="background:var(--amarelo)"></i>≥ 70%</span><span><i style="background:var(--vermelho)"></i>&lt; 70%</span>${t === 'DIA' ? '<span><i class="ln" style="border-color:var(--azul)"></i>acumulado do mês</span>' : `<span><i style="background:repeating-linear-gradient(45deg,var(--p300) 0 3px,transparent 3px 6px)"></i>${t === 'MES' ? 'mês aberto' : 'semana aberta'}</span>`}<span><i class="ln dash"></i>meta</span></div>`;
    const cab = t === 'DIA' ? 'DIA' : t === 'SEMANA' ? 'SEMANA' : 'MÊS';
    return `
      <div class="kpis">${k}</div>
      <div style="height:12px"></div>
      <div class="card chart"><h2>${tituloNS}</h2>${chartNs(items, t)}${legNS}
        <div class="cap" id="cap1">${t === 'DIA' ? 'Toque numa barra para ver o dia.' : 'Abaixo de cada barra: QUANTIDADE_DIAS. Toque para detalhes.'}</div></div>
      <div class="card chart"><h2>${t === 'DIA' ? 'Volume e atendimento por dia' : 'Volume médio por dia'}</h2>${chartVol(items, t)}
        <div class="legend"><span><i style="background:var(--bar1)"></i>volume${t === 'DIA' ? '' : '/dia'}</span><span><i style="background:var(--bar2)"></i>atendidas${t === 'DIA' ? '' : '/dia'}</span><span><i style="background:var(--bar3)"></i>até 5 min${t === 'DIA' ? '' : '/dia'}</span></div>
        <div class="cap" id="cap2">${t === 'DIA' ? 'Toque numa barra para ver o dia.' : 'Dividido pela QUANTIDADE_DIAS, para comparar o período aberto com os fechados.'}</div></div>
      <div class="card"><h2>${t === 'DIA' ? 'Dias' : t === 'SEMANA' ? 'Semanas' : 'Meses'}</h2><div style="overflow-x:auto"><table class="conf" style="cursor:default">
        <thead><tr><th>${cab}</th>${t === 'DIA' ? '' : '<th>DIAS</th>'}<th>VOLUME</th><th>ATEND.</th><th>≤5MIN</th><th>NS</th></tr></thead><tbody>
        ${[...items].reverse().map(r => `<tr style="cursor:default"><td>${esc(P.rotulo(r, t !== 'DIA'))}</td>${t === 'DIA' ? '' : `<td class="${r.completo ? '' : 'dias-aberto'}">${r.completo ? r.dias : r.dias + '/' + r.diasPeriodo}</td>`}
          <td>${fmtInt(r.volume)}</td><td>${fmtInt(r.total)}</td><td>${fmtInt(r.ate)}</td><td><span class="pill ${r.status}">${fmtPct(r.ns)}</span></td></tr>`).join('')}</tbody></table></div>
        ${t === 'DIA' ? '' : `<div class="small muted" style="margin-top:6px">${t === 'MES' ? 'Mês aberto' : 'Semana aberta'}: DIAS mostra dias até agora / dias do período; os totais cobrem só esses dias.</div>`}</div>`;
  }

  // ---------------- Gráficos (SVG) ----------------
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const corStatus = s => s === 'VERDE' ? css('--verde') : s === 'AMARELO' ? css('--amarelo') : css('--vermelho');
  function xLabels(items, t, L, bw, H) {
    const step = Math.ceil(items.length / (t === 'DIA' ? 14 : 12));
    return items.map((d, i) => {
      const cx = L + i * bw + bw / 2;
      if (t === 'DIA') return i % step === 0 || i === items.length - 1 ? `<text x="${cx}" y="${H - 8}" font-size="10" text-anchor="middle" fill="${css('--ink2')}">${P.rotulo(d, true)}</text>` : '';
      return `<text x="${cx}" y="${H - 22}" font-size="${items.length > 8 ? 9 : 10.5}" font-weight="600" text-anchor="middle" fill="${css('--ink2')}">${P.rotulo(d, true)}</text>
        <text x="${cx}" y="${H - 8}" font-size="9.5" text-anchor="middle" fill="${d.completo ? css('--ink3') : css('--user')}" font-weight="${d.completo ? 400 : 700}">${d.dias}d</text>`;
    }).join('');
  }
  function chartNs(items, t) {
    const mensal = t !== 'DIA';
    const W = 360, H = mensal ? 214 : 210, L = 30, R = 8, T = 18, B = mensal ? 40 : 26, iw = W - L - R, ih = H - T - B;
    const meta = items[items.length - 1].meta || 0.8;
    const vals = items.map(d => d.ns ?? 0);
    // acumulado do mês (dias): reinicia quando muda o mês
    let acc = 0, accT = 0, mes = null;
    const cum = t === 'DIA' ? items.map(d => { const m = d.inicio.slice(0, 7); if (m !== mes) { mes = m; acc = 0; accT = 0; } acc += d.ate; accT += d.total; return accT ? acc / accT : null; }) : [];
    const lo = Math.max(0, Math.floor((Math.min(...vals, ...cum.filter(v => v != null), meta) - 0.05) * 10) / 10), hi = 1;
    const y = v => T + ih - (v - lo) / (hi - lo) * ih;
    const bw = iw / items.length, gap = mensal ? Math.min(16, bw * 0.3) : Math.min(6, bw * 0.25);
    let g = '';
    for (let v = lo; v <= hi + 1e-9; v += 0.1) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${css('--line')}"/><text x="${L - 4}" y="${y(v) + 4}" font-size="10" text-anchor="end" fill="${css('--ink3')}">${Math.round(v * 100)}</text>`;
    const bars = items.map((d, i) => {
      const x = L + i * bw + gap / 2, w = bw - gap, h = Math.max(1, y(lo) - y(d.ns ?? lo));
      const hatch = !d.completo ? `<rect x="${x}" y="${y(d.ns ?? lo)}" width="${w}" height="${h}" rx="3" fill="url(#hatch)"/>` : '';
      return `<rect x="${x}" y="${y(d.ns ?? lo)}" width="${w}" height="${h}" rx="${mensal ? 3 : 2}" fill="${corStatus(d.status)}"/>${hatch}`;
    }).join('');
    const vl = items.length <= 12 ? items.map((d, i) => d.ns == null ? '' : `<text x="${L + i * bw + bw / 2}" y="${y(d.ns) - 5}" font-size="${items.length > 8 ? 9 : 10.5}" font-weight="700" text-anchor="middle" fill="${css('--ink')}">${(d.ns * 100).toFixed(t === 'DIA' && items.length > 8 ? 0 : 1).replace('.', ',')}</text>`).join('') : '';
    const line = cum.length ? `<path d="${cum.map((v, i) => `${i && items[i].inicio.slice(0, 7) === items[i - 1].inicio.slice(0, 7) ? 'L' : 'M'}${(L + i * bw + bw / 2).toFixed(1)},${y(v).toFixed(1)}`).join('')}" fill="none" stroke="${css('--azul')}" stroke-width="2.2"/>
      ${cum.map((v, i) => `<circle cx="${L + i * bw + bw / 2}" cy="${y(v)}" r="2.6" fill="${css('--azul')}"/>`).join('')}` : '';
    const hits = items.map((d, i) => `<rect data-i="${i}" x="${L + i * bw}" y="${T}" width="${bw}" height="${ih + B}" fill="transparent"/>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" id="ch1" role="img" aria-label="NS">
      <defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="#fff" fill-opacity=".45"/></pattern></defs>
      ${g}${bars}<line x1="${L}" x2="${W - R}" y1="${y(meta)}" y2="${y(meta)}" stroke="${css('--ink2')}" stroke-dasharray="4 3" stroke-width="1.5"/>
      ${line}${t === 'DIA' && cum.length ? '' : vl}${xLabels(items, t, L, bw, H)}${hits}</svg>`;
  }
  function chartVol(items, t) {
    const mensal = t !== 'DIA';
    const W = 360, H = mensal ? 214 : 200, L = 38, R = 8, T = 10, B = mensal ? 40 : 26, iw = W - L - R, ih = H - T - B;
    const k = d => mensal ? 1 / (d.dias || 1) : 1;
    const max = Math.max(...items.map(d => d.volume * k(d))) * 1.05 || 1;
    const nice = Math.pow(10, Math.floor(Math.log10(max))); const stepV = max / nice > 5 ? nice * 2 : max / nice > 2 ? nice : nice / 2;
    const y = v => T + ih - v / max * ih;
    const bw = iw / items.length, gap = mensal ? Math.min(16, bw * 0.3) : Math.min(6, bw * 0.25);
    let g = '';
    for (let v = 0; v <= max; v += stepV) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${css('--line')}"/><text x="${L - 4}" y="${y(v) + 4}" font-size="10" text-anchor="end" fill="${css('--ink3')}">${v >= 1000 ? (v / 1000).toLocaleString('pt-BR') + 'k' : Math.round(v)}</text>`;
    const bars = items.map((d, i) => { const x = L + i * bw + gap / 2, w = bw - gap, f = k(d);
      return `<rect x="${x}" y="${y(d.volume * f)}" width="${w}" height="${y(0) - y(d.volume * f)}" rx="2" fill="${css('--bar1')}"/>
        <rect x="${x + w * 0.15}" y="${y(d.total * f)}" width="${w * 0.7}" height="${y(0) - y(d.total * f)}" rx="1.5" fill="${css('--bar2')}"/>
        <rect x="${x + w * 0.3}" y="${y(d.ate * f)}" width="${w * 0.4}" height="${y(0) - y(d.ate * f)}" rx="1" fill="${css('--bar3')}"/>`; }).join('');
    const hits = items.map((d, i) => `<rect data-i="${i}" x="${L + i * bw}" y="${T}" width="${bw}" height="${ih + B}" fill="transparent"/>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" id="ch2" role="img" aria-label="Volume">${g}${bars}${xLabels(items, t, L, bw, H)}${hits}</svg>`;
  }
  function bindTaps(items) {
    const info = d => {
      const ex = d.extras && Object.keys(d.extras).length ? ' · ' + Object.entries(d.extras).map(([c, v]) => `${c} ${typeof v === 'number' ? String(v).replace('.', ',') : v}`).join(' · ') : '';
      const base = `${P.rotulo(d)}${d.tipo === 'DIA' ? '' : ` (${diasTxt(d)})`} — NS ${fmtPct(d.ns)} · ${fmtInt(d.ate)} de ${fmtInt(d.total)} em até 5 min · volume ${fmtInt(d.volume)}`;
      return base + (d.tipo === 'DIA' ? '' : ` (${fmtInt(d.volume / d.dias)}/dia)`) + ex;
    };
    [['#ch1', '#cap1'], ['#ch2', '#cap2']].forEach(([s, c]) => {
      const el = $(s); if (!el) return;
      el.addEventListener('click', e => { const t = e.target.closest('[data-i]'); if (t) { const cp = $(c); if (cp) cp.textContent = info(items[+t.dataset.i]); } });
    });
  }

  // ---------------- Histórico ----------------
  function renderHist() {
    main.innerHTML = `
      <div class="card"><h2>Arquivos recebidos (${snaps.length})</h2>
        ${snaps.length ? `<div class="list">${snaps.map(s => `<div class="it" data-id="${s.id}">
            <div class="t"><b>Dados até ${fmtData(s.dataRef)}</b> <span class="origem ${s.origem}">${s.origem}</span>
            <div class="small muted">${s.rows.length} linhas · recebido ${fmtDT(s.id)}${s.colunasExtras && s.colunasExtras.length ? ' · +' + s.colunasExtras.length + ' coluna(s)' : ''}</div></div>›</div>`).join('')}</div>`
        : '<div class="empty">Nada salvo ainda.</div>'}
        <div class="small muted" style="margin-top:8px">O painel usa, para cada período, o valor do arquivo com dados mais recentes. Arquivos antigos ficam como histórico.</div>
      </div>
      <div class="card"><h2>Backup</h2>
        <div class="small muted" style="margin-bottom:10px">Os dados ficam neste aparelho. Exporte de vez em quando.</div>
        <div class="row"><button class="btn sec" id="bExp">Exportar</button><button class="btn sec" id="bImp">Importar backup</button></div>
        <div class="small muted" id="persist" style="margin-top:10px"></div>
      </div>`;
    main.querySelectorAll('.it').forEach(it => it.onclick = () => abrirSnap(+it.dataset.id));
    $('#bExp').onclick = exportar;
    $('#bImp').onclick = () => $('#fileImp').click();
    if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(p => {
      const el = $('#persist'); if (el) el.textContent = p ? 'Armazenamento protegido contra limpeza automática ✓' : 'O navegador pode limpar os dados se faltar espaço — mantenha backup.';
    });
  }
  function abrirSnap(id) {
    const s = snaps.find(x => x.id === id); if (!s) return;
    const bg = document.createElement('div'); bg.className = 'sheet-bg';
    bg.innerHTML = `<div class="sheet"><h3>Dados até ${fmtData(s.dataRef)}</h3>
      <div class="small muted">${esc(s.arquivo)} · ${s.origem} · recebido ${fmtDT(s.id)}${s.mudancasAceitas && s.mudancasAceitas.length ? ` · ${s.mudancasAceitas.length} alteração(ões) em período fechado confirmada(s)` : ''}</div>
      <table class="conf" style="cursor:default;margin-top:8px"><thead><tr><th>PERÍODO</th><th>DIAS</th><th>VOLUME</th><th>ATEND.</th><th>≤5MIN</th><th>NS</th></tr></thead><tbody>
      ${s.rows.map(r => `<tr style="cursor:default"><td>${esc(P.rotulo(r, r.tipo === 'SEMANA'))}</td><td>${r.completo ? r.dias : r.dias + '/' + r.diasPeriodo}</td><td>${r.volume}</td><td>${r.total}</td><td>${r.ate}</td><td>${fmtNs(r.ns)}</td></tr>`).join('')}
      </tbody></table>
      <div class="row" style="margin-top:12px"><button class="btn sec" id="cClose">Fechar</button><button class="btn danger" id="cDel">Excluir</button></div></div>`;
    document.body.appendChild(bg);
    bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });
    bg.querySelector('#cClose').onclick = () => bg.remove();
    bg.querySelector('#cDel').onclick = async () => {
      if (!window.confirm('Excluir este arquivo do histórico? O painel passa a usar os outros arquivos salvos.')) return;
      try { await dbDel(id); await reload(); bg.remove(); toast('Excluído'); renderHist(); }
      catch (e) { alert('Erro ao excluir: ' + e.message); }
    };
  }
  function exportar() {
    const data = { app: 'ns-painel', versao: APP_VERSION, exportadoEm: new Date().toISOString(), snapshots: snaps };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `ns-painel-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  $('#fileImp').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || data.app !== 'ns-painel' || !Array.isArray(data.snapshots)) throw new Error('Arquivo não é um backup do NS Painel.');
      const valid = data.snapshots.filter(s => Number.isInteger(s.id) && Array.isArray(s.rows) && s.rows.length && s.rows.every(r =>
        /^[123]\d{8}$/.test(r.ordem) && [r.volume, r.total, r.ate, r.dias].every(Number.isInteger) && r.ate <= r.total && r.total <= r.volume));
      if (valid.length !== data.snapshots.length && !window.confirm(`${data.snapshots.length - valid.length} item(ns) do backup estão inválidos e serão ignorados. Continuar?`)) return;
      const ids = new Set(snaps.map(s => s.id)), hs = new Set(snaps.map(s => s.hash));
      const novos = valid.filter(s => !ids.has(s.id) && !hs.has(s.hash));
      for (const s of novos) await salvarSnapshot(s);
      await reload();
      toast(`Importados ${novos.length} arquivo(s)` + (valid.length - novos.length ? ` · ${valid.length - novos.length} já existiam` : ''));
      renderHist();
    } catch (err) { alert('Não consegui importar o backup: ' + err.message); }
  });

  // ---------------- Início ----------------
  window.addEventListener('beforeunload', e => { if (preview) { e.preventDefault(); e.returnValue = ''; } });
  (async () => {
    try { await reload(); } catch (e) { main.innerHTML = `<div class="card"><div class="banner bad">Erro ao abrir os dados: ${esc(e.message)}</div></div>`; return; }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    go(snaps.length ? 'painel' : 'dados');
    buscarPublicado(false);
  })();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  window.__ns = { version: APP_VERSION, state: () => ({ snaps, preview, view, modo, pubStatus }), reload, buscarPublicado };
})();
