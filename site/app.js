/* 訊號終端 — GitHub Pages 主站
 * 資料：data/snapshot.json（GitHub 排程產生）→ 過舊或抓不到時改向 NAS 備援
 * 持股：只存在這台裝置的瀏覽器（localStorage），不會上傳
 * 本機加速：自動偵測 localhost 的 NPU(8766)／CPU(8767)／語言模型(8768)
 */
(function () {
  'use strict';

  // ── 基本工具 ────────────────────────────────────────────────
  const $ = s => document.querySelector(s);
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  };
  const DEF = { colors: 'tw', nasUrl: '', localHost: 'localhost', localEnabled: true, limits: { var95: 2.5, single: 20, cashMin: 10 } };
  const cfg = Object.assign({}, DEF, LS.get('cfg', {}));
  cfg.limits = Object.assign({}, DEF.limits, cfg.limits || {});
  const saveCfg = () => LS.set('cfg', cfg);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const sign = v => (v > 0 ? '+' : v < 0 ? '−' : '');
  const fix = (v, d = 2) => (isNum(v) ? Math.abs(v).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const pct = (v, d = 2) => (isNum(v) ? sign(v) + fix(v, d) + '%' : '—');
  const num = (v, d = 2) => (isNum(v) ? (v < 0 ? '−' : '') + fix(v, d) : '—');
  const int = v => (isNum(v) ? (v < 0 ? '−' : '') + Math.round(Math.abs(v)).toLocaleString('zh-TW') : '—');
  const px = v => (!isNum(v) ? '—' : num(v, v >= 1000 ? 0 : v >= 100 ? 1 : 2));
  const cls = (v, inverse) => (!isNum(v) || v === 0 ? 'flat' : (v > 0) !== !!inverse ? 'up' : 'down');
  const SIG = { BUY: '買進', SELL: '賣出', HOLD: '觀望' };
  const sigCls = s => (s === 'BUY' ? 'buy' : s === 'SELL' ? 'sell' : '');
  const EVK = [['tech', '技術'], ['chip', '籌碼'], ['fund', '基本面'], ['model', '模型']];
  const EVW = { pos: '支持', neg: '反對', neu: '中性' };
  const ago = iso => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!isNum(m)) return '—';
    if (m < 1) return '剛剛'; if (m < 60) return `${m} 分鐘前`;
    const h = Math.round(m / 60); return h < 48 ? `${h} 小時前` : `${Math.round(h / 24)} 天前`;
  };
  const tpeTime = iso => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

  async function getJSON(url, ms = 10000) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
    try { const r = await fetch(url, { cache: 'no-store', signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { clearTimeout(t); }
  }
  async function postJSON(url, body, ms = 15000) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
    try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { clearTimeout(t); }
  }

  // ── 狀態 ────────────────────────────────────────────────────
  const S = { snap: null, source: null, base: 'data/', bars: {}, local: { checked: false }, localPreds: {}, llm: {}, route: '' };
  const nasBase = () => (cfg.nasUrl || '').trim().replace(/\/+$/, '');

  /** 盤中超過 75 分鐘、或平常超過 3 天沒更新，就算過舊 */
  function isStale(iso) {
    const age = Date.now() - Date.parse(iso);
    const d = new Date(), wd = d.getUTCDay(), h = d.getUTCHours() + d.getUTCMinutes() / 60;
    const inMarket = wd >= 1 && wd <= 5 && ((h >= 1 && h <= 5.7) || (h >= 13.5 && h <= 21.2));
    return inMarket ? age > 75 * 60000 : age > 3 * 86400000;
  }

  async function loadSnapshot() {
    let gh = null, nas = null;
    try { gh = await getJSON('data/snapshot.json?t=' + Date.now()); } catch (_) {}
    if (nasBase() && (!gh || isStale(gh.generatedAt))) {
      try { nas = await getJSON(nasBase() + '/backup/data/snapshot.json?t=' + Date.now()); } catch (_) {}
    }
    if (nas && (!gh || Date.parse(nas.generatedAt) > Date.parse(gh.generatedAt))) { S.snap = nas; S.source = 'nas'; S.base = nasBase() + '/backup/data/'; }
    else if (gh) { S.snap = gh; S.source = 'github'; S.base = 'data/'; }
    else throw new Error(nasBase() ? 'GitHub 與 NAS 都取不到資料' : 'GitHub 取不到資料（可在設定填入 NAS 備援網址）');
    S.bars = {};
    updateDataPill();
  }

  async function loadBars(key) {
    if (S.bars[key]) return S.bars[key];
    const f = String(key).replace(/[^A-Za-z0-9_.-]/g, '_') + '.json';
    let b = null;
    try { b = await getJSON(S.base + 'bars/' + f); } catch (_) {
      if (S.source === 'github' && nasBase()) { try { b = await getJSON(nasBase() + '/backup/data/bars/' + f); } catch (_) {} }
    }
    if (b) S.bars[key] = b;
    return b;
  }

  function updateDataPill() {
    const el = $('#pill-data'); if (!el || !S.snap) return;
    const stale = isStale(S.snap.generatedAt);
    el.className = 'pill ' + (stale ? 'warn' : S.source === 'nas' ? 'warn' : 'ok');
    el.querySelector('.t').textContent = `${S.source === 'nas' ? 'NAS 備援' : 'GitHub'}・${tpeTime(S.snap.generatedAt)} 更新`;
    const bn = $('#banner');
    if (stale) { bn.hidden = false; bn.className = 'banner'; bn.textContent = `資料已 ${ago(S.snap.generatedAt)} 沒更新${nasBase() ? '' : '。可到「設定」填入 NAS 備援網址'}。`; }
    else if (S.source === 'nas') { bn.hidden = false; bn.className = 'banner'; bn.textContent = 'GitHub 資料過舊或取不到，目前顯示 NAS 備援資料。'; }
    else bn.hidden = true;
  }

  // ── 本機加速 ────────────────────────────────────────────────
  const LOCAL = { npu: { port: 8766, label: 'NPU' }, cpu: { port: 8767, label: 'CPU' }, llm: { port: 8768, label: '語言模型' } };
  const localUrl = (k, p) => `http://${cfg.localHost || 'localhost'}:${LOCAL[k].port}${p}`;

  async function probeLocal() {
    if (!cfg.localEnabled) { S.local = { checked: true, off: true }; updateLocalPill(); return; }
    const r = { checked: true };
    await Promise.all(Object.keys(LOCAL).map(async k => {
      try { const j = await getJSON(localUrl(k, '/health'), 1500); r[k] = j.status === 'ok'; } catch (_) { r[k] = false; }
    }));
    S.local = r; updateLocalPill();
  }
  const localAny = () => S.local.npu || S.local.cpu || S.local.llm;
  function updateLocalPill() {
    const el = $('#pill-local'); if (!el) return;
    if (!S.local.checked) return;
    if (S.local.off) { el.className = 'pill'; el.querySelector('.t').textContent = '本機加速已關閉'; return; }
    const on = Object.keys(LOCAL).filter(k => S.local[k]).map(k => LOCAL[k].label);
    el.className = 'pill ' + (on.length ? 'ok' : '');
    el.querySelector('.t').textContent = on.length ? `本機加速：${on.join('、')}` : '雲端模式';
  }

  async function localPredict(keys) {
    const eng = S.local.npu ? 'npu' : S.local.cpu ? 'cpu' : null;
    if (!eng) return false;
    const stocks = [];
    for (const k of keys) { if (S.localPreds[k]) continue; const b = await loadBars(k); if (b) stocks.push({ sym: k, history: b.close.slice(-120) }); }
    if (!stocks.length) return true;
    try {
      const j = await postJSON(localUrl(eng, '/predict/batch'), { stocks }, 8000);
      for (const [k, v] of Object.entries(j.results || {})) S.localPreds[k] = { d1: v.d1_pct, d5: v.d5_pct, eng: LOCAL[eng].label };
      return true;
    } catch (_) { return false; }
  }

  async function askLLM(q, sym) {
    if (!S.local.llm) return null;
    try { const j = await postJSON(localUrl('llm', '/api/ask'), { q, sym, stream: false }, 60000); return (j.answer || '').trim() || null; }
    catch (_) { return null; }
  }

  // ── 持股（只存在瀏覽器）─────────────────────────────────────
  const H = { load: () => LS.get('holdings', { items: [], cash: 0 }), save: h => LS.set('holdings', h) };
  const fx = () => (S.snap.env.find(e => e.key === 'twd')?.value) || 32;
  function holdings() {
    const h = H.load(), rate = fx();
    const rows = h.items.map(x => {
      const it = S.snap.items[x.key];
      const k = it?.market === 'us' ? rate : 1;
      const mv = it && isNum(it.price) ? it.price * x.shares * k : null;
      const cost = isNum(x.cost) ? x.cost * x.shares * k : null;
      return { ...x, it, mv, cost, pnl: mv != null && cost != null ? mv - cost : null, day: it && isNum(it.prevClose) ? (it.price - it.prevClose) * x.shares * k : null };
    });
    const stock = rows.reduce((s, r) => s + (r.mv || 0), 0);
    const cash = Number(h.cash) || 0, total = stock + cash;
    const tw = rows.filter(r => r.it?.market === 'tw').reduce((s, r) => s + (r.mv || 0), 0);
    const us = rows.filter(r => r.it?.market === 'us').reduce((s, r) => s + (r.mv || 0), 0);
    const day = rows.reduce((s, r) => s + (r.day || 0), 0);
    const pnl = rows.reduce((s, r) => s + (r.pnl || 0), 0), cost = rows.reduce((s, r) => s + (r.cost || 0), 0);
    const maxPos = rows.reduce((m, r) => (r.mv && total ? Math.max(m, r.mv / total * 100) : m), 0);
    const maxRow = rows.slice().sort((a, b) => (b.mv || 0) - (a.mv || 0))[0];
    return { rows, stock, cash, total, tw, us, day, dayPct: total - day > 0 ? day / (total - day) * 100 : null, pnl, pnlPct: cost > 0 ? pnl / cost * 100 : null, maxPos, maxRow, missing: rows.filter(r => !r.it) };
  }
  /** 組合 1 日風險值（歷史法 95%）：依共同交易日對齊各持股日報酬 */
  async function portfolioVaR(P) {
    const rows = P.rows.filter(r => r.mv > 0 && r.it);
    if (!rows.length || !P.total) return null;
    const bars = await Promise.all(rows.map(r => loadBars(r.key)));
    if (bars.some(b => !b)) return null;
    let common = new Set(bars[0].dates);
    for (const b of bars.slice(1)) { const s = new Set(b.dates); common = new Set([...common].filter(d => s.has(d))); }
    const dates = [...common].sort().slice(-253);
    if (dates.length < 60) return null;
    const maps = bars.map(b => new Map(b.dates.map((d, i) => [d, b.close[i]])));
    const rets = [];
    for (let i = 1; i < dates.length; i++) {
      let r = 0;
      rows.forEach((row, j) => { r += (row.mv / P.total) * (maps[j].get(dates[i]) / maps[j].get(dates[i - 1]) - 1); });
      rets.push(r);
    }
    rets.sort((a, b) => a - b);
    return -rets[Math.floor(0.05 * rets.length)] * 100;
  }

  // ── 共用元件 ────────────────────────────────────────────────
  const evDots = ev => `<span class="ev" role="img" aria-label="${EVK.map(([k, l]) => `${l}${ev[k] ? EVW[ev[k]] : '無資料'}`).join('、')}">${EVK.map(([k, l]) => `<span><i class="${ev[k] || 'na'}" aria-hidden="true"></i>${l[0]}</span>`).join('')}</span>`;
  const sigTag = s => `<span class="tag ${sigCls(s)}">${SIG[s] || s}</span>`;
  const nameOf = k => S.snap.items[k]?.name || k;

  // ── 總覽 ────────────────────────────────────────────────────
  function viewHome() {
    const s = S.snap, v = s.verdict, P = holdings();
    const holdChanges = [];
    if (P.total && P.maxPos > cfg.limits.single) holdChanges.push({ tag: '持股', title: `${P.maxRow.key} ${nameOf(P.maxRow.key)} 占 ${P.maxPos.toFixed(0)}%，超過單一持股上限 ${cfg.limits.single}%`, detail: '可考慮減碼，或調整上限（設定）', key: P.maxRow.key });
    if (P.total && P.cash / P.total * 100 < cfg.limits.cashMin) holdChanges.push({ tag: '持股', title: `現金比例 ${(P.cash / P.total * 100).toFixed(0)}%，低於下限 ${cfg.limits.cashMin}%`, detail: '' });
    for (const r of P.rows) {
      const c = s.changes.find(x => x.key === r.key);
      if (c) holdChanges.push({ ...c, tag: c.tag, title: '（持有中）' + c.title });
    }
    const changes = [...holdChanges, ...s.changes.filter(c => !P.rows.some(r => r.key === c.key))].slice(0, 8);
    return `
<section class="verdict" aria-labelledby="v-h">
  <div class="l">
    <div class="k"><span>今日判斷・${esc(tpeTime(s.generatedAt))}</span>${v.trend ? `<span class="trend">${esc(v.trend)}</span>` : ''}</div>
    <h1 id="v-h">${esc(v.headline)}</h1>
    <p>${esc(v.detail)}</p>
    <div id="ai-verdict"></div>
  </div>
  <div class="r">
    <div class="small" style="color:var(--topmute)">判斷依據（${v.points > 0 ? '+' : ''}${v.points} 分）</div>
    <div class="chips">${v.reasons.map(r => `<span class="chip ${r.pts < 0 ? 'neg' : 'pos'}">${esc(r.text)}</span>`).join('') || '<span class="chip">資料不足</span>'}</div>
  </div>
</section>

<section aria-labelledby="env-h">
  <div class="hd" style="margin-bottom:10px"><h2 id="env-h">市場環境</h2><span class="note">漲跌皆相對前一交易日收盤</span></div>
  <div class="env">${s.env.map(e => `
    <div class="tile"><div class="lb">${esc(e.label)}</div>
      <div class="v"><b>${e.key === 'curve' ? (e.value > 0 ? '+' : '') + num(e.value) : e.key === 'foreign' ? int(e.value) : e.key === 'twd' ? num(e.value, 3) : num(e.value, e.value >= 1000 ? 0 : 2)}${e.unit && e.key !== 'curve' ? ` <small style="font-size:13px">${esc(e.unit)}</small>` : ''}</b>
      ${isNum(e.changePct) ? `<span class="${cls(e.changePct, e.inverse)}">${pct(e.changePct)}</span>` : isNum(e.change) ? `<span class="${cls(e.change)}">${sign(e.change)}${fix(e.change)}</span>` : ''}</div>
      <div class="m">${esc(e.meaning)}</div></div>`).join('')}</div>
</section>

<div class="row">
  <section class="card wide" aria-labelledby="pf-h">${viewHoldingsCard(P)}</section>
  <section class="card side" aria-labelledby="chg-h">
    <div class="hd"><h2 id="chg-h">今天有什麼變了</h2><span class="note">依影響程度排序</span></div>
    ${changes.length ? `<ol class="list">${changes.map(c => `<li><span class="tag t-${esc(c.tag)}">${esc(c.tag)}</span><div>${c.key ? `<a class="t" href="#/s/${encodeURIComponent(c.key)}">${esc(c.title)}</a>` : `<div class="t">${esc(c.title)}</div>`}${c.detail ? `<div class="d">${esc(c.detail)}</div>` : ''}</div></li>`).join('')}</ol>` : '<p class="empty">沒有值得注意的變化。</p>'}
  </section>
</div>

<section class="card" id="opps" aria-labelledby="opp-h">${viewOpps(10)}</section>

<div class="row">
  <section class="card wide" aria-labelledby="sec-h">${viewSectors()}</section>
  <section class="card side" aria-labelledby="sc-h">${viewScoreMini()}</section>
</div>
${s.chipMarket ? `<section class="card" aria-labelledby="cm-h">${viewChipMarket()}</section>` : ''}
${footer()}`;
  }

  function viewHoldingsCard(P) {
    if (!P.rows.length && !P.cash) return `
      <div class="hd"><h2 id="pf-h">我的部位</h2></div>
      <p class="empty">還沒有輸入持股。持股只存在這台裝置的瀏覽器，不會上傳到網站。</p>
      <div><a class="btn primary" href="#/portfolio">新增持股</a></div>`;
    const L = cfg.limits;
    const w = v => (P.total ? (v / P.total * 100) : 0);
    const meter = (label, val, limit, unit, higherBad = true, id = '') => {
      const ok = val == null ? null : higherBad ? val <= limit : val >= limit;
      const color = ok == null ? 'var(--faint)' : ok ? 'var(--acc)' : 'var(--bad)';
      const scale = Math.max(limit * 1.25, val || 0);
      return `<div class="limit"${id ? ` id="${id}"` : ''}><div>${label}</div><div class="meter" role="img" aria-label="${label} ${val == null ? '計算中' : val.toFixed(1) + unit}，${higherBad ? '上限' : '下限'} ${limit}${unit}"><div style="width:${val == null ? 0 : Math.min(100, val / scale * 100)}%;background:${color}"></div><i style="left:${limit / scale * 100}%"></i></div><div class="mono" style="text-align:right"><b style="color:${color}">${val == null ? '…' : val.toFixed(1) + unit}</b> / ${limit}${unit}</div></div>`;
    };
    return `
      <div class="hd"><h2 id="pf-h">我的部位</h2><span class="note">新台幣計價・美股以美元兌台幣 ${num(fx(), 2)} 換算・只存在本機</span><a class="act" href="#/portfolio">編輯</a></div>
      <div class="kpis">
        <div class="kpi"><div class="lb">總市值</div><div class="v">${int(P.total)}</div></div>
        <div class="kpi"><div class="lb">今日損益</div><div class="v ${cls(P.day)}">${sign(P.day)}${int(Math.abs(P.day))}</div><div class="small ${cls(P.day)}">${pct(P.dayPct)}</div></div>
        <div class="kpi"><div class="lb">未實現損益</div><div class="v ${cls(P.pnl)}">${sign(P.pnl)}${int(Math.abs(P.pnl))}</div><div class="small ${cls(P.pnl)}">${pct(P.pnlPct)}</div></div>
        <div class="kpi"><div class="lb">現金</div><div class="v">${P.total ? w(P.cash).toFixed(0) : 0}%</div></div>
      </div>
      <div>
        <div class="bar" role="img" aria-label="台股 ${w(P.tw).toFixed(0)}%、美股 ${w(P.us).toFixed(0)}%、現金 ${w(P.cash).toFixed(0)}%"><div style="width:${w(P.tw)}%;background:var(--acc)"></div><div style="width:${w(P.us)}%;background:var(--acc2)"></div><div style="width:${w(P.cash)}%;background:#D5D9E0"></div></div>
        <div class="legend" style="margin-top:6px"><span><i style="background:var(--acc)"></i>台股 ${w(P.tw).toFixed(0)}%</span><span><i style="background:var(--acc2)"></i>美股 ${w(P.us).toFixed(0)}%</span><span><i style="background:#D5D9E0"></i>現金 ${w(P.cash).toFixed(0)}%</span></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="small" style="font-weight:500;color:var(--ink)">風險 vs 自訂上限</div>
        ${meter('1 日風險值（95%）', null, L.var95, '%', true, 'pf-var')}
        ${meter('最大單一持股', P.total ? P.maxPos : null, L.single, '%')}
        ${meter('現金比例', P.total ? w(P.cash) : null, L.cashMin, '%', false)}
      </div>
      ${P.missing.length ? `<p class="small bad-text">${P.missing.map(r => esc(r.key)).join('、')} 不在觀察清單，沒有報價。請加到 config/watchlist.json。</p>` : ''}`;
  }

  function viewOpps(n) {
    const s = S.snap, keys = s.ranking.slice(0, n || s.ranking.length);
    const lp = Object.keys(S.localPreds).length > 0;
    const row = (k, i) => {
      const it = s.items[k], g = it.signal, l = S.localPreds[k];
      return `<tr><td class="num muted">${i + 1}</td>
        <td><a class="sym" href="#/s/${encodeURIComponent(k)}">${esc(k)}</a> <span class="small muted">${esc(it.name)}</span></td>
        <td class="num">${px(it.price)}</td><td class="num ${cls(it.changePct)}">${pct(it.changePct)}</td>
        <td>${sigTag(g.sig)}</td><td>${evDots(g.evidence)}</td><td class="num"><b>${g.score}</b></td>
        <td class="num">${px(g.stop)}</td>
        ${lp ? `<td class="num ${l ? cls(l.d1) : ''}">${l ? pct(l.d1) : '—'}</td><td class="num ${l ? cls(l.d5) : ''}">${l ? pct(l.d5) : '—'}</td>` : ''}</tr>`;
    };
    const card = k => {
      const it = s.items[k], g = it.signal, l = S.localPreds[k];
      return `<a class="ocard" href="#/s/${encodeURIComponent(k)}"><div class="r1"><b>${esc(k)}</b><span class="small muted">${esc(it.name)}</span>${sigTag(g.sig)}</div>
        <div class="r2"><span class="mono" style="font-size:17px;font-weight:600">${px(it.price)}</span><span class="mono small ${cls(it.changePct)}">${pct(it.changePct)}</span><span class="small muted" style="margin-left:auto">分數 ${g.score}・停損 ${px(g.stop)}</span></div>
        <div>${evDots(g.evidence)}${l ? `<span class="small muted" style="margin-left:10px">本機預測 5 日 <b class="${cls(l.d5)}">${pct(l.d5)}</b></span>` : ''}</div></a>`;
    };
    return `
      <div class="hd"><h2 id="opp-h">機會清單</h2><span class="note">依綜合分數排序・證據：技術／籌碼／基本面／模型（${cfg.colors === 'us' ? '實心綠' : '實心紅'}＝支持、${cfg.colors === 'us' ? '實心紅' : '實心綠'}＝反對、空心＝中性、虛線＝無資料）</span>${n ? `<a class="act" href="#/all">看全部 ${s.ranking.length} 檔</a>` : ''}</div>
      <div class="tbl-box opp"><table class="tbl"><thead><tr><th>#</th><th>標的</th><th class="num">價格</th><th class="num">今日</th><th>判斷</th><th>證據</th><th class="num">分數</th><th class="num">停損價（2 倍 ATR）</th>${lp ? '<th class="num">本機 1 日</th><th class="num">本機 5 日</th>' : ''}</tr></thead>
      <tbody>${keys.map(row).join('')}</tbody></table></div>
      <div class="cards">${keys.map(card).join('')}</div>
      <p class="small muted" style="margin:0">買進門檻 ${s.items[keys[0]]?.signal.buyThreshold ?? 63} 分（VIX 越高門檻越高）、賣出門檻 37 分。模型以「隔日漲跌」訓練，僅供參考。</p>`;
  }

  function viewSectors() {
    const sec = S.snap.sectors; if (!sec.length) return '<div class="hd"><h2 id="sec-h">美股板塊輪動</h2></div><p class="empty">暫無資料</p>';
    const mx = Math.max(...sec.map(x => Math.abs(x.ret21 || 0)), 1);
    return `<div class="hd"><h2 id="sec-h">美股板塊輪動</h2><span class="note">近 1 個月（21 個交易日）報酬</span></div>
      <div style="display:flex;flex-direction:column;gap:6px">${sec.map(x => `<div class="sec"><div>${esc(x.name)} <span class="small muted">${esc(x.etf)}</span></div>
        <div class="neg"><div style="width:${x.ret21 < 0 ? (-x.ret21 / mx * 100) : 0}%"></div></div><div class="pos"><div style="width:${x.ret21 > 0 ? (x.ret21 / mx * 100) : 0}%"></div></div>
        <div class="mono ${cls(x.ret21)}" style="text-align:right">${pct(x.ret21, 1)}</div></div>`).join('')}</div>`;
  }

  function scoreRows(d) {
    return [['隔日（1 個交易日）', d.h1], ['5 個交易日', d.h5], ['20 個交易日', d.h20]].map(([l, r]) => `
      <div style="display:flex;flex-direction:column;gap:6px"><div style="display:flex;justify-content:space-between;font-size:13px"><span>${l}</span><span class="mono"><b>${r.rate == null ? '—' : r.rate.toFixed(0) + '%'}</b> <span class="muted">（${r.n} 筆）</span></span></div>
      <div class="meter" role="img" aria-label="${l}命中率 ${r.rate == null ? '尚無資料' : r.rate.toFixed(0) + '%'}，${r.n} 筆"><div style="width:${r.rate || 0}%;background:${r.n < 30 ? 'var(--faint)' : 'var(--acc)'}"></div><i style="left:50%"></i></div></div>`).join('');
  }
  function viewScoreMini() {
    const sc = S.snap.scorecard;
    return `<div class="hd"><h2 id="sc-h">模型成績單</h2><span class="note">近 30 天</span><a class="act" href="#/scorecard">詳細</a></div>
      ${scoreRows(sc.d30)}<p class="small muted" style="margin:0">黑線＝50%（擲硬幣）；灰色＝樣本少於 30 筆，僅供參考。${sc.since ? `自 ${esc(sc.since)} 起累積 ${sc.total} 筆。` : '收盤後開始累積紀錄。'}</p>`;
  }

  function viewChipMarket() {
    const c = S.snap.chipMarket;
    const d = c.date ? `${c.date.slice(0, 4)}/${c.date.slice(4, 6)}/${c.date.slice(6, 8)}` : '';
    const list = (title, rows, key) => `<div style="flex:1 1 280px;min-width:0"><div class="small" style="font-weight:600;margin-bottom:6px">${title}</div>
      <table class="tbl" style="min-width:0"><tbody>${rows.slice(0, 6).map(r => `<tr><td style="padding:7px 6px">${esc(r.id)} <span class="small muted">${esc(r.name)}</span></td><td class="num small" style="padding:7px 6px">${int(r[key])} 張</td><td class="num small ${cls(r.chgPct)}" style="padding:7px 6px">${pct(r.chgPct)}</td></tr>`).join('')}</tbody></table></div>`;
    return `<div class="hd"><h2 id="cm-h">台股三大法人</h2><span class="note">${d} 收盤・外資合計約 ${int(c.foreignValueEst / 1e8)} 億（以收盤價估算）</span></div>
      <div class="row" style="gap:16px">${list('外資買超', c.topForeignBuy, 'foreign')}${list('外資賣超', c.topForeignSell, 'foreign')}${list('投信買超', c.topTrustBuy, 'trust')}</div>`;
  }

  function footer() {
    return `<footer class="src">資料來源：Yahoo 財經（報價、日 K）、臺灣證券交易所（三大法人、收盤行情）、FinMind（法人歷史、月營收）、芝加哥選擇權交易所（VIX 恐慌指數）、美國財政部（公債殖利率）。
      訊號與模型為統計推估，非投資建議。資料${S.source === 'nas' ? '來自 NAS 備援' : '由 GitHub 排程產生'}，${esc(tpeTime(S.snap.generatedAt))}（${ago(S.snap.generatedAt)}）。</footer>`;
  }

  async function afterHome() {
    const P = holdings();
    if (P.rows.length) {
      const v = await portfolioVaR(P);
      const el = $('#pf-var');
      if (el && S.route === 'home') {
        const L = cfg.limits.var95, ok = v != null && v <= L, color = v == null ? 'var(--faint)' : ok ? 'var(--acc)' : 'var(--bad)', sc = Math.max(L * 1.25, v || 0);
        el.querySelector('.meter > div').style.cssText = `width:${v == null ? 0 : Math.min(100, v / sc * 100)}%;background:${color}`;
        el.querySelector('.meter > i').style.left = (L / sc * 100) + '%';
        el.querySelector('.mono').innerHTML = `<b style="color:${color}">${v == null ? '資料不足' : v.toFixed(1) + '%'}</b> / ${L}%`;
        el.querySelector('.meter').setAttribute('aria-label', `1 日風險值 ${v == null ? '資料不足' : v.toFixed(1) + '%'}，上限 ${L}%`);
      }
    }
    if (S.local.npu || S.local.cpu) {
      const ok = await localPredict(S.snap.ranking.slice(0, 10));
      if (ok && S.route === 'home') { const box = $('#opps'); if (box) box.innerHTML = viewOpps(10); }
    }
    if (S.local.llm && S.route === 'home') {
      const key = 'verdict:' + S.snap.generatedAt;
      const box = $('#ai-verdict');
      if (box) box.innerHTML = '<div class="ai"><b>本機 AI 解讀</b>產生中…</div>';
      if (!S.llm[key]) {
        const v = S.snap.verdict;
        const envTxt = S.snap.env.map(e => `${e.label} ${e.value}${e.unit || ''} ${isNum(e.changePct) ? pct(e.changePct) : ''}（${e.meaning}）`).join('；');
        S.llm[key] = await askLLM(`以下是今天的市場環境與規則判斷，請用繁體中文寫 2 句話給一般投資人：第一句說明現在市場的重點，第二句說明該怎麼做。不要列點，不要超過 80 字。\n判斷：${v.headline}\n理由：${v.detail}\n環境：${envTxt}`) || '';
      }
      const b2 = $('#ai-verdict');
      if (b2 && S.route === 'home') b2.innerHTML = S.llm[key] ? `<div class="ai"><b>本機 AI 解讀</b>${esc(S.llm[key])}</div>` : '';
    }
  }

  // ── 個股頁 ──────────────────────────────────────────────────
  function thesis(it, P) {
    const pros = [], cons = [], ta = it.ta || {}, c = it.chip, f = it.fund, m = it.ml;
    if (ta.ma20) (it.price > ta.ma20 ? pros : cons).push(`收盤${it.price > ta.ma20 ? '站上' : '跌破'} 20 日均線（${px(ta.ma20)}）`);
    if (ta.cross === 'golden') pros.push('20 日線在 60 日線之上（多頭排列）'); else if (ta.cross === 'death') cons.push('20 日線在 60 日線之下（空頭排列）');
    if (isNum(ta.rsi)) { if (ta.rsi < 30) pros.push(`相對強弱 RSI ${ta.rsi.toFixed(0)}，進入超賣區`); else if (ta.rsi > 70) cons.push(`相對強弱 RSI ${ta.rsi.toFixed(0)}，進入超買區`); }
    if (c?.foreignStreak >= 3) pros.push(`外資連 ${c.foreignStreak} 日買超`); else if (c?.foreignStreak <= -3) cons.push(`外資連 ${-c.foreignStreak} 日賣超`);
    if (isNum(c?.trust5) && Math.abs(c.trust5) > 0) (c.trust5 > 0 ? pros : cons).push(`投信近 5 日${c.trust5 > 0 ? '買超' : '賣超'} ${int(Math.abs(c.trust5))} 張`);
    if (isNum(f?.revenueYoY)) { if (f.revenueYoY >= 10) pros.push(`月營收年增 ${f.revenueYoY.toFixed(0)}%（${esc(f.revenuePeriod || '')}）`); else if (f.revenueYoY < 0) cons.push(`月營收年減 ${Math.abs(f.revenueYoY).toFixed(0)}%（${esc(f.revenuePeriod || '')}）`); }
    if (isNum(f?.recommendationMean)) { if (f.recommendationMean <= 2.2) pros.push(`分析師平均評等偏買進（${f.recommendationMean.toFixed(1)}，1＝強力買進）`); else if (f.recommendationMean >= 3) cons.push(`分析師平均評等偏保守（${f.recommendationMean.toFixed(1)}）`); }
    if (isNum(f?.targetPrice) && it.price) { const u = (f.targetPrice / it.price - 1) * 100; if (u > 10) pros.push(`分析師目標價 ${px(f.targetPrice)}，高於現價 ${u.toFixed(0)}%`); else if (u < -5) cons.push(`分析師目標價 ${px(f.targetPrice)}，低於現價 ${(-u).toFixed(0)}%`); }
    if (isNum(f?.revenueGrowth) && f.revenueGrowth < 0) cons.push(`營收年減 ${Math.abs(f.revenueGrowth).toFixed(0)}%`);
    if (m && isNum(m.buyProb)) { if (it.signal.evidence.model === 'pos') pros.push(`模型隔日上漲機率 ${(m.buyProb * 100).toFixed(0)}%`); else if (it.signal.evidence.model === 'neg') cons.push(`模型隔日下跌機率 ${(m.sellProb * 100).toFixed(0)}%`); }
    if (f?.earningsDate) { const d = Math.round((Date.parse(f.earningsDate) - Date.now()) / 86400000); if (d >= 0 && d <= 14) cons.push(`財報 ${esc(f.earningsDate)}（${d} 天後），前後波動放大`); }
    if (isNum(ta.var95) && ta.var95 > 3.5) cons.push(`1 日風險值 ${ta.var95.toFixed(1)}%，波動偏大`);
    const pos = P.rows.find(r => r.key === it.key);
    if (pos && P.total && pos.mv / P.total * 100 > cfg.limits.single) cons.push(`占持股 ${(pos.mv / P.total * 100).toFixed(0)}%，超過單一持股上限 ${cfg.limits.single}%`);
    return { pros, cons, pos };
  }

  function lineChart(b, it) {
    const n = Math.min(120, b.close.length), c = b.close.slice(-n), d = b.dates.slice(-n);
    const maS = k => b.close.map((_, i) => i < k - 1 ? null : b.close.slice(i - k + 1, i + 1).reduce((s, v) => s + v, 0) / k).slice(-n);
    const m20 = maS(20), m60 = maS(60), stop = it.signal.stop;
    const vals = [...c, ...m20.filter(isNum), ...m60.filter(isNum), ...(isNum(stop) ? [stop] : [])];
    let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    const W = 1200, Hh = 300, x = i => (i / (n - 1) * W).toFixed(1), y = v => (Hh - (v - lo) / (hi - lo) * Hh).toFixed(1);
    const path = a => a.map((v, i) => (v == null ? '' : `${a[i - 1] == null ? 'M' : 'L'}${x(i)},${y(v)}`)).join('');
    const grid = [0.25, 0.5, 0.75].map(t => { const v = lo + (hi - lo) * t; return `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#EEF0F3"/><text x="4" y="${(+y(v) - 5).toFixed(1)}" font-size="14" fill="#8A93A3">${px(v)}</text>`; }).join('');
    return `<svg viewBox="0 0 ${W} ${Hh + 22}" role="img" aria-label="近 ${n} 個交易日收盤價，20 日線 ${px(m20[n - 1])}，60 日線 ${px(m60[n - 1])}">
      ${grid}<path d="${path(m60)}" fill="none" stroke="#B9C0CC" stroke-width="1.5" stroke-dasharray="4 3"/><path d="${path(m20)}" fill="none" stroke="#6E8EEB" stroke-width="1.5"/>
      <path d="${path(c)}" fill="none" stroke="#15181D" stroke-width="2"/>
      ${isNum(stop) && stop > lo ? `<line x1="0" x2="${W}" y1="${y(stop)}" y2="${y(stop)}" stroke="#B91C1C" stroke-dasharray="6 4"/><text x="${W - 4}" y="${(+y(stop) - 5).toFixed(1)}" text-anchor="end" font-size="14" fill="#B91C1C">停損 ${px(stop)}</text>` : ''}
      <text x="0" y="${Hh + 18}" font-size="14" fill="#8A93A3">${esc(d[0])}</text><text x="${W}" y="${Hh + 18}" font-size="14" fill="#8A93A3" text-anchor="end">${esc(d[n - 1])}</text></svg>`;
  }

  function viewStock(key, b) {
    const it = S.snap.items[key];
    if (!it) return `<section class="card"><h2 style="margin:0">找不到 ${esc(key)}</h2><p class="empty">這個代號不在觀察清單。要追蹤請加到 GitHub 專案的 config/watchlist.json。</p><div><a class="btn" href="#/">回總覽</a></div></section>`;
    const P = holdings(), T = thesis(it, P), g = it.signal, ta = it.ta || {}, f = it.fund || {}, c = it.chip;
    const lp = S.localPreds[key];
    const range52 = isNum(ta.high52) && isNum(ta.low52) && ta.high52 > ta.low52 ? (it.price - ta.low52) / (ta.high52 - ta.low52) * 100 : null;
    const hist = (b?.chipHistory || []).slice(-20);
    const fmx = Math.max(...hist.map(h => Math.abs(h.foreign || 0)), 1);
    const preds = (b?.predictions || []).slice().reverse();
    const pos = T.pos;
    return `
<div><a href="#/" class="small">← 回總覽</a></div>
<section class="card" aria-labelledby="s-h">
  <div class="hd"><h1 id="s-h" style="margin:0;font-size:22px">${esc(key)} ${esc(it.name)}</h1><span class="note">${it.market === 'tw' ? '台股' : '美股'}・${esc(it.currency || '')}${pos ? `・持有 ${int(pos.shares)} 股` : ''}</span></div>
  <div class="quote">
    <div><div style="display:flex;align-items:baseline;gap:12px"><span class="px">${px(it.price)}</span><span class="ch ${cls(it.changePct)}">${sign(it.price - it.prevClose)}${fix(Math.abs(it.price - it.prevClose), it.price >= 100 ? 1 : 2)}（${pct(it.changePct)}）</span></div>
      <div class="small muted">${esc(it.marketDate)}・成交量為 20 日均量 ${isNum(ta.relVolume) ? ta.relVolume.toFixed(1) : '—'} 倍</div></div>
    <div style="display:flex;align-items:center;gap:12px"><span class="tag ${sigCls(g.sig)}" style="font-size:14px;padding:6px 14px">${SIG[g.sig]}</span><div><div class="small muted">綜合分數</div><div class="mono" style="font-size:20px;font-weight:600">${g.score} / 100</div></div></div>
    <div class="evbig" role="img" aria-label="${EVK.map(([k, l]) => `${l}${g.evidence[k] ? EVW[g.evidence[k]] : '無資料'}`).join('、')}">${EVK.map(([k, l]) => `<span><i class="${g.evidence[k] || 'na'}" style="width:10px;height:10px;border-radius:50%;border:1px solid var(--faint);display:inline-block;background:${g.evidence[k] === 'pos' ? 'var(--up)' : g.evidence[k] === 'neg' ? 'var(--down)' : '#fff'}"></i>${l}：${g.evidence[k] ? EVW[g.evidence[k]] : '無資料'}</span>`).join('')}</div>
  </div>
</section>

<section class="card" aria-labelledby="th-h">
  <div class="hd"><h2 id="th-h">投資論點</h2><span class="note">依資料自動整理</span></div>
  <p style="margin:0;font-size:17px;font-weight:500">${SIG[g.sig]}（${g.score} 分）：${T.pros.length} 項支持、${T.cons.length} 項風險。${isNum(g.stop) ? `跌破 ${px(g.stop)}（2 倍日線 ATR）宜停損。` : ''}</p>
  <div id="ai-stock"></div>
  <div class="thesis"><div><b class="small">支持</b><ul>${T.pros.map(x => `<li>${x}</li>`).join('') || '<li class="muted">無</li>'}</ul></div>
  <div><b class="small">風險</b><ul>${T.cons.map(x => `<li>${x}</li>`).join('') || '<li class="muted">無</li>'}</ul></div></div>
</section>

<div class="grid2">
  <section class="card" aria-labelledby="val-h"><div class="hd"><h2 id="val-h">估值與基本面</h2></div>
    ${range52 != null ? `<div style="display:flex;flex-direction:column;gap:6px"><div style="display:flex;justify-content:space-between;font-size:13px"><span>52 週區間位置</span><span class="mono">${range52.toFixed(0)}%</span></div>
      <div class="meter" role="img" aria-label="現價位於 52 週區間 ${range52.toFixed(0)}% 位置"><i style="left:${range52}%;width:4px;background:var(--acc)"></i></div>
      <div style="display:flex;justify-content:space-between" class="small muted"><span>低 ${px(ta.low52)}</span><span>高 ${px(ta.high52)}</span></div></div>` : ''}
    <dl class="facts">${it.market === 'us' ? `
      <div><dt>本益比（近 4 季）</dt><dd>${num(f.pe, 1)}</dd></div><div><dt>預估本益比</dt><dd>${num(f.forwardPE, 1)}</dd></div>
      <div><dt>每股盈餘（近 4 季）</dt><dd>${num(f.eps)}</dd></div><div><dt>殖利率</dt><dd>${isNum(f.dividendYield) ? f.dividendYield.toFixed(2) + '%' : '—'}</dd></div>
      <div><dt>分析師目標價</dt><dd>${px(f.targetPrice)}</dd></div><div><dt>營收年增率</dt><dd class="${cls(f.revenueGrowth)}">${pct(f.revenueGrowth, 1)}</dd></div>
      <div><dt>下次財報</dt><dd style="font-size:15px">${esc(f.earningsDate || '—')}</dd></div>` : `
      <div><dt>月營收年增率</dt><dd class="${cls(f.revenueYoY)}">${pct(f.revenueYoY, 1)}</dd></div><div><dt>營收月份</dt><dd style="font-size:15px">${esc(f.revenuePeriod || '—')}</dd></div>
      <div><dt>近 1 個月報酬</dt><dd class="${cls(ta.ret21)}">${pct(ta.ret21, 1)}</dd></div><div><dt>近 3 個月報酬</dt><dd class="${cls(ta.ret63)}">${pct(ta.ret63, 1)}</dd></div>`}
    </dl>${it.market === 'us' && !it.fund ? '<p class="small muted" style="margin:0">基本面於美股收盤後更新。</p>' : ''}</section>

  <section class="card chart" aria-labelledby="ta-h"><div class="hd"><h2 id="ta-h">技術面</h2><span class="note">日 K・近 ${Math.min(120, b?.close?.length || 0)} 個交易日</span></div>
    ${b ? lineChart(b, it) : '<p class="empty">走勢資料載入失敗</p>'}
    <div class="legend"><span><i style="background:#15181D;height:2px"></i>收盤</span><span><i style="background:#6E8EEB;height:2px"></i>20 日線 ${px(ta.ma20)}</span><span><i style="background:#B9C0CC;height:2px"></i>60 日線 ${px(ta.ma60)}</span>
      <span>相對強弱 RSI(14) ${isNum(ta.rsi) ? ta.rsi.toFixed(0) : '—'}</span><span>布林位置 ${isNum(ta.bbPct) ? ta.bbPct.toFixed(0) + '%' : '—'}</span></div></section>

  ${it.market === 'tw' ? `<section class="card" aria-labelledby="ch-h"><div class="hd"><h2 id="ch-h">籌碼</h2><span class="note">${hist.length ? `外資每日買賣超・近 ${hist.length} 個交易日（張）` : esc(c?.source === 'TWSE' ? '只有最新一日（需設定 FinMind 權杖才有歷史）' : '尚無資料')}</span></div>
    ${hist.length ? `<div class="flows" style="grid-template-columns:repeat(${hist.length},minmax(0,1fr))" role="img" aria-label="外資近 ${hist.length} 日買賣超">${hist.map(h => `<div><div class="p"><div style="height:${h.foreign > 0 ? h.foreign / fmx * 100 : 0}%"></div></div><div class="n"><div style="height:${h.foreign < 0 ? -h.foreign / fmx * 100 : 0}%"></div></div></div>`).join('')}</div>` : ''}
    ${c ? `<dl class="facts"><div><dt>外資連續</dt><dd class="${cls(c.foreignStreak)}" style="font-size:16px">${c.foreignStreak ? `${c.foreignStreak > 0 ? '買' : '賣'} ${Math.abs(c.foreignStreak)} 日` : '—'}</dd></div>
      <div><dt>外資 20 日</dt><dd class="${cls(c.foreign20)}">${c.foreign20 == null ? int(c.foreign1) : int(c.foreign20)}</dd></div><div><dt>投信 20 日</dt><dd class="${cls(c.trust20)}">${c.trust20 == null ? int(c.trust1) : int(c.trust20)}</dd></div><div><dt>自營商 20 日</dt><dd class="${cls(c.dealer20)}">${int(c.dealer20)}</dd></div></dl>` : ''}</section>` : ''}

  <section class="card" aria-labelledby="rk-h"><div class="hd"><h2 id="rk-h">風險</h2></div>
    <dl class="facts">
      <div><dt>停損價（收盤 − 2 倍日線 ATR）</dt><dd>${px(g.stop)}${isNum(g.stop) ? ` <small class="muted">（${pct((g.stop / it.price - 1) * 100, 1)}）</small>` : ''}</dd></div>
      <div><dt>1 日風險值（VaR 95%）</dt><dd>${isNum(ta.var95) ? ta.var95.toFixed(1) + '%' : '—'}</dd></div>
      <div><dt>平均真實波幅 ATR</dt><dd>${isNum(ta.atrPct) ? ta.atrPct.toFixed(1) + '%' : '—'}</dd></div>
      <div><dt>年化波動（20 日）</dt><dd>${isNum(ta.vol20) ? ta.vol20.toFixed(0) + '%' : '—'}</dd></div>
      <div><dt>Beta 系統風險（相對${it.market === 'tw' ? '加權指數' : '標普 500'}）</dt><dd>${num(ta.beta)}</dd></div>
      <div><dt>模型（隔日）買／觀望／賣</dt><dd style="font-size:15px">${it.ml ? `${(it.ml.buyProb * 100).toFixed(0)}／${(it.ml.holdProb * 100).toFixed(0)}／${(it.ml.sellProb * 100).toFixed(0)}%` : '—'}</dd></div>
      ${lp ? `<div><dt>本機預測（${esc(lp.eng)}）1 日／5 日</dt><dd style="font-size:15px"><span class="${cls(lp.d1)}">${pct(lp.d1)}</span>／<span class="${cls(lp.d5)}">${pct(lp.d5)}</span></dd></div>` : ''}
    </dl></section>
</div>

<section class="card" aria-labelledby="ph-h"><div class="hd"><h2 id="ph-h">這檔股票的預測紀錄</h2><span class="note">收盤後的買進／賣出訊號，依之後的交易日收盤判定</span></div>
  ${preds.length ? `<div class="tbl-box"><table class="tbl" style="min-width:600px"><thead><tr><th>訊號日</th><th>訊號</th><th class="num">當時價</th><th class="num">1 日後</th><th>結果</th><th class="num">5 日後</th><th>結果</th></tr></thead><tbody>
    ${preds.map(p => `<tr><td class="mono">${esc(p.date)}</td><td>${sigTag(p.signal)}</td><td class="num">${px(p.price)}</td><td class="num">${px(p.p1)}</td><td>${resZh(p.r1)}</td><td class="num">${px(p.p5)}</td><td>${resZh(p.r5)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">還沒有紀錄（收盤後出現買進或賣出訊號才會記錄）。</p>'}
</section>
${footer()}`;
  }
  const resZh = r => (r === 'correct' ? '<span class="ok-text">命中</span>' : r === 'wrong' ? '<span class="bad-text">未中</span>' : r === 'neutral' ? '<span class="muted">持平</span>' : '<span class="muted">待結算</span>');

  async function afterStock(key) {
    S.localTried = S.localTried || {};
    if ((S.local.npu || S.local.cpu) && !S.localPreds[key] && !S.localTried[key]) {
      S.localTried[key] = true;
      await localPredict([key]);
      if (S.localPreds[key] && S.route === 's/' + key) { render(); return; }
    }
    if (S.local.llm) {
      const it = S.snap.items[key]; if (!it) return;
      const box = $('#ai-stock'); if (!box) return;
      const k = `stock:${key}:${S.snap.generatedAt}`;
      box.innerHTML = '<div class="ai" style="background:var(--bg);color:var(--ink2)"><b style="color:var(--ink)">本機 AI 解讀</b>產生中…</div>';
      if (S.llm[k] == null) {
        const T = thesis(it, holdings());
        S.llm[k] = await askLLM(`請用繁體中文，用 2 到 3 句話解讀這檔股票目前的狀況與操作重點，不要列點，不超過 100 字。\n標的：${key} ${it.name}\n現價 ${it.price}（${pct(it.changePct)}），規則判斷：${SIG[it.signal.sig]}，分數 ${it.signal.score}\n支持：${T.pros.join('；') || '無'}\n風險：${T.cons.join('；') || '無'}`, key) || '';
      }
      const b2 = $('#ai-stock');
      if (b2 && S.route === 's/' + key) b2.innerHTML = S.llm[k] ? `<div class="ai" style="background:var(--bg);color:var(--ink2)"><b style="color:var(--ink)">本機 AI 解讀</b>${esc(S.llm[k])}</div>` : '';
    }
  }

  // ── 持股編輯 ────────────────────────────────────────────────
  function viewPortfolio() {
    const h = H.load(), opts = Object.keys(S.snap.items).map(k => `<option value="${esc(k)}">${esc(k)} ${esc(nameOf(k))}</option>`).join('');
    const rowHtml = (x, i) => `<div class="hrow" data-i="${i}"><input aria-label="代號" list="hold-list" value="${esc(x.key || '')}" placeholder="代號，如 2330、NVDA"><input aria-label="股數" type="number" inputmode="decimal" value="${x.shares ?? ''}" placeholder="股數"><input aria-label="平均成本" type="number" inputmode="decimal" step="any" value="${x.cost ?? ''}" placeholder="成本（原幣）"><button type="button" class="iconbtn" aria-label="刪除這一列" data-del="${i}">✕</button></div>`;
    return `
<section class="card" aria-labelledby="pe-h">
  <div class="hd"><h2 id="pe-h">我的持股</h2><span class="note">只存在這台裝置的瀏覽器，不會上傳到網站。換裝置可用「匯出／匯入」。</span></div>
  <datalist id="hold-list">${opts}</datalist>
  <form id="pf-form" class="form">
    <div class="hrow small muted" aria-hidden="true"><span>代號</span><span>股數</span><span>平均成本（原幣）</span><span></span></div>
    <div id="hold-rows" class="form">${(h.items.length ? h.items : [{}]).map(rowHtml).join('')}</div>
    <div class="actions"><button type="button" class="btn" id="add-row">＋ 新增一列</button></div>
    <div class="field" style="max-width:280px"><label for="cash">現金（新台幣）</label><input id="cash" type="number" inputmode="decimal" value="${h.cash || ''}" placeholder="0"></div>
    <div class="actions"><button class="btn primary" type="submit">儲存</button><button type="button" class="btn" id="exp">匯出</button><button type="button" class="btn" id="imp">匯入</button><button type="button" class="btn danger" id="clr">全部清除</button></div>
    <p id="pf-msg" class="small" role="status"></p>
  </form>
</section>
<section class="card" aria-labelledby="lm-h">
  <div class="hd"><h2 id="lm-h">風險上限</h2><span class="note">總覽的「風險 vs 自訂上限」用這些數字</span></div>
  <form id="lm-form" class="form" style="max-width:420px">
    <div class="field"><label for="l-var">1 日風險值上限（%）</label><input id="l-var" type="number" step="0.1" value="${cfg.limits.var95}"></div>
    <div class="field"><label for="l-single">單一持股上限（% 總資產）</label><input id="l-single" type="number" step="1" value="${cfg.limits.single}"></div>
    <div class="field"><label for="l-cash">現金比例下限（%）</label><input id="l-cash" type="number" step="1" value="${cfg.limits.cashMin}"></div>
    <div class="actions"><button class="btn primary" type="submit">儲存上限</button></div>
  </form>
</section>`;
  }
  function bindPortfolio() {
    const rows = $('#hold-rows'), msg = $('#pf-msg');
    const read = () => [...rows.querySelectorAll('.hrow')].map(r => { const [k, s, c] = r.querySelectorAll('input'); return { key: k.value.trim().toUpperCase().replace(/\.TWO?$/, ''), shares: parseFloat(s.value), cost: c.value === '' ? null : parseFloat(c.value) }; }).filter(x => x.key && x.shares > 0);
    $('#add-row').onclick = () => { const i = rows.children.length; rows.insertAdjacentHTML('beforeend', `<div class="hrow" data-i="${i}"><input aria-label="代號" list="hold-list" placeholder="代號，如 2330、NVDA"><input aria-label="股數" type="number" inputmode="decimal" placeholder="股數"><input aria-label="平均成本" type="number" inputmode="decimal" step="any" placeholder="成本（原幣）"><button type="button" class="iconbtn" aria-label="刪除這一列">✕</button></div>`); rows.lastElementChild.querySelector('input').focus(); };
    rows.addEventListener('click', e => { const b = e.target.closest('.iconbtn'); if (b) b.closest('.hrow').remove(); });
    $('#pf-form').onsubmit = e => { e.preventDefault(); const items = read(); H.save({ items, cash: parseFloat($('#cash').value) || 0 }); msg.className = 'small ok-text'; msg.textContent = `已儲存 ${items.length} 檔持股。`; };
    $('#clr').onclick = () => { if (confirm('確定清除這台裝置上的所有持股資料？')) { H.save({ items: [], cash: 0 }); render(); } };
    $('#exp').onclick = () => { const blob = new Blob([JSON.stringify(H.load(), null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'holdings.json'; a.click(); URL.revokeObjectURL(a.href); };
    $('#imp').onclick = () => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'application/json'; i.onchange = async () => { try { const d = JSON.parse(await i.files[0].text()); if (!Array.isArray(d.items)) throw 0; H.save({ items: d.items, cash: d.cash || 0 }); render(); } catch (_) { msg.className = 'small bad-text'; msg.textContent = '檔案格式不正確。'; } }; i.click(); };
    $('#lm-form').onsubmit = e => { e.preventDefault(); cfg.limits = { var95: +$('#l-var').value || DEF.limits.var95, single: +$('#l-single').value || DEF.limits.single, cashMin: +$('#l-cash').value || 0 }; saveCfg(); msg.className = 'small ok-text'; msg.textContent = '風險上限已儲存。'; };
  }

  // ── 模型成績 ────────────────────────────────────────────────
  function viewScorecard() {
    const sc = S.snap.scorecard, st = S.snap.status || {};
    const STZ = { yahoo: 'Yahoo 報價', vix: 'VIX 恐慌指數', treasury: '美國公債殖利率', t86: '三大法人（TWSE）', finmind: 'FinMind 法人／營收', fundamentals: '美股基本面' };
    return `
<section class="card" aria-labelledby="sc1"><div class="hd"><h2 id="sc1">模型成績單</h2><span class="note">${esc(sc.note)}</span></div>
  <div class="grid2"><div style="display:flex;flex-direction:column;gap:12px"><b class="small">近 30 天</b>${scoreRows(sc.d30)}</div><div style="display:flex;flex-direction:column;gap:12px"><b class="small">近 90 天</b>${scoreRows(sc.d90)}</div></div>
  <p class="small muted" style="margin:0">黑線＝50%（擲硬幣）。灰色條＝樣本少於 30 筆，數字不穩定。${sc.since ? `自 ${esc(sc.since)} 起共 ${sc.total} 筆。` : ''}</p></section>
<section class="card" aria-labelledby="sc2"><div class="hd"><h2 id="sc2">資料狀態</h2><span class="note">本次更新：${esc(tpeTime(S.snap.generatedAt))}・${S.snap.mode.startsWith('full') ? '收盤後完整更新' : '盤中快速更新'}・用時 ${S.snap.buildSeconds} 秒</span></div>
  <table class="tbl" style="min-width:0"><tbody>${Object.entries(st).map(([k, v]) => `<tr><td>${esc(STZ[k] || k)}</td><td class="${/fail|no-token/.test(String(v)) ? 'bad-text' : ''}">${esc(String(v).replace('no-token', '未設定權杖').replace(/^fail.*/, '失敗'))}</td></tr>`).join('')}
  <tr><td>資料來源</td><td>${S.source === 'nas' ? 'NAS 備援' : 'GitHub'}</td></tr>
  <tr><td>本機加速</td><td>${S.local.off ? '已關閉' : Object.keys(LOCAL).map(k => `${LOCAL[k].label} ${S.local[k] ? '✓' : '✕'}`).join('　')}</td></tr></tbody></table></section>
${footer()}`;
  }

  // ── 設定 ────────────────────────────────────────────────────
  function viewSettings() {
    return `
<section class="card" aria-labelledby="st-h"><div class="hd"><h2 id="st-h">設定</h2><span class="note">只存在這台裝置</span></div>
  <form id="st-form" class="form" style="max-width:520px">
    <div class="field"><label for="st-colors">漲跌顏色</label><select id="st-colors"><option value="tw"${cfg.colors === 'tw' ? ' selected' : ''}>台股習慣：紅漲綠跌</option><option value="us"${cfg.colors === 'us' ? ' selected' : ''}>美股習慣：綠漲紅跌</option></select></div>
    <div class="field"><label for="st-nas">NAS 備援網址</label><input id="st-nas" type="url" value="${esc(cfg.nasUrl)}" placeholder="https://你的-nas.tailxxxx.ts.net"><span class="hint">GitHub 資料過舊或取不到時，改從這裡讀。必須是 https 開頭（例如 Tailscale 網址）。</span></div>
    <div class="field"><label><input id="st-local" type="checkbox"${cfg.localEnabled ? ' checked' : ''}> 啟用本機加速（自動偵測 NPU／CPU／語言模型）</label><span class="hint">在你的電腦上打開時，會連到本機的推論服務。第一次瀏覽器可能會詢問是否允許存取區域網路，請按允許。</span></div>
    <div class="field"><label for="st-host">本機服務位址</label><input id="st-host" value="${esc(cfg.localHost)}" placeholder="localhost"><span class="hint">通常是 localhost；在家中其他裝置使用時可填那台電腦的區網 IP（例如 192.168.1.100）。</span></div>
    <div class="actions"><button class="btn primary" type="submit">儲存</button><button type="button" class="btn" id="st-test">測試連線</button></div>
    <p id="st-msg" class="small" role="status"></p>
  </form></section>`;
  }
  function bindSettings() {
    const msg = $('#st-msg');
    const readForm = () => { cfg.colors = $('#st-colors').value; cfg.nasUrl = $('#st-nas').value.trim(); cfg.localEnabled = $('#st-local').checked; cfg.localHost = $('#st-host').value.trim() || 'localhost'; };
    $('#st-form').onsubmit = async e => { e.preventDefault(); readForm(); saveCfg(); applyColors(); msg.className = 'small ok-text'; msg.textContent = '已儲存。'; await probeLocal(); };
    $('#st-test').onclick = async () => {
      readForm(); msg.className = 'small'; msg.textContent = '測試中…';
      const out = [];
      if (nasBase()) { if (!/^https:\/\//.test(nasBase())) out.push('NAS：網址必須是 https 開頭'); else { try { const j = await getJSON(nasBase() + '/backup/data/snapshot.json?t=' + Date.now(), 8000); out.push(`NAS：✓ 連線成功（資料 ${tpeTime(j.generatedAt)}）`); } catch (er) { out.push('NAS：✕ 連不到（確認網址、Tailscale 是否連線）'); } } }
      else out.push('NAS：未填寫');
      await probeLocal();
      out.push('本機：' + (S.local.off ? '已關閉' : Object.keys(LOCAL).map(k => `${LOCAL[k].label} ${S.local[k] ? '✓' : '✕'}`).join('　')));
      msg.innerHTML = out.map(esc).join('<br>');
    };
  }

  // ── 路由 ────────────────────────────────────────────────────
  function applyColors() { document.body.className = cfg.colors === 'us' ? 'us-colors' : 'tw-colors'; }
  async function render() {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    S.route = h.startsWith('s/') ? h : (h.split('/')[0] || 'home');
    const nav = h.startsWith('s/') ? 'home' : (S.route === 'all' ? 'home' : S.route);
    document.querySelectorAll('[data-nav]').forEach(a => { a.classList.toggle('act', a.dataset.nav === nav); if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const main = $('#main');
    if (!S.snap) return;
    if (S.route.startsWith('s/')) {
      const key = S.route.slice(2).toUpperCase();
      main.innerHTML = '<p class="loading">載入走勢…</p>';
      const b = await loadBars(key);
      if (S.route !== 's/' + key) return;
      main.innerHTML = viewStock(key, b); document.title = `${key} ${nameOf(key)}・訊號終端`;
      afterStock(key);
    } else if (S.route === 'portfolio') { main.innerHTML = viewPortfolio(); bindPortfolio(); document.title = '持股・訊號終端'; }
    else if (S.route === 'scorecard') { main.innerHTML = viewScorecard(); document.title = '模型成績・訊號終端'; }
    else if (S.route === 'settings') { main.innerHTML = viewSettings(); bindSettings(); document.title = '設定・訊號終端'; }
    else if (S.route === 'all') { main.innerHTML = `<div><a href="#/" class="small">← 回總覽</a></div><section class="card" id="opps">${viewOpps(0)}</section>${footer()}`; document.title = '全部標的・訊號終端'; }
    else { main.innerHTML = viewHome(); document.title = '訊號終端'; afterHome(); }
  }

  function setupSearch() {
    const dl = $('#search-list');
    dl.innerHTML = Object.values(S.snap.items).map(it => `<option value="${esc(it.key)}">${esc(it.name)}</option>`).join('');
    $('#search').onsubmit = e => {
      e.preventDefault();
      const q = $('#search-input').value.trim().toUpperCase(); if (!q) return;
      const hit = S.snap.items[q] ? q : Object.values(S.snap.items).find(it => it.name.toUpperCase().includes(q))?.key;
      location.hash = '#/s/' + encodeURIComponent(hit || q);
      $('#search-input').value = '';
    };
  }

  async function boot() {
    applyColors();
    try { await loadSnapshot(); }
    catch (e) { $('#main').innerHTML = `<section class="card"><h2 style="margin:0">無法載入資料</h2><p>${esc(e.message)}</p><div class="actions"><button class="btn primary" onclick="location.reload()">重新整理</button><a class="btn" href="#/settings">設定</a></div></section>`; if (location.hash.startsWith('#/settings')) { $('#main').innerHTML = viewSettings(); bindSettings(); } return; }
    setupSearch();
    window.addEventListener('hashchange', render);
    await render();
    probeLocal().then(() => { if (localAny() && (S.route === 'home' || S.route.startsWith('s/'))) render(); });
    // 每 5 分鐘檢查一次新資料（分頁在前景時）
    setInterval(async () => {
      if (document.hidden) return;
      const old = S.snap.generatedAt;
      try { await loadSnapshot(); } catch (_) { return; }
      if (S.snap.generatedAt !== old && !['portfolio', 'settings'].includes(S.route)) render();
    }, 5 * 60000);
  }
  boot();
})();
