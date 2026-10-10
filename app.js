/* NS Painel — app (v2: dados por TXT) */
(function () {
  'use strict';
  const APP_VERSION = '3.4.0';
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
  // O painel mostra SOMENTE o TXT mais recente (snaps[0]), exatamente como ele está:
  // nada de completar com períodos de arquivos anteriores (eles ficam só no Histórico).
  // Meta definida pela coordenação: 90% (o META_NS do arquivo é ignorado). Situação recalculada:
  // Meta atingida ≥ 90% · Em atenção ≥ 70% · Crítico < 70%
  const META = 0.9;
  // situação pelo NS exibido (89,96% aparece 90,0% → Meta atingida, distância 0,0)
  const situacao = ns => { if (ns == null) return null; const v = Math.round(ns * 1000 + 1e-9) / 10; return v >= META * 100 ? 'VERDE' : v >= 70 ? 'AMARELO' : 'VERMELHO'; };
  function periodos() {
    const map = new Map();
    const atual = snaps[0];
    if (!atual) return map;
    // NS exato (ATE_5_MIN ÷ TOTAL_ATENDIDAS) para exibir e comparar: evita arredondar duas vezes
    // (ex.: 1.802 ÷ 2.414 = 74,648% → 74,6%; pelo NS de 4 casas 0,7465 sairia 74,7%)
    for (const r of atual.rows) { const ns = r.total > 0 ? r.ate / r.total : null; map.set(r.ordem, { ...r, ns, meta: META, status: situacao(ns) }); }
    return map;
  }

  // ---------------- Utilidades ----------------
  const fmtInt = v => v == null ? '—' : Math.round(v).toLocaleString('pt-BR');
  const fmtNs = v => v == null ? '—' : String(+v.toFixed(4)).replace('.', ',');
  // percentual com 1 casa, arredondamento correto (sem erro de ponto flutuante)
  const p1 = v => (Math.round(v * 1000 + 1e-9) / 10).toFixed(1).replace('.', ',');
  // NS como aparece na tela (1 casa); diferenças em p.p. usam este valor para bater com a conta de quem lê (90 − 74,6 = 15,4)
  const nsP = v => Math.round(v * 1000 + 1e-9) / 10;
  const difPP = (a, b) => Math.round((nsP(a) - nsP(b)) * 10) / 10;
  const fmtPct = v => v == null ? '—' : p1(v) + '%';
  const fmtDT = ts => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  const fmtData = isoD => isoD ? isoD.slice(8, 10) + '/' + isoD.slice(5, 7) + '/' + isoD.slice(2, 4) : '—';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const NOME = { DIA: 'Dia', SEMANA: 'Semana', MES: 'Mês' };
  const STATUS = { VERDE: 'Meta atingida', AMARELO: 'Em atenção', VERMELHO: 'Crítico' };
  const stNome = s => STATUS[s] || s || '';
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
    if (v !== 'painel' || view !== 'painel') sel = null; // seleção vale só enquanto se está no painel
    view = v;
    document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    render(); window.scrollTo(0, 0);
  }
  function render() {
    main.classList.toggle('modo-painel', view === 'painel');
    $('#bShare').hidden = !(view === 'painel' && snaps.length);
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
        <thead><tr><th>PERÍODO</th><th>DIAS</th><th>RECEBIDAS</th><th>NS</th></tr></thead><tbody>
        ${rs.map(r => `<tr style="cursor:default"><td>${esc(P.rotulo(r))}</td><td class="${r.completo ? '' : 'dias-aberto'}">${r.tipo === 'DIA' ? '1' : r.completo ? r.dias : r.dias + '/' + r.diasPeriodo}</td>
          <td>${fmtInt(r.volume)}</td><td><span class="pill ${situacao(r.total > 0 ? r.ate / r.total : null)}">${fmtPct(r.total > 0 ? r.ate / r.total : null)}</span></td></tr>`).join('')}
        </tbody></table></div>`;
    };
    main.innerHTML = `
      <div class="card"><h2>Conferir importação</h2>
        <div class="small muted">${esc(preview.arquivo)} · ${esc(pr.formato || '?')}${preview.encoding ? ' · ' + preview.encoding : ''}</div>
        ${pr.rows.length ? `<div class="chips"><span class="chip">${pr.resumo.MES} meses</span><span class="chip">${pr.resumo.SEMANA} semanas</span><span class="chip">${pr.resumo.DIA} dias</span><span class="chip">dados até ${fmtData(pr.dataRef)}</span></div>` : ''}
        ${pr.erros.length ? `<div class="banner bad" style="margin-top:8px"><b>${pr.erros.length} erro(s) — corrija o arquivo e importe de novo.</b> Nada foi salvo.</div><ul class="list-msg err">${pr.erros.map(msgLi).join('')}</ul>` : ''}
        ${dup ? `<div class="banner info" style="margin-top:8px">Este arquivo já foi importado em ${fmtDT(dup.id)} — não há nada novo para salvar.</div>` : ''}
        ${!pr.erros.length && !dup ? `<div class="banner ok" style="margin-top:8px"><b>Arquivo conferido.</b> ${pr.rows.length} linhas válidas, NS conferido em todas${pr.info.length ? ' · ' + esc(pr.info.join(' ')) : '.'}</div>` : ''}
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
  // Seleção: tocar numa coluna (gráficos) ou linha (tabela) seleciona o período; os cards
  // passam a mostrar esse período comparado ao anterior. Tocar de novo no selecionado limpa
  // a seleção e os cards voltam ao último período.
  let sel = null; // ORDEM do período selecionado no modo atual
  const ORDEM_MODOS = ['DIA', 'SEMANA', 'MES'];
  let modosDisp = ORDEM_MODOS.slice();
  const semAnim = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // troca de modo com efeito de "passar página"; dir = +1 (veio da direita) / -1 (veio da esquerda)
  function setModo(m, dir) {
    if (dir == null) dir = Math.sign(ORDEM_MODOS.indexOf(m) - ORDEM_MODOS.indexOf(modo)) || 1;
    modo = m; sel = null;
    try { localStorage.setItem('ns-modo', m); } catch (e) {}
    const y = window.scrollY;
    renderPainel();
    window.scrollTo(0, y);
    const pag = $('#pag');
    if (!pag || semAnim()) return;
    pag.style.transition = 'none';
    pag.style.transform = `translateX(${dir * 38}%)`;
    pag.style.opacity = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      pag.style.transition = 'transform .24s cubic-bezier(.2,.8,.2,1), opacity .24s';
      pag.style.transform = ''; pag.style.opacity = '';
    }));
  }
  function dicaArrastar() {
    try { if (localStorage.getItem('ns-dica-arrastar')) return; localStorage.setItem('ns-dica-arrastar', '1'); } catch (e) { return; }
    if (modosDisp.length > 1) setTimeout(() => toast('Dica: arraste para o lado para trocar entre Dia, Semana e Mês', 4000), 600);
  }
  // modo vizinho disponível (step +1 = próximo, -1 = anterior), ou null
  function vizinho(step) {
    const i = ORDEM_MODOS.indexOf(modo);
    for (let k = i + step; k >= 0 && k < ORDEM_MODOS.length; k += step) if (modosDisp.includes(ORDEM_MODOS[k])) return ORDEM_MODOS[k];
    return null;
  }
  // arrastar para o lado em qualquer ponto do painel troca Dia ⇄ Semana ⇄ Mês
  (function gestoArrastar() {
    let st = null, acabouDeArrastar = false;
    main.addEventListener('pointerdown', e => {
      if (view !== 'painel' || e.pointerType === 'mouse' || !e.isPrimary || document.querySelector('.sheet-bg')) return;
      const pag = $('#pag'); if (!pag) return;
      st = { x: e.clientX, y: e.clientY, id: e.pointerId, dir: null, dx: 0, pag };
    });
    main.addEventListener('pointermove', e => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!st.dir) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        st.dir = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'h' : 'v';
        if (st.dir === 'h') st.pag.style.transition = 'none';
      }
      if (st.dir !== 'h') return;
      st.dx = dx;
      const alvo = vizinho(dx < 0 ? 1 : -1);
      const mov = alvo ? dx : dx * 0.22; // sem vizinho: só um "elástico"
      st.pag.style.transform = `translateX(${mov}px)`;
      st.pag.style.opacity = String(1 - Math.min(0.45, Math.abs(mov) / 700));
    });
    const fim = e => {
      if (!st || e.pointerId !== st.id) return;
      const s = st; st = null;
      if (s.dir !== 'h') return;
      acabouDeArrastar = true; setTimeout(() => { acabouDeArrastar = false; }, 350);
      const W = main.clientWidth, step = s.dx < 0 ? 1 : -1, alvo = vizinho(step);
      if (alvo && Math.abs(s.dx) > Math.min(70, W * 0.18)) {
        if (semAnim()) { setModo(alvo, step); return; }
        s.pag.style.transition = 'transform .14s ease-in, opacity .14s';
        s.pag.style.transform = `translateX(${-step * W * 0.6}px)`;
        s.pag.style.opacity = '0';
        setTimeout(() => setModo(alvo, step), 140);
      } else {
        s.pag.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1), opacity .22s';
        s.pag.style.transform = ''; s.pag.style.opacity = '';
      }
    };
    main.addEventListener('pointerup', fim);
    main.addEventListener('pointercancel', fim);
    // depois de arrastar, o "clique" que o navegador gera não deve selecionar coluna
    main.addEventListener('click', e => { if (acabouDeArrastar) { e.stopPropagation(); e.preventDefault(); } }, true);
  })();
  function toggleSel(ordem) {
    const y = window.scrollY;
    sel = sel === ordem ? null : ordem;
    renderPainel();
    window.scrollTo(0, y);
  }
  const LIMITE = { DIA: 14, SEMANA: 12, MES: 12 };
  // card 4: qual período está na tela e se ele está completo
  const DIAS_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const MESES_NOME = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const tituloPeriodo = (t, s) => t === 'DIA' ? (s ? 'Dia selecionado' : 'Último dia') : t === 'SEMANA' ? (s ? 'Semana selecionada' : 'Última semana') : (s ? 'Mês selecionado' : 'Último mês');
  function valorPeriodo(r) {
    const [y, m, d] = r.inicio.split('-').map(Number);
    if (r.tipo === 'DIA') return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${String(y).slice(2)}`;
    if (r.tipo === 'MES') return `${MESES_NOME[m - 1]}/${String(y).slice(2)}`;
    return P.rotulo(r).replace('*', '');
  }
  function situacaoPeriodo(r) {
    if (r.tipo === 'DIA') { const [y, m, d] = r.inicio.split('-').map(Number); return DIAS_SEMANA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; }
    const f = r.tipo === 'MES' ? 'o' : 'a';
    return r.completo ? `complet${f} · ${r.dias} dias` : `<b class="dias">incomplet${f}</b> · ${r.dias} de ${r.diasPeriodo} dias`;
  }
  const diasTxt = r => r.completo ? `${r.dias} dias` : `${r.dias} de ${r.diasPeriodo} dias`;
  // variação com seta: ▲ subiu / ▼ caiu (sem sinal de + ou −)
  const seta = v => Math.abs(v) < 0.05 ? '' : v > 0 ? '▲ ' : '▼ ';
  // NS: verde se melhorou (subiu), vermelho se piorou (caiu)
  // arredonda para 1 casa sem o erro do ponto flutuante (10,35 → 10,4)
  const r1 = v => Math.round(Math.round(v * 100) / 10) / 10;
  function pp(v, status) {
    const a = r1(v);
    const cls = a === 0 ? 'neu' : a > 0 ? 'up' : 'down';
    return `<span class="dlt ${cls}">${seta(a)}${Math.abs(a).toFixed(1).replace('.', ',')} p.p.</span>`;
  }
  // volume: só a seta (mais volume não é bom nem ruim)
  // variação de chamadas recebidas nos cards: subir = vermelho, cair = verde
  const pc = v => { const a = r1(v * 100); return `<span class="dlt ${a === 0 ? 'neu' : a > 0 ? 'down' : 'up'}">${seta(a)}${Math.abs(a).toFixed(1).replace('.', ',')}%</span>`; };
  // células da tabela: ▲ verde quando sobe, ▼ vermelho quando cai
  // inverso = true para chamadas recebidas: receber mais é ruim (vermelho), receber menos é bom (verde)
  const tdVar = (a, suf, inverso) => a == null ? '<td class="tv nd">—</td>'
    : `<td class="tv"><span class="dlt ${a === 0 ? 'neu' : (a > 0) !== !!inverso ? 'up' : 'down'}">${a === 0 ? '' : a > 0 ? '▲' : '▼'}${Math.abs(a).toFixed(1).replace('.', ',')}${suf}</span></td>`;
  function varRecebidas(r, ant) {
    // período aberto (mês/semana) ainda não tem todos os dias: comparar o total seria injusto
    if (!ant || !r.completo || !ant.completo || !(ant.volume > 0)) return null;
    return r1((r.volume / ant.volume - 1) * 100);
  }
  const varNs = (r, ant) => ant && r.ns != null && ant.ns != null ? difPP(r.ns, ant.ns) : null;
  const nomePrev = (t, r) => !r ? 'anterior' : t === 'DIA' ? P.rotulo(r) : P.rotulo(r, true).replace('*', '');
  function detalhe(d) {
    const ex = d.extras && Object.keys(d.extras).length ? ' · ' + Object.entries(d.extras).map(([c, v]) => `${c} ${typeof v === 'number' ? String(v).replace('.', ',') : v}`).join(' · ') : '';
    const base = `${P.rotulo(d)}${d.tipo === 'DIA' ? '' : ` (${diasTxt(d)})`} — NS ${fmtPct(d.ns)} · ${fmtInt(d.volume)} chamadas recebidas`;
    return base + ex;
  }

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
    if (!por(modo).length) { modo = ['DIA', 'SEMANA', 'MES'].find(t => por(t).length); sel = null; }
    const serie = por(modo);
    const items = serie.slice(-LIMITE[modo]);
    if (sel && !items.some(r => r.ordem === sel)) sel = null; // período saiu da janela/dados
    const s0 = snaps[0];
    const selRow = sel ? items.find(r => r.ordem === sel) : null;
    main.innerHTML = `${pubErr}
      <div class="card topbar">
        <div class="seg" role="tablist" aria-label="TIPO_PERIODO">
          ${['DIA', 'SEMANA', 'MES'].map(t => `<button role="tab" data-m="${t}" class="${modo === t ? 'on' : ''}" ${por(t).length ? '' : 'disabled'}>${NOME[t]}</button>`).join('')}
        </div>
        <div class="meta-line" style="margin-top:10px"><span>Dados até <b>${fmtData(s0.dataRef)}</b></span><span>${s0.origem === 'publicado' ? 'publicado' : 'importado'} ${fmtDT(s0.publicadoEm || s0.id)}</span></div>
        ${selRow ? `<button class="selchip" id="bLimpar" aria-label="Limpar seleção"><span class="t">Selecionado: <b>${esc(P.rotulo(selRow))}</b> · toque para limpar</span><span aria-hidden="true">✕</span></button>` : ''}
      </div>
      <div id="pag">${painelTipo(modo, items, serie, all)}</div>`;
    modosDisp = ORDEM_MODOS.filter(t => por(t).length);
    dicaArrastar();
    main.querySelectorAll('.seg button').forEach(b => b.onclick = () => { if (b.dataset.m !== modo) setModo(b.dataset.m); });
    if ($('#bLimpar')) $('#bLimpar').onclick = () => toggleSel(sel);
    bindTaps(items);
  }

  function painelTipo(t, items, serie, all) {
    const selRow = sel ? items.find(r => r.ordem === sel) : null;
    const cur = selRow || items[items.length - 1];
    const ic = serie.indexOf(cur);
    const prev = ic > 0 ? serie[ic - 1] : null;
    const meta = META;
    const dPP = prev && cur.ns != null && prev.ns != null ? difPP(cur.ns, prev.ns) : null;
    const kc = selRow ? 'kpi ksel' : 'kpi';
    // 4 cards no mesmo padrão: título · valor · comparação com o período anterior
    // 1) NS  2) Chamadas recebidas (total do período, sem média)  3) Distância da meta + situação  4) Período
    const vsPrev = prev ? ` vs ${esc(nomePrev(t, prev))}` : '';
    const dVol = varRecebidas(cur, prev);
    const sVol = !prev ? 'sem período anterior' : dVol == null ? '<span class="parc">parcial</span> · sem variação' : `${pc(dVol / 100)}${vsPrev}`;
    const sNs = dPP == null ? 'sem período anterior' : `${pp(dPP)}${vsPrev}`;
    const dMeta = cur.ns == null ? null : difPP(cur.ns, META);
    const k = `
        <div class="${kc} kns"><div class="l">NS 5 min</div><div class="v">${fmtPct(cur.ns)}</div><div class="s">${sNs}</div></div>
        <div class="${kc} kvol"><div class="l">Chamadas recebidas</div><div class="v">${fmtInt(cur.volume)}</div><div class="s">${sVol}</div></div>
        <div class="${kc} kdist"><div class="l">Distância da meta</div><div class="v">${dMeta == null ? '—' : pp(dMeta)}</div><div class="s">${cur.status ? `<span class="pill ${cur.status}">${stNome(cur.status)}</span>` : ''}</div></div>
        <div class="${kc} kper"><div class="l">${tituloPeriodo(t, !!selRow)}</div><div class="v">${esc(valorPeriodo(cur))}</div><div class="s">${situacaoPeriodo(cur)}</div></div>`;
    const tituloNS = t === 'DIA' ? 'NS por dia' : t === 'SEMANA' ? 'NS por semana' : 'NS por mês';
    const legNS = `<div class="legend"><span><i style="background:var(--verdeS)"></i>Meta atingida</span><span><i style="background:var(--amareloS)"></i>Em atenção</span><span><i style="background:var(--vermelhoS)"></i>Crítico</span>${t === 'DIA' ? '' : `<span><i style="background:repeating-linear-gradient(45deg,var(--p300) 0 3px,transparent 3px 6px)"></i>${t === 'MES' ? 'mês aberto' : 'semana aberta'}</span>`}<span><i class="ln dash"></i>meta ${fmtPct(META).replace(',0', '')}</span></div>`;
    const cab = t === 'DIA' ? 'DIA' : t === 'SEMANA' ? 'SEMANA' : 'MÊS';
    const dica = 'Toque numa coluna para selecionar · toque de novo para limpar.';
    const cap = selRow ? esc(detalhe(selRow)) : dica;
    return `
      <div class="kpis">${k}</div>
      <div style="height:12px"></div>
      <div class="card chart"><h2>${t === 'DIA' ? 'Chamadas recebidas e NS por dia' : t === 'SEMANA' ? 'Chamadas recebidas e NS por semana' : 'Chamadas recebidas e NS por mês'}</h2>${chartVol(items, t)}
        <div class="legend"><span><i style="background:var(--barR)"></i>chamadas recebidas</span><span><i class="ln mk" style="border-color:var(--laranjaL)"></i>NS 5 min (eixo à direita)</span></div>
        <div class="cap${selRow ? ' capsel' : ''}" id="cap2">${selRow ? cap : (t === 'DIA' ? dica : `Hachurado = ${t === 'MES' ? 'mês' : 'semana'} em aberto (total parcial). ` + dica)}</div></div>
      <div class="card chart"><h2>${tituloNS}</h2>${chartNs(items, t)}${legNS}
        <div class="cap${selRow ? ' capsel' : ''}" id="cap1">${cap}</div></div>
      <div class="card"><h2>${t === 'DIA' ? 'Dias' : t === 'SEMANA' ? 'Semanas' : 'Meses'}</h2><div style="overflow-x:auto"><table class="conf tsel">
        <thead><tr><th>${cab}</th>${t === 'DIA' ? '' : '<th>DIAS</th>'}<th>RECEB.</th><th>VAR.</th><th>NS</th><th>VAR. NS</th></tr></thead><tbody>
        ${[...items].reverse().map(r => { const ant = serie[serie.indexOf(r) - 1]; return `<tr data-ordem="${r.ordem}" class="${r.ordem === sel ? 'sel' : ''}" aria-selected="${r.ordem === sel}"><td>${esc(P.rotulo(r, t !== 'DIA'))}</td>${t === 'DIA' ? '' : `<td class="${r.completo ? '' : 'dias-aberto'}">${r.completo ? r.dias : r.dias + '/' + r.diasPeriodo}</td>`}
          <td>${fmtInt(r.volume)}</td>${tdVar(varRecebidas(r, ant), '%', true)}<td><span class="pill ${r.status}">${fmtPct(r.ns)}</span></td>${tdVar(varNs(r, ant), '')}</tr>`; }).join('')}</tbody></table></div>
        <div class="small muted" style="margin-top:6px">VAR. = variação de chamadas recebidas (%) · VAR. NS = variação do NS (p.p.), sempre contra ${t === 'DIA' ? 'o dia anterior' : t === 'SEMANA' ? 'a semana anterior' : 'o mês anterior'}.${t === 'DIA' ? '' : ` ${t === 'MES' ? 'Mês aberto' : 'Semana aberta'}: DIAS mostra dias até agora / dias do período; a variação de chamadas só aparece com o período fechado.`}</div></div>`;
  }

  // ---------------- Gráficos (SVG) ----------------
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const corStatus = s => s === 'VERDE' ? css('--verdeS') : s === 'AMARELO' ? css('--amareloS') : css('--vermelhoS');
  // rótulo com contorno da cor do card: legível sobre barra, linha ou grade
  const halo = () => `paint-order="stroke" stroke="${css('--card')}" stroke-width="3" stroke-linejoin="round"`;
  function numCurto(v, largo) {
    if (largo) return fmtInt(v);
    if (v >= 1000) return (v / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 'k';
    return String(Math.round(v));
  }
  function faixaSel(items, L, bw, T, h) {
    const i = items.findIndex(r => r.ordem === sel);
    return i < 0 ? '' : `<rect class="selband" x="${L + i * bw + 1}" y="${T - 14}" width="${bw - 2}" height="${h + 14}" rx="6" fill="${css('--selbg')}" stroke="${css('--selln')}" stroke-width="1"/>`;
  }
  const opac = r => sel && r.ordem !== sel ? ' opacity=".42"' : '';
  const SEMANA_ABR = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
  function xLabels(items, t, L, bw, H) {
    const step = Math.ceil(items.length / (t === 'DIA' ? 14 : 12));
    return items.map((d, i) => {
      const cx = L + i * bw + bw / 2, s = d.ordem === sel;
      const cor = s ? css('--selink') : css('--ink2');
      if (t === 'DIA') {
        // dia do mês + dia da semana abreviado (como no calendário); domingo em vermelho
        if (!(i % step === 0 || i === items.length - 1 || s)) return '';
        const [yy, mm, dd] = d.inicio.split('-').map(Number);
        const wd = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay();
        const dom = wd === 0;
        return `<text x="${cx}" y="${H - 22}" font-size="${items.length > 10 ? 9 : 10.5}" font-weight="${s ? 800 : 600}" text-anchor="middle" fill="${dom ? css('--vermelho') : cor}">${P.rotulo(d, true)}</text>
        <text class="wd" x="${cx}" y="${H - 8}" font-size="${items.length > 10 ? 8.5 : 9.5}" font-weight="${dom || s ? 700 : 400}" text-anchor="middle" fill="${dom ? css('--vermelho') : s ? css('--selink') : css('--ink3')}">${SEMANA_ABR[wd]}</text>`;
      }
      return `<text x="${cx}" y="${H - 22}" font-size="${items.length > 8 ? 9 : 10.5}" font-weight="${s ? 800 : 600}" text-anchor="middle" fill="${cor}">${P.rotulo(d, true)}</text>
        <text x="${cx}" y="${H - 8}" font-size="9.5" text-anchor="middle" fill="${s ? css('--selink') : d.completo ? css('--ink3') : css('--user')}" font-weight="${d.completo && !s ? 400 : 700}">${d.dias}d</text>`;
    }).join('');
  }
  // barra com os cantos de cima levemente arredondados (raio 4)
  const RAIO = 4;
  function barra(x, yTop, w, yBase, fill, extra = '') {
    const h = Math.max(0, yBase - yTop); if (h <= 0) return '';
    const r = Math.min(RAIO, w / 2, h);
    return `<path d="M${x},${yBase} V${yTop + r} A${r},${r} 0 0 1 ${x + r},${yTop} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${yTop + r} V${yBase} Z" fill="${fill}" ${extra}/>`;
  }
  const largura = bw => Math.max(8, Math.min(28, bw * 0.56));
  function chartNs(items, t) {
    const mensal = t !== 'DIA';
    const W = 360, H = 220, L = 22, R = 6, T = 24, B = 40, iw = W - L - R, ih = H - T - B;
    const meta = META;
    const vals = items.map(d => d.ns ?? 0);
    const lo = Math.max(0, Math.floor((Math.min(...vals, meta) - 0.05) * 10) / 10), hi = 1;
    const y = v => T + ih - (v - lo) / (hi - lo) * ih;
    const bw = iw / items.length;
    const w = largura(bw);
    let g = '';
    for (let v = lo; v <= hi + 1e-9; v += 0.1) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${css('--line')}"/><text x="${L - 3}" y="${y(v) + 3}" font-size="7.5" text-anchor="end" fill="${css('--ink3')}">${Math.round(v * 100)}</text>`;
    const bars = items.map((d, i) => {
      const x = L + i * bw + (bw - w) / 2, yt = y(d.ns ?? lo), yb = y(lo);
      return `<g${opac(d)}>${barra(x, yt, w, yb, corStatus(d.status))}${!d.completo ? barra(x, yt, w, yb, 'url(#hatch)') : ''}</g>`;
    }).join('');
    const fs = bw >= 34 ? 10.5 : bw >= 24 ? 9 : 7.5;
    const vl = items.map((d, i) => d.ns == null ? '' : `<text class="vlab" x="${L + i * bw + bw / 2}" y="${y(d.ns) - 5}" font-size="${d.ordem === sel ? fs + 1 : fs}" font-weight="800" text-anchor="middle" fill="${d.ordem === sel ? css('--selink') : css('--ink')}" ${halo()}${opac(d)}>${p1(d.ns)}</text>`).join('');
    const hits = items.map((d, i) => `<rect class="hit" data-i="${i}" x="${L + i * bw}" y="${T - 14}" width="${bw}" height="${ih + B + 14}" fill="transparent"/>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" id="ch1" role="img" aria-label="NS">
      <defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="#fff" fill-opacity=".5"/></pattern></defs>
      ${faixaSel(items, L, bw, T, ih + B)}${g}${bars}<line x1="${L}" x2="${W - R}" y1="${y(meta)}" y2="${y(meta)}" stroke="${css('--ink2')}" stroke-dasharray="4 3" stroke-width="1.5"/>
      ${vl}${xLabels(items, t, L, bw, H)}${hits}</svg>`;
  }
  // Chamadas recebidas (barras com o total, eixo esquerdo) + NS 5 min (linha com marcadores e rótulo, eixo direito)
  function chartVol(items, t) {
    const mensal = t !== 'DIA';
    const W = 360, H = 226, L = 26, R = 24, T = 24, B = 40, iw = W - L - R, ih = H - T - B;
    const k = () => 1; // sempre o total do período (sem média por dia)
    const max = Math.max(...items.map(d => d.volume * k(d))) * 1.02 || 1;
    const nice = Math.pow(10, Math.floor(Math.log10(max))); const stepV = max / nice > 5 ? nice * 2 : max / nice > 2 ? nice : nice / 2;
    const y = v => T + ih - v / max * ih;
    // eixo direito do NS: mesma faixa usada no gráfico de NS
    const meta = META;
    const lo = Math.max(0, Math.floor((Math.min(...items.map(d => d.ns ?? 1), meta) - 0.05) * 10) / 10), hi = 1;
    const yn = v => T + ih - (v - lo) / (hi - lo) * ih;
    const bw = iw / items.length;
    const w = largura(bw);
    const largo = bw >= 40;
    const fs = bw >= 34 ? 9.5 : bw >= 24 ? 8.5 : 7.5;
    let g = '';
    for (let v = 0; v <= max; v += stepV) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${css('--line')}"/><text x="${L - 3}" y="${y(v) + 3}" font-size="7.5" text-anchor="end" fill="${css('--ink3')}">${v >= 1000 ? (v / 1000).toLocaleString('pt-BR') + 'k' : Math.round(v)}</text>`;
    for (let v = lo; v <= hi + 1e-9; v += 0.1) g += `<text class="axr" x="${W - R + 3}" y="${yn(v) + 3}" font-size="7.5" text-anchor="start" fill="${css('--laranjaL')}">${Math.round(v * 100)}%</text>`;
    const bars = items.map((d, i) => {
      const x0 = L + i * bw + (bw - w) / 2, f = k(d), yb = y(0), yt = y(d.volume * f);
      return `<g class="grp"${opac(d)}>${barra(x0, yt, w, yb, css('--barR'), 'class="b-vol"')}${!d.completo ? barra(x0, yt, w, yb, 'url(#hatchV)') : ''}</g>`;
    }).join('');
    const labs = items.map((d, i) => {
      const s2 = d.ordem === sel, f = k(d);
      return `<text class="vlab" x="${L + i * bw + bw / 2}" y="${(y(d.volume * f) - 5).toFixed(1)}" font-size="${s2 ? fs + .5 : fs}" font-weight="700" text-anchor="middle" fill="${s2 ? css('--selink') : css('--ink2')}" ${halo()}${opac(d)}>${numCurto(d.volume * f, largo)}</text>`;
    }).join('');
    const pts = items.map((d, i) => d.ns == null ? null : [L + i * bw + bw / 2, yn(d.ns), d]).filter(Boolean);
    // rótulo do NS: em cima ou embaixo do marcador (ou na diagonal), onde não encavalar
    // com o total de chamadas, com os marcadores, com a linha ou com outro rótulo
    const fsN = bw >= 34 ? 9 : bw >= 24 ? 8.5 : 7.5;
    const corLab = css('--nsLab');
    const curva = amostrasCurva(pts);
    const obst = items.map((d, i) => { const fv = d.ordem === sel ? fs + .5 : fs, x = L + i * bw + bw / 2, yv = y(d.volume) - 5, hwv = numCurto(d.volume, largo).length * fv * 0.3 + 1.5; return [x - hwv, yv - fv * 0.95 - 1.5, x + hwv, yv + fv * 0.25 + 1.5]; })
      .concat(pts.map(p => { const r = (p[2].ordem === sel ? 5 : 3.6) + 1.6; return [p[0] - r, p[1] - r, p[0] + r, p[1] + r]; }));
    const area = [L - 2, 2, W - R + 2, y(0) - 1];
    const sobre = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const rotNs = pts.map(p => {
      const [x, py, d] = p, sl = d.ordem === sel, rr = sl ? 5 : 3.6, f = sl ? fsN + .5 : fsN;
      const txt = p1(d.ns), hw = txt.length * f * 0.3 + 1;
      const cima = py - rr - 2.5 - f * 0.22, baixo = py + rr + 2.5 + f * 0.92, lado = hw + rr + 2.5;
      const cands = [[x, cima, 0], [x, baixo, 0.5], [x - lado, py - f * 0.2, 3], [x + lado, py - f * 0.2, 3], [x - lado, cima, 2], [x + lado, cima, 2], [x - lado, baixo, 2.5], [x + lado, baixo, 2.5]];
      let best = null;
      for (const [cx, b, pref] of cands) {
        const bx = [cx - hw, b - f * 0.92, cx + hw, b + f * 0.22];
        let c = pref;
        for (const o of obst) { const a = sobre(bx, o); if (a > 0) c += 50 + a; }
        if (curva.some(q => q[0] > bx[0] - 1 && q[0] < bx[2] + 1 && q[1] > bx[1] - 1 && q[1] < bx[3] + 1)) c += 20;
        if (bx[0] < area[0] || bx[2] > area[2] || bx[1] < area[1] || bx[3] > area[3]) c += 1000;
        if (!best || c < best.c) best = { c, cx, b, bx };
      }
      obst.push(best.bx);
      return `<text class="nslab" x="${best.cx.toFixed(1)}" y="${best.b.toFixed(1)}" font-size="${f}" font-weight="800" text-anchor="middle" fill="${corLab}">${txt}</text>`;
    });
    const linha = pts.length ? `<path class="nsline" d="${curvaSuave(pts)}" fill="none" stroke="${css('--laranjaL')}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round" opacity="${sel ? .65 : 1}"/>
      ${pts.map((p, j) => `<g class="nsptg"${opac(p[2])}><circle class="nsmk" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${p[2].ordem === sel ? 5 : 3.6}" fill="${css('--card')}" stroke="${css('--laranjaL')}" stroke-width="2.2"/>${rotNs[j]}</g>`).join('')}` : '';
    const hits = items.map((d, i) => `<rect class="hit" data-i="${i}" x="${L + i * bw}" y="${T - 14}" width="${bw}" height="${ih + B + 14}" fill="transparent"/>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" id="ch2" role="img" aria-label="Chamadas recebidas e NS">
      <defs><pattern id="hatchV" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="#fff" fill-opacity=".5"/></pattern></defs>
      ${faixaSel(items, L, bw, T, ih + B)}${g}${bars}${labs}${linha}${xLabels(items, t, L, bw, H)}${hits}</svg>`;
  }
  // curva suave monotônica (Fritsch–Carlson): passa pelos pontos sem "estourar" acima/abaixo deles
  function tangentes(pts) {
    const n = pts.length, dx = [], m = [], t = new Array(n);
    for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], h = a * a + b * b;
      if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    return { dx, t };
  }
  function curvaSuave(pts) {
    const n = pts.length;
    if (n < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    const { dx, t } = tangentes(pts);
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], h3 = dx[i] / 3;
      d += ` C${(x0 + h3).toFixed(1)},${(y0 + t[i] * h3).toFixed(1)} ${(x1 - h3).toFixed(1)},${(y1 - t[i + 1] * h3).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
    }
    return d;
  }
  // pontos ao longo da curva desenhada (para os rótulos não ficarem em cima da linha)
  function amostrasCurva(pts) {
    const n = pts.length, out = [];
    if (n < 2) return pts.map(p => [p[0], p[1]]);
    if (n < 3) { for (let k = 0; k <= 40; k++) { const u = k / 40; out.push([pts[0][0] + (pts[1][0] - pts[0][0]) * u, pts[0][1] + (pts[1][1] - pts[0][1]) * u]); } return out; }
    const { dx, t } = tangentes(pts);
    for (let i = 0; i < n - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], h3 = dx[i] / 3;
      const c1 = [x0 + h3, y0 + t[i] * h3], c2 = [x1 - h3, y1 - t[i + 1] * h3];
      for (let k = 0; k <= 30; k++) {
        const u = k / 30, v = 1 - u;
        out.push([v * v * v * x0 + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * x1, v * v * v * y0 + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * y1]);
      }
    }
    return out;
  }
  function bindTaps(items) {
    ['#ch1', '#ch2'].forEach(s => {
      const el = $(s); if (!el) return;
      el.addEventListener('click', e => { const t = e.target.closest('[data-i]'); if (t) toggleSel(items[+t.dataset.i].ordem); });
    });
    main.querySelectorAll('table.tsel tbody tr').forEach(tr => tr.addEventListener('click', () => toggleSel(tr.dataset.ordem)));
  }

  // ---------------- Compartilhar (WhatsApp) ----------------
  // Imagem do NS por dia + resumo do último dia; o link do app vai no texto da mensagem
  // (o WhatsApp não torna clicável um link desenhado dentro da imagem).
  const APP_URL = 'https://vivo61991-tech.github.io/co_ns_servico/';
  const SEMANA_MIN = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const IMG = { W: 1080, H: 1350 };
  // paleta fixa (clara) para a imagem, independente do modo escuro do aparelho
  const PAL = {
    bg: '#F5F3F8', card: '#FFFFFF', line: '#E6E0EE', ink: '#1F1530', ink2: '#5B5068', ink3: '#9A90A8',
    p800: '#52227A', p700: '#642A90', p500: '#8549B5', p300: '#B48FD3',
    VERDE: '#BCDD83', AMARELO: '#FFC266', VERMELHO: '#F286AF', dom: '#EC357D',
    up: '#5F8A12', down: '#D0256A', selbg: '#FFF4E3', selln: '#FFD9A0',
    pill: { VERDE: ['#EEF7DC', '#5F8A12'], AMARELO: ['#FFF1DC', '#B36800'], VERMELHO: ['#FDE6EF', '#C41A60'] },
  };
  const FONTE = "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

  function dadosCompartilhar() {
    const all = [...periodos().values()].sort((a, b) => a.ordem.localeCompare(b.ordem));
    const dias = all.filter(r => r.tipo === 'DIA');
    if (!dias.length) return null;
    const items = dias.slice(-7);
    const cur = dias[dias.length - 1], prev = dias.length > 1 ? dias[dias.length - 2] : null;
    const wd = r => { const [y, m, d] = r.inicio.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
    const dPP = prev && cur.ns != null && prev.ns != null ? difPP(cur.ns, prev.ns) : null;
    return { items, cur, prev, dPP, wd, meta: META, dataRef: snaps[0] && snaps[0].dataRef };
  }
  const ddmm = r => r.inicio.slice(8, 10) + '/' + r.inicio.slice(5, 7);
  const pct1 = v => p1(v) + '%';
  const ppTxt = v => (v === 0 ? '' : v > 0 ? '▲ ' : '▼ ') + Math.abs(v).toFixed(1).replace('.', ',') + ' p.p.';

  // Mensagem no formato sugerido pela gerência, ampliado com dia, semana e mês (mais recente primeiro).
  // Número = chamadas recebidas (VOLUME) do período, total, sem média. Atendidas não são exibidas
  // (parte das chamadas vai para a parceira e conta como abandonada). NS em negrito. * = parcial.
  const MES_ABR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const MES_EXT = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const Cap = t => t.charAt(0).toUpperCase() + t.slice(1);
  function rotuloMsg(r) {
    const ast = r.completo ? '' : '*';
    const [, m, d] = r.inicio.split('-').map(Number);
    if (r.tipo === 'MES') return Cap(MES_ABR[m - 1]) + ast;
    if (r.tipo === 'DIA') return `${String(d).padStart(2, '0')}/${MES_ABR[m - 1]}`;
    const [, m2, d2] = r.fim.split('-').map(Number);       // semana: 24-30/ago, 31-06/set
    return `${String(d).padStart(2, '0')}-${String(d2).padStart(2, '0')}/${MES_ABR[m2 - 1]}${ast}`;
  }
  // conteúdo da mensagem, independente do formato (WhatsApp / Teams)
  function conteudoMsg() {
    const all = [...periodos().values()].sort((a, b) => a.ordem.localeCompare(b.ordem));
    const por = t => all.filter(r => r.tipo === t && r.ns != null);
    const meses = por('MES').slice(-LIMITE.MES), semanas = por('SEMANA').slice(-LIMITE.SEMANA), dias = por('DIA').slice(-LIMITE.DIA);
    const linha = r => ({ lab: rotuloMsg(r), num: fmtInt(r.volume), ns: pct1(r.ns), status: r.status });
    // ordem: Diário, Semanal, Mensal; em cada bloco, do mais recente (topo) para o mais antigo
    const rec = lista => [...lista].reverse();
    const blocos = [];
    if (dias.length) {
      const ms = [...new Set(rec(dias).map(r => +r.inicio.slice(5, 7)))].map(m => MES_EXT[m - 1]);
      blocos.push({ titulo: `Diário – ${ms.join('/')}`, col: 'Dia', linhas: rec(dias).map(linha) });
    }
    if (semanas.length) blocos.push({ titulo: 'Semanal', col: 'Semana', linhas: rec(semanas).map(linha) });
    if (meses.length) blocos.push({ titulo: 'Mensal', col: 'Mês', linhas: rec(meses).map(linha) });
    return { blocos, parcial: [...meses, ...semanas].some(r => !r.completo) };
  }
  function textoCompartilhar() {
    const c = conteudoMsg();
    const L = ['📊 *Chamadas recebidas x NS (5 min)*'];
    for (const b of c.blocos) {
      const lw = Math.max(...b.linhas.map(x => x.lab.length)), nw = Math.max(...b.linhas.map(x => x.num.length));
      L.push('', `*${b.titulo}*`, ...b.linhas.map(x => `▫️ ${x.lab.padEnd(lw)} → ${x.num.padStart(nw)} | *${x.ns}*`));
    }
    if (c.parcial) L.push('', '* _parcial_');
    L.push('', 'Fonte: ' + APP_URL);   // uma linha só: evita o "Ler mais" do WhatsApp esconder o link
    return L.join('\n');
  }
  // Teams: HTML com uma tabela por bloco (o Teams cola tabelas como tabelas, com negrito e link)
  const COR_TEAMS = { VERDE: '#5F8A12', AMARELO: '#B36800', VERMELHO: '#C41A60' };
  function htmlTeams() {
    const c = conteudoMsg();
    const th = 'style="text-align:left;padding:4px 12px 4px 0;border-bottom:1px solid #D5BFE7;color:#642A90"';
    const thR = 'style="text-align:right;padding:4px 12px 4px 0;border-bottom:1px solid #D5BFE7;color:#642A90"';
    const td = 'style="padding:3px 12px 3px 0"', tdR = 'style="text-align:right;padding:3px 12px 3px 0"';
    let h = '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">';
    h += '<p>📊 <b>Chamadas recebidas x NS (5 min)</b></p>';
    for (const b of c.blocos) {
      h += `<p><b>${esc(b.titulo)}</b></p><table style="border-collapse:collapse"><thead><tr><th ${th}>${esc(b.col)}</th><th ${thR}>Chamadas recebidas</th><th ${thR}>NS 5 min</th></tr></thead><tbody>`;
      for (const x of b.linhas) h += `<tr><td ${td}>${esc(x.lab)}</td><td ${tdR}>${esc(x.num)}</td><td ${tdR}><b style="color:${COR_TEAMS[x.status] || '#1F1530'}">${esc(x.ns)}</b></td></tr>`;
      h += '</tbody></table>';
    }
    if (c.parcial) h += '<p>* <i>parcial</i></p>';
    h += `<p>Fonte: <a href="${APP_URL}">${APP_URL}</a></p></div>`;
    return h;
  }
  // versão em texto simples (para quem colar onde não há formatação)
  function textoSimples() {
    const c = conteudoMsg();
    const L = ['📊 Chamadas recebidas x NS (5 min)'];
    for (const b of c.blocos) {
      const lw = Math.max(...b.linhas.map(x => x.lab.length)), nw = Math.max(...b.linhas.map(x => x.num.length));
      L.push('', b.titulo, ...b.linhas.map(x => `▫️ ${x.lab.padEnd(lw)} → ${x.num.padStart(nw)} | ${x.ns}`));
    }
    if (c.parcial) L.push('', '* parcial');
    L.push('', 'Fonte: ' + APP_URL);
    return L.join('\n');
  }
  // copia com formatação (HTML) + texto simples; cai para execCommand se o navegador não suportar
  async function copiarFormatado(html, plain) {
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]);
        return true;
      }
    } catch (e) { /* tenta o método antigo */ }
    const div = document.createElement('div');
    div.contentEditable = 'true'; div.innerHTML = html;
    div.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(div);
    const rg = document.createRange(); rg.selectNodeContents(div);
    const sl = getSelection(); sl.removeAllRanges(); sl.addRange(rg);
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    sl.removeAllRanges(); div.remove();
    return ok;
  }

  function svgCompartilhar(d) {
    const { W, H } = IMG, c = d.cur, e = esc;
    const T = (x, y, s, txt, o = {}) => `<text x="${x}" y="${y}" font-size="${s}" font-family="${FONTE}" font-weight="${o.w || 400}" fill="${o.f || PAL.ink}" text-anchor="${o.a || 'start'}"${o.halo ? ` paint-order="stroke" stroke="${PAL.card}" stroke-width="6" stroke-linejoin="round"` : ''}${o.op ? ` opacity="${o.op}"` : ''}>${e(txt)}</text>`;
    const pc = PAL.pill[c.status] || [PAL.line, PAL.ink2];
    const stT = stNome(c.status), pillW = 28 + stT.length * 15.5;
    const dCor = d.dPP == null || d.dPP === 0 ? PAL.ink2 : d.dPP > 0 ? PAL.up : PAL.down;
    // ---- gráfico ----
    const it = d.items, CX0 = 120, CX1 = 1000, CY0 = 720, CY1 = 1060;
    const lo = Math.max(0, Math.floor((Math.min(...it.map(r => r.ns ?? 0), d.meta) - 0.05) * 10) / 10), hi = 1;
    const y = v => CY1 - (v - lo) / (hi - lo) * (CY1 - CY0);
    const bw = (CX1 - CX0) / it.length, w = Math.max(20, Math.min(64, bw * 0.56)), r = 8;
    let g = '';
    for (let v = lo; v <= hi + 1e-9; v += 0.1) g += `<line x1="${CX0}" x2="${CX1}" y1="${y(v)}" y2="${y(v)}" stroke="${PAL.line}" stroke-width="2"/>` + T(CX0 - 14, y(v) + 8, 24, String(Math.round(v * 100)), { f: PAL.ink3, a: 'end' });
    const iUlt = it.length - 1;
    const band = `<rect x="${CX0 + iUlt * bw + 4}" y="${CY0 - 46}" width="${bw - 8}" height="${CY1 - CY0 + 136}" rx="14" fill="${PAL.selbg}" stroke="${PAL.selln}" stroke-width="2"/>`;
    const bars = it.map((x, i) => {
      const bx = CX0 + i * bw + (bw - w) / 2, yt = y(x.ns ?? lo), rr = Math.min(r, w / 2, CY1 - yt);
      return CY1 - yt <= 0 ? '' : `<path d="M${bx},${CY1} V${yt + rr} A${rr},${rr} 0 0 1 ${bx + rr},${yt} H${bx + w - rr} A${rr},${rr} 0 0 1 ${bx + w},${yt + rr} V${CY1} Z" fill="${PAL[x.status] || PAL.ink3}"/>`;
    }).join('');
    const vals = it.map((x, i) => x.ns == null ? '' : T(CX0 + i * bw + bw / 2, y(x.ns) - 14, 30, p1(x.ns), { w: 800, a: 'middle', halo: true }));
    const meta = `<line x1="${CX0}" x2="${CX1}" y1="${y(d.meta)}" y2="${y(d.meta)}" stroke="${PAL.ink2}" stroke-width="3" stroke-dasharray="12 9"/>`;
    const xl = it.map((x, i) => {
      const cx = CX0 + i * bw + bw / 2, dom = d.wd(x) === 0;
      return T(cx, CY1 + 44, 30, String(+x.inicio.slice(8, 10)), { w: 700, a: 'middle', f: dom ? PAL.dom : PAL.ink2 }) +
        T(cx, CY1 + 80, 23, ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'][d.wd(x)], { w: dom ? 700 : 400, a: 'middle', f: dom ? PAL.dom : PAL.ink3 });
    }).join('');
    const legItem = (x, cor, txt) => `<rect x="${x}" y="1173" width="22" height="22" rx="5" fill="${cor}"/>` + T(x + 32, 1192, 25, txt, { f: PAL.ink2 });
    const leg = legItem(96, PAL.VERDE, 'Meta atingida') + legItem(330, PAL.AMARELO, 'Em atenção') + legItem(540, PAL.VERMELHO, 'Crítico') +
      `<line x1="700" x2="746" y1="1184" y2="1184" stroke="${PAL.ink2}" stroke-width="3" stroke-dasharray="10 7"/>` + T(758, 1192, 25, `meta ${pct1(d.meta).replace(',0%', '%')}`, { f: PAL.ink2 });
    const agora = new Date();
    const gerado = `Gerado em ${agora.toLocaleDateString('pt-BR')} às ${agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="hd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${PAL.p800}"/><stop offset=".6" stop-color="${PAL.p700}"/><stop offset="1" stop-color="${PAL.p500}"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="${PAL.bg}"/>
  <rect width="${W}" height="200" fill="url(#hd)"/>
  ${T(60, 92, 52, 'NS 5 min · B2C Suporte', { w: 800, f: '#FFFFFF' })}
  ${T(60, 146, 29, `Nível de serviço diário · dados até ${fmtData(d.dataRef || c.inicio)}`, { f: '#FFFFFF', op: .88 })}
  <rect x="48" y="236" width="984" height="300" rx="28" fill="${PAL.card}" stroke="${PAL.line}" stroke-width="2"/>
  ${T(92, 300, 30, `Último dia · ${P.rotulo(c)} · ${['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'][d.wd(c)]}`, { f: PAL.ink2 })}
  ${T(88, 418, 112, pct1(c.ns), { w: 800 })}
  <rect x="92" y="446" width="${pillW}" height="52" rx="26" fill="${pc[0]}"/>
  ${T(92 + pillW / 2, 481, 27, stT, { w: 700, f: pc[1], a: 'middle' })}
  ${T(92 + pillW + 22, 481, 26, `meta ${pct1(d.meta).replace(',0%', '%')}`, { f: PAL.ink3 })}
  <line x1="600" x2="600" y1="276" y2="496" stroke="${PAL.line}" stroke-width="2"/>
  ${T(640, 300, 30, d.prev ? `vs ${P.rotulo(d.prev)}` : 'vs dia anterior', { f: PAL.ink2 })}
  ${T(636, 384, 66, d.dPP == null ? '—' : ppTxt(d.dPP), { w: 800, f: dCor })}
  ${T(640, 430, 27, d.prev ? `NS ${pct1(d.prev.ns)}` : '', { f: PAL.ink3 })}
  ${T(640, 481, 27, `${fmtInt(c.volume)} chamadas recebidas`, { f: PAL.ink2 })}
  <rect x="48" y="572" width="984" height="652" rx="28" fill="${PAL.card}" stroke="${PAL.line}" stroke-width="2"/>
  ${T(92, 636, 32, `NS por dia · últimos ${it.length} dias`, { w: 800, f: PAL.p700 })}
  ${band}${g}${bars}${meta}${vals.join('')}${xl}${leg}
  <text x="60" y="1280" font-size="28" font-family="${FONTE}" fill="${PAL.ink2}">Painel completo: <tspan font-weight="700" fill="${PAL.p700}">${e(APP_URL.replace(/^https:\/\//, '').replace(/\/$/, ''))}</tspan></text>
  ${T(60, 1318, 22, gerado, { f: PAL.ink3 })}
</svg>`;
  }

  async function pngDeSvg(svg) {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = new Image(); img.src = url; await img.decode();
      const cv = document.createElement('canvas'); cv.width = IMG.W; cv.height = IMG.H;
      const ctx = cv.getContext('2d'); ctx.fillStyle = PAL.bg; ctx.fillRect(0, 0, IMG.W, IMG.H); ctx.drawImage(img, 0, 0);
      return await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('Falha ao gerar a imagem')), 'image/png'));
    } finally { URL.revokeObjectURL(url); }
  }

  async function abrirCompartilhar() {
    const d = dadosCompartilhar();
    if (!d) { toast('Ainda não há dados diários para compartilhar.'); return; }
    const bg = document.createElement('div'); bg.className = 'sheet-bg';
    bg.innerHTML = `<div class="sheet"><h3>Compartilhar</h3>
      <div class="small muted" style="margin-bottom:8px">Confira a imagem e a mensagem antes de enviar.</div>
      <div id="shPrev" class="shprev"><div class="small muted" style="padding:40px 0;text-align:center">Gerando a imagem…</div></div>
      <div class="row" style="margin-bottom:12px"><button class="btn sec" id="shBaixar" disabled>Baixar imagem</button><button class="btn sec" id="shCopImg" disabled>Copiar imagem</button></div>
      <div class="seg shtabs" role="tablist"><button role="tab" data-t="wa" class="on">WhatsApp</button><button role="tab" data-t="teams">Teams</button></div>
      <div id="tabWa">
        <pre class="shmsg" id="shMsg"></pre>
        <button class="btn" id="shEnviar" disabled>Enviar pelo WhatsApp</button>
        <button class="btn sec" id="shCopiar" style="margin-top:10px">Copiar texto do WhatsApp</button>
      </div>
      <div id="tabTeams" hidden>
        <div class="shteams" id="shTeams"></div>
        <button class="btn" id="shTeamsCop">Copiar para o Teams</button>
        <div class="small muted" style="margin-top:8px">Copia a mensagem com negrito, tabelas e link. No Teams, cole (Ctrl+V) na conversa ou no canal; para a imagem, use <b>Copiar imagem</b> e cole também, ou anexe a imagem baixada.</div>
      </div>
      <button class="btn sec" id="shFechar" style="margin-top:12px">Fechar</button></div>`;
    document.body.appendChild(bg);
    const q = sel => bg.querySelector(sel);
    const texto = textoCompartilhar(), html = htmlTeams(), simples = textoSimples();
    q('#shMsg').textContent = texto;
    q('#shTeams').innerHTML = html;
    bg.querySelectorAll('.shtabs button').forEach(b => b.onclick = () => {
      bg.querySelectorAll('.shtabs button').forEach(x => x.classList.toggle('on', x === b));
      q('#tabWa').hidden = b.dataset.t !== 'wa'; q('#tabTeams').hidden = b.dataset.t !== 'teams';
    });
    let urlPrev = null, file = null, blob = null;
    const fechar = () => { bg.remove(); if (urlPrev) URL.revokeObjectURL(urlPrev); };
    bg.addEventListener('click', e => { if (e.target === bg) fechar(); });
    q('#shFechar').onclick = fechar;
    q('#shCopiar').onclick = async () => { try { await navigator.clipboard.writeText(texto); toast('Texto do WhatsApp copiado'); } catch (e) { toast('Não consegui copiar — selecione o texto e copie.'); } };
    q('#shTeamsCop').onclick = async () => {
      const ok = await copiarFormatado(html, simples);
      toast(ok ? 'Copiado ✓ Agora cole no Teams (Ctrl+V)' : 'Não consegui copiar — selecione a tabela e copie.', 4000);
    };
    const nome = `ns-diario-${d.cur.inicio}.png`;
    try {
      blob = await pngDeSvg(svgCompartilhar(d));   // gera antes do toque em Enviar (o celular exige o toque "fresco" para compartilhar)
      file = new File([blob], nome, { type: 'image/png' });
      urlPrev = URL.createObjectURL(blob);
      q('#shPrev').innerHTML = `<img src="${urlPrev}" alt="Imagem do NS por dia" id="shImg">`;
      q('#shEnviar').disabled = false; q('#shBaixar').disabled = false; q('#shCopImg').disabled = false;
    } catch (err) {
      q('#shPrev').innerHTML = `<div class="banner bad">Não consegui gerar a imagem: ${esc(err.message)}</div>`;
      return;
    }
    const baixar = () => { const a = document.createElement('a'); a.href = urlPrev; a.download = nome; document.body.appendChild(a); a.click(); a.remove(); };
    q('#shBaixar').onclick = baixar;
    q('#shCopImg').onclick = async () => {
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Imagem copiada ✓ Cole na conversa (Ctrl+V)'); }
      catch (e) { toast('Este navegador não copia imagem — use Baixar imagem.'); }
    };
    q('#shEnviar').onclick = async () => {
      // copia a mensagem também: alguns celulares (iPhone) mandam a imagem sem o texto — aí é só colar
      if (navigator.clipboard) navigator.clipboard.writeText(texto).catch(() => {});
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], text: texto }); return; }
        catch (err) { if (err && err.name === 'AbortError') return; }
      }
      // sem compartilhamento de arquivo (ex.: computador): baixa a imagem e abre o WhatsApp com a mensagem
      baixar();
      window.open('https://wa.me/?text=' + encodeURIComponent(texto), '_blank', 'noopener');
      toast('Imagem baixada — anexe-a na conversa do WhatsApp que abriu.', 4500);
    };
  }

  // ---------------- Histórico ----------------
  function renderHist() {
    main.innerHTML = `
      <div class="card"><h2>Arquivos recebidos (${snaps.length})</h2>
        ${snaps.length ? `<div class="list">${snaps.map(s => `<div class="it" data-id="${s.id}">
            <div class="t"><b>Dados até ${fmtData(s.dataRef)}</b> <span class="origem ${s.origem}">${s.origem}</span>
            <div class="small muted">${s.rows.length} linhas · recebido ${fmtDT(s.id)}${s.colunasExtras && s.colunasExtras.length ? ' · +' + s.colunasExtras.length + ' coluna(s)' : ''}</div></div>›</div>`).join('')}</div>`
        : '<div class="empty">Nada salvo ainda.</div>'}
        <div class="small muted" style="margin-top:8px">O painel mostra somente o arquivo com os dados mais recentes, exatamente como está no TXT. Os anteriores ficam aqui só como histórico.</div>
      </div>
      <div class="card"><h2>Backup</h2>
        <div class="small muted" style="margin-bottom:10px">Os dados ficam neste aparelho. Exporte de vez em quando.</div>
        <div class="row"><button class="btn sec" id="bExp">Exportar</button><button class="btn sec" id="bImp">Importar backup</button></div>
        <div class="small muted" id="persist" style="margin-top:10px"></div>
        <div class="small muted" style="margin-top:6px">NS Painel v${APP_VERSION}</div>
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
      <table class="conf" style="cursor:default;margin-top:8px"><thead><tr><th>PERÍODO</th><th>DIAS</th><th>RECEBIDAS</th><th>NS</th></tr></thead><tbody>
      ${s.rows.map(r => `<tr style="cursor:default"><td>${esc(P.rotulo(r, r.tipo === 'SEMANA'))}</td><td>${r.completo ? r.dias : r.dias + '/' + r.diasPeriodo}</td><td>${fmtInt(r.volume)}</td><td>${fmtPct(r.total > 0 ? r.ate / r.total : null)}</td></tr>`).join('')}
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
  $('#bShare').addEventListener('click', abrirCompartilhar);
  window.__ns = { version: APP_VERSION, state: () => ({ snaps, preview, view, modo, pubStatus }), reload, buscarPublicado, share: { dados: dadosCompartilhar, texto: () => textoCompartilhar(), teams: () => htmlTeams(), simples: () => textoSimples(), svg: () => svgCompartilhar(dadosCompartilhar()), png: async () => { const b = await pngDeSvg(svgCompartilhar(dadosCompartilhar())); return { size: b.size, type: b.type, url: await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); }) }; } } };
})();
