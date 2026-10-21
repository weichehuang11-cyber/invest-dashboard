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
  const S = { snap: null, source: null, base: 'data/', bars: {}, local: { checked: false }, localPreds: {}, llm: {}, route: '', range: LS.get('range', 120), alertsHit: [], idx: LS.get('idx', '^TWII') };
  const UI = Object.assign({ mk: 'all', cat: 'all', sort: 'score' }, LS.get('oppF', {}));
  const stars = () => LS.get('stars', []);
  const isStar = k => stars().includes(k);
  const alerts = () => LS.get('alerts', {});
  function toast(msg) {
    let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2600);
  }
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
    checkAlerts();
  }

  /** 價格提醒：只存在這台裝置；新資料進來時比對，命中就列在「今天有什麼變了」，允許通知時跳通知 */
  function checkAlerts() {
    const A = alerts(), hit = [], sent = LS.get('alertSent', {});
    for (const [k, a] of Object.entries(A)) {
      const it = S.snap.items[k]; if (!it || !isNum(it.price)) continue;
      if (isNum(a.above) && it.price >= a.above) hit.push({ key: k, tag: '提醒', title: `${k} ${it.name} 漲到 ${px(it.price)}，已達提醒價 ${px(a.above)}`, detail: '到個股頁可修改或清除提醒' });
      if (isNum(a.below) && it.price <= a.below) hit.push({ key: k, tag: '提醒', title: `${k} ${it.name} 跌到 ${px(it.price)}，已達提醒價 ${px(a.below)}`, detail: '到個股頁可修改或清除提醒' });
    }
    S.alertsHit = hit;
    try {
      if (hit.length && 'Notification' in window && Notification.permission === 'granted') {
        for (const h of hit) { const id = h.title.split('，')[1] + h.key; if (sent[id] === S.snap.generatedAt.slice(0, 10)) continue; new Notification('訊號終端・價格提醒', { body: h.title }); sent[id] = S.snap.generatedAt.slice(0, 10); }
        LS.set('alertSent', sent);
      }
    } catch (_) {}
  }

  /** 下次排程更新（大約）：GitHub 盤中每 10 分鐘檢查、超過 20 分鐘沒更新就跑 */
  function nextUpdateText() {
    const d = new Date(), wd = d.getUTCDay(), h = d.getUTCHours() + d.getUTCMinutes() / 60;
    const wk = wd >= 1 && wd <= 5;
    if (wk && h >= 1 && h < 6) return '台股盤中，約每 20–30 分鐘更新';
    if (wk && h >= 13.5 && h < 21) return '美股盤中，約每 20–30 分鐘更新';
    if (wk && h >= 8.6 && h < 11) return '台股收盤後完整更新進行中（約 16:40–19:00）';
    if (wk && h >= 21) return '美股收盤後完整更新（約 05:15–08:00）';
    return '非交易時段，下一次在開盤後更新';
  }
  async function refreshNow(manual) {
    const old = S.snap?.generatedAt;
    if (manual) toast('檢查新資料…');
    try { await loadSnapshot(); } catch (_) { if (manual) toast('連不到資料來源，稍後再試'); return; }
    if (S.snap.generatedAt !== old) { if (!['portfolio', 'settings'].includes(S.route)) render(); toast(`已更新到 ${tpeTime(S.snap.generatedAt)}`); }
    else if (manual) toast(`已是最新（${tpeTime(S.snap.generatedAt)}）・${nextUpdateText()}`);
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
    el.title = `點一下檢查新資料。${nextUpdateText()}`;
    const bn = $('#banner');
    if (stale) { bn.hidden = false; bn.className = 'banner'; bn.textContent = `資料已 ${ago(S.snap.generatedAt)}沒更新（GitHub 排程偶爾延遲）。點上方更新時間可重新檢查${nasBase() ? '' : '；也可到「設定」填入 NAS 備援網址'}。`; }
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
    const changes = [...S.alertsHit, ...thesisAlerts(), ...holdChanges, ...s.changes.filter(c => !P.rows.some(r => r.key === c.key))].slice(0, 10);
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
    <div class="mymood"><div class="small" style="color:var(--topmute)">我今天的市場感覺${todayMood() ? `：<b style="color:#fff">${esc(todayMood())}</b>` : '（點一下記錄，之後統計你的感覺準不準）'}</div>
      <div class="mrow"><span class="small" style="color:var(--topmute)">台股</span>${moodSeg('hm-tw', moodOf('tw'))}</div><div class="mrow"><span class="small" style="color:var(--topmute)">美股</span>${moodSeg('hm-us', moodOf('us'))}</div></div>
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

<section class="card" id="idx" aria-labelledby="ix-h"><p class="loading">載入指數走勢…</p></section>

<div class="row">
  ${s.health ? `<section class="card wide" aria-labelledby="hl-h">${viewHealth()}</section>` : ''}
  ${s.calendar?.length ? `<section class="card side" aria-labelledby="cal-h">${viewCalendar()}</section>` : ''}
</div>

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

  const todayKey = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const moodOf = mk => { const m = J.load().moods.filter(x => x.market === mk && x.at.slice(0, 10) === todayKey()).pop(); return m ? m.mood : null; };
  const todayMood = () => ['tw', 'us'].map(mk => (moodOf(mk) != null ? `${mk === 'tw' ? '台股' : '美股'}${moodZh(moodOf(mk))}` : '')).filter(Boolean).join('、');
  function saveMood(mk, v) {
    const j = J.load(), day = todayKey();
    j.moods = j.moods.filter(x => !(x.market === mk && x.at.slice(0, 10) === day));
    if (v != null) j.moods.push({ at: new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00'), market: mk, mood: v, ctx: { verdict: S.snap.verdict.label, vix: S.snap.env.find(e => e.key === 'vix')?.value ?? null, above20: S.snap.health?.tw?.breadth?.above20 ?? null } });
    J.save(j);
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
      ${P.rows.length ? `<div class="whatif"><label for="wi" class="small" style="font-weight:500;color:var(--ink)">情境試算：如果大盤 <b id="wi-v">−5%</b></label>
        <input id="wi" type="range" min="-15" max="15" step="1" value="-5" aria-describedby="wi-out">
        <div id="wi-out" class="small">${whatIf(P, -5)}</div></div>` : ''}
      ${P.missing.length ? `<p class="small bad-text">${P.missing.map(r => esc(r.key)).join('、')} 不在觀察清單，沒有報價。請加到 config/watchlist.json。</p>` : ''}`;
  }

  /** 依各持股 Beta 估算大盤漲跌 m% 時的部位變化 */
  function whatIf(P, m) {
    let d = 0, miss = 0;
    for (const r of P.rows) { if (!r.mv) continue; const b = r.it?.ta?.beta; if (isNum(b)) d += r.mv * b * m / 100; else { d += r.mv * m / 100; miss++; } }
    return `預估部位 <b class="${cls(d)}">${sign(d)}${int(Math.abs(d))}</b> 元（<span class="${cls(d)}">${pct(P.total ? d / P.total * 100 : null, 1)}</span>）・依各檔 Beta 估算${miss ? `，${miss} 檔無 Beta 以 1 計` : ''}`;
  }

  function oppKeys() {
    const s = S.snap, P = holdings(), held = new Set(P.rows.map(r => r.key)), st = new Set(stars());
    let ks = s.ranking.filter(k => {
      const it = s.items[k];
      if (UI.mk !== 'all' && it.market !== UI.mk) return false;
      if (UI.cat === 'buy') return it.signal.sig === 'BUY';
      if (UI.cat === 'sell') return it.signal.sig === 'SELL';
      if (UI.cat === 'star') return st.has(k);
      if (UI.cat === 'held') return held.has(k);
      return true;
    });
    if (UI.sort === 'up') ks = ks.slice().sort((a, b) => (s.items[b].changePct ?? -1e9) - (s.items[a].changePct ?? -1e9));
    if (UI.sort === 'down') ks = ks.slice().sort((a, b) => (s.items[a].changePct ?? 1e9) - (s.items[b].changePct ?? 1e9));
    return ks;
  }
  const seg = (name, val, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-of="${name}" data-v="${v}" aria-pressed="${val === v}">${l}</button>`).join('')}</div>`;

  function viewOpps(n) {
    const s = S.snap, all = oppKeys(), keys = all.slice(0, n || all.length), st = new Set(stars());
    const lp = Object.keys(S.localPreds).length > 0;
    const row = (k, i) => {
      const it = s.items[k], g = it.signal, l = S.localPreds[k];
      return `<tr><td class="num muted">${i + 1}</td>
        <td>${st.has(k) ? '<span class="staron" aria-label="自選">★</span> ' : ''}<a class="sym" href="#/s/${encodeURIComponent(k)}">${esc(k)}</a> <span class="small muted">${esc(it.name)}</span></td>
        <td class="num">${px(it.price)}</td><td class="num ${cls(it.changePct)}">${pct(it.changePct)}</td>
        <td>${sigTag(g.sig)}</td><td>${evDots(g.evidence)}</td><td class="num"><b>${g.score}</b></td>
        <td class="num">${px(g.stop)}</td>
        ${lp ? `<td class="num ${l ? cls(l.d1) : ''}">${l ? pct(l.d1) : '—'}</td><td class="num ${l ? cls(l.d5) : ''}">${l ? pct(l.d5) : '—'}</td>` : ''}</tr>`;
    };
    const card = k => {
      const it = s.items[k], g = it.signal, l = S.localPreds[k];
      return `<a class="ocard" href="#/s/${encodeURIComponent(k)}"><div class="r1">${st.has(k) ? '<span class="staron" aria-label="自選">★</span>' : ''}<b>${esc(k)}</b><span class="small muted">${esc(it.name)}</span>${sigTag(g.sig)}</div>
        <div class="r2"><span class="mono" style="font-size:17px;font-weight:600">${px(it.price)}</span><span class="mono small ${cls(it.changePct)}">${pct(it.changePct)}</span><span class="small muted" style="margin-left:auto">分數 ${g.score}・停損 ${px(g.stop)}</span></div>
        <div>${evDots(g.evidence)}${l ? `<span class="small muted" style="margin-left:10px">本機預測 5 日 <b class="${cls(l.d5)}">${pct(l.d5)}</b></span>` : ''}</div></a>`;
    };
    return `
      <div class="hd"><h2 id="opp-h">機會清單</h2><span class="note">依綜合分數排序・證據：技術／籌碼／基本面／模型（${cfg.colors === 'us' ? '實心綠' : '實心紅'}＝支持、${cfg.colors === 'us' ? '實心紅' : '實心綠'}＝反對、空心＝中性、虛線＝無資料）</span>${n && all.length > n ? `<a class="act" href="#/all">看全部 ${all.length} 檔</a>` : ''}</div>
      <div class="filters">${seg('mk', UI.mk, [['all', '全部'], ['tw', '台股'], ['us', '美股']])}${seg('cat', UI.cat, [['all', '全部訊號'], ['buy', '買進'], ['sell', '賣出'], ['star', '★ 自選'], ['held', '持有中']])}${seg('sort', UI.sort, [['score', '依分數'], ['up', '漲最多'], ['down', '跌最多']])}</div>
      ${keys.length ? '' : `<p class="empty">${UI.cat === 'star' ? '還沒有自選股。到個股頁按「☆ 加入自選」。' : UI.cat === 'held' ? '還沒有持股，或持股不在觀察清單。' : '沒有符合條件的標的。'}</p>`}
      <div class="tbl-box opp"><table class="tbl"><thead><tr><th>#</th><th>標的</th><th class="num">價格</th><th class="num">今日</th><th>判斷</th><th>證據</th><th class="num">分數</th><th class="num">停損價（2 倍 ATR）</th>${lp ? '<th class="num">本機 1 日</th><th class="num">本機 5 日</th>' : ''}</tr></thead>
      <tbody>${keys.map(row).join('')}</tbody></table></div>
      <div class="cards">${keys.map(card).join('')}</div>
      <p class="small muted" style="margin:0">買進門檻 ${s.items[s.ranking[0]]?.signal.buyThreshold ?? 63} 分（VIX 越高門檻越高）、賣出門檻 37 分。模型以「隔日漲跌」訓練，僅供參考。</p>`;
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
    fillIndexSection();
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

  // ── 市場健康度、事件行事曆 ────────────────────────────────────
  function spark(a, { w = 140, h = 30, zero = false, col = '#1F4FD8' } = {}) {
    const v = (a || []).filter(isNum); if (v.length < 2) return '';
    let lo = Math.min(...v), hi = Math.max(...v); if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); } if (hi === lo) { hi += 1; lo -= 1; }
    const x = i => (i / (v.length - 1) * w).toFixed(1), y = t => (h - 2 - (t - lo) / (hi - lo) * (h - 4)).toFixed(1);
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${zero && lo < 0 && hi > 0 ? `<line x1="0" x2="${w}" y1="${y(0)}" y2="${y(0)}" stroke="#C9CED6" stroke-dasharray="2 2"/>` : ''}<path d="${v.map((t, i) => `${i ? 'L' : 'M'}${x(i)},${y(t)}`).join('')}" fill="none" stroke="${col}" stroke-width="1.5"/><circle cx="${x(v.length - 1)}" cy="${y(v[v.length - 1])}" r="2.5" fill="${col}"/></svg>`;
  }
  const pctTag = p => (isNum(p) ? `<span class="small muted">歷史第 ${p.toFixed(0)} 百分位</span>` : '');
  const hrow = (label, val, extra = '', sp = '') => `<div class="hrow2"><div class="hl">${label}</div><div class="hv">${val}${extra ? ` <span class="small">${extra}</span>` : ''}</div>${sp ? `<div class="hs">${sp}</div>` : ''}</div>`;
  const parts = (...a) => a.filter(x => x && !/^\S+ $/.test(x)).join('・');
  const chgTxt = (v, unit = '', d = 0) => (isNum(v) ? `<span class="${cls(v)}">${sign(v)}${fix(v, d)}${unit}</span>` : '');

  function viewHealth() {
    const H = S.snap.health; if (!H) return '';
    const tw = H.tw || {}, us = H.us || {}, b = tw.breadth;
    const panel = (title, body, note) => `<div class="hp"><div class="hp-h">${title}</div>${body}${note ? `<p class="hp-n">${note}</p>` : ''}</div>`;
    const adBar = b && isNum(b.adv) ? (() => { const t = b.adv + b.dec + (b.unch || 0); return `<div class="adbar" role="img" aria-label="上漲 ${b.adv} 家、下跌 ${b.dec} 家、平盤 ${b.unch ?? 0} 家"><div class="up-bg" style="width:${b.adv / t * 100}%"></div><div style="width:${(b.unch || 0) / t * 100}%;background:#D5D9E0"></div><div class="down-bg" style="width:${b.dec / t * 100}%"></div></div>
      <div class="legend"><span class="up">上漲 ${int(b.adv)}${b.upLimit != null ? `（漲停 ${b.upLimit}）` : ''}</span><span>平盤 ${int(b.unch)}</span><span class="down">下跌 ${int(b.dec)}${b.downLimit != null ? `（跌停 ${b.downLimit}）` : ''}</span></div>`; })() : '';
    const accum = n => `<span class="small muted">累積中（${b?.days || 0}／${n} 個交易日）</span>`;
    const p1 = b ? panel('台股市場寬度', `${adBar}
      ${hrow('站上 20 日線', isNum(b.above20) ? `<b>${b.above20.toFixed(0)}%</b>` : accum(20), '', spark(b.series.map(x => x.above20)))}
      ${hrow('站上 60 日線', isNum(b.above60) ? `<b>${b.above60.toFixed(0)}%</b>` : accum(60))}
      ${hrow('20 日新高／新低', b.newHiLo ? `<b class="up">${b.newHiLo.hi}</b> ／ <b class="down">${b.newHiLo.lo}</b> 家` : accum(21))}
      ${hrow('近 5 日漲跌家數比', isNum(b.adRatio5) ? `<b>${b.adRatio5.toFixed(2)}</b>` : '—', isNum(b.adRatio5) ? (b.adRatio5 >= 1 ? '上漲家數較多' : '下跌家數較多') : '', spark(b.adLine.map(x => x.v)))}`,
      '站上 20 日線比例低於 25% 代表普遍弱勢，高於 75% 代表普遍強勢。指數漲但多數股票跌，是常見的轉弱警訊。') : '';
    const f = tw.futures, pc = tw.putcall, vt = us.vixTerm;
    const p2 = (f || pc || vt) ? panel('期貨、選擇權部位', `
      ${f ? hrow('外資台指期未平倉淨額', `<b class="${cls(f.net)}">${sign(f.net)}${int(Math.abs(f.net))}</b> 口`, parts(isNum(f.chg) && `日 ${chgTxt(f.chg)}`, isNum(f.chg5) && `5 日 ${chgTxt(f.chg5)}`), spark(f.hist.map(x => x.net), { zero: true })) : ''}
      ${pc ? hrow('台指選擇權 P/C 未平倉比', `<b>${num(pc.oi, 1)}%</b>`, pctTag(pc.pct), spark(pc.hist.map(x => x.oi))) : ''}
      ${vt ? hrow('VIX 期限結構（近月／三個月）', `<b class="${vt.ratio > 1 ? 'bad-text' : ''}">${num(vt.ratio, 2)}</b>`, vt.ratio > 1 ? '倒掛：急性恐慌' : vt.ratio > 0.92 ? '接近倒掛' : '正常（遠月較高）') : ''}`,
      '外資台指期淨空單越多，代表避險或看空越重（常與現貨賣超同步）。P/C 未平倉比偏高多半是賣方支撐、偏多解讀；VIX 近月高於三個月代表恐慌。') : '';
    const fc = tw.foreignCum, m = tw.margin;
    const p3 = (fc || m) ? panel('資金流向', `
      ${fc ? hrow('外資現貨累計（估算）', `5 日 <b class="${cls(fc.d5)}">${sign(fc.d5)}${int(Math.abs(fc.d5))}</b> 億`, fc.days >= 20 ? `20 日 ${chgTxt(fc.d20, ' 億')}` : `（${fc.days} 日資料）`) : ''}
      ${m ? hrow('融資餘額', `<b>${int(m.balance)}</b> 億`, `日 ${chgTxt(m.chg, ' 億')}${isNum(m.chg5) ? `・5 日 ${chgTxt(m.chg5, ' 億')}` : ''}${isNum(m.chg20) ? `・20 日 ${chgTxt(m.chg20, ' 億')}` : ''}`, spark(m.hist.map(x => x.balance))) : ''}`,
      '融資增加代表散戶加槓桿；下跌時融資反而增加，常代表籌碼轉亂、後續賣壓較重。') : '';
    const ew = us.equalWeight, sa = us.sectorsAbove50;
    const p4 = (ew || sa) ? panel('美股市場寬度', `
      ${ew ? hrow('等權重 vs 市值權重（20 日）', `<b class="${cls(ew.rel20)}">${pct(ew.rel20, 1)}</b>`, `60 日 ${chgTxt(ew.rel60, '%', 1)}`) : ''}
      ${sa ? hrow('板塊站上 50 日線', `<b>${sa.n}／${sa.of}</b> 個`) : ''}`,
      '等權重落後市值權重，代表漲勢集中在少數大型股；板塊多數在 50 日線之上代表上漲範圍廣。') : '';
    const tv = tw.valuation, uv = us.valuation;
    const p5 = (tv || uv) ? panel('估值位置', `
      ${tv ? hrow('台股上市本益比中位數', `<b>${num(tv.pe, 1)}</b> 倍`, `殖利率 ${num(tv.dy, 2)}%・淨值比 ${num(tv.pb, 2)}・${tv.days >= 20 ? pctTag(tv.pct) : `累積中（${tv.days} 天）`}`) : ''}
      ${uv ? hrow('標普 500 本益比（SPY）', `<b>${num(uv.pe, 1)}</b> 倍`, `${uv.days >= 20 ? pctTag(uv.pct) : `累積中（${uv.days} 天）`}`) : ''}
      ${uv && isNum(uv.erp) ? hrow('股債利差（盈餘殖利率 − 10 年債）', `<b class="${cls(uv.erp)}">${num(uv.erp, 2)}%</b>`, `盈餘殖利率 ${num(uv.earningsYield, 2)}%、10 年債 ${num(uv.y10, 2)}%`) : ''}`,
      '百分位需要累積歷史後才會出現。股債利差越低代表股票相對債券越貴。') : '';
    const hy = us.hy, st = us.stress, nf = us.nfci;
    const p6 = (hy || st || nf) ? panel('信用與金融壓力', `
      ${hy ? hrow('美國高收益債利差', `<b>${num(hy.v, 2)}%</b>`, `20 日 ${chgTxt(hy.chg, '', 2)}・${pctTag(hy.pct)}`, spark(hy.hist, { col: '#B45309' })) : ''}
      ${st ? hrow('聖路易聯準會金融壓力指數', `<b class="${st.v > 1 ? 'bad-text' : ''}">${num(st.v, 2)}</b>`, '0＝正常，越高越緊張', spark(st.hist, { zero: true, col: '#B45309' })) : ''}
      ${nf ? hrow('芝加哥聯準會金融情勢指數', `<b>${num(nf.v, 2)}</b>`, '負值＝寬鬆，正值＝緊縮', spark(nf.hist, { zero: true, col: '#B45309' })) : ''}`,
      '信用利差快速擴大通常領先股市下跌；壓力指數高於 1 代表金融體系明顯緊張。資料來自美國聖路易聯準會 FRED，每週或每日更新。') : '';
    const sigs = H.signals || [];
    return `<div class="hd"><h2 id="hl-h">市場健康度</h2><span class="note">寬度、部位、資金、估值、信用・收盤後更新</span></div>
      ${sigs.length ? `<ul class="tcom">${sigs.map(x => `<li class="${x.tone}"><i aria-hidden="true"></i>${esc(x.text)}</li>`).join('')}</ul>` : '<p class="small muted" style="margin:0">目前沒有明顯的警訊。</p>'}
      <div class="hgrid">${p1}${p2}${p3}${p4}${p5}${p6}</div>`;
  }

  function viewCalendar() {
    const ev = S.snap.calendar || []; if (!ev.length) return '';
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const dd = d => Math.round((Date.parse(d) - Date.parse(today)) / 86400000);
    const wk = d => '日一二三四五六'[new Date(d + 'T00:00:00Z').getUTCDay()];
    const held = new Set(holdings().rows.map(r => r.key));
    return `<div class="hd"><h2 id="cal-h">事件行事曆</h2><span class="note">未來 3 週</span></div>
      <ol class="cal">${ev.slice(0, 14).map(e => { const n = dd(e.date); return `<li class="imp${e.importance}${e.key && held.has(e.key) ? ' held' : ''}"><div class="cd"><b>${e.date.slice(5).replace('-', '/')}</b><span class="small muted">週${wk(e.date)}・${n === 0 ? '今天' : n === 1 ? '明天' : `${n} 天後`}</span></div>
        <div><span class="tag">${e.region === 'tw' ? '台' : '美'}</span> ${e.key ? `<a href="#/s/${encodeURIComponent(e.key)}">${esc(e.title)}</a>` : esc(e.title)}${e.key && held.has(e.key) ? ' <span class="small bad-text">持有中</span>' : ''}</div></li>`; }).join('')}</ol>
      <p class="small muted" style="margin:0">紅點＝重大（利率決議、CPI）。央行日期為推估，可在 config/events.json 修改。</p>`;
  }

  // ── 指數走勢、技術解讀與推論 ─────────────────────────────────
  /** 走勢圖＋未來 20 個交易日的推論區間（深色 50%、淺色 80%、虛線中位數） */
  function coneChart(b, o, label) {
    const N = Math.min(120, b.close.length), c = b.close.slice(-N), d = b.dates.slice(-N), F = o?.cone?.length || 0, T = N + F;
    const ma = k => b.close.map((_, i) => i < k - 1 ? null : b.close.slice(i - k + 1, i + 1).reduce((s, v) => s + v, 0) / k).slice(-N);
    const m20 = ma(20), m60 = ma(60);
    const sup = o?.sr?.support?.[0], res = o?.sr?.resistance?.[0];
    const vals = [...c, ...m20.filter(isNum), ...m60.filter(isNum), ...(o?.cone || []).flatMap(q => [q[0], q[4]]), ...(sup ? [sup.p] : []), ...(res ? [res.p] : [])];
    let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.05 || 1; lo -= pad; hi += pad;
    const MOB = window.innerWidth < 760, W = MOB ? 640 : 1200, Hh = MOB ? 400 : 320, FS = MOB ? 20 : 13, x = i => (i / (T - 1) * W).toFixed(1), y = v => (Hh - (v - lo) / (hi - lo) * Hh).toFixed(1);
    const path = a => a.map((v, i) => (v == null ? '' : `${a[i - 1] == null ? 'M' : 'L'}${x(i)},${y(v)}`)).join('');
    const band = (a, b2) => { const top = [`${x(N - 1)},${y(c[N - 1])}`, ...o.cone.map((q, j) => `${x(N + j)},${y(q[a])}`)]; const bot = [...o.cone.map((q, j) => `${x(N + j)},${y(q[b2])}`).reverse(), `${x(N - 1)},${y(c[N - 1])}`]; return `M${top.join('L')}L${bot.join('L')}Z`; };
    const hline = (v, txt, col, below) => `<line x1="0" x2="${x(N - 1)}" y1="${y(v)}" y2="${y(v)}" stroke="${col}" stroke-dasharray="5 4" stroke-width="1.2"/><text x="6" y="${(below ? +y(v) + FS + 2 : +y(v) - 5).toFixed(1)}" font-size="${FS}" fill="${col}">${esc(txt)}</text>`;
    const grid = [0.25, 0.5, 0.75].map(t => { const v = lo + (hi - lo) * t; return `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#EEF0F3"/><text x="${W - 4}" y="${(+y(v) - 5).toFixed(1)}" font-size="${FS}" fill="#8A93A3" text-anchor="end">${px(v)}</text>`; }).join('');
    const f20 = o?.forecast?.h20;
    return `<svg class="cone" viewBox="0 0 ${W} ${Hh + FS + 12}" role="img" aria-label="${esc(label)}近 ${N} 個交易日走勢${f20 ? `，未來 20 個交易日 80% 推論區間 ${px(f20.q[0])} 到 ${px(f20.q[4])}` : ''}">
      ${grid}
      ${F ? `<rect x="${x(N - 1)}" y="0" width="${(W - +x(N - 1)).toFixed(1)}" height="${Hh}" fill="#F6F8FC"/>
        <path d="${band(4, 0)}" fill="#1F4FD8" fill-opacity=".10"/><path d="${band(3, 1)}" fill="#1F4FD8" fill-opacity=".20"/>
        <path d="M${x(N - 1)},${y(c[N - 1])}${o.cone.map((q, j) => `L${x(N + j)},${y(q[2])}`).join('')}" fill="none" stroke="#1F4FD8" stroke-width="1.5" stroke-dasharray="5 4"/>
        <text x="${(+x(N - 1) + 8).toFixed(1)}" y="${FS + 4}" font-size="${FS}" fill="#5B6270">${MOB ? '推論' : '推論區間（未來 20 日）'}</text>` : ''}
      ${sup ? hline(sup.p, `支撐 ${px(sup.p)}・${sup.label}`, '#0E7C4A', true) : ''}${res ? hline(res.p, `壓力 ${px(res.p)}・${res.label}`, '#B45309') : ''}
      <path d="${path(m60)}" fill="none" stroke="#B9C0CC" stroke-width="1.5" stroke-dasharray="4 3"/><path d="${path(m20)}" fill="none" stroke="#6E8EEB" stroke-width="1.5"/>
      <path d="${path(c)}" fill="none" stroke="#15181D" stroke-width="2"/>
      <circle cx="${x(N - 1)}" cy="${y(c[N - 1])}" r="4" fill="#15181D"/>
      <text x="0" y="${Hh + FS + 6}" font-size="${FS}" fill="#8A93A3">${esc(d[0])}</text><text x="${x(N - 1)}" y="${Hh + FS + 6}" font-size="${FS}" fill="#8A93A3" text-anchor="middle">${esc(d[N - 1])}</text>${F && !MOB ? `<text x="${W}" y="${Hh + FS + 6}" font-size="${FS}" fill="#8A93A3" text-anchor="end">＋20 交易日</text>` : ''}</svg>
      <div class="legend"><span><i style="background:#15181D;height:2px"></i>收盤</span><span><i style="background:#6E8EEB;height:2px"></i>20 日線</span><span><i style="background:#B9C0CC;height:2px"></i>60 日線</span>${F ? '<span><i style="background:rgba(31,79,216,.3)"></i>50% 區間</span><span><i style="background:rgba(31,79,216,.12)"></i>80% 區間</span>' : ''}</div>`;
  }

  /** 可靠度：用回測數字說話，並翻成白話 */
  function relBlock(rel) {
    const r5 = rel?.h5, r20 = rel?.h20;
    if (!r5) return '<p class="small muted" style="margin:0">歷史資料不足，無法回測可靠度。</p>';
    const grade = r => {
      const band = Math.abs(r.cov80 - 80) <= 5 ? ['ok', '區間校準良好'] : r.cov80 < 75 ? ['warn', '區間偏窄，實際波動常超出'] : ['warn', '區間偏寬'];
      const best = Math.max(r.base, 100 - r.base), edge = r.dir == null ? null : r.dir - best;
      const dir = edge == null ? ['warn', '方向無資料'] : edge >= 5 ? ['ok', `方向比單純猜測好 ${edge.toFixed(0)} 個百分點`] : edge >= 2 ? ['warn', '方向僅略優於單純猜測'] : ['bad', '方向沒有比單純猜測好，只當參考'];
      return { band, dir };
    };
    const row = (l, r) => { if (!r) return ''; const g = grade(r); return `<tr><td>${l}</td><td class="num">${r.cov80}%</td><td class="num">${r.cov50}%</td><td class="num">${r.dir ?? '—'}%</td><td class="num muted">${Math.max(r.base, 100 - r.base)}%</td><td class="num muted">${r.n}</td></tr>
      <tr class="sub"><td colspan="6"><span class="rel ${g.band[0]}">${g.band[1]}</span><span class="rel ${g.dir[0]}">${g.dir[1]}</span></td></tr>`; };
    return `<div class="tbl-box"><table class="tbl rtbl"><thead><tr><th>回測</th><th class="num">80% 區間<br>實際涵蓋</th><th class="num">50% 區間<br>實際涵蓋</th><th class="num">方向<br>命中率</th><th class="num">單純猜測<br>基準</th><th class="num">次數</th></tr></thead>
      <tbody>${row('5 日', r5)}${row('20 日', r20)}</tbody></table></div>`;
  }

  function outlookLeft(o) {
    if (!o) return '';
    return `<div class="ostate"><span class="tag ${o.state === 'up' ? 'buy' : o.state === 'down' ? 'sell' : ''}" style="font-size:13px;padding:4px 10px">${esc(o.stateZh)}</span><span>${esc(o.trendText)}</span><span class="small muted">偏多訊號 ${o.posN}・偏空訊號 ${o.negN}</span></div>
      <div><b class="small">技術面解讀</b><ul class="tcom">${o.comments.map(c => `<li class="${c.tone}"><i aria-hidden="true"></i>${esc(c.text)}</li>`).join('')}</ul></div>
      <dl class="facts mini"><div><dt>RSI(14)</dt><dd>${num(o.ind.rsi, 0)}</dd></div><div><dt>KD(9)</dt><dd>${num(o.ind.k, 0)}／${num(o.ind.d, 0)}</dd></div><div><dt>MACD 柱</dt><dd class="${cls(o.ind.hist)}">${num(o.ind.hist, 2)}</dd></div><div><dt>年線（240 日）</dt><dd>${px(o.levels.ma240)}</dd></div></dl>`;
  }
  function outlookPanel(o, price) {
    if (!o) return '<p class="empty">資料不足（需要至少半年的日 K）。</p>';
    const f = o.forecast, rng = (q, a, b2) => `${px(q[a])}–${px(q[b2])}`;
    const fr = (l, x) => !x ? '' : `<tr><td>${l}</td><td class="num"><b>${px(x.q[2])}</b><div class="small ${cls(x.qPct[2])}">${pct(x.qPct[2], 1)}</div></td><td class="num">${rng(x.q, 1, 3)}<div class="small muted">${pct(x.qPct[1], 1)}～${pct(x.qPct[3], 1)}</div></td><td class="num">${rng(x.q, 0, 4)}<div class="small muted">${pct(x.qPct[0], 1)}～${pct(x.qPct[4], 1)}</div></td><td class="num"><b>${x.upProb}%</b><div class="small muted">${x.nState >= 30 ? `同狀態 ${x.nState} 次` : '全部歷史'}</div></td></tr>`;
    return `
      <div class="srbox"><div><b class="small">壓力</b>${o.sr.resistance.map(s => `<div class="srow"><span>${esc(s.label)}</span><span class="mono">${px(s.p)} <small class="muted">+${fix(s.dist, 1)}%</small></span></div>`).join('') || '<div class="small muted">上方無明顯壓力</div>'}</div>
        <div><b class="small">支撐</b>${o.sr.support.map(s => `<div class="srow"><span>${esc(s.label)}</span><span class="mono">${px(s.p)} <small class="muted">${pct(s.dist, 1)}</small></span></div>`).join('') || '<div class="small muted">下方無明顯支撐</div>'}</div></div>
      <div><b class="small">走勢推論</b><div class="tbl-box"><table class="tbl rtbl"><thead><tr><th>期間</th><th class="num">中位數</th><th class="num">50% 機率落在</th><th class="num">80% 機率落在</th><th class="num">上漲機率</th></tr></thead><tbody>${fr('5 個交易日後', f.h5)}${fr('20 個交易日後', f.h20)}</tbody></table></div></div>
      <div><b class="small">這個推論有多可靠？</b>${relBlock(o.reliability)}<p class="small muted" style="margin:6px 0 0">${esc(o.method)}</p></div>`;
  }

  async function viewIndexSection() {
    const ix = S.snap.indices || {}, ks = Object.keys(ix);
    if (!ks.length) return '';
    if (!ix[S.idx]) S.idx = ks[0];
    const it = ix[S.idx], b = await loadBars(S.idx);
    return `<div class="hd"><h2 id="ix-h">指數走勢與推論</h2><span class="note">${it.years ? `以 ${it.years} 年日 K 回測` : ''}・${esc(it.marketDate || '')}</span></div>
      ${seg('idx', S.idx, ks.map(k => [k, ix[k].name]))}
      <div class="ixgrid"><div class="chart"><div class="ixq"><b class="mono" style="font-size:22px">${px(it.price)}</b><span class="mono ${cls(it.changePct)}">${pct(it.changePct)}</span></div>${b ? coneChart(b, it.outlook, it.name) : '<p class="empty">走勢資料載入失敗</p>'}${outlookLeft(it.outlook)}</div>
      <div class="opanel">${outlookPanel(it.outlook, it.price)}</div></div>`;
  }
  async function fillIndexSection() {
    const box = $('#idx'); if (!box) return;
    const html = await viewIndexSection();
    if ($('#idx') && S.route === 'home') { box.innerHTML = html; box.hidden = !html; }
  }

  // ── 財報重點 ──────────────────────────────────────────────────
  function viewFin(it) {
    const f = it.fin;
    if (!f) return `<section class="card" aria-labelledby="fn-h"><div class="hd"><h2 id="fn-h">財報重點</h2></div><p class="empty" style="margin:0">${it.market === 'tw' ? '台股財報於收盤後完整更新時抓取（FinMind），下次更新後出現。' : '美股財報於美股收盤後完整更新時抓取，下次更新後出現。'}</p></section>`;
    const unit = it.market === 'tw' ? '億元' : '億美元', bn = v => (isNum(v) ? fix(v / 1e8, v / 1e8 >= 100 ? 0 : 1) : '—');
    const qlab = d => { const m = +d.slice(5, 7); return `${d.slice(2, 4)}Q${Math.ceil(m / 3)}`; };
    const Q = f.quarters, R = f.ratios || {};
    const bars = (k, col) => { const v = Q.map(q => q[k]).filter(isNum); if (!v.length) return ''; const mx = Math.max(...v.map(Math.abs)); return `<div class="qbars" aria-hidden="true">${Q.map(q => `<div title="${qlab(q.date)}"><div style="height:${isNum(q[k]) ? Math.abs(q[k]) / mx * 100 : 0}%;background:${q[k] < 0 ? 'var(--down)' : col}"></div></div>`).join('')}</div>`; };
    const sp = f.surprises || [], rv = f.revisions?.y0;
    return `<section class="card" aria-labelledby="fn-h"><div class="hd"><h2 id="fn-h">財報重點</h2><span class="note">最新季度 ${esc(qlab(f.asOf))}（${esc(f.asOf)}）・來源 ${esc(f.source)}</span><span class="tag ${f.score >= 1 ? 'buy' : f.score <= -2 ? 'sell' : ''}" style="margin-left:auto;font-size:13px;padding:4px 10px">${esc(f.grade)}</span></div>
      <ul class="tcom">${f.checks.map(c => `<li class="${c.tone}"><i aria-hidden="true"></i>${esc(c.text)}</li>`).join('') || '<li class="neu"><i></i>沒有特別值得注意的變化</li>'}</ul>
      <div class="grid2">
        <div><b class="small">近 ${Q.length} 季</b>
          <div class="qgrid"><div><div class="small muted">營收（${unit}）</div>${bars('rev', 'var(--acc2)')}</div><div><div class="small muted">EPS</div>${bars('eps', 'var(--acc)')}</div></div>
          <div class="tbl-box"><table class="tbl rtbl qtbl"><thead><tr><th>季度</th><th class="num">營收</th><th class="num">年增</th><th class="num">毛利率</th><th class="num">營益率</th><th class="num">EPS</th><th class="num">年增</th></tr></thead><tbody>
          ${Q.slice().reverse().map(q => `<tr><td class="mono">${qlab(q.date)}</td><td class="num">${bn(q.rev)}</td><td class="num ${cls(q.revYoY)}">${pct(q.revYoY, 0)}</td><td class="num">${isNum(q.gm) ? q.gm.toFixed(1) + '%' : '—'}</td><td class="num">${isNum(q.om) ? q.om.toFixed(1) + '%' : '—'}</td><td class="num">${num(q.eps)}</td><td class="num ${cls(q.epsYoY)}">${pct(q.epsYoY, 0)}</td></tr>`).join('')}</tbody></table></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:14px">
          <dl class="facts mini">
            <div><dt>近 4 季 EPS</dt><dd>${num(f.ttm?.eps)}</dd></div>
            <div><dt>股東權益報酬率</dt><dd>${isNum(R.roe) ? R.roe.toFixed(1) + '%' : '—'}</dd></div>
            <div><dt>自由現金流（近 4 季）</dt><dd class="${cls(f.ttm?.fcf)}">${bn(f.ttm?.fcf)} <small class="muted">${unit}</small></dd></div>
            <div><dt>自由現金流率</dt><dd>${isNum(R.fcfMargin) ? R.fcfMargin.toFixed(1) + '%' : '—'}</dd></div>
            <div><dt>${it.market === 'tw' ? '負債／權益' : '負債／權益'}</dt><dd>${isNum(R.debtToEquity) ? (R.debtToEquity / 100).toFixed(2) + ' 倍' : '—'}</dd></div>
            <div><dt>流動比率</dt><dd>${num(R.currentRatio)}</dd></div>
            ${it.market === 'us' ? `<div><dt>本益成長比 PEG</dt><dd>${num(R.peg)}</dd></div><div><dt>EV／EBITDA</dt><dd>${num(R.evEbitda, 1)}</dd></div>` : ''}
          </dl>
          ${sp.length ? `<div><b class="small">EPS 實際 vs 分析師預期</b><table class="tbl rtbl"><thead><tr><th>季度</th><th class="num">預期</th><th class="num">實際</th><th class="num">驚喜</th></tr></thead><tbody>${sp.slice().reverse().map(s2 => `<tr><td class="mono">${s2.quarter ? qlab(s2.quarter) : '—'}</td><td class="num">${num(s2.estimate)}</td><td class="num">${num(s2.actual)}</td><td class="num ${cls(s2.surprisePct)}">${pct(s2.surprisePct, 1)}</td></tr>`).join('')}</tbody></table></div>` : ''}
          ${rv ? `<div><b class="small">分析師預估修正（今年 EPS）</b><dl class="facts mini" style="margin-top:6px"><div><dt>目前預估</dt><dd>${num(rv.current)}</dd></div><div><dt>近 30 日修正</dt><dd class="${cls(rv.d30)}">${pct(rv.d30, 1)}</dd></div><div><dt>近 90 日修正</dt><dd class="${cls(rv.d90)}">${pct(rv.d90, 1)}</dd></div><div><dt>近 30 日上修／下修</dt><dd>${rv.up30 ?? '—'}／${rv.down30 ?? '—'} 位</dd></div></dl></div>` : ''}
        </div>
      </div>
      <p class="small muted" style="margin:0">${f.isFinancial ? '金融股沒有毛利率，現金流與負債比的意義不同，相關檢查已略過。' : ''}財報反映的是過去一季，對隔日漲跌幾乎沒有預測力；對未來 1～6 個月的方向、以及避開財務惡化的公司較有幫助。</p>
    </section>`;
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
    for (const c of (it.fin?.checks || []).slice(0, 4)) { if (c.tone === 'pos') pros.push('財報：' + esc(c.text)); else if (c.tone === 'neg') cons.push('財報：' + esc(c.text)); }
    if (isNum(ta.var95) && ta.var95 > 3.5) cons.push(`1 日風險值 ${ta.var95.toFixed(1)}%，波動偏大`);
    const pos = P.rows.find(r => r.key === it.key);
    if (pos && P.total && pos.mv / P.total * 100 > cfg.limits.single) cons.push(`占持股 ${(pos.mv / P.total * 100).toFixed(0)}%，超過單一持股上限 ${cfg.limits.single}%`);
    return { pros, cons, pos };
  }

  /** 互動走勢圖：可切換區間，滑鼠移動或手指按住拖曳看每天的價格 */
  function lineChart(b, it) {
    const n = Math.min(S.range, b.close.length), off = b.close.length - n;
    const c = b.close.slice(-n), d = b.dates.slice(-n);
    const maS = k => b.close.map((_, i) => i < k - 1 ? null : b.close.slice(i - k + 1, i + 1).reduce((s, v) => s + v, 0) / k).slice(-n);
    const m20 = maS(20), m60 = maS(60), stop = it.signal.stop;
    const vals = [...c, ...m20.filter(isNum), ...m60.filter(isNum), ...(isNum(stop) ? [stop] : [])];
    let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    const W = 1200, Hh = 300, x = i => (i / (n - 1) * W).toFixed(1), y = v => (Hh - (v - lo) / (hi - lo) * Hh).toFixed(1);
    S.chart = { n, d, c, m20, m60, prev: b.close.slice(-n - 1), off, x, y, W, Hh };
    const path = a => a.map((v, i) => (v == null ? '' : `${a[i - 1] == null ? 'M' : 'L'}${x(i)},${y(v)}`)).join('');
    const grid = [0.25, 0.5, 0.75].map(t => { const v = lo + (hi - lo) * t; return `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#EEF0F3"/><text x="4" y="${(+y(v) - 5).toFixed(1)}" font-size="14" fill="#8A93A3">${px(v)}</text>`; }).join('');
    const chg = (c[n - 1] / c[0] - 1) * 100;
    return `<div class="chart-top"><div id="xh-read" class="small mono" aria-live="polite">${esc(d[0])} → ${esc(d[n - 1])}・區間 <b class="${cls(chg)}">${pct(chg, 1)}</b></div>
      ${seg('range', String(S.range), [['22', '1 月'], ['66', '3 月'], ['120', '6 月'], ['250', '1 年']])}</div>
      <svg id="pxchart" viewBox="0 0 ${W} ${Hh + 22}" role="img" aria-label="近 ${n} 個交易日收盤價，區間 ${pct(chg, 1)}，20 日線 ${px(m20[n - 1])}，60 日線 ${px(m60[n - 1])}" style="touch-action:pan-y">
      ${grid}<path d="${path(m60)}" fill="none" stroke="#B9C0CC" stroke-width="1.5" stroke-dasharray="4 3"/><path d="${path(m20)}" fill="none" stroke="#6E8EEB" stroke-width="1.5"/>
      <path d="${path(c)}" fill="none" stroke="#15181D" stroke-width="2"/>
      ${isNum(stop) && stop > lo ? `<line x1="0" x2="${W}" y1="${y(stop)}" y2="${y(stop)}" stroke="#B91C1C" stroke-dasharray="6 4"/><text x="${W - 4}" y="${(+y(stop) - 5).toFixed(1)}" text-anchor="end" font-size="14" fill="#B91C1C">停損 ${px(stop)}</text>` : ''}
      <g id="xh" style="display:none"><line id="xh-l" y1="0" y2="${Hh}" stroke="#15181D" stroke-width="1" stroke-dasharray="3 3"/><circle id="xh-c" r="6" fill="#1F4FD8" stroke="#fff" stroke-width="2"/></g>
      <rect x="0" y="0" width="${W}" height="${Hh}" fill="transparent" id="xh-hit"/>
      <text x="0" y="${Hh + 18}" font-size="14" fill="#8A93A3">${esc(d[0])}</text><text x="${W}" y="${Hh + 18}" font-size="14" fill="#8A93A3" text-anchor="end">${esc(d[n - 1])}</text></svg>`;
  }
  function bindChart() {
    const svg = $('#pxchart'); if (!svg || !S.chart) return;
    const C = S.chart, g = $('#xh'), rd = $('#xh-read'), base = rd.innerHTML;
    const show = ev => {
      const r = svg.getBoundingClientRect(), t = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const i = Math.round(t * (C.n - 1)), v = C.c[i], pv = i > 0 ? C.c[i - 1] : C.prev[0];
      g.style.display = ''; $('#xh-l').setAttribute('x1', C.x(i)); $('#xh-l').setAttribute('x2', C.x(i));
      $('#xh-c').setAttribute('cx', C.x(i)); $('#xh-c').setAttribute('cy', C.y(v));
      const ch = pv ? (v / pv - 1) * 100 : null, fromEnd = (C.c[C.n - 1] / v - 1) * 100;
      rd.innerHTML = `${esc(C.d[i])}・收盤 <b>${px(v)}</b> <span class="${cls(ch)}">${pct(ch)}</span>・20 日線 ${px(C.m20[i])}・至今 <span class="${cls(fromEnd)}">${pct(fromEnd, 1)}</span>`;
    };
    const hide = () => { g.style.display = 'none'; rd.innerHTML = base; };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', hide);
  }

  function viewStock(key, b) {
    const it = S.snap.items[key];
    if (!it) return `<section class="card"><h2 style="margin:0">找不到 ${esc(key)}</h2><p class="empty">這個代號不在觀察清單。</p><div class="actions"><a class="btn primary" href="#/q/${encodeURIComponent(key)}">快速檢視／加入觀察清單</a><a class="btn" href="#/">回總覽</a></div></section>`;
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
  <div class="hd"><h1 id="s-h" style="margin:0;font-size:22px">${esc(key)} ${esc(it.name)}</h1><span class="note">${it.market === 'tw' ? '台股' : '美股'}・${esc(it.currency || '')}${pos ? `・持有 ${int(pos.shares)} 股` : ''}</span>
 <a class="small muted" href="${watchlistLink(key, it.name, true)}" target="_blank" rel="noopener" style="margin-left:auto">從觀察清單移除</a>
    <button type="button" class="btn sm" data-star="${esc(key)}" aria-pressed="${isStar(key)}">${isStar(key) ? '★ 已自選' : '☆ 加入自選'}</button></div>
  <div class="quote">
    <div><div style="display:flex;align-items:baseline;gap:12px"><span class="px">${px(it.price)}</span><span class="ch ${cls(it.changePct)}">${sign(it.price - it.prevClose)}${fix(Math.abs(it.price - it.prevClose), it.price >= 100 ? 1 : 2)}（${pct(it.changePct)}）</span></div>
      <div class="small muted">${esc(it.marketDate)}・成交量為 20 日均量 ${isNum(ta.relVolume) ? ta.relVolume.toFixed(1) : '—'} 倍</div></div>
    <div style="display:flex;align-items:center;gap:12px"><span class="tag ${sigCls(g.sig)}" style="font-size:14px;padding:6px 14px">${SIG[g.sig]}</span><div><div class="small muted">綜合分數</div><div class="mono" style="font-size:20px;font-weight:600">${g.score} / 100</div></div></div>
    <div class="evbig" role="img" aria-label="${EVK.map(([k, l]) => `${l}${g.evidence[k] ? EVW[g.evidence[k]] : '無資料'}`).join('、')}">${EVK.map(([k, l]) => `<span><i class="${g.evidence[k] || 'na'}" style="width:10px;height:10px;border-radius:50%;border:1px solid var(--faint);display:inline-block;background:${g.evidence[k] === 'pos' ? 'var(--up)' : g.evidence[k] === 'neg' ? 'var(--down)' : '#fff'}"></i>${l}：${g.evidence[k] ? EVW[g.evidence[k]] : '無資料'}</span>`).join('')}</div>
  </div>
</section>

${viewThesisCard(key)}
${viewDecideCard(key)}

<section class="card" aria-labelledby="th-h">
  <div class="hd"><h2 id="th-h">系統觀點</h2><span class="note">依公開資料自動整理（和你的論點對照看）</span></div>
  <p style="margin:0;font-size:17px;font-weight:500">${SIG[g.sig]}（${g.score} 分）：${T.pros.length} 項支持、${T.cons.length} 項風險。${isNum(g.stop) ? `跌破 ${px(g.stop)}（2 倍日線 ATR）宜停損。` : ''}</p>
  <div id="ai-stock"></div>
  ${S.local.llm ? `<form id="ask" class="ask"><label for="ask-q" class="sr">問本機 AI</label><input id="ask-q" placeholder="問本機 AI，例如：現在適合加碼嗎？停損要設多少？" autocomplete="off"><button class="btn primary" type="submit">問</button></form><div id="ask-a"></div>` : ''}
  <div class="thesis"><div><b class="small">支持</b><ul>${T.pros.map(x => `<li>${x}</li>`).join('') || '<li class="muted">無</li>'}</ul></div>
  <div><b class="small">風險</b><ul>${T.cons.map(x => `<li>${x}</li>`).join('') || '<li class="muted">無</li>'}</ul></div></div>
</section>

${viewFin(it)}

<section class="card" aria-labelledby="ol-h"><div class="hd"><h2 id="ol-h">技術解讀與走勢推論</h2><span class="note">日 K・規則化解讀＋歷史模擬推論，附回測可靠度</span></div>
  <div class="ixgrid"><div class="chart">${b ? coneChart(b, it.outlook, it.name) : ''}${outlookLeft(it.outlook)}</div><div class="opanel">${outlookPanel(it.outlook, it.price)}</div></div>
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

  <section class="card chart" aria-labelledby="ta-h"><div class="hd"><h2 id="ta-h">技術面</h2><span class="note">日 K・滑過或按住圖表看每天價格</span><a class="act" href="#/backtest/${encodeURIComponent(key)}">回測這檔</a></div>
    <div class="chart-wrap">${b ? lineChart(b, it) : '<p class="empty">走勢資料載入失敗</p>'}</div>
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

<section class="card" aria-labelledby="al-h"><div class="hd"><h2 id="al-h">價格提醒</h2><span class="note">只存在這台裝置；有新資料時比對，達到就列在總覽「今天有什麼變了」${'Notification' in window ? '，並跳出通知' : ''}</span></div>
  <form id="al-form" class="alform">
    <div class="field"><label for="al-up">漲到（含）以上</label><input id="al-up" type="number" step="any" inputmode="decimal" value="${alerts()[key]?.above ?? ''}" placeholder="${px(it.price * 1.05)}"></div>
    <div class="field"><label for="al-dn">跌到（含）以下</label><input id="al-dn" type="number" step="any" inputmode="decimal" value="${alerts()[key]?.below ?? (isNum(g.stop) ? '' : '')}" placeholder="${isNum(g.stop) ? px(g.stop) + '（停損價）' : px(it.price * 0.95)}"></div>
    <div class="actions"><button class="btn primary" type="submit">儲存提醒</button>${alerts()[key] ? '<button type="button" class="btn" id="al-clr">清除</button>' : ''}</div>
  </form><p id="al-msg" class="small" role="status"></p></section>

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

  function bindStock(key) {
    bindChart();
    const f = $('#al-form');
    if (f) {
      f.onsubmit = async e => {
        e.preventDefault();
        const up = parseFloat($('#al-up').value), dn = parseFloat($('#al-dn').value), A = alerts();
        if (!isNum(up) && !isNum(dn)) { delete A[key]; } else A[key] = { above: isNum(up) ? up : null, below: isNum(dn) ? dn : null };
        LS.set('alerts', A); checkAlerts();
        let note = '';
        try { if ('Notification' in window && Notification.permission === 'default') { const p = await Notification.requestPermission(); note = p === 'granted' ? '，已開啟通知' : ''; } } catch (_) {}
        $('#al-msg').className = 'small ok-text'; $('#al-msg').textContent = (A[key] ? '已儲存提醒' : '已清除提醒') + note + '。網站開著時，每次有新資料都會比對。';
      };
      const c = $('#al-clr'); if (c) c.onclick = () => { const A = alerts(); delete A[key]; LS.set('alerts', A); checkAlerts(); render(); };
    }
    const ask = $('#ask');
    if (ask) ask.onsubmit = async e => {
      e.preventDefault();
      const q = $('#ask-q').value.trim(); if (!q) return;
      const it = S.snap.items[key], T = thesis(it, holdings()), out = $('#ask-a');
      out.innerHTML = '<div class="ai" style="background:var(--bg);color:var(--ink2)"><b style="color:var(--ink)">本機 AI</b>思考中…</div>';
      const a = await askLLM(`用繁體中文簡短回答（不超過 150 字），最後提醒這不是投資建議。\n問題：${q}\n標的：${key} ${it.name}，現價 ${it.price}（${pct(it.changePct)}），判斷 ${SIG[it.signal.sig]}，分數 ${it.signal.score}，停損 ${it.signal.stop}\n支持：${T.pros.join('；') || '無'}\n風險：${T.cons.join('；') || '無'}`, key);
      if ($('#ask-a')) $('#ask-a').innerHTML = `<div class="ai" style="background:var(--bg);color:var(--ink2)"><b style="color:var(--ink)">本機 AI</b>${esc(a || '沒有回應，確認語言模型服務是否開著。')}</div>`;
    };
  }

  // ── 我的論點與決策紀錄（只存在這台裝置）────────────────────
  const J = {
    load: () => Object.assign({ theses: {}, decisions: [], moods: [] }, LS.get('journal', {})),
    save: j => LS.set('journal', j),
  };
  /** 可自動檢查的出場／警示條件（全部用網站已有的資料判斷） */
  const COND = {
    priceBelow: { label: '價格跌破', unit: '元', need: true, check: (it, v) => [it.price <= v, `現價 ${px(it.price)}`] },
    priceAbove: { label: '價格漲到（目標價）', unit: '元', need: true, check: (it, v) => [it.price >= v, `現價 ${px(it.price)}`] },
    lossPct: { label: '從我的成本虧損超過', unit: '%', need: true, check: (it, v, ctx) => { const c = ctx.cost; if (!isNum(c)) return [null, '沒有成本資料（到持股頁輸入，或記一筆「我買了」）']; const r = (it.price / c - 1) * 100; return [r <= -v, `目前 ${pct(r, 1)}（成本 ${px(c)}）`]; } },
    belowMa20: { label: '收盤跌破 20 日線', check: it => isNum(it.ta?.ma20) ? [it.price < it.ta.ma20, `20 日線 ${px(it.ta.ma20)}`] : [null, '無資料'] },
    belowMa60: { label: '收盤跌破 60 日線', check: it => isNum(it.ta?.ma60) ? [it.price < it.ta.ma60, `60 日線 ${px(it.ta.ma60)}`] : [null, '無資料'] },
    foreignSell: { label: '外資連續賣超（天）', unit: '天', need: true, check: (it, v) => isNum(it.chip?.foreignStreak) ? [it.chip.foreignStreak <= -v, it.chip.foreignStreak < 0 ? `目前連賣 ${-it.chip.foreignStreak} 天` : it.chip.foreignStreak > 0 ? `目前連買 ${it.chip.foreignStreak} 天` : '外資無連續買賣'] : [null, '無籌碼資料'] },
    revenueNeg: { label: '月營收轉為年減', check: it => isNum(it.fund?.revenueYoY) ? [it.fund.revenueYoY < 0, `月營收年增 ${pct(it.fund.revenueYoY, 1)}`] : [null, '無營收資料'] },
    rsiAbove: { label: 'RSI 過熱（高於）', unit: '', need: true, check: (it, v) => isNum(it.ta?.rsi) ? [it.ta.rsi >= v, `RSI ${it.ta.rsi.toFixed(0)}`] : [null, '無資料'] },
    scoreBelow: { label: '綜合分數低於', unit: '分', need: true, check: (it, v) => [it.signal.score < v, `目前 ${it.signal.score} 分`] },
    revQNeg: { label: '季營收轉為年減', check: it => { const q = it.fin?.quarters?.slice(-1)[0]; return isNum(q?.revYoY) ? [q.revYoY < 0, `最新季營收年增 ${pct(q.revYoY, 1)}`] : [null, '無財報資料']; } },
    gmDown: { label: '毛利率比去年同期下降超過（百分點）', unit: '', need: true, check: (it, v) => { const Q = it.fin?.quarters || [], a = Q[Q.length - 1], b = Q[Q.length - 5]; return isNum(a?.gm) && isNum(b?.gm) ? [b.gm - a.gm >= v, `毛利率 ${a.gm}%（去年同期 ${b.gm}%）`] : [null, '無財報資料']; } },
    finWeak: { label: '財報體質轉弱', check: it => it.fin ? [it.fin.score <= -2, `目前「${it.fin.grade}」`] : [null, '無財報資料'] },
    sellSignal: { label: '出現賣出訊號', check: it => [it.signal.sig === 'SELL', `目前 ${SIG[it.signal.sig]}`] },
    earnings: { label: '財報前（天內）', unit: '天', need: true, check: (it, v) => { const e = it.fund?.earningsDate; if (!e) return [null, '無財報日']; const d = Math.round((Date.parse(e) - Date.now()) / 86400000); return [d >= 0 && d <= v, `財報 ${e}（${d} 天後）`]; } },
  };
  function costOf(key) {
    const h = H.load().items.find(x => x.key === key); if (h && isNum(h.cost)) return h.cost;
    const b = J.load().decisions.filter(d => d.key === key && d.action === 'buy').pop(); return b ? b.price : null;
  }
  function checkThesis(key) {
    const t = J.load().theses[key], it = S.snap.items[key]; if (!t || !it) return null;
    const ctx = { cost: costOf(key) };
    const rows = (t.conds || []).map(c => { const d = COND[c.type]; if (!d) return null; const [hit, now] = d.check(it, c.value, ctx); return { ...c, label: d.label + (d.need ? ` ${c.value}${!d.unit || d.unit === '%' ? (d.unit || '') : ' ' + d.unit}` : ''), hit, now }; }).filter(Boolean);
    return { t, rows, hits: rows.filter(r => r.hit) };
  }
  function thesisAlerts() {
    const out = [];
    for (const k of Object.keys(J.load().theses)) { const r = checkThesis(k); if (r?.hits.length) out.push({ key: k, tag: '論點', title: `${k} ${nameOf(k)}：你設定的條件「${r.hits.map(h => h.label).join('、')}」已觸發`, detail: '回頭看你當初的論點，決定是否照計畫執行' }); }
    return out;
  }

  /** 決策當下的情境（之後用來找出你的習慣） */
  function contextOf(key) {
    const it = S.snap.items[key], ta = it.ta || {}, vix = S.snap.env.find(e => e.key === 'vix')?.value;
    return { sig: it.signal.sig, score: it.signal.score, rsi: isNum(ta.rsi) ? Math.round(ta.rsi) : null, chg: isNum(it.changePct) ? +it.changePct.toFixed(2) : null,
      aboveMa20: isNum(ta.ma20) ? it.price > ta.ma20 : null, foreign: it.chip?.foreignStreak ?? null, vix: isNum(vix) ? +vix.toFixed(1) : null, market: S.snap.verdict.label || S.snap.verdict.level, verdictLevel: S.snap.verdict.level, above20: S.snap.health?.tw?.breadth?.above20 ?? null, ret21: isNum(ta.ret21) ? +ta.ret21.toFixed(1) : null };
  }
  const ACT = { buy: '我買了', sell: '我賣了', hold: '決定不動' };
  const MOOD = [[-2, '極度恐慌'], [-1, '悲觀'], [0, '中性'], [1, '樂觀'], [2, '過熱']];
  const moodZh = m => (MOOD.find(x => x[0] === m) || [, '—'])[1];
  const BASIS = { analysis: '依據分析', feel: '依據市場感覺', both: '兩者都有' };
  const moodSeg = (name, cur) => `<div class="seg mood" role="group" aria-label="市場情緒">${MOOD.map(([v, l]) => `<button type="button" data-${name}="${v}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div>`;
  const TAGS = ['技術突破', '跌深反彈', '法人買超', '基本面', '財報／消息', '跟著模型', '別人推薦', '直覺', '停損', '獲利了結', '資金調度'];

  /** 用日 K 結算每筆決策 1／5／20 個交易日後的結果，並與同期大盤比較 */
  async function scoreDecisions() {
    const ds = J.load().decisions; if (!ds.length) return [];
    const keys = [...new Set(ds.map(d => d.key))];
    const bars = {}; await Promise.all([...keys, '^TWII', '^GSPC'].map(async k => { bars[k] = await loadBars(k); }));
    const at = (b, date, n) => { if (!b) return null; const i = b.dates.findIndex(d => d >= date); if (i < 0) return null; const j = i + n; return j < b.dates.length ? b.close[j] : null; };
    return ds.map(d => {
      const b = bars[d.key], bm = bars[d.market === 'us' ? '^GSPC' : '^TWII'], day = d.at.slice(0, 10), r = {};
      for (const n of [1, 5, 20]) {
        const p = at(b, day, n); if (!isNum(p)) continue;
        const raw = (p / d.price - 1) * 100;
        const m0 = at(bm, day, 0), m1 = at(bm, day, n), mk = isNum(m0) && isNum(m1) ? (m1 / m0 - 1) * 100 : null;
        // 買進看漲幅；賣出看「避開的跌幅」；不動看持有的漲跌
        const eff = d.action === 'sell' ? -raw : raw;
        r[n] = { raw, eff, mk, ex: isNum(mk) ? eff - (d.action === 'sell' ? -mk : mk) : null, win: d.action === 'hold' ? null : eff > 0.5 ? true : eff < -0.5 ? false : null };
      }
      return { ...d, r };
    });
  }
  function insights(rows) {
    const done = rows.filter(d => d.r[5] && d.action !== 'hold');
    const grp = (name, f) => { const g = done.filter(f); if (g.length < 3) return null; const avg = g.reduce((s, d) => s + d.r[5].eff, 0) / g.length; const win = g.filter(d => d.r[5].win).length / g.length * 100; return { name, n: g.length, avg, win }; };
    const list = [
      grp('買在 RSI 70 以上（追高）', d => d.action === 'buy' && d.ctx?.rsi >= 70),
      grp('買在 RSI 30 以下（抄底）', d => d.action === 'buy' && d.ctx?.rsi != null && d.ctx.rsi <= 30),
      grp('當天大漲 3% 以上才買', d => d.action === 'buy' && d.ctx?.chg >= 3),
      grp('跌破 20 日線時買', d => d.action === 'buy' && d.ctx?.aboveMa20 === false),
      grp('站上 20 日線時買', d => d.action === 'buy' && d.ctx?.aboveMa20 === true),
      grp('外資連賣時買', d => d.action === 'buy' && d.ctx?.foreign <= -3),
      grp('大盤判斷偏空時買', d => d.action === 'buy' && /空/.test(d.ctx?.market || '')),
      grp('VIX 高於 25 時買', d => d.action === 'buy' && d.ctx?.vix > 25),
      grp('跟模型同方向', d => (d.action === 'buy' && d.ctx?.sig === 'BUY') || (d.action === 'sell' && d.ctx?.sig === 'SELL')),
      grp('跟模型反方向', d => (d.action === 'buy' && d.ctx?.sig === 'SELL') || (d.action === 'sell' && d.ctx?.sig === 'BUY')),
      grp('依據市場感覺的操作', d => d.basis === 'feel'),
      grp('依據分析的操作', d => d.basis === 'analysis'),
      ...MOOD.map(([v, l]) => grp(`覺得市場「${l}」時買進`, d => d.action === 'buy' && d.mood === v)),
      ...MOOD.map(([v, l]) => grp(`覺得市場「${l}」時賣出`, d => d.action === 'sell' && d.mood === v)),
      ...TAGS.map(t => grp(`理由「${t}」`, d => (d.tags || []).includes(t))),
    ].filter(Boolean);
    return list.sort((a, b) => Math.abs(b.avg) - Math.abs(a.avg));
  }

  function viewThesisCard(key) {
    const it = S.snap.items[key], r = checkThesis(key), t = r?.t || { why: '', conds: [] };
    const opts = Object.entries(COND).map(([k, d]) => `<option value="${k}">${d.label}</option>`).join('');
    const condRow = (c, i) => { const d = COND[c.type]; return `<div class="crow" data-i="${i}"><select aria-label="條件">${Object.entries(COND).map(([k, x]) => `<option value="${k}"${k === c.type ? ' selected' : ''}>${x.label}</option>`).join('')}</select><input aria-label="數值" type="number" step="any" value="${c.value ?? ''}" placeholder="${d?.need ? '數值' : '不需填'}"${d?.need ? '' : ' disabled'}><button type="button" class="iconbtn" aria-label="刪除條件">✕</button></div>`; };
    return `<section class="card mine" aria-labelledby="my-h">
  <div class="hd"><h2 id="my-h">我的論點</h2><span class="note">你自己的理由與出場條件，系統每次更新都幫你檢查・只存在這台裝置</span>${r ? `<span class="tag ${r.hits.length ? 't-論點' : 't-訊號'}" style="margin-left:auto">${r.hits.length ? `${r.hits.length} 項觸發` : '論點仍成立'}</span>` : ''}</div>
  ${r ? `<ul class="checks">${r.rows.map(x => `<li class="${x.hit ? 'hit' : x.hit === false ? 'ok' : 'na'}"><span class="ic" aria-hidden="true">${x.hit ? '!' : x.hit === false ? '✓' : '–'}</span><b>${esc(x.label)}</b><span class="small muted">${x.hit ? '已觸發' : x.hit === false ? '未觸發' : '無法判斷'}・${esc(x.now)}</span></li>`).join('') || '<li class="na small muted">還沒有設定條件</li>'}</ul>
    ${t.why ? `<blockquote class="why">${esc(t.why)}<div class="small muted">寫於 ${esc((t.created || '').slice(0, 10))}${t.updated && t.updated !== t.created ? `，更新 ${esc(t.updated.slice(0, 10))}` : ''}${isNum(t.target) ? `・目標價 ${px(t.target)}（距現價 ${pct((t.target / it.price - 1) * 100, 1)}）` : ''}</div></blockquote>` : ''}` : '<p class="empty" style="margin:0">寫下你為什麼看好（或看壞）這檔，以及什麼情況代表你錯了。之後條件一觸發，總覽會提醒你。</p>'}
  <details${r ? '' : ' open'}><summary>${r ? '編輯論點' : '寫下論點'}</summary>
  <form id="th-form" class="form" style="margin-top:10px">
    <div class="field"><label for="th-why">我的理由</label><textarea id="th-why" rows="3" placeholder="例：AI 伺服器訂單能見度到明年，回檔到季線是加碼機會">${esc(t.why || '')}</textarea></div>
    <div class="field" style="max-width:240px"><label for="th-tg">我的目標價</label><input id="th-tg" type="number" step="any" value="${t.target ?? ''}"></div>
    <div class="field"><label>出場／警示條件（任一觸發就提醒）</label><div id="conds" class="form">${(t.conds || []).map(condRow).join('')}</div>
      <div class="actions"><select id="c-new" aria-label="新增條件">${opts}</select><button type="button" class="btn sm" id="c-add">＋ 加入條件</button></div></div>
    <div class="actions"><button class="btn primary" type="submit">儲存論點</button>${r ? '<button type="button" class="btn danger" id="th-del">刪除論點</button>' : ''}</div>
  </form></details>
</section>`;
  }

  function viewDecideCard(key) {
    const it = S.snap.items[key], mine = J.load().decisions.filter(d => d.key === key).slice(-5).reverse();
    return `<section class="card mine" aria-labelledby="dc-h">
  <div class="hd"><h2 id="dc-h">記錄我的決定</h2><span class="note">每次操作或「決定不動」都記一筆，之後自動算你的成績、找出你的習慣</span><a class="act" href="#/journal">我的成績單</a></div>
  <div class="actions" role="group" aria-label="記錄決定">${Object.entries(ACT).map(([k, l]) => `<button type="button" class="btn${k === 'buy' ? ' primary' : ''}" data-act="${k}">${l}</button>`).join('')}</div>
  <form id="dc-form" class="form" hidden>
    <div class="alform"><div class="field"><label for="dc-px">價格</label><input id="dc-px" type="number" step="any" inputmode="decimal" value="${it.price}"></div>
    <div class="field"><label for="dc-sh">股數（可不填）</label><input id="dc-sh" type="number" inputmode="decimal"></div></div>
    <div class="field"><label>這筆主要是</label><div class="seg" role="group" aria-label="決定依據">${Object.entries(BASIS).map(([k, l]) => `<button type="button" data-basis="${k}" aria-pressed="false">${l}</button>`).join('')}</div></div>
    <div class="field"><label>我感覺現在市場情緒（可不選）</label>${moodSeg('dmood', null)}<span class="hint">憑感覺操作也記下來：之後會統計「你的感覺」帶來的結果。</span></div>
    <div class="field"><label>理由（可複選）</label><div class="tagpick">${TAGS.map(t => `<label><input type="checkbox" value="${esc(t)}"><span>${esc(t)}</span></label>`).join('')}</div></div>
    <div class="field"><label for="dc-note">補充（可不填）</label><input id="dc-note" placeholder="例：法說會後毛利率上修"></div>
    <div class="actions"><button class="btn primary" type="submit" id="dc-ok">儲存</button><button type="button" class="btn" id="dc-cancel">取消</button></div>
  </form>
  ${mine.length ? `<ol class="list">${mine.map(d => `<li><span class="tag ${d.action === 'buy' ? 'buy' : d.action === 'sell' ? 'sell' : ''}">${ACT[d.action].replace('我', '').replace('決定', '')}</span><div><div class="t">${esc(d.at.slice(0, 10))}・${px(d.price)}${d.shares ? `・${int(d.shares)} 股` : ''}</div><div class="d">${esc([d.basis ? BASIS[d.basis] : '', d.mood != null ? '感覺市場' + moodZh(d.mood) : '', ...(d.tags || []), d.note].filter(Boolean).join('、') || '沒有寫理由')}・當時系統判斷 ${SIG[d.ctx?.sig] || '—'} ${d.ctx?.score ?? ''} 分</div></div></li>`).join('')}</ol>` : ''}
</section>`;
  }

  function bindMine(key) {
    const f = $('#th-form');
    if (f) {
      const conds = $('#conds');
      const rowHtml = type => { const d = COND[type]; return `<div class="crow"><select aria-label="條件">${Object.entries(COND).map(([k, x]) => `<option value="${k}"${k === type ? ' selected' : ''}>${x.label}</option>`).join('')}</select><input aria-label="數值" type="number" step="any" placeholder="${d.need ? '數值' : '不需填'}"${d.need ? '' : ' disabled'}><button type="button" class="iconbtn" aria-label="刪除條件">✕</button></div>`; };
      $('#c-add').onclick = () => { conds.insertAdjacentHTML('beforeend', rowHtml($('#c-new').value)); const i = conds.lastElementChild.querySelector('input:not([disabled])'); if (i) i.focus(); };
      conds.addEventListener('click', e => { const b = e.target.closest('.iconbtn'); if (b) b.closest('.crow').remove(); });
      conds.addEventListener('change', e => { if (e.target.tagName === 'SELECT') { const d = COND[e.target.value], i = e.target.nextElementSibling; i.disabled = !d.need; i.placeholder = d.need ? '數值' : '不需填'; if (!d.need) i.value = ''; } });
      f.onsubmit = e => {
        e.preventDefault();
        const j = J.load(), now = new Date().toISOString(), old = j.theses[key];
        const cs = [...conds.querySelectorAll('.crow')].map(r => { const [s, i] = r.querySelectorAll('select,input'); return { type: s.value, value: i.value === '' ? null : parseFloat(i.value) }; }).filter(c => !COND[c.type].need || isNum(c.value));
        j.theses[key] = { why: $('#th-why').value.trim(), target: $('#th-tg').value === '' ? null : parseFloat($('#th-tg').value), conds: cs, created: old?.created || now, updated: now };
        J.save(j); toast('論點已儲存'); render();
      };
      const del = $('#th-del'); if (del) del.onclick = () => { if (!confirm('刪除這檔的論點？')) return; const j = J.load(); delete j.theses[key]; J.save(j); render(); };
    }
    const df = $('#dc-form'); if (!df) return;
    let act = null, basis = null, mood = null;
    df.querySelectorAll('[data-basis]').forEach(b => b.onclick = () => { basis = basis === b.dataset.basis ? null : b.dataset.basis; df.querySelectorAll('[data-basis]').forEach(x => x.setAttribute('aria-pressed', x.dataset.basis === basis)); });
    df.querySelectorAll('[data-dmood]').forEach(b => b.onclick = () => { const v = +b.dataset.dmood; mood = mood === v ? null : v; df.querySelectorAll('[data-dmood]').forEach(x => x.setAttribute('aria-pressed', +x.dataset.dmood === mood)); });
    document.querySelectorAll('[data-act]').forEach(b => b.onclick = () => { act = b.dataset.act; df.hidden = false; $('#dc-ok').textContent = `儲存「${ACT[act]}」`; $('#dc-px').focus(); });
    $('#dc-cancel').onclick = () => { df.hidden = true; };
    df.onsubmit = e => {
      e.preventDefault();
      const price = parseFloat($('#dc-px').value); if (!isNum(price)) return;
      const j = J.load(), it = S.snap.items[key];
      j.decisions.push({ id: Date.now().toString(36), key, market: it.market, action: act, price, shares: parseFloat($('#dc-sh').value) || null,
        tags: [...df.querySelectorAll('.tagpick input:checked')].map(i => i.value), note: $('#dc-note').value.trim(), basis, mood, at: new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00'), ctx: contextOf(key) });
      J.save(j); toast(`已記錄：${ACT[act]} ${key}`); render();
    };
  }

  function viewJournal() {
    return `<section class="card" aria-labelledby="jn-h"><div class="hd"><h2 id="jn-h">我的成績單</h2><span class="note">依你記錄的決定，用之後的實際收盤結算・只存在這台裝置</span></div><div id="jn-body"><p class="loading">計算中…</p></div></section>
<section class="card" aria-labelledby="md-h"><div class="hd"><h2 id="md-h">我的市場感覺準不準</h2><span class="note">每天在總覽記下感覺，依之後大盤實際走勢統計</span></div><div id="md-body"><p class="loading">計算中…</p></div></section>
<section class="card" aria-labelledby="th2-h"><div class="hd"><h2 id="th2-h">我的論點</h2><span class="note">每次資料更新都會重新檢查</span></div>${viewThesisList()}</section>${footer()}`;
  }
  function viewThesisList() {
    const ks = Object.keys(J.load().theses);
    if (!ks.length) return '<p class="empty" style="margin:0">還沒有寫論點。到任一個股頁的「我的論點」寫下理由和出場條件。</p>';
    return `<ol class="list">${ks.map(k => { const r = checkThesis(k); if (!r) return `<li><span class="tag">已移除</span><div class="t">${esc(k)}（不在觀察清單）</div></li>`; return `<li><span class="tag ${r.hits.length ? 't-論點' : 't-訊號'}">${r.hits.length ? '觸發' : '成立'}</span><div><a class="t" href="#/s/${encodeURIComponent(k)}">${esc(k)} ${esc(nameOf(k))}</a><div class="d">${esc(r.t.why || '（沒有寫理由）')}</div>${r.hits.length ? `<div class="d bad-text">已觸發：${esc(r.hits.map(h => h.label).join('、'))}</div>` : ''}</div></li>`; }).join('')}</ol>`;
  }
  async function moodStats() {
    const ms = J.load().moods; if (!ms.length) return null;
    const bars = { tw: await loadBars('^TWII'), us: await loadBars('^GSPC') };
    const fwd = (b, day, n) => { if (!b) return null; const i = b.dates.findIndex(d => d >= day); if (i < 0 || i + n >= b.dates.length) return null; return (b.close[i + n] / b.close[i] - 1) * 100; };
    const rows = ms.map(m => ({ ...m, r5: fwd(bars[m.market], m.at.slice(0, 10), 5), r20: fwd(bars[m.market], m.at.slice(0, 10), 20) }));
    const groups = MOOD.map(([v, l]) => { const g = rows.filter(r => r.mood === v), g5 = g.filter(r => isNum(r.r5)), g20 = g.filter(r => isNum(r.r20)); const avg = (a, k) => a.length ? a.reduce((s, r) => s + r[k], 0) / a.length : null; return { v, l, n: g.length, n5: g5.length, a5: avg(g5, 'r5'), a20: avg(g20, 'r20'), n20: g20.length }; });
    return { rows, groups };
  }
  async function fillMood() {
    const box = $('#md-body'); if (!box) return;
    const M = await moodStats(); if (!$('#md-body') || S.route !== 'journal') return;
    if (!M) { box.innerHTML = '<p class="empty" style="margin:0">還沒有紀錄。到總覽「今日判斷」右邊點選你對台股、美股的感覺（極度恐慌～過熱），每天點一次就好。</p>'; return; }
    const g = M.groups.filter(x => x.n);
    const fear = M.groups.filter(x => x.v < 0 && x.n5), greed = M.groups.filter(x => x.v > 0 && x.n5);
    const avgOf = a => { const n = a.reduce((s, x) => s + x.n5, 0); return n ? a.reduce((s, x) => s + x.a5 * x.n5, 0) / n : null; };
    const fa = avgOf(fear), ga = avgOf(greed);
    let verdict = '累積更多紀錄後（每種感覺至少 3 次、滿 5 個交易日）會告訴你：你的感覺是順勢指標還是反向指標。';
    if (fa != null && ga != null && fear.reduce((s, x) => s + x.n5, 0) >= 3 && greed.reduce((s, x) => s + x.n5, 0) >= 3) {
      verdict = fa > ga + 0.5 ? `你覺得悲觀／恐慌之後，大盤 5 日平均 ${pct(fa, 1)}；覺得樂觀／過熱之後 ${pct(ga, 1)}。你的感覺偏向「反向指標」：恐慌時常是買點、過熱時該小心。`
        : ga > fa + 0.5 ? `你覺得樂觀之後大盤 5 日平均 ${pct(ga, 1)}，悲觀之後 ${pct(fa, 1)}。你的感覺偏向「順勢指標」，可以適度相信直覺。`
        : `你的感覺和大盤之後的走勢關係不明顯（悲觀後 ${pct(fa, 1)}、樂觀後 ${pct(ga, 1)}），憑感覺操作時建議縮小部位。`;
    }
    box.innerHTML = `<p style="margin:0;font-weight:500">${verdict}</p>
      <div class="tbl-box"><table class="tbl rtbl"><thead><tr><th>我的感覺</th><th class="num">次數</th><th class="num">之後 5 日大盤</th><th class="num">之後 20 日大盤</th></tr></thead><tbody>
      ${g.map(x => `<tr><td>${x.l}</td><td class="num">${x.n}</td><td class="num ${cls(x.a5)}">${x.a5 == null ? '<span class="muted">待結算</span>' : pct(x.a5, 1) + ` <small class="muted">(${x.n5})</small>`}</td><td class="num ${cls(x.a20)}">${x.a20 == null ? '<span class="muted">待結算</span>' : pct(x.a20, 1) + ` <small class="muted">(${x.n20})</small>`}</td></tr>`).join('')}</tbody></table></div>
      <p class="small muted" style="margin:0">台股感覺對照加權指數、美股感覺對照標普 500。最近 5 筆：${M.rows.slice(-5).reverse().map(r => `${r.at.slice(5, 10)} ${r.market === 'tw' ? '台' : '美'}${moodZh(r.mood)}`).join('、')}</p>`;
  }
  async function afterJournal() {
    fillMood();
    const rows = await scoreDecisions(), box = $('#jn-body'); if (!box || S.route !== 'journal') return;
    if (!rows.length) { box.innerHTML = '<p class="empty" style="margin:0">還沒有紀錄。到個股頁按「我買了／我賣了／決定不動」記下你的決定，5 個交易日後就會開始出現成績。</p>'; return; }
    const act = rows.filter(d => d.action !== 'hold'), d5 = act.filter(d => d.r[5]);
    const avg = (a, f) => a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : null;
    const win = d5.length ? d5.filter(d => d.r[5].win).length / d5.length * 100 : null;
    const ex = avg(d5.filter(d => isNum(d.r[5].ex)), d => d.r[5].ex);
    const model = d5.filter(d => d.ctx?.sig && d.ctx.sig !== 'HOLD');
    const modelWin = model.length ? model.filter(d => { const raw = d.r[5].raw; return d.ctx.sig === 'BUY' ? raw > 0.5 : raw < -0.5; }).length / model.length * 100 : null;
    const ins = insights(rows);
    const res = (r, n) => !r[n] ? '<span class="muted">待結算</span>' : `<span class="${cls(r[n].eff)}">${pct(r[n].eff, 1)}</span>${isNum(r[n].ex) ? `<div class="small muted">贏大盤 ${pct(r[n].ex, 1)}</div>` : ''}`;
    box.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="lb">紀錄筆數</div><div class="v">${rows.length}</div><div class="small muted">已結算 5 日：${d5.length} 筆</div></div>
        <div class="kpi"><div class="lb">我的 5 日勝率</div><div class="v">${win == null ? '—' : win.toFixed(0) + '%'}</div><div class="small muted">賣出以「之後下跌」算對</div></div>
        <div class="kpi"><div class="lb">平均贏大盤（5 日）</div><div class="v ${cls(ex)}">${ex == null ? '—' : pct(ex, 1)}</div></div>
        <div class="kpi"><div class="lb">同樣時點系統的勝率</div><div class="v">${modelWin == null ? '—' : modelWin.toFixed(0) + '%'}</div><div class="small muted">${model.length} 筆系統有給買賣訊號</div></div>
      </div>
      <div><b class="small">我的習慣</b>${ins.length ? `<ul class="habits">${ins.slice(0, 6).map(g => `<li><span>${esc(g.name)}</span><span class="small muted">${g.n} 次・勝率 ${g.win.toFixed(0)}%</span><b class="mono ${cls(g.avg)}">5 日平均 ${pct(g.avg, 1)}</b></li>`).join('')}</ul>` : '<p class="small muted" style="margin:4px 0 0">同一種情況累積 3 筆已結算的紀錄後，這裡會告訴你哪些習慣幫你賺、哪些讓你賠。</p>'}</div>
      <div class="tbl-box"><table class="tbl" style="min-width:680px"><thead><tr><th>日期</th><th>標的</th><th>決定</th><th class="num">價格</th><th>理由</th><th>當時系統</th><th class="num">1 日</th><th class="num">5 日</th><th class="num">20 日</th><th></th></tr></thead><tbody>
      ${rows.slice().reverse().map(d => `<tr><td class="mono">${esc(d.at.slice(0, 10))}</td><td><a class="sym" href="#/s/${encodeURIComponent(d.key)}">${esc(d.key)}</a></td><td>${esc(ACT[d.action])}</td><td class="num">${px(d.price)}</td>
        <td class="small" style="white-space:normal;max-width:220px">${esc([d.basis ? BASIS[d.basis] : '', d.mood != null ? '感覺' + moodZh(d.mood) : '', ...(d.tags || []), d.note].filter(Boolean).join('、') || '—')}</td><td class="small">${SIG[d.ctx?.sig] || '—'} ${d.ctx?.score ?? ''}</td>
        <td class="num">${res(d.r, 1)}</td><td class="num">${res(d.r, 5)}</td><td class="num">${res(d.r, 20)}</td><td><button type="button" class="iconbtn" data-deld="${esc(d.id)}" aria-label="刪除這筆">✕</button></td></tr>`).join('')}</tbody></table></div>
      <p class="small muted" style="margin:0">「決定不動」不算勝率，只記錄之後的漲跌，讓你回頭看「不動」對不對。漲跌未達 ±0.5% 不計入勝負。</p>`;
    box.onclick = e => { const b = e.target.closest('[data-deld]'); if (!b || !confirm('刪除這筆紀錄？')) return; const j = J.load(); j.decisions = j.decisions.filter(x => x.id !== b.dataset.deld); J.save(j); render(); };
  }

  // ── 組合分析（歸因、回撤、相關性、曝險）──────────────────────
  async function portfolioAnalytics(P) {
    const rows = P.rows.filter(r => r.mv > 0 && r.it);
    if (!rows.length || !P.total) return null;
    const keys = rows.map(r => r.key), bars = {};
    await Promise.all([...keys, '^TWII', '^GSPC'].map(async k => { bars[k] = await loadBars(k); }));
    if (keys.some(k => !bars[k])) return { error: '部分持股走勢資料載入失敗' };
    const maps = Object.fromEntries(Object.entries(bars).filter(([, b]) => b).map(([k, b]) => [k, new Map(b.dates.map((d, i) => [d, b.close[i]]))]));
    let dates = bars[keys[0]].dates.slice();
    for (const k of keys.slice(1)) dates = dates.filter(d => maps[k].has(d));
    dates = dates.slice(-253);
    if (dates.length < 30) return { error: '共同交易日太少' };
    const w = Object.fromEntries(rows.map(r => [r.key, r.mv / P.total]));
    const wTW = P.tw / P.total, wUS = P.us / P.total;
    const ret = (k, i) => { const m = maps[k]; const a = m?.get(dates[i - 1]), b = m?.get(dates[i]); return a && b ? b / a - 1 : 0; };
    const rp = [], rb = [], R = Object.fromEntries(keys.map(k => [k, []]));
    for (let i = 1; i < dates.length; i++) {
      let s = 0; for (const k of keys) { const r = ret(k, i); R[k].push(r); s += w[k] * r; }
      rp.push(s); rb.push(wTW * ret('^TWII', i) + wUS * ret('^GSPC', i));
    }
    const cum = (a, n) => { const x = a.slice(-n); return (x.reduce((p, r) => p * (1 + r), 1) - 1) * 100; };
    const mdd = a => { let pk = 1, v = 1, m = 0; for (const r of a) { v *= 1 + r; pk = Math.max(pk, v); m = Math.min(m, v / pk - 1); } return m * 100; };
    const sd = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
    const corr = (a, b) => { const n = Math.min(a.length, b.length, 60), x = a.slice(-n), y = b.slice(-n); const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n; let c = 0, vx = 0, vy = 0; for (let i = 0; i < n; i++) { c += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; } return vx && vy ? c / Math.sqrt(vx * vy) : 0; };
    const C = keys.map(a => keys.map(b => corr(R[a], R[b])));
    let pairs = 0, sumC = 0; for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) { pairs++; sumC += C[i][j]; }
    const hhi = rows.reduce((s, r) => s + (r.mv / P.stock) ** 2, 0);
    const beta = rows.reduce((s, r) => s + w[r.key] * (isNum(r.it.ta?.beta) ? r.it.ta.beta : 1), 0);
    let v = 1; const curve = rp.slice(-120).map(r => (v *= 1 + r)); let vb = 1; const curveB = rb.slice(-120).map(r => (vb *= 1 + r));
    const soonEarn = rows.filter(r => { const e = r.it.fund?.earningsDate; if (!e) return false; const d = (Date.parse(e) - Date.now()) / 86400000; return d >= 0 && d <= 14; });
    return {
      n: dates.length - 1, keys, C, avgCorr: pairs ? sumC / pairs : null,
      perf: [['近 1 個月', 21], ['近 3 個月', 63], ['近 1 年', 252]].map(([l, n]) => ({ l, p: cum(rp, n), b: cum(rb, n) })),
      vol: sd(rp.slice(-60)) * Math.sqrt(252) * 100, volB: sd(rb.slice(-60)) * Math.sqrt(252) * 100, mdd: mdd(rp), mddB: mdd(rb),
      beta, effN: hhi > 0 ? 1 / hhi : null, top3: rows.slice().sort((a, b) => b.mv - a.mv).slice(0, 3).reduce((s, r) => s + r.mv, 0) / P.total * 100,
      today: rows.map(r => ({ key: r.key, day: r.day || 0 })).sort((a, b) => Math.abs(b.day) - Math.abs(a.day)),
      todayP: P.dayPct, todayB: (wTW * (S.snap.indices?.['^TWII']?.changePct || 0) + wUS * (S.snap.indices?.['^GSPC']?.changePct || 0)),
      curve, curveB, soonEarn: soonEarn.map(r => r.key), soonW: soonEarn.reduce((s, r) => s + r.mv, 0) / P.total * 100,
    };
  }
  function viewAnalytics(A, P) {
    if (!A) return '';
    if (A.error) return `<p class="empty">${esc(A.error)}</p>`;
    const mx = Math.max(...A.today.map(t => Math.abs(t.day)), 1);
    const cc = v => { const a = Math.abs(v); return `background:rgba(${v >= 0 ? '200,35,44' : '14,124,74'},${(a * 0.55).toFixed(2)});color:${a > 0.6 ? '#fff' : 'var(--ink)'}`; };
    return `
      <div class="kpis">
        <div class="kpi"><div class="lb">組合 Beta</div><div class="v">${num(A.beta)}</div><div class="small muted">大盤漲跌 1%，組合約 ${num(A.beta)}%</div></div>
        <div class="kpi"><div class="lb">有效持股數</div><div class="v">${num(A.effN, 1)}</div><div class="small muted">前 3 大占總資產 ${A.top3.toFixed(0)}%</div></div>
        <div class="kpi"><div class="lb">平均相關係數（60 日）</div><div class="v">${A.avgCorr == null ? '—' : num(A.avgCorr)}</div><div class="small muted">${A.avgCorr == null ? '只有一檔' : A.avgCorr > 0.6 ? '持股走勢高度同步，分散效果有限' : A.avgCorr > 0.3 ? '中度相關' : '分散效果良好'}</div></div>
        <div class="kpi"><div class="lb">14 天內有財報</div><div class="v">${A.soonW.toFixed(0)}%</div><div class="small muted">${A.soonEarn.length ? esc(A.soonEarn.join('、')) : '無'}</div></div>
      </div>
      <div class="grid2">
        <div><b class="small">績效 vs 同配置大盤</b><span class="small muted">（以目前權重回推，美股未計匯率）</span>
          <table class="tbl rtbl" style="margin-top:6px"><thead><tr><th></th><th class="num">我的組合</th><th class="num">同配置大盤</th><th class="num">差異</th></tr></thead><tbody>
          ${A.perf.map(x => `<tr><td>${x.l}</td><td class="num ${cls(x.p)}">${pct(x.p, 1)}</td><td class="num ${cls(x.b)}">${pct(x.b, 1)}</td><td class="num ${cls(x.p - x.b)}"><b>${pct(x.p - x.b, 1)}</b></td></tr>`).join('')}
          <tr><td>年化波動（60 日）</td><td class="num">${num(A.vol, 1)}%</td><td class="num">${num(A.volB, 1)}%</td><td></td></tr>
          <tr><td>最大回撤（1 年）</td><td class="num down">${pct(A.mdd, 1)}</td><td class="num down">${pct(A.mddB, 1)}</td><td></td></tr></tbody></table>
          <div class="legend" style="margin-top:6px"><span><i style="background:#1F4FD8;height:2px"></i>我的組合</span><span><i style="background:#8A93A3;height:2px"></i>同配置大盤</span><span class="muted">近 120 個交易日</span></div>
          ${(() => { const all = [...A.curve, ...A.curveB]; const lo = Math.min(...all), hi = Math.max(...all), W = 600, Hh = 120; const y = t => (Hh - 4 - (t - lo) / ((hi - lo) || 1) * (Hh - 8)).toFixed(1); const pth = a => a.map((t, i) => `${i ? 'L' : 'M'}${(i / (a.length - 1) * W).toFixed(1)},${y(t)}`).join(''); return `<svg viewBox="0 0 ${W} ${Hh}" style="width:100%;height:auto" role="img" aria-label="組合與大盤近 120 日走勢"><path d="${pth(A.curveB)}" fill="none" stroke="#8A93A3" stroke-width="1.5"/><path d="${pth(A.curve)}" fill="none" stroke="#1F4FD8" stroke-width="2"/></svg>`; })()}
        </div>
        <div><b class="small">今日損益歸因</b><span class="small muted">（組合 ${pct(A.todayP)}，同配置大盤 ${pct(A.todayB)}）</span>
          <div class="attr">${A.today.map(t => `<div class="ar"><span><a href="#/s/${encodeURIComponent(t.key)}">${esc(t.key)}</a> <span class="small muted">${esc(nameOf(t.key))}</span></span><div class="ab"><div class="${t.day >= 0 ? 'up-bg' : 'down-bg'}" style="width:${Math.abs(t.day) / mx * 100}%;${t.day >= 0 ? 'margin-left:50%' : `margin-left:${50 - Math.abs(t.day) / mx * 50}%`};max-width:50%"></div></div><span class="mono small ${cls(t.day)}" style="text-align:right">${sign(t.day)}${int(Math.abs(t.day))}</span></div>`).join('')}</div>
        </div>
      </div>
      ${A.keys.length > 1 ? `<div><b class="small">持股相關係數（近 60 個交易日）</b><div class="tbl-box"><table class="tbl corr"><thead><tr><th></th>${A.keys.map(k => `<th class="num">${esc(k)}</th>`).join('')}</tr></thead><tbody>${A.keys.map((a, i) => `<tr><td><b>${esc(a)}</b></td>${A.C[i].map((v, j) => `<td class="num" style="${i === j ? '' : cc(v)}">${i === j ? '—' : v.toFixed(2)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="small muted" style="margin:4px 0 0">越接近 1 代表走勢越同步；高相關的持股一起跌的機率高。</p></div>` : ''}`;
  }

  // ── 持股編輯 ────────────────────────────────────────────────
  function viewPortfolio() {
    const h = H.load(), opts = Object.keys(S.snap.items).map(k => `<option value="${esc(k)}">${esc(k)} ${esc(nameOf(k))}</option>`).join('');
    const rowHtml = (x, i) => `<div class="hrow" data-i="${i}"><input aria-label="代號" list="hold-list" value="${esc(x.key || '')}" placeholder="代號，如 2330、NVDA"><input aria-label="股數" type="number" inputmode="decimal" value="${x.shares ?? ''}" placeholder="股數"><input aria-label="平均成本" type="number" inputmode="decimal" step="any" value="${x.cost ?? ''}" placeholder="成本（原幣）"><button type="button" class="iconbtn" aria-label="刪除這一列" data-del="${i}">✕</button></div>`;
    return `${h.items.length ? `<section class="card" aria-labelledby="pa-h"><div class="hd"><h2 id="pa-h">組合分析</h2><span class="note">歸因、績效、回撤、相關性、曝險・只在你的裝置上計算</span></div><div id="pa-body"><p class="loading">計算中…</p></div></section>` : ''}
<section class="card" aria-labelledby="pe-h">
  <div class="hd"><h2 id="pe-h">我的持股</h2><span class="note">只存在這台裝置的瀏覽器，不會上傳到網站。換裝置可用「匯出／匯入」（含論點、決策紀錄、自選、提醒）。</span></div>
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
    $('#exp').onclick = () => { const blob = new Blob([JSON.stringify({ ...H.load(), journal: J.load(), stars: stars(), alerts: alerts() }, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'signal-terminal-mine.json'; a.click(); URL.revokeObjectURL(a.href); };
    $('#imp').onclick = () => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'application/json'; i.onchange = async () => { try { const d = JSON.parse(await i.files[0].text()); if (!Array.isArray(d.items)) throw 0; H.save({ items: d.items, cash: d.cash || 0 }); if (d.journal) J.save(d.journal); if (d.stars) LS.set('stars', d.stars); if (d.alerts) LS.set('alerts', d.alerts); render(); } catch (_) { msg.className = 'small bad-text'; msg.textContent = '檔案格式不正確。'; } }; i.click(); };
    $('#lm-form').onsubmit = e => { e.preventDefault(); cfg.limits = { var95: +$('#l-var').value || DEF.limits.var95, single: +$('#l-single').value || DEF.limits.single, cashMin: +$('#l-cash').value || 0 }; saveCfg(); msg.className = 'small ok-text'; msg.textContent = '風險上限已儲存。'; };
  }

  // ── 策略回測（在瀏覽器計算，參數可調）────────────────────────
  const BT_DEF = { scope: 'all', buy: 63, sell: 37, stopAtr: 2, takePct: 0, maxDays: 0, costTW: 0.585, costUS: 0.05, trend: false };
  const BT = Object.assign({}, BT_DEF, LS.get('bt', {}));

  /** 與雲端 Signal.taScore 相同的技術面分數，逐日計算（只用當天以前的資料） */
  function taSeries(b) {
    const c = b.close, h = b.high, l = b.low, v = b.volume, n = c.length;
    const ema = (a, k) => { const q = 2 / (k + 1), o = [a[0]]; for (let i = 1; i < a.length; i++) o.push(a[i] * q + o[i - 1] * (1 - q)); return o; };
    const e12 = ema(c, 12), e26 = ema(c, 26), macd = c.map((_, i) => e12[i] - e26[i]);
    const rsi = new Array(n).fill(null); { const a = 1 / 14; let g = 0, ls = 0, den = 0; for (let i = 1; i < n; i++) { const d = c[i] - c[i - 1]; g = g * (1 - a) + Math.max(0, d); ls = ls * (1 - a) + Math.max(0, -d); den = den * (1 - a) + 1; if (i >= 14) { const ag = g / den, al = ls / den; rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } } }
    const sma = (i, k) => { if (i < k - 1) return null; let s = 0; for (let j = i - k + 1; j <= i; j++) s += c[j]; return s / k; };
    const out = [];
    for (let i = 0; i < n; i++) {
      if (i < 35) { out.push(null); continue; }
      const chg = (c[i] / c[i - 1] - 1) * 100, ma20 = sma(i, 20), ma60 = sma(i, 60);
      let sd = 0; for (let j = i - 19; j <= i; j++) sd += (c[j] - ma20) ** 2; sd = Math.sqrt(sd / 19);
      const bb = sd > 0 ? (c[i] - (ma20 - 2 * sd)) / (4 * sd) * 100 : 50;
      let av = 0; for (let j = i - 20; j < i; j++) av += v[j] || 0; av /= 20;
      const rv = av > 0 ? v[i] / av : null;
      let s = 50 + Math.max(-10, Math.min(10, chg));
      if (rsi[i] != null) s += (50 - rsi[i]) * 0.25;
      s += macd[i] / c[i] * 100 * 8;
      s += (50 - bb) * 0.10;
      s += c[i] > ma20 ? 4 : -4;
      if (ma60 != null) s += ma20 > ma60 ? 3 : -3;
      if (rv > 2) s += chg > 0 ? 4 : chg < 0 ? -4 : 0;
      if (rsi[i] != null && rsi[i] < 30) s += 5;
      if (rsi[i] != null && rsi[i] > 70) s -= 5;
      let tr = 0; for (let j = i - 13; j <= i; j++) tr += Math.max(h[j] - l[j], Math.abs(h[j] - c[j - 1]), Math.abs(l[j] - c[j - 1])); tr /= 14;
      out.push({ score: Math.max(5, Math.min(95, s)), atr: tr, ma60 });
    }
    return out;
  }

  /** 單一標的回測：收盤出訊號，隔天開盤成交；停損停利盤中觸價成交（跳空以開盤價） */
  function backtestOne(b, market, P) {
    const ta = taSeries(b), c = b.close, o = b.open, h = b.high, l = b.low, d = b.dates, n = c.length;
    const start = 60, cost = (market === 'tw' ? P.costTW : P.costUS) / 100 / 2;
    let pos = null, cash = 1, eq = [], trades = [], days = 0;
    for (let i = start; i < n; i++) {
      // 先處理持倉中的盤中停損／停利
      if (pos) {
        let exit = null, why = '';
        if (pos.stop && l[i] <= pos.stop) { exit = Math.min(o[i], pos.stop); why = '停損'; }
        else if (pos.take && h[i] >= pos.take) { exit = Math.max(o[i], pos.take); why = '停利'; }
        if (exit != null) { const r = exit * (1 - cost) / pos.cost - 1; cash *= 1 + r; trades.push({ in: pos.date, out: d[i], pin: pos.px, pout: exit, r: r * 100, days: i - pos.i, why }); pos = null; }
      }
      // 隔日開盤執行前一天收盤的訊號
      if (i > start && ta[i - 1]) {
        const t = ta[i - 1];
        if (!pos && t.score >= P.buy && (!P.trend || (t.ma60 && c[i - 1] > t.ma60))) {
          const px = o[i]; pos = { px, cost: px * (1 + cost), date: d[i], i, stop: P.stopAtr > 0 ? c[i - 1] - P.stopAtr * t.atr : null, take: P.takePct > 0 ? px * (1 + P.takePct / 100) : null };
          if (pos.stop && l[i] <= pos.stop) { const ex = Math.min(o[i], pos.stop), r = ex * (1 - cost) / pos.cost - 1; cash *= 1 + r; trades.push({ in: d[i], out: d[i], pin: px, pout: ex, r: r * 100, days: 0, why: '停損' }); pos = null; }
        } else if (pos && (t.score <= P.sell || (P.maxDays > 0 && i - pos.i >= P.maxDays))) {
          const ex = o[i], r = ex * (1 - cost) / pos.cost - 1; cash *= 1 + r; trades.push({ in: pos.date, out: d[i], pin: pos.px, pout: ex, r: r * 100, days: i - pos.i, why: t.score <= P.sell ? '賣出訊號' : '持有期滿' }); pos = null;
        }
      }
      if (pos) days++;
      eq.push({ date: d[i], v: pos ? cash * (c[i] * (1 - cost) / pos.cost) : cash });
    }
    const bh = eq.map((e, k) => ({ date: e.date, v: c[start + k] / c[start] }));
    return { eq, bh, trades, open: pos ? { date: pos.date, px: pos.px, unreal: (c[n - 1] / pos.cost - 1) * 100 } : null, exposure: days / Math.max(1, n - start) * 100 };
  }
  function stats(eq, trades) {
    if (!eq.length) return null;
    const v = eq.map(e => e.v), tot = (v[v.length - 1] / v[0] - 1) * 100, yrs = eq.length / 250;
    let pk = v[0], mdd = 0; for (const x of v) { pk = Math.max(pk, x); mdd = Math.min(mdd, x / pk - 1); }
    const rets = v.slice(1).map((x, i) => x / v[i] - 1), m = rets.reduce((s, x) => s + x, 0) / rets.length, sd = Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1));
    const t = trades || [];
    return { tot, cagr: (Math.pow(v[v.length - 1] / v[0], 1 / Math.max(yrs, 0.1)) - 1) * 100, mdd: mdd * 100, sharpe: sd > 0 ? m / sd * Math.sqrt(250) : null,
      n: t.length, win: t.length ? t.filter(x => x.r > 0).length / t.length * 100 : null, avg: t.length ? t.reduce((s, x) => s + x.r, 0) / t.length : null, hold: t.length ? t.reduce((s, x) => s + x.days, 0) / t.length : null };
  }
  /** 多檔平均：每檔分配相同資金、各自進出，依日期對齊（休市日沿用前值） */
  function combine(curves) {
    const dates = [...new Set(curves.flatMap(c => c.map(e => e.date)))].sort();
    const maps = curves.map(c => new Map(c.map(e => [e.date, e.v])));
    const last = curves.map(() => 1);
    return dates.map(d => { maps.forEach((m, i) => { if (m.has(d)) last[i] = m.get(d) / curves[i][0].v; }); return { date: d, v: last.reduce((s, x) => s + x, 0) / last.length }; });
  }
  function halves(curve) { const k = Math.floor(curve.length / 2); return [curve.slice(0, k + 1), curve.slice(k)].map(c => (c.length > 1 ? (c[c.length - 1].v / c[0].v - 1) * 100 : null)); }

  function viewBacktest(key) {
    const opts = Object.values(S.snap.items).map(it => `<option value="${esc(it.key)}"${BT.scope === it.key ? ' selected' : ''}>${esc(it.key)} ${esc(it.name)}</option>`).join('');
    const f = (id, label, val, step, hint) => `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="number" step="${step}" value="${val}" inputmode="decimal">${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
    return `<div><a href="#/scorecard" class="small">← 系統成績</a></div>
<section class="card" aria-labelledby="bt-h"><div class="hd"><h2 id="bt-h">策略回測</h2><span class="note">如果過去照技術面訊號操作，結果會怎樣・在你的瀏覽器計算</span></div>
  <form id="bt-form" class="btform">
    <div class="field"><label for="bt-scope">標的</label><select id="bt-scope"><option value="all"${BT.scope === 'all' ? ' selected' : ''}>全部觀察清單（每檔相同資金）</option><option value="tw"${BT.scope === 'tw' ? ' selected' : ''}>台股觀察清單</option><option value="us"${BT.scope === 'us' ? ' selected' : ''}>美股觀察清單</option>${opts}</select></div>
    ${f('bt-buy', '買進：技術分數 ≥', BT.buy, 1, '系統預設 63')}
    ${f('bt-sell', '賣出：技術分數 ≤', BT.sell, 1, '系統預設 37')}
    ${f('bt-stop', '停損：進場前收盤 − N 倍 ATR', BT.stopAtr, 0.5, '0＝不停損；系統預設 2')}
    ${f('bt-take', '停利（%）', BT.takePct, 1, '0＝不停利')}
    ${f('bt-days', '最長持有（交易日）', BT.maxDays, 1, '0＝不限')}
    ${f('bt-ctw', '台股交易成本（來回 %）', BT.costTW, 0.005, '手續費 0.1425%×2＋證交稅 0.3%')}
    ${f('bt-cus', '美股交易成本（來回 %）', BT.costUS, 0.01, '')}
    <div class="field"><label><input id="bt-trend" type="checkbox"${BT.trend ? ' checked' : ''}> 只在收盤高於 60 日線時買進（順勢濾網）</label></div>
    <div class="actions"><button class="btn primary" type="submit">重新回測</button><button class="btn" type="button" id="bt-reset">恢復系統預設</button></div>
  </form>
  <div id="bt-out"><p class="loading">回測中…</p></div>
</section>
<section class="card" aria-labelledby="oos-h">${viewModelOOS()}</section>
${footer()}`;
  }
  function viewModelOOS() {
    const o = S.snap.scorecard?.modelOOS;
    const since = o?.since ? `台股模型 ${esc(o.since.tw || '—')}、美股模型 ${esc(o.since.us || '—')}` : '';
    if (!o || !o.all?.n) return `<div class="hd"><h2 id="oos-h">AI 模型的樣本外表現</h2></div><p class="empty" style="margin:0">尚無資料（下次更新後出現）。</p>`;
    const row = (l, g) => `<tr><td>${l}</td><td class="num">${g.n}</td><td class="num ${cls(g.avg)}">${g.avg == null ? '—' : pct(g.avg, 2)}</td><td class="num">${g.up == null ? '—' : g.up.toFixed(0) + '%'}</td></tr>`;
    return `<div class="hd"><h2 id="oos-h">AI 模型的樣本外表現</h2><span class="note">只看模型訓練日之後（${since}），避免用訓練過的資料自我評分</span></div>
      <table class="tbl rtbl"><thead><tr><th>模型判斷</th><th class="num">次數（檔×日）</th><th class="num">隔日平均漲跌</th><th class="num">隔日上漲比例</th></tr></thead><tbody>${row('買進', o.buy)}${row('觀望', o.hold)}${row('賣出', o.sell)}${row('全部（基準）', o.all)}</tbody></table>
      <p class="small muted" style="margin:0">${o.hit ? `買進／賣出判斷的方向命中率 ${o.hit.rate}%（${o.hit.n} 次，漲跌未達 ±0.5% 不計）。` : ''}「買進」的隔日表現要明顯好於「全部」，模型才有價值。樣本期間只有訓練日之後的幾週，數字會隨時間累積變得可靠；台股模型在這裡沒有籌碼特徵（純技術模式）。</p>`;
  }
  async function runBacktest() {
    const out = $('#bt-out'); if (!out) return;
    out.innerHTML = '<p class="loading">回測中…</p>';
    const items = Object.values(S.snap.items).filter(it => BT.scope === 'all' || it.market === BT.scope || it.key === BT.scope);
    const res = [];
    for (const it of items) { const b = await loadBars(it.key); if (b && b.close.length > 120) res.push({ it, r: backtestOne(b, it.market, BT) }); }
    if (S.route !== 'backtest' || !$('#bt-out')) return;
    if (!res.length) { out.innerHTML = '<p class="empty">沒有足夠的歷史資料。</p>'; return; }
    const single = res.length === 1;
    const curve = single ? res[0].r.eq : combine(res.map(x => x.r.eq)), bh = single ? res[0].r.bh : combine(res.map(x => x.r.bh));
    const trades = res.flatMap(x => x.r.trades.map(t => ({ ...t, key: x.it.key })));
    const S1 = stats(curve, trades), S2 = stats(bh, null);
    const [h1, h2] = halves(curve), [b1, b2] = halves(bh);
    const exp = res.reduce((s, x) => s + x.r.exposure, 0) / res.length;
    const all = [...curve.map(e => e.v), ...bh.map(e => e.v)], lo = Math.min(...all), hi = Math.max(...all), W = 1000, Hh = 220;
    const y = t => (Hh - 6 - (t - lo) / ((hi - lo) || 1) * (Hh - 12)).toFixed(1), pth = a => a.map((e, i) => `${i ? 'L' : 'M'}${(i / (a.length - 1) * W).toFixed(1)},${y(e.v)}`).join('');
    const better = S1.tot - S2.tot;
    const halfOk = h1 != null && h2 != null && (h1 - b1 > 0) === (h2 - b2 > 0);
    const verdict = better > 0
      ? `這組規則在回測期間比一直持有${better > 0 ? '多賺' : ''} ${fix(better, 1)} 個百分點${halfOk ? '，前後兩半段都贏，結果較穩定' : '，但只在其中一半期間贏，可能是運氣或過度調整參數'}。`
      : `這組規則在回測期間比一直持有少賺 ${fix(-better, 1)} 個百分點${S1.mdd > S2.mdd ? `，但最大回撤較小（${pct(S1.mdd, 1)} vs ${pct(S2.mdd, 1)}），風險較低` : ''}。`;
    const per = res.map(x => { const a = stats(x.r.eq, x.r.trades), bb = stats(x.r.bh, null); return { key: x.it.key, name: x.it.name, s: a.tot, b: bb.tot, n: a.n, win: a.win, mdd: a.mdd, open: x.r.open }; }).sort((a, b) => (b.s - b.b) - (a.s - a.b));
    out.innerHTML = `
      <p style="margin:0;font-weight:500">${verdict}</p>
      <div class="kpis">
        <div class="kpi"><div class="lb">策略總報酬</div><div class="v ${cls(S1.tot)}">${pct(S1.tot, 1)}</div><div class="small muted">一直持有 ${pct(S2.tot, 1)}</div></div>
        <div class="kpi"><div class="lb">最大回撤</div><div class="v down">${pct(S1.mdd, 1)}</div><div class="small muted">一直持有 ${pct(S2.mdd, 1)}</div></div>
        <div class="kpi"><div class="lb">交易次數／勝率</div><div class="v">${S1.n}／${S1.win == null ? '—' : S1.win.toFixed(0) + '%'}</div><div class="small muted">每筆平均 ${pct(S1.avg, 2)}，持有 ${S1.hold == null ? '—' : S1.hold.toFixed(0)} 天</div></div>
        <div class="kpi"><div class="lb">夏普值／持股時間</div><div class="v">${num(S1.sharpe)}</div><div class="small muted">一直持有 ${num(S2.sharpe)}・有部位 ${exp.toFixed(0)}% 的時間</div></div>
      </div>
      <div class="legend"><span><i style="background:#1F4FD8;height:2px"></i>策略</span><span><i style="background:#8A93A3;height:2px"></i>一直持有</span><span class="muted">${esc(curve[0].date)} → ${esc(curve[curve.length - 1].date)}（${curve.length} 個交易日）</span></div>
      <svg viewBox="0 0 ${W} ${Hh}" style="width:100%;height:auto" role="img" aria-label="策略與一直持有的資產曲線"><line x1="0" x2="${W}" y1="${y(1)}" y2="${y(1)}" stroke="#E2E5EA" stroke-dasharray="4 4"/><path d="${pth(bh)}" fill="none" stroke="#8A93A3" stroke-width="1.5"/><path d="${pth(curve)}" fill="none" stroke="#1F4FD8" stroke-width="2"/></svg>
      <table class="tbl rtbl"><thead><tr><th>穩定度檢查</th><th class="num">策略</th><th class="num">一直持有</th><th class="num">差異</th></tr></thead><tbody>
        <tr><td>前半段</td><td class="num ${cls(h1)}">${pct(h1, 1)}</td><td class="num ${cls(b1)}">${pct(b1, 1)}</td><td class="num ${cls(h1 - b1)}"><b>${pct(h1 - b1, 1)}</b></td></tr>
        <tr><td>後半段</td><td class="num ${cls(h2)}">${pct(h2, 1)}</td><td class="num ${cls(b2)}">${pct(b2, 1)}</td><td class="num ${cls(h2 - b2)}"><b>${pct(h2 - b2, 1)}</b></td></tr></tbody></table>
      ${single ? `<div><b class="small">交易明細</b><div class="tbl-box"><table class="tbl rtbl"><thead><tr><th>進場</th><th>出場</th><th class="num">進場價</th><th class="num">出場價</th><th class="num">報酬</th><th class="num">天數</th><th>出場原因</th></tr></thead><tbody>
        ${trades.slice().reverse().map(t => `<tr><td class="mono">${esc(t.in)}</td><td class="mono">${esc(t.out)}</td><td class="num">${px(t.pin)}</td><td class="num">${px(t.pout)}</td><td class="num ${cls(t.r)}">${pct(t.r, 1)}</td><td class="num">${t.days}</td><td class="small">${esc(t.why)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">沒有交易</td></tr>'}</tbody></table></div>
        ${res[0].r.open ? `<p class="small" style="margin:0">目前持有中：${esc(res[0].r.open.date)} 以 ${px(res[0].r.open.px)} 進場，未實現 <b class="${cls(res[0].r.open.unreal)}">${pct(res[0].r.open.unreal, 1)}</b></p>` : ''}</div>`
        : `<div><b class="small">各檔結果（依「贏過一直持有」排序）</b><div class="tbl-box"><table class="tbl rtbl"><thead><tr><th>標的</th><th class="num">策略</th><th class="num">一直持有</th><th class="num">差異</th><th class="num">已平倉</th><th class="num">勝率</th><th class="num">最大回撤</th></tr></thead><tbody>
        ${per.map(p => `<tr><td><a href="#" data-btkey="${esc(p.key)}">${esc(p.key)}</a> <span class="small muted">${esc(p.name)}</span>${p.open ? ' <span class="tag buy">持有中</span>' : ''}</td><td class="num ${cls(p.s)}">${pct(p.s, 1)}</td><td class="num ${cls(p.b)}">${pct(p.b, 1)}</td><td class="num ${cls(p.s - p.b)}"><b>${pct(p.s - p.b, 1)}</b></td><td class="num">${p.n}</td><td class="num">${p.win == null ? '—' : p.win.toFixed(0) + '%'}</td><td class="num down">${pct(p.mdd, 1)}</td></tr>`).join('')}</tbody></table></div></div>`}
      <p class="small muted" style="margin:0">規則：收盤後計算技術分數（與系統相同公式，不含 AI 模型與 VIX 門檻調整），隔天開盤成交；停損停利在盤中觸價成交，跳空時以開盤價計。已扣交易成本，未計股利。歷史約 2 年。注意：一直調參數直到結果最好，等於「看著答案找規則」，未來不一定有效——請以前後兩半段都穩定的設定為準。</p>`;
  }
  function bindBacktest() {
    const read = () => { BT.scope = $('#bt-scope').value; BT.buy = +$('#bt-buy').value || BT_DEF.buy; BT.sell = +$('#bt-sell').value || BT_DEF.sell; BT.stopAtr = +$('#bt-stop').value || 0; BT.takePct = +$('#bt-take').value || 0; BT.maxDays = +$('#bt-days').value || 0; BT.costTW = +$('#bt-ctw').value || 0; BT.costUS = +$('#bt-cus').value || 0; BT.trend = $('#bt-trend').checked; LS.set('bt', BT); };
    $('#bt-form').onsubmit = e => { e.preventDefault(); read(); runBacktest(); };
    $('#bt-scope').onchange = () => { read(); runBacktest(); };
    $('#bt-reset').onclick = () => { Object.assign(BT, BT_DEF, { scope: BT.scope }); LS.set('bt', BT); render(); };
    $('#bt-out').addEventListener('click', e => { const a = e.target.closest('[data-btkey]'); if (!a) return; e.preventDefault(); BT.scope = a.dataset.btkey; LS.set('bt', BT); $('#bt-scope').value = BT.scope; runBacktest(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    runBacktest();
  }

  // ── 模型成績 ────────────────────────────────────────────────
  function viewScorecard() {
    const sc = S.snap.scorecard, st = S.snap.status || {};
    const STZ = { yahoo: 'Yahoo 報價', vix: 'VIX 恐慌指數', treasury: '美國公債殖利率', t86: '三大法人（TWSE）', finmind: 'FinMind 法人／營收', fundamentals: '美股基本面', breadth: '台股寬度（收盤歷史）', futures: '外資台指期', putcall: '選擇權 P/C 比', valuation: '台股估值', margin: '融資餘額', usValuation: '標普本益比', fred: 'FRED 信用／壓力', indices: '指數推論' };
    return `
<section class="card" aria-labelledby="bt0"><div class="hd"><h2 id="bt0">策略回測</h2><span class="note">過去 2 年照技術面訊號操作的結果，可自行調整門檻、停損、停利；另附 AI 模型的樣本外表現</span><a class="act btn primary sm" href="#/backtest" style="color:#fff">開始回測</a></div></section>
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
    const nav = h.startsWith('s/') ? 'home' : S.route === 'all' ? 'home' : S.route === 'backtest' ? 'scorecard' : S.route;
    document.querySelectorAll('[data-nav]').forEach(a => { a.classList.toggle('act', a.dataset.nav === nav); if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const main = $('#main');
    if (!S.snap) return;
    if (S.route.startsWith('s/')) {
      const key = S.route.slice(2).toUpperCase();
      main.innerHTML = '<p class="loading">載入走勢…</p>';
      const b = await loadBars(key);
      if (S.route !== 's/' + key) return;
      main.innerHTML = viewStock(key, b); document.title = `${key} ${nameOf(key)}・訊號終端`;
      bindStock(key); bindMine(key);
      afterStock(key);
    } else if (S.route.startsWith('q')) {
      const key = decodeURIComponent(h.split('/')[1] || '').toUpperCase();
      if (S.snap.items[key]) { location.replace('#/s/' + encodeURIComponent(key)); return; }
      main.innerHTML = '<p class="loading">載入中…</p>';
      const html = await viewQuick(key); if (!location.hash.includes('/q/')) return;
      main.innerHTML = html; document.title = `${key}・訊號終端`;
    } else if (S.route === 'portfolio') { main.innerHTML = viewPortfolio(); bindPortfolio(); (async () => { const P = holdings(); const A = await portfolioAnalytics(P); const el = $('#pa-body'); if (el && S.route === 'portfolio') el.innerHTML = viewAnalytics(A, P) || '<p class="empty">持股不在觀察清單，無法分析。</p>'; })(); document.title = '持股・訊號終端'; }
    else if (S.route === 'backtest') { const k = h.split('/')[1]; if (k) { BT.scope = decodeURIComponent(k).toUpperCase(); LS.set('bt', BT); } main.innerHTML = viewBacktest(); bindBacktest(); document.title = '策略回測・訊號終端'; }
    else if (S.route === 'journal') { main.innerHTML = viewJournal(); document.title = '我的成績單・訊號終端'; afterJournal(); }
    else if (S.route === 'scorecard') { main.innerHTML = viewScorecard(); document.title = '模型成績・訊號終端'; }
    else if (S.route === 'settings') { main.innerHTML = viewSettings(); bindSettings(); document.title = '設定・訊號終端'; }
    else if (S.route === 'all') { main.innerHTML = `<div><a href="#/" class="small">← 回總覽</a></div><section class="card" id="opps">${viewOpps(0)}</section>${footer()}`; document.title = '全部標的・訊號終端'; }
    else { main.innerHTML = viewHome(); document.title = '訊號終端'; afterHome(); }
  }

  // ── 全市場清單：搜尋任何台股、快速檢視、一鍵加入觀察清单 ─────────
  let UNI = null, UNIH = null;
  async function loadUniverse() { if (UNI) return UNI; try { UNI = await getJSON(S.base + 'universe.json'); } catch (_) { UNI = { list: [] }; } return UNI; }
  const repoInfo = () => { const owner = location.hostname.split('.')[0], repo = location.pathname.split('/').filter(Boolean)[0] || 'invest-dashboard'; return { owner, repo }; };
  function watchlistLink(key, name, remove) {
    const { owner, repo } = repoInfo();
    const t = `${remove ? '移除' : '加入'}觀察清單 ${key}`;
    const body = `${name ? `名稱：${name}\n` : ''}\n（直接按「Submit new issue」送出即可，系統會自動${remove ? '移除' : '加入'}並在約 3～5 分鐘後更新網站。只有專案擁有者送出的才會生效。）`;
    return `https://github.com/${owner}/${repo}/issues/new?title=${encodeURIComponent(t)}&body=${encodeURIComponent(body)}`;
  }
  async function viewQuick(key) {
    const U = await loadUniverse(), u = U.list.find(x => x.k === key);
    if (!u) return `<div><a href="#/" class="small">← 回總覽</a></div><section class="card"><h2 style="margin:0">找不到 ${esc(key)}</h2>
      <p class="empty">全市場清單裡沒有這個代號。${/^[A-Z.\-]+$/.test(key) ? '美股可以直接加入觀察清單，系統會先確認代號是否存在。' : '請確認代號是否正確（上市、上櫃、ETF 都可以）。'}</p>
      <div class="actions"><a class="btn primary" href="${watchlistLink(key)}" target="_blank" rel="noopener">加入觀察清單</a><a class="btn" href="#/">回總覽</a></div></section>`;
    if (!UNIH && u.x === 'TWSE') { try { UNIH = await getJSON(S.base + 'universe_hist.json'); } catch (_) { UNIH = { dates: [], c: {} }; } }
    const ser = UNIH?.c?.[key] || [];
    return `<div><a href="#/" class="small">← 回總覽</a></div>
<section class="card" aria-labelledby="qk-h">
  <div class="hd"><h1 id="qk-h" style="margin:0;font-size:22px">${esc(key)} ${esc(u.n)}</h1><span class="note">${u.x === 'TPEx' ? '上櫃' : u.x === 'TWSE' ? (/^00/.test(key) ? '上市 ETF' : '上市') : '美股'}・快速檢視（不在觀察清單）</span></div>
  <div class="quote"><div><div style="display:flex;align-items:baseline;gap:12px"><span class="px">${px(u.c)}</span><span class="ch ${cls(u.p)}">${pct(u.p)}</span></div><div class="small muted">${esc((u.x === 'TPEx' ? UNI.tpexDate : UNI.date) || '')} 收盤</div></div></div>
  ${ser.filter(isNum).length > 5 ? `<div>${spark(ser, { w: 600, h: 90 })}<div class="small muted">近 ${ser.filter(isNum).length} 個交易日收盤</div></div>` : ''}
  <dl class="facts mini">
    <div><dt>20 日線</dt><dd>${u.a20 == null ? '—' : u.a20 ? '<span class="up">站上</span>' : '<span class="down">跌破</span>'}</dd></div>
    <div><dt>60 日線</dt><dd>${u.a60 == null ? '—' : u.a60 ? '<span class="up">站上</span>' : '<span class="down">跌破</span>'}</dd></div>
    <div><dt>近 20 日報酬</dt><dd class="${cls(u.r20)}">${pct(u.r20, 1)}</dd></div>
  </dl>
  <div style="background:var(--acc-bg);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:8px">
    <b>想看完整分析？加入觀察清單</b>
    <span class="small">加入後系統會每天計算技術面、籌碼、財報、AI 模型、走勢推論與回測。按下按鈕會開啟 GitHub，直接按「Submit new issue」送出，約 3～5 分鐘後這檔就會有完整頁面（需要登入你的 GitHub 帳號）。</span>
    <div><a class="btn primary" href="${watchlistLink(key, u.n)}" target="_blank" rel="noopener">加入觀察清單</a></div>
  </div>
</section>${footer()}`;
  }

  function setupSearch() {
    const inp = $('#search-input'), box = $('#search-results'), form = $('#search');
    const all = () => { const w = Object.values(S.snap.items).map(it => ({ key: it.key, name: it.name, changePct: it.changePct, w: 1 })); const seen = new Set(w.map(x => x.key)); return [...w, ...(UNI?.list || []).filter(u => !seen.has(u.k)).map(u => ({ key: u.k, name: u.n, changePct: u.p, w: 0, x: u.x }))]; };
    const norm = v => String(v || '').trim().toUpperCase().replace(/\.TWO?$/, '');
    const find = q => {
      q = norm(q); if (!q) return [];
      const exact = all().filter(it => it.key === q);
      const starts = all().filter(it => it.key !== q && it.key.startsWith(q));
      const name = all().filter(it => !it.key.startsWith(q) && String(it.name).toUpperCase().includes(q));
      const byW = a => a.sort((x, y) => y.w - x.w);
      return [...exact, ...byW(starts), ...byW(name)].slice(0, 10);
    };
    let hits = [], cur = -1;
    const go = key => { box.hidden = true; inp.value = ''; inp.blur(); location.hash = (S.snap.items[key] ? '#/s/' : '#/q/') + encodeURIComponent(key); };
    const draw = () => {
      if (!inp.value.trim()) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = hits.length ? hits.map((it, i) => `<li role="option" data-key="${esc(it.key)}" aria-selected="${i === cur}"><b>${esc(it.key)}</b><span>${esc(it.name)}${it.w ? ' <span class="tag buy" style="font-size:10px">觀察中</span>' : ''}</span><span class="${cls(it.changePct)}">${pct(it.changePct)}</span></li>`).join('')
        : `<li class="none" data-key="${esc(norm(inp.value))}">找不到「${esc(inp.value.trim())}」。${/^[A-Za-z.\-]+$/.test(inp.value.trim()) ? '美股代號可以點這裡加入觀察清單。' : '台股請輸入上市、上櫃或 ETF 代號。'}</li>`;
    };
    inp.addEventListener('input', async () => { if (!UNI) { await loadUniverse(); } hits = find(inp.value); cur = hits.length ? 0 : -1; draw(); });
    inp.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' && hits.length) { cur = (cur + 1) % hits.length; draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp' && hits.length) { cur = (cur - 1 + hits.length) % hits.length; draw(); e.preventDefault(); }
      else if (e.key === 'Escape') box.hidden = true;
    });
    box.addEventListener('pointerdown', e => { const li = e.target.closest('[data-key]'); if (li) { e.preventDefault(); go(li.dataset.key); } });
    inp.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
    inp.addEventListener('focus', () => { loadUniverse(); if (inp.value.trim()) { hits = find(inp.value); draw(); } });
    form.onsubmit = e => {
      e.preventDefault();
      const q = norm(inp.value); if (!q) return;
      const h = find(q);
      if (h.length) go(h[cur >= 0 && h[cur] ? cur : 0].key); else go(q);
    };
  }

  async function boot() {
    applyColors();
    try { await loadSnapshot(); }
    catch (e) { $('#main').innerHTML = `<section class="card"><h2 style="margin:0">無法載入資料</h2><p>${esc(e.message)}</p><div class="actions"><button class="btn primary" onclick="location.reload()">重新整理</button><a class="btn" href="#/settings">設定</a></div></section>`; if (location.hash.startsWith('#/settings')) { $('#main').innerHTML = viewSettings(); bindSettings(); } return; }
    setupSearch();
    window.addEventListener('hashchange', render);
    document.addEventListener('click', e => {
      const f = e.target.closest('[data-of]');
      if (f) {
        const k = f.dataset.of, v = f.dataset.v;
        if (k === 'idx') { S.idx = v; LS.set('idx', v); fillIndexSection(); return; }
        if (k === 'range') { S.range = +v; LS.set('range', S.range); const b = S.bars[S.route.slice(2).toUpperCase()]; const box = $('#pxchart')?.closest('.card'); if (b && box) { const it = S.snap.items[b.key]; box.querySelector('.chart-wrap').innerHTML = lineChart(b, it); bindChart(); } return; }
        UI[k] = v; LS.set('oppF', UI);
        const box = $('#opps'); if (box) box.innerHTML = viewOpps(S.route === 'all' ? 0 : 10);
        return;
      }
      const hm = e.target.closest('[data-hm-tw],[data-hm-us]');
      if (hm) { const mk = hm.dataset.hmTw != null ? 'tw' : 'us', v = +(hm.dataset.hmTw ?? hm.dataset.hmUs), cur = moodOf(mk); saveMood(mk, cur === v ? null : v); toast(cur === v ? '已取消今天的感覺' : `已記錄：${mk === 'tw' ? '台股' : '美股'}${moodZh(v)}`); render(); return; }
      const st = e.target.closest('[data-star]');
      if (st) { const k = st.dataset.star, a = stars(), on = !a.includes(k); LS.set('stars', on ? [...a, k] : a.filter(x => x !== k)); st.setAttribute('aria-pressed', on); st.textContent = on ? '★ 已自選' : '☆ 加入自選'; toast(on ? `已把 ${k} 加入自選` : `已移除 ${k}`); return; }
      if (e.target.closest('#pill-data')) refreshNow(true);
    });
    document.addEventListener('input', e => { if (e.target.id === 'wi') { const m = +e.target.value; $('#wi-v').textContent = (m > 0 ? '+' : m < 0 ? '−' : '') + Math.abs(m) + '%'; $('#wi-out').innerHTML = whatIf(holdings(), m); } });
    // 回到這個分頁或 App 時立刻檢查新資料（手機切回來不用等）
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.snap && Date.now() - Date.parse(S.snap.generatedAt) > 10 * 60000) refreshNow(false); });
    await render();
    probeLocal().then(() => { if (localAny() && (S.route === 'home' || S.route.startsWith('s/'))) render(); });
    // 每 5 分鐘檢查一次新資料（分頁在前景時）
    setInterval(() => { if (!document.hidden) refreshNow(false); }, 3 * 60000);
  }
  boot();
})();
