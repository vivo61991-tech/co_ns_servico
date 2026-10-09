/* NS Leitor — app */
(function () {
  'use strict';
  const APP_VERSION = '1.0.0';
  const E = window.NSEngine;
  const $ = s => document.querySelector(s);
  const main = $('#main');
  $('#ver').textContent = 'v' + APP_VERSION;

  // ---------------- Banco (IndexedDB) ----------------
  const DB_NAME = 'ns-leitor', STORE = 'capturas';
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

  // ---------------- Estado ----------------
  let caps = [];          // capturas salvas (mais nova primeiro)
  let view = 'painel';
  let draft = null;       // leitura aguardando conferência
  let busy = false;
  let selMonth = null;

  async function reload() {
    caps = (await dbAll()).sort((a, b) => b.id - a.id);
  }

  // valor vigente de cada período = o da captura mais recente que o contém
  function periodos() {
    const map = new Map();
    for (const c of caps) for (const r of c.rows) if (r.ordem && !map.has(r.ordem)) map.set(r.ordem, { ...r, capId: c.id, em: c.id });
    return map;
  }

  // ---------------- Utilidades ----------------
  const fmtInt = v => v == null ? '—' : v.toLocaleString('pt-BR');
  const fmtNs = v => v == null ? '—' : String(+v.toFixed(4)).replace('.', ',');
  const fmtPct = v => v == null ? '—' : (v * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
  const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const ymLabel = ym => MESES[+ym.slice(4, 6) - 1] + '/' + ym.slice(2, 4);
  const fmtDT = ts => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const statusOf = (ns, meta) => ns == null ? null : ns >= meta ? 'VERDE' : ns >= 0.7 ? 'AMARELO' : 'VERMELHO';
  function toast(msg, ms = 2600) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }
  function confirmDlg(msg) { return Promise.resolve(window.confirm(msg)); }

  // ---------------- Navegação ----------------
  $('#nav').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || busy) return;
    if (draft && b.dataset.v !== 'captura') {
      if (!window.confirm('Há uma leitura não salva. Sair e descartar?')) return;
      draft = null;
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
    else if (view === 'captura') draft ? renderConf() : renderCaptura();
    else renderHist();
  }

  // ---------------- Captura ----------------
  function renderCaptura() {
    main.innerHTML = `
      <div class="card">
        <h2>Ler a tabela</h2>
        <div class="row" style="flex-direction:column;gap:10px">
          <button class="btn" id="bCam">📷 Fotografar a tela</button>
          <button class="btn sec" id="bGal">Escolher imagem da galeria</button>
        </div>
        <ol class="tips">
          <li>Enquadre <b>do cabeçalho</b> (PERIODO … ORDEM) <b>até a última linha</b>.</li>
          <li>Chegue perto: a tabela deve ocupar quase toda a foto, de lado (paisagem).</li>
          <li>Foto reta e parada; evite reflexo de luz na tela.</li>
        </ol>
        <div class="small muted" id="ocrState" style="margin-top:10px"></div>
      </div>`;
    $('#bCam').onclick = () => $('#fileCam').click();
    $('#bGal').onclick = () => $('#fileGal').click();
    warmup();
  }
  let warmed = false;
  function warmup() {
    if (warmed) return;
    const st = $('#ocrState'); if (st) st.textContent = 'Preparando o leitor… (na 1ª vez baixa ~7 MB)';
    window.NSOcr.warmup().then(() => { warmed = true; const s = $('#ocrState'); if (s) s.textContent = 'Leitor pronto ✓ (funciona offline)'; })
      .catch(e => { const s = $('#ocrState'); if (s) s.textContent = 'Não consegui preparar o leitor: ' + e.message; });
  }
  ['#fileCam', '#fileGal'].forEach(id => $(id).addEventListener('change', e => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (f) processFile(f);
  }));

  async function processFile(file) {
    busy = true;
    main.innerHTML = `<div class="card"><h2>Lendo a tabela</h2>
      <div id="pmsg" class="muted">Abrindo a imagem…</div><div class="prog"><div id="pbar"></div></div>
      <div class="small muted">Leva uns segundos. Pode deixar o celular parado.</div></div>`;
    const setP = (msg, frac) => { const m = $('#pmsg'), b = $('#pbar'); if (m && msg) m.textContent = msg; if (b && frac != null) b.style.width = Math.round(frac * 100) + '%'; };
    try {
      const ad = await window.NSOcr.makeAdapter(file, () => setP('Preparando o leitor…', 0.02));
      const res = await E.readTable(ad, { onProgress: p => setP(p.msg, p.frac) });
      setP('Gerando miniatura…', 0.98);
      const thumb = makeThumb(ad, res.quality);
      draft = {
        rows: res.rows, meta: res.meta, quality: res.quality, thumb,
        user: {}, // "i:campo" -> true quando o usuário conferiu/editou
        edited: 0,
      };
      busy = false;
      go('captura');
    } catch (err) {
      busy = false;
      console.warn('Leitura falhou:', err && err.message);
      main.innerHTML = `<div class="card"><h2>Não deu certo</h2>
        <div class="banner bad">${esc(err.message || err)}</div>
        <button class="btn" id="bAgain">Tentar outra foto</button></div>`;
      $('#bAgain').onclick = () => renderCaptura();
    }
  }

  function makeThumb(ad, q) {
    try {
      const b = ad.baseCanvas(q.rotation || 0);
      const r = q.roi || { x: 0, y: 0, w: b.width, h: b.height };
      const x = Math.max(0, r.x - r.w * 0.02), y = Math.max(0, r.y - r.h * 0.04);
      const w = Math.min(b.width - x, r.w * 1.04), h = Math.min(b.height - y, r.h * 1.08);
      const ow = Math.min(1600, Math.round(w)), oh = Math.round(h * ow / w);
      const c = document.createElement('canvas'); c.width = ow; c.height = oh;
      const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(b, x, y, w, h, 0, 0, ow, oh);
      return c.toDataURL('image/jpeg', 0.72);
    } catch (e) { return null; }
  }

  // ---------------- Conferência ----------------
  const FIELDS = ['volume', 'total', 'ate'];
  function cellState(i, c) {
    const r = draft.rows[i];
    if (draft.user[i + ':' + c]) return 'user';
    if (c === 'ns') return (r.total == null || r.ate == null) ? 'faltando' : (draft.user[i + ':total'] && draft.user[i + ':ate'] ? 'user' : r.flags.ns);
    return r.flags[c] || 'conferir';
  }
  function conflicts() {
    // meses fechados já salvos com valores diferentes
    const per = periodos(), out = [];
    draft.rows.forEach((r, i) => {
      const old = r.ordem && per.get(r.ordem);
      if (!old || r.tipo !== 'MES' || r.partial || old.partial) return;
      for (const c of FIELDS) if (old[c] != null && r[c] != null && old[c] !== r[c] && !draft.user[i + ':' + c])
        out.push({ i, c, old: old[c], now: r[c] });
    });
    return out;
  }
  function pendencias() {
    const p = [];
    draft.rows.forEach((r, i) => {
      for (const c of FIELDS) { const s = cellState(i, c); if (s === 'conferir' || s === 'faltando') p.push({ i, c, s }); }
      const o = r.flags.ordem;
      if ((o === 'conferir' || o === 'faltando') && !draft.user[i + ':ordem']) p.push({ i, c: 'ordem', s: o });
    });
    for (const k of conflicts()) if (!p.some(x => x.i === k.i && x.c === k.c)) p.push({ i: k.i, c: k.c, s: 'conferir', conflito: k });
    return p;
  }

  function renderConf() {
    const q = draft.quality, pend = pendencias(), conf = conflicts();
    const nLido = draft.rows.reduce((s, r, i) => s + FIELDS.filter(c => cellState(i, c) === 'lido').length, 0);
    const banners = [];
    if (q.lowRes) banners.push(`<div class="banner warn">A tabela ficou pequena na foto (letra ≈ ${q.textPx}px). Para menos correções, chegue mais perto.</div>`);
    if (conf.length) banners.push(`<div class="banner warn"><b>Diferente do já salvo:</b> ${conf.map(k => `${esc(draft.rows[k.i].label)} ${labelCampo(k.c)}: salvo ${k.old}, lido ${k.now}`).join(' · ')}</div>`);
    if (draft.sumIssues && draft.sumIssues.length) banners.push(`<div class="banner bad"><b>A soma dos dias não fecha com o mês:</b> ${draft.sumIssues.map(k => `${labelCampo(k.col)} — dias somam ${k.soma}, mês mostra ${k.mes}`).join(' · ')}. Confira os valores.</div>`);
    if (pend.length) banners.push(`<div class="banner warn"><b>${pend.length} ${pend.length === 1 ? 'item precisa' : 'itens precisam'} de conferência.</b> Toque na linha para corrigir ou confirmar olhando a tela.</div>`);
    else banners.push(`<div class="banner ok"><b>Tudo conferido.</b> ${q.trusted} de ${q.cells} valores batem com os totais da própria tabela.</div>`);
    if (nLido) banners.push(`<div class="banner info small">${nLido} valor(es) de meses fechados não têm conferência automática (a tabela não traz um total para comparar). Vale bater o olho.</div>`);

    main.innerHTML = `
      <div class="card">
        <h2>Conferir leitura</h2>
        ${banners.join('')}
        ${draft.thumb ? `<img class="thumb" id="thumb" src="${draft.thumb}" alt="Foto da tabela"><div class="small muted" style="margin:4px 0 8px">Toque na foto para ampliar.</div>` : ''}
        <div class="legend2">
          <span><i class="sw" style="box-shadow:inset 0 -3px 0 var(--ok)"></i>conferido</span>
          <span><i class="sw" style="background:var(--calcbg)"></i>calculado</span>
          <span><i class="sw" style="box-shadow:inset 0 -3px 0 var(--ink3)"></i>lido (sem total p/ conferir)</span>
          <span><i class="sw" style="background:var(--warnbg)"></i>conferir</span>
          <span><i class="sw" style="background:var(--badbg)"></i>faltando</span>
          <span><i class="sw" style="background:var(--userbg)"></i>você conferiu</span>
        </div>
        <div style="overflow-x:auto">
        <table class="conf">
          <thead><tr><th>PERÍODO</th><th>VOLUME</th><th>TOT_ATEND</th><th>ATE_5MIN</th><th>NS</th></tr></thead>
          <tbody>${draft.rows.map((r, i) => {
            const o = r.flags.ordem, oc = draft.user[i + ':ordem'] ? 'user' : (o === 'conferir' || o === 'faltando' ? o : 'ok');
            const isConf = c => conf.some(k => k.i === i && k.c === c);
            return `<tr data-i="${i}">
              <td class="f-${oc}">${esc(r.label)}</td>
              ${FIELDS.map(c => `<td class="f-${isConf(c) ? 'conferir' : cellState(i, c)}">${r[c] == null ? '?' : r[c]}</td>`).join('')}
              <td class="f-${cellState(i, 'ns')}">${fmtNs(r.ns)}</td></tr>`;
          }).join('')}</tbody>
        </table></div>
        <div class="small muted" style="margin-top:6px">Números no mesmo formato da tela do SQL Developer, para comparar fácil. NS = ATE_5MIN ÷ TOTAL_ATENDIDAS.</div>
      </div>
      <div class="row">
        <button class="btn sec" id="bDesc">Descartar</button>
        <button class="btn" id="bSave" ${pend.length ? 'disabled' : ''}>Salvar ${draft.rows.length} linhas</button>
      </div>
      ${pend.length ? `<button class="btn sec" id="bAll" style="margin-top:10px">Conferi tudo na tela — confirmar os ${pend.length} itens</button>` : ''}
      <div style="height:6px"></div>
      <button class="btn sec" id="bRetry" style="margin-top:6px">Tirar outra foto</button>`;

    main.querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = () => openRow(+tr.dataset.i));
    $('#bDesc').onclick = async () => { if (await confirmDlg('Descartar esta leitura?')) { draft = null; renderCaptura(); } };
    $('#bRetry').onclick = async () => { if (await confirmDlg('Descartar esta leitura e tirar outra foto?')) { draft = null; renderCaptura(); $('#fileCam').click(); } };
    $('#bSave').onclick = saveDraft;
    if ($('#bAll')) $('#bAll').onclick = async () => {
      const faltando = pend.filter(p => p.s === 'faltando');
      if (faltando.length) { toast('Ainda há valores faltando — toque na linha e digite.'); return; }
      if (!await confirmDlg(`Você comparou os ${pend.length} itens amarelos com a tela e estão certos?`)) return;
      for (const p of pend) draft.user[p.i + ':' + p.c] = true;
      renderConf();
    };
    if ($('#thumb')) $('#thumb').onclick = () => {
      const z = document.createElement('div'); z.className = 'zoom';
      z.innerHTML = `<button class="btn" style="width:auto">Fechar</button><img src="${draft.thumb}">`;
      z.querySelector('button').onclick = () => z.remove(); document.body.appendChild(z);
    };
  }
  const labelCampo = c => ({ volume: 'VOLUME', total: 'TOTAL_ATENDIDAS', ate: 'ATE_5_MIN', ordem: 'PERÍODO', ns: 'NS' }[c]);
  const FLAG_TXT = { ok: 'conferido ✓', derivado: 'calculado pela soma do mês', lido: 'lido — sem total para conferir', conferir: 'confira na tela', faltando: 'não consegui ler', user: 'você conferiu' };

  function openRow(i) {
    const r = draft.rows[i];
    const bg = document.createElement('div'); bg.className = 'sheet-bg';
    const ordTxt = r.ordem || '';
    const fstate = c => cellState(i, c);
    bg.innerHTML = `<div class="sheet">
      <h3>Linha ${i + 1}: ${esc(r.label)}</h3>
      <div class="small muted">Compare com a tela e corrija se preciso.</div>
      <div class="field"><label><span>ORDEM (AAAAMMDD; mês = dia 00)</span><span>${FLAG_TXT[draft.user[i + ':ordem'] ? 'user' : (r.flags.ordem || 'ok')] || ''}</span></label>
        <input id="eOrd" inputmode="numeric" value="${esc(ordTxt)}" class="f-${r.flags.ordem}"></div>
      ${FIELDS.map(c => `<div class="field"><label><span>${labelCampo(c)}</span><span>${FLAG_TXT[fstate(c)] || ''}</span></label>
        <input id="e_${c}" inputmode="numeric" value="${r[c] ?? ''}" class="f-${fstate(c)}"></div>`).join('')}
      <div class="small muted" id="eNs" style="margin:-2px 0 10px">NS calculado: ${fmtNs(r.ns)}</div>
      <div class="row"><button class="btn sec" id="eCancel">Cancelar</button><button class="btn" id="eOk">Está certo</button></div>
      <button class="btn sec" id="eDel" style="margin-top:10px;color:var(--bad)">Excluir esta linha</button>
    </div>`;
    document.body.appendChild(bg);
    const val = c => { const t = bg.querySelector('#e_' + c).value.replace(/\D/g, ''); return t === '' ? null : parseInt(t, 10); };
    const upd = () => { const t = val('total'), a = val('ate'); bg.querySelector('#eNs').textContent = 'NS calculado: ' + (t > 0 && a != null && a <= t ? fmtNs(E.ns4(a, t)) : '—'); };
    FIELDS.forEach(c => bg.querySelector('#e_' + c).addEventListener('input', upd));
    bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });
    bg.querySelector('#eCancel').onclick = () => bg.remove();
    bg.querySelector('#eDel').onclick = async () => {
      if (!await confirmDlg(`Excluir a linha ${r.label}? (use só se for uma linha lida por engano)`)) return;
      draft.rows.splice(i, 1); remapUser(i); revalidateDraft(); bg.remove(); renderConf();
    };
    bg.querySelector('#eOk').onclick = () => {
      const ord = bg.querySelector('#eOrd').value.replace(/\D/g, '');
      if (!/^20\d{2}(0[1-9]|1[0-2])([0-2]\d|3[01])$/.test(ord)) { toast('ORDEM inválida. Ex.: 20261007 (dia) ou 20261000 (mês).'); return; }
      const v = {}; for (const c of FIELDS) { v[c] = val(c); if (v[c] == null) { toast(`Preencha ${labelCampo(c)}.`); return; } }
      if (v.ate > v.total) { toast('ATE_5_MIN não pode ser maior que TOTAL_ATENDIDAS.'); return; }
      if (v.total > v.volume) { toast('TOTAL_ATENDIDAS não pode ser maior que VOLUME.'); return; }
      if (draft.rows.some((x, k) => k !== i && x.ordem === ord)) { toast('Já existe outra linha com essa ORDEM.'); return; }
      let changed = false;
      if (ord !== r.ordem) { r.ordem = ord; r.tipo = ord.endsWith('00') ? 'MES' : 'DIA'; changed = true; }
      for (const c of FIELDS) if (v[c] !== r[c]) { r[c] = v[c]; changed = true; }
      for (const c of [...FIELDS, 'ordem']) draft.user[i + ':' + c] = true;
      if (changed) draft.edited++;
      revalidateDraft(); bg.remove(); renderConf();
    };
  }
  function remapUser(removed) {
    const nu = {};
    for (const [k, v] of Object.entries(draft.user)) {
      const [i, c] = k.split(':'); const n = +i;
      if (n === removed) continue; nu[(n > removed ? n - 1 : n) + ':' + c] = v;
    }
    draft.user = nu;
  }
  function revalidateDraft() {
    // reordena por ORDEM (meses primeiro, depois dias) levando junto as marcações do usuário
    const tagged = draft.rows.map((r, i) => ({ r, u: Object.fromEntries(Object.entries(draft.user).filter(([k]) => +k.split(':')[0] === i).map(([k, v]) => [k.split(':')[1], v])) }));
    tagged.sort((a, b) => (a.r.ordem || '').localeCompare(b.r.ordem || ''));
    const ordered = [...tagged.filter(t => (t.r.ordem || '').endsWith('00')), ...tagged.filter(t => !(t.r.ordem || '').endsWith('00'))];
    const re = E.revalidate(ordered.map(t => t.r), draft.meta, ordered.map(t => t.u));
    draft.sumIssues = re.issues || [];
    draft.rows = re;
    draft.user = {};
    ordered.forEach((t, k) => { for (const [c, v] of Object.entries(t.u)) draft.user[k + ':' + c] = v; });
  }

  async function saveDraft() {
    if (pendencias().length) { toast('Ainda há itens para conferir.'); return; }
    const btn = $('#bSave'); btn.disabled = true; btn.textContent = 'Salvando…';
    const id = Date.now();
    const rows = draft.rows.map((r, i) => ({
      ordem: r.ordem, tipo: r.tipo, label: r.label, dias: r.dias, partial: !!r.partial,
      volume: r.volume, total: r.total, ate: r.ate, ns: r.ns, status: statusOf(r.ns, draft.meta),
      origem: Object.fromEntries([...FIELDS, 'ns', 'ordem'].map(c => [c, draft.user[i + ':' + c] ? 'usuario' : (r.flags[c] || 'ok')])),
    }));
    // checagens finais de integridade
    for (const r of rows) {
      if (!r.ordem || [r.volume, r.total, r.ate].some(v => !Number.isInteger(v) || v < 0) || r.ate > r.total) {
        btn.disabled = false; btn.textContent = 'Salvar';
        toast('Linha inválida: ' + r.label + '. Corrija antes de salvar.'); return;
      }
      r.ns = E.ns4(r.ate, r.total); r.status = statusOf(r.ns, draft.meta);
    }
    const cap = { id, app: APP_VERSION, meta: draft.meta, rows, thumb: draft.thumb, quality: { ...draft.quality, roi: undefined }, editadas: draft.edited, conferidasManual: Object.keys(draft.user).length };
    try {
      await dbPut(cap);
      const back = await dbGet(id);
      if (!back || JSON.stringify(back.rows) !== JSON.stringify(rows)) throw new Error('A verificação depois de salvar não bateu.');
      draft = null;
      await reload();
      toast(`Salvo ✓ ${rows.length} linhas`);
      go('painel');
    } catch (e) {
      console.error(e);
      btn.disabled = false; btn.textContent = 'Tentar salvar de novo';
      alert('ERRO AO SALVAR — os dados NÃO foram gravados.\n\n' + (e.message || e) + '\n\nA leitura continua aqui na tela; tente de novo. Se persistir, exporte um backup no Histórico.');
    }
  }

  // ---------------- Painel ----------------
  function monthsAvailable(per) {
    const s = new Set(); for (const o of per.keys()) s.add(o.slice(0, 6));
    return [...s].sort().reverse();
  }
  function renderPainel() {
    const per = periodos();
    if (!per.size) {
      main.innerHTML = `<div class="card empty"><div style="font-size:40px">📊</div><p>Nenhuma leitura salva ainda.</p>
        <button class="btn" id="bGo">Capturar a primeira tabela</button></div>`;
      $('#bGo').onclick = () => go('captura'); return;
    }
    const months = monthsAvailable(per);
    if (!selMonth || !months.includes(selMonth)) selMonth = months[0];
    const ym = selMonth;
    const days = [...per.values()].filter(r => r.tipo === 'DIA' && r.ordem.startsWith(ym)).sort((a, b) => a.ordem.localeCompare(b.ordem));
    const mRow = per.get(ym + '00');
    const meta = (caps[0] && caps[0].meta) || 0.8;
    const sum = c => days.reduce((s, d) => s + d[c], 0);
    const tot = mRow ? mRow.total : sum('total'), ate = mRow ? mRow.ate : sum('ate'), vol = mRow ? mRow.volume : sum('volume');
    const ns = tot > 0 ? ate / tot : null;
    const naMeta = days.filter(d => d.ns >= meta).length;
    const falta = ns != null && ns < meta ? Math.ceil(meta * tot - ate - 1e-9) : 0;
    const folga = ns != null && ns >= meta ? Math.floor(ate / meta - tot + 1e-9) : 0;
    const st = statusOf(ns, meta);
    const last = caps[0];
    main.innerHTML = `
      <div class="card" style="display:flex;align-items:center;gap:10px">
        <select id="selM">${months.map(m => `<option value="${m}" ${m === ym ? 'selected' : ''}>${ymLabel(m)}</option>`).join('')}</select>
        <div class="small muted" style="flex:1;text-align:right">Última leitura<br><b>${fmtDT(last.id)}</b></div>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="l">NS 5 min${mRow && mRow.partial ? ' (parcial)' : ''}</div><div class="v">${fmtPct(ns)}</div><div class="s">${st ? `<span class="pill ${st}">${st}</span>` : ''} meta ${fmtPct(meta)}</div></div>
        <div class="kpi"><div class="l">${falta ? 'Faltam p/ meta' : 'Folga na meta'}</div><div class="v">${fmtInt(falta || folga)}</div><div class="s">${falta ? 'atend. em até 5 min (volume atual)' : 'atend. podem passar de 5 min'}</div></div>
        <div class="kpi"><div class="l">Atendidas / volume</div><div class="v">${fmtInt(tot)}</div><div class="s">de ${fmtInt(vol)} (${vol ? fmtPct(tot / vol) : '—'})</div></div>
        <div class="kpi"><div class="l">Dias na meta</div><div class="v">${days.length ? `${naMeta}/${days.length}` : '—'}</div><div class="s">${days.length ? `${days.length} dia(s) lidos` : 'sem dias deste mês'}</div></div>
      </div>
      <div style="height:12px"></div>
      ${days.length ? `<div class="card chart"><h2>NS por dia · ${ymLabel(ym)}</h2>${chartNsDias(days, meta)}
        <div class="legend"><span><i style="background:var(--verde)"></i>≥ meta</span><span><i style="background:var(--amarelo)"></i>≥ 70%</span><span><i style="background:var(--vermelho)"></i>&lt; 70%</span><span><i style="background:var(--ink);height:2px"></i>acumulado do mês</span><span><i style="background:none;border-top:2px dashed var(--ink3);height:0"></i>meta</span></div>
        <div class="cap" id="cap1">Toque numa barra para ver o dia.</div></div>
      <div class="card chart"><h2>Volume e atendimento por dia</h2>${chartVolDias(days)}
        <div class="legend"><span><i style="background:var(--bar1)"></i>volume</span><span><i style="background:var(--bar2)"></i>atendidas</span><span><i style="background:var(--bar3)"></i>em até 5 min</span></div>
        <div class="cap" id="cap2">Toque numa barra para ver o dia.</div></div>` : ''}
      ${chartMesesCard(per, meta)}
      ${days.length ? tabelaDias(days, meta) : ''}`;
    $('#selM').onchange = e => { selMonth = e.target.value; renderPainel(); };
    bindChartTaps(days, meta);
  }

  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  function chartNsDias(days, meta) {
    const W = 360, H = 210, L = 30, R = 8, T = 12, B = 26, iw = W - L - R, ih = H - T - B;
    const vals = days.map(d => d.ns);
    let acc = 0, accT = 0; const cum = days.map(d => { acc += d.ate; accT += d.total; return accT ? acc / accT : null; });
    const lo = Math.max(0, Math.floor((Math.min(...vals, ...cum, meta) - 0.05) * 10) / 10), hi = 1;
    const y = v => T + ih - (v - lo) / (hi - lo) * ih;
    const bw = iw / days.length, gap = Math.min(6, bw * 0.25);
    const col = v => v >= meta ? css('--verde') : v >= 0.7 ? css('--amarelo') : css('--vermelho');
    let g = '';
    for (let t = lo; t <= hi + 1e-9; t += 0.1) g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="${css('--line')}"/><text x="${L - 4}" y="${y(t) + 4}" font-size="10" text-anchor="end" fill="${css('--ink3')}">${Math.round(t * 100)}</text>`;
    const bars = days.map((d, i) => `<rect data-i="${i}" x="${L + i * bw + gap / 2}" y="${y(d.ns)}" width="${bw - gap}" height="${Math.max(1, y(lo) - y(d.ns))}" rx="2" fill="${col(d.ns)}"/>`).join('');
    const hits = days.map((d, i) => `<rect data-i="${i}" x="${L + i * bw}" y="${T}" width="${bw}" height="${ih}" fill="transparent"/>`).join('');
    const line = cum.map((v, i) => `${i ? 'L' : 'M'}${(L + i * bw + bw / 2).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const step = Math.ceil(days.length / 10);
    const xl = days.map((d, i) => i % step === 0 || i === days.length - 1 ? `<text x="${L + i * bw + bw / 2}" y="${H - 8}" font-size="10" text-anchor="middle" fill="${css('--ink2')}">${+d.ordem.slice(6)}</text>` : '').join('');
    return `<svg viewBox="0 0 ${W} ${H}" id="ch1" role="img" aria-label="NS por dia">${g}${bars}
      <line x1="${L}" x2="${W - R}" y1="${y(meta)}" y2="${y(meta)}" stroke="${css('--ink2')}" stroke-dasharray="4 3" stroke-width="1.5"/>
      <path d="${line}" fill="none" stroke="${css('--ink')}" stroke-width="2"/>
      ${cum.map((v, i) => `<circle cx="${L + i * bw + bw / 2}" cy="${y(v)}" r="2.4" fill="${css('--ink')}"/>`).join('')}
      ${xl}${hits}</svg>`;
  }
  function chartVolDias(days) {
    const W = 360, H = 200, L = 38, R = 8, T = 10, B = 26, iw = W - L - R, ih = H - T - B;
    const max = Math.max(...days.map(d => d.volume)) * 1.05 || 1;
    const nice = Math.pow(10, Math.floor(Math.log10(max))); const stepV = max / nice > 5 ? nice * 2 : max / nice > 2 ? nice : nice / 2;
    const y = v => T + ih - v / max * ih;
    const bw = iw / days.length, gap = Math.min(6, bw * 0.25);
    let g = '';
    for (let t = 0; t <= max; t += stepV) g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="${css('--line')}"/><text x="${L - 4}" y="${y(t) + 4}" font-size="10" text-anchor="end" fill="${css('--ink3')}">${t >= 1000 ? (t / 1000).toLocaleString('pt-BR') + 'k' : t}</text>`;
    const bars = days.map((d, i) => { const x = L + i * bw + gap / 2, w = bw - gap;
      return `<rect x="${x}" y="${y(d.volume)}" width="${w}" height="${y(0) - y(d.volume)}" rx="2" fill="${css('--bar1')}"/>
        <rect x="${x + w * 0.15}" y="${y(d.total)}" width="${w * 0.7}" height="${y(0) - y(d.total)}" rx="1.5" fill="${css('--bar2')}"/>
        <rect x="${x + w * 0.3}" y="${y(d.ate)}" width="${w * 0.4}" height="${y(0) - y(d.ate)}" rx="1" fill="${css('--bar3')}"/>`; }).join('');
    const hits = days.map((d, i) => `<rect data-i="${i}" x="${L + i * bw}" y="${T}" width="${bw}" height="${ih}" fill="transparent"/>`).join('');
    const step = Math.ceil(days.length / 10);
    const xl = days.map((d, i) => i % step === 0 || i === days.length - 1 ? `<text x="${L + i * bw + bw / 2}" y="${H - 8}" font-size="10" text-anchor="middle" fill="${css('--ink2')}">${+d.ordem.slice(6)}</text>` : '').join('');
    return `<svg viewBox="0 0 ${W} ${H}" id="ch2" role="img" aria-label="Volume por dia">${g}${bars}${xl}${hits}</svg>`;
  }
  function chartMesesCard(per, meta) {
    const ms = [...per.values()].filter(r => r.tipo === 'MES').sort((a, b) => a.ordem.localeCompare(b.ordem)).slice(-12);
    if (!ms.length) return '';
    const W = 360, H = 190, L = 30, R = 8, T = 18, B = 26, iw = W - L - R, ih = H - T - B;
    const lo = Math.max(0, Math.floor((Math.min(...ms.map(m => m.ns), meta) - 0.1) * 10) / 10), hi = 1;
    const y = v => T + ih - (v - lo) / (hi - lo) * ih;
    const bw = iw / ms.length, gap = Math.min(18, bw * 0.35);
    const col = v => v >= meta ? css('--verde') : v >= 0.7 ? css('--amarelo') : css('--vermelho');
    let g = '';
    for (let t = lo; t <= hi + 1e-9; t += 0.1) g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="${css('--line')}"/><text x="${L - 4}" y="${y(t) + 4}" font-size="10" text-anchor="end" fill="${css('--ink3')}">${Math.round(t * 100)}</text>`;
    const bars = ms.map((m, i) => `<rect x="${L + i * bw + gap / 2}" y="${y(m.ns)}" width="${bw - gap}" height="${y(lo) - y(m.ns)}" rx="3" fill="${col(m.ns)}" ${m.partial ? 'fill-opacity=".55"' : ''}/>
      <text x="${L + i * bw + bw / 2}" y="${y(m.ns) - 4}" font-size="10" font-weight="600" text-anchor="middle" fill="${css('--ink')}">${(m.ns * 100).toFixed(1).replace('.', ',')}</text>
      <text x="${L + i * bw + bw / 2}" y="${H - 8}" font-size="10" text-anchor="middle" fill="${css('--ink2')}">${MESES[+m.ordem.slice(4, 6) - 1]}${m.partial ? '*' : ''}</text>`).join('');
    return `<div class="card chart"><h2>NS por mês</h2><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="NS por mês">${g}${bars}
      <line x1="${L}" x2="${W - R}" y1="${y(meta)}" y2="${y(meta)}" stroke="${css('--ink2')}" stroke-dasharray="4 3" stroke-width="1.5"/></svg>
      <div class="cap">* mês em andamento (parcial).</div></div>`;
  }
  function tabelaDias(days, meta) {
    return `<div class="card"><h2>Dias</h2><div style="overflow-x:auto"><table class="conf" style="cursor:default">
      <thead><tr><th>DIA</th><th>VOLUME</th><th>ATEND.</th><th>≤5 MIN</th><th>NS</th></tr></thead><tbody>
      ${days.map(d => `<tr style="cursor:default"><td>${esc(d.label)}</td><td>${fmtInt(d.volume)}</td><td>${fmtInt(d.total)}</td><td>${fmtInt(d.ate)}</td>
        <td><span class="pill ${statusOf(d.ns, meta)}">${fmtPct(d.ns)}</span></td></tr>`).join('')}</tbody></table></div></div>`;
  }
  function bindChartTaps(days, meta) {
    const cap = (id, txt) => { const c = $(id); if (c) c.textContent = txt; };
    const info = d => `${d.label} — NS ${fmtPct(d.ns)} · ${fmtInt(d.ate)} de ${fmtInt(d.total)} atendidas em até 5 min · volume ${fmtInt(d.volume)}`;
    [['#ch1', '#cap1'], ['#ch2', '#cap2']].forEach(([s, c]) => {
      const el = $(s); if (!el) return;
      el.addEventListener('click', e => { const t = e.target.closest('[data-i]'); if (t) cap(c, info(days[+t.dataset.i])); });
    });
  }

  // ---------------- Histórico ----------------
  function renderHist() {
    main.innerHTML = `
      <div class="card"><h2>Leituras salvas (${caps.length})</h2>
        ${caps.length ? `<div class="list">${caps.map(c => {
          const lab = c.rows.length ? `${esc(c.rows[0].label)} … ${esc(c.rows[c.rows.length - 1].label)}` : '';
          return `<div class="it" data-id="${c.id}">${c.thumb ? `<img src="${c.thumb}" alt="">` : ''}
            <div class="t"><b>${fmtDT(c.id)}</b>${c.editadas ? `<span class="badge">${c.editadas} editada(s)</span>` : ''}<div class="small muted">${c.rows.length} linhas · ${lab}</div></div>›</div>`;
        }).join('')}</div>` : '<div class="empty">Nada salvo ainda.</div>'}
      </div>
      <div class="card"><h2>Backup</h2>
        <div class="small muted" style="margin-bottom:10px">Os dados ficam só neste aparelho. Exporte de vez em quando.</div>
        <div class="row"><button class="btn sec" id="bExp">Exportar</button><button class="btn sec" id="bImp">Importar</button></div>
        <div class="small muted" id="persist" style="margin-top:10px"></div>
      </div>`;
    main.querySelectorAll('.it').forEach(it => it.onclick = () => openCap(+it.dataset.id));
    $('#bExp').onclick = exportar;
    $('#bImp').onclick = () => $('#fileImp').click();
    if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(p => {
      const el = $('#persist'); if (el) el.textContent = p ? 'Armazenamento protegido contra limpeza automática ✓' : 'Armazenamento pode ser limpo pelo navegador se faltar espaço — mantenha backup.';
    });
  }
  function openCap(id) {
    const c = caps.find(x => x.id === id); if (!c) return;
    const bg = document.createElement('div'); bg.className = 'sheet-bg';
    bg.innerHTML = `<div class="sheet"><h3>Leitura de ${fmtDT(c.id)}</h3>
      ${c.thumb ? `<img class="thumb" src="${c.thumb}" style="margin:8px 0">` : ''}
      <table class="conf" style="cursor:default"><thead><tr><th>PERÍODO</th><th>VOLUME</th><th>TOT</th><th>ATE5</th><th>NS</th></tr></thead><tbody>
      ${c.rows.map(r => `<tr style="cursor:default"><td>${esc(r.label)}</td>${['volume', 'total', 'ate'].map(k => `<td class="${r.origem && r.origem[k] === 'usuario' ? 'f-user' : ''}">${r[k]}</td>`).join('')}<td>${fmtNs(r.ns)}</td></tr>`).join('')}
      </tbody></table>
      <div class="small muted" style="margin:6px 0 12px">Em roxo: valores conferidos/editados por você.</div>
      <div class="row"><button class="btn sec" id="cClose">Fechar</button><button class="btn danger" id="cDel">Excluir leitura</button></div></div>`;
    document.body.appendChild(bg);
    bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });
    bg.querySelector('#cClose').onclick = () => bg.remove();
    bg.querySelector('#cDel').onclick = async () => {
      if (!await confirmDlg('Excluir esta leitura? Os gráficos passam a usar a leitura anterior de cada período.')) return;
      try { await dbDel(id); await reload(); bg.remove(); toast('Leitura excluída'); renderHist(); }
      catch (e) { alert('Erro ao excluir: ' + e.message); }
    };
  }
  function exportar() {
    const data = { app: 'ns-leitor', versao: APP_VERSION, exportadoEm: new Date().toISOString(), capturas: caps };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `ns-leitor-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  $('#fileImp').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || data.app !== 'ns-leitor' || !Array.isArray(data.capturas)) throw new Error('Arquivo não é um backup do NS Leitor.');
      const valid = data.capturas.filter(c => Number.isInteger(c.id) && Array.isArray(c.rows) && c.rows.every(r =>
        typeof r.ordem === 'string' && /^\d{8}$/.test(r.ordem) && [r.volume, r.total, r.ate].every(Number.isInteger) && r.ate <= r.total));
      if (valid.length !== data.capturas.length && !window.confirm(`${data.capturas.length - valid.length} leitura(s) do arquivo estão inválidas e serão ignoradas. Continuar?`)) return;
      const ids = new Set(caps.map(c => c.id));
      const novas = valid.filter(c => !ids.has(c.id));
      for (const c of novas) await dbPut(c);
      await reload();
      toast(`Importadas ${novas.length} leitura(s)` + (valid.length - novas.length ? ` · ${valid.length - novas.length} já existiam` : ''));
      renderHist();
    } catch (err) { alert('Não consegui importar: ' + err.message); }
  });

  // ---------------- Início ----------------
  window.addEventListener('beforeunload', e => { if (draft || busy) { e.preventDefault(); e.returnValue = ''; } });
  (async () => {
    try { await reload(); } catch (e) { main.innerHTML = `<div class="card"><div class="banner bad">Erro ao abrir os dados: ${esc(e.message)}</div></div>`; return; }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    go(caps.length ? 'painel' : 'captura');
  })();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__nsApp = { version: APP_VERSION, state: () => ({ caps, draft, view }), processFile, reload };
})();
