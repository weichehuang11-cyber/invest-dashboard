'use strict';
/**
 * 推播通知與每週投資週報（GitHub Actions 執行）
 *
 *   node pipeline/notify.js --snap=out/data/snapshot.json --state=state          每次更新後：送出新事件
 *   node pipeline/notify.js --weekly --snap=… --bars=out/data/bars --state=…      每週一：投資週報
 *
 * 通知管道（GitHub Secrets，至少設一個）：
 *   NTFY_TOPIC（＋選用 NTFY_SERVER，預設 https://ntfy.sh）── 手機裝 ntfy App 訂閱同一個主題
 *   TELEGRAM_BOT_TOKEN ＋ TELEGRAM_CHAT_ID
 * 個人資料（選用）：BACKUP_GIST_ID ＋ BACKUP_PASSPHRASE ── 解開網站的加密備份，才能檢查你的價格提醒、論點、持股
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const pct = (v, d = 1) => (isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}%` : '—');
const px = v => (!isNum(v) ? '—' : v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(v >= 100 ? 1 : 2));
const SIG = { BUY: '買進', SELL: '賣出', HOLD: '觀望' };
const SITE = process.env.SITE_URL || '';
const tpeDay = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

// ── 解開網站的加密備份（與瀏覽器相同：PBKDF2-SHA256 → AES-256-GCM）──
function decrypt(env, pass) {
  const key = crypto.pbkdf2Sync(pass, Buffer.from(env.salt, 'base64'), env.iter, 32, 'sha256');
  const buf = Buffer.from(env.ct, 'base64'), tag = buf.subarray(buf.length - 16), ct = buf.subarray(0, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64')); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}
async function loadPersonal() {
  const id = process.env.BACKUP_GIST_ID, pass = process.env.BACKUP_PASSPHRASE;
  if (!id || !pass) return null;
  try {
    const r = await fetch(`https://api.github.com/gists/${id}`, { headers: { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
    if (!r.ok) throw new Error('gist HTTP ' + r.status);
    const g = await r.json(), f = g.files?.['signal-terminal-backup.json'];
    let content = f?.content;
    if (f?.truncated && f.raw_url) content = await (await fetch(f.raw_url)).text();
    return decrypt(JSON.parse(content), pass);
  } catch (e) { console.log('個人資料讀取失敗：', e.message); return null; }
}

// ── 送出 ──────────────────────────────────────────────────────
async function send(title, lines, { priority = 3, tags = [] } = {}) {
  const body = lines.join('\n');
  const out = [];
  if (process.env.NTFY_TOPIC) {
    const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
    const r = await fetch(server, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: process.env.NTFY_TOPIC, title, message: body.slice(0, 3900), priority, tags, ...(SITE ? { click: SITE } : {}) }) }).catch(e => ({ ok: false, statusText: e.message }));
    out.push('ntfy ' + (r.ok ? 'ok' : 'fail ' + (r.status || r.statusText)));
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const text = `${title}\n\n${body}${SITE ? `\n\n${SITE}` : ''}`.slice(0, 4000);
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }) }).catch(e => ({ ok: false, statusText: e.message }));
    out.push('telegram ' + (r.ok ? 'ok' : 'fail ' + (r.status || r.statusText)));
  }
  console.log(`送出「${title}」：${out.join('、') || '沒有設定通知管道（NTFY_TOPIC 或 TELEGRAM_*）'}`);
  return out.length > 0;
}

// ── 論點條件（與網站相同規則）────────────────────────────────
function costOf(key, P) {
  const h = (P?.holdings?.items || []).find(x => x.key === key); if (h && isNum(h.cost)) return h.cost;
  const b = (P?.journal?.decisions || []).filter(d => d.key === key && d.action === 'buy').pop(); return b ? b.price : null;
}
function condHit(c, it, P) {
  const ta = it.ta || {}, f = it.fund || {}, Q = it.fin?.quarters || [], v = c.value;
  switch (c.type) {
    case 'priceBelow': return [it.price <= v, `跌破 ${v}`];
    case 'priceAbove': return [it.price >= v, `漲到目標 ${v}`];
    case 'lossPct': { const k = costOf(it.key, P); return isNum(k) ? [(it.price / k - 1) * 100 <= -v, `從成本虧損超過 ${v}%`] : [null]; }
    case 'belowMa20': return isNum(ta.ma20) ? [it.price < ta.ma20, '跌破 20 日線'] : [null];
    case 'belowMa60': return isNum(ta.ma60) ? [it.price < ta.ma60, '跌破 60 日線'] : [null];
    case 'foreignSell': return isNum(it.chip?.foreignStreak) ? [it.chip.foreignStreak <= -v, `外資連賣 ${v} 天`] : [null];
    case 'revenueNeg': return isNum(f.revenueYoY) ? [f.revenueYoY < 0, '月營收轉年減'] : [null];
    case 'rsiAbove': return isNum(ta.rsi) ? [ta.rsi >= v, `RSI 高於 ${v}`] : [null];
    case 'scoreBelow': return [it.signal.score < v, `分數低於 ${v}`];
    case 'sellSignal': return [it.signal.sig === 'SELL', '出現賣出訊號'];
    case 'earnings': { const e = f.earningsDate; if (!e) return [null]; const d = Math.round((Date.parse(e) - Date.now()) / 86400000); return [d >= 0 && d <= v, `財報前 ${v} 天內`]; }
    case 'revQNeg': { const q = Q[Q.length - 1]; return isNum(q?.revYoY) ? [q.revYoY < 0, '季營收轉年減'] : [null]; }
    case 'gmDown': { const a = Q[Q.length - 1], b = Q[Q.length - 5]; return isNum(a?.gm) && isNum(b?.gm) ? [b.gm - a.gm >= v, `毛利率年減超過 ${v} 個百分點`] : [null]; }
    case 'finWeak': return it.fin ? [it.fin.score <= -2, '財報體質轉弱'] : [null];
    default: return [null];
  }
}

// ── 每次更新後：找出新事件 ────────────────────────────────────
async function events(snap, P, notified) {
  const day = tpeDay(), ev = [];
  const add = (id, prio, text) => { if (notified[id]) return; ev.push({ id, prio, text }); };
  const items = snap.items || {}, held = new Set((P?.holdings?.items || []).map(x => x.key));
  // 你的價格提醒
  for (const [k, a] of Object.entries(P?.alerts || {})) {
    const it = items[k]; if (!it) continue;
    if (isNum(a.above) && it.price >= a.above) add(`alert:${k}:above:${a.above}:${day}`, 4, `🔔 ${k} ${it.name} 漲到 ${px(it.price)}（提醒價 ${a.above}）`);
    if (isNum(a.below) && it.price <= a.below) add(`alert:${k}:below:${a.below}:${day}`, 4, `🔔 ${k} ${it.name} 跌到 ${px(it.price)}（提醒價 ${a.below}）`);
  }
  // 你的論點條件
  for (const [k, t] of Object.entries(P?.journal?.theses || {})) {
    const it = items[k]; if (!it) continue;
    const hits = (t.conds || []).map(c => condHit(c, it, P)).filter(h => h[0]).map(h => h[1]);
    if (hits.length) add(`thesis:${k}:${hits.join('|')}:${day}`, 4, `📌 ${k} ${it.name} 論點條件觸發：${hits.join('、')}（現價 ${px(it.price)}）`);
  }
  // 持股
  for (const k of held) {
    const it = items[k]; if (!it) continue;
    if (Math.abs(it.changePct || 0) >= 4) add(`move:${k}:${day}`, 3, `${it.changePct > 0 ? '📈' : '📉'} 持股 ${k} ${it.name} ${pct(it.changePct)}（${px(it.price)}）`);
    const e = it.fund?.earningsDate; if (e) { const d = Math.round((Date.parse(e) - Date.parse(day)) / 86400000); if (d === 1 || d === 0) add(`earn:${k}:${e}`, 3, `🗓 持股 ${k} ${it.name} 財報${d === 0 ? '今天' : '明天'}（${e}）`); }
    const x = it.fund?.exDividendDate; if (x) { const d = Math.round((Date.parse(x) - Date.parse(day)) / 86400000); if (d === 1) add(`exdiv:${k}:${x}`, 2, `💰 持股 ${k} ${it.name} 明天除權息${it.fund.exDividendCash ? `（現金 ${it.fund.exDividendCash} 元）` : ''}`); }
  }
  // 高信心訊號（同一檔同一分組只通知一次，分組改變才再通知）
  const CT = { ex20: '20 日贏大盤', ex5: '5 日贏大盤', up20: '20 日上漲' };
  for (const it of Object.values(items)) {
    const c = it.conv; if (!c?.high?.length) continue;
    const h = c.high[0];
    add(`conv:${it.key}:${c.bucket}`, held.has(it.key) ? 4 : 3, `🎯 ${held.has(it.key) ? '持股 ' : ''}${it.key} ${it.name} 高信心${c.dir < 0 ? '偏空' : '偏多'}（信心 ${c.score > 0 ? '+' : ''}${c.score}）：過去 5 年同樣情況 ${CT[h.target]}${c.dir < 0 ? '（反向）' : ''}命中 ${h.hit}%`);
  }
  // 持股技術面全面轉弱（減碼提醒，每檔每週最多一次）
  const wk = (() => { const d = new Date(Date.now() + 8 * 3600000); const j = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return d.getUTCFullYear() + '-W' + Math.ceil(((d - j) / 86400000 + j.getUTCDay() + 1) / 7); })();
  for (const k of held) { const it = items[k]; if (it?.conv?.bucket === '強烈偏空') add(`weak:${k}:${wk}`, 3, `⚠️ 持股 ${k} ${it.name} 技術面全面轉弱（信心 ${it.conv.score}），可考慮減碼或收緊停損`); }
  // 觀察清單訊號轉變（持股優先標示）
  for (const c of snap.changes || []) if (c.tag === '訊號') add(`sig:${c.key}:${c.title}:${day}`, held.has(c.key) ? 4 : 3, `${held.has(c.key) ? '⚠️ 持股 ' : '🔄 '}${c.title}（${c.detail}）`);
  // 市場
  for (const sgl of snap.health?.signals || []) if (sgl.sev >= 3) add(`mkt:${sgl.text}:${day}`, 4, `🚨 ${sgl.text}`);
  if (snap.verdict?.trend && snap.verdict.trend !== '與前次相同') add(`verdict:${snap.verdict.headline}:${day}`, 3, `🧭 今日判斷${snap.verdict.trend}：${snap.verdict.headline}`);
  for (const e of snap.calendar || []) { const d = Math.round((Date.parse(e.date) - Date.parse(day)) / 86400000); if (e.kind === 'macro' && e.importance >= 3 && d === 1) add(`cal:${e.date}:${e.title}`, 2, `🗓 明天：${e.title}`); }
  return ev;
}

// ── 每週投資週報 ──────────────────────────────────────────────
function barsRet(dir, key, n) {
  const b = readJSON(path.join(dir, `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`), null); if (!b?.close?.length) return null;
  const c = b.close, k = c.length; return k > n ? (c[k - 1] / c[k - 1 - n] - 1) * 100 : null;
}
function weekly(snap, P, barsDir) {
  const L = [], items = Object.values(snap.items || {});
  const tw = barsRet(barsDir, '^TWII', 5), sp = barsRet(barsDir, '^GSPC', 5), sox = barsRet(barsDir, '^SOX', 5);
  L.push(`【市場】加權 ${pct(tw)}、標普 500 ${pct(sp)}、費半 ${pct(sox)}（近 5 個交易日）`);
  L.push(`今日判斷：${snap.verdict?.headline || '—'}`);
  if (snap.ai?.verdict) L.push(`AI 解讀：${snap.ai.verdict}`);
  const sg = (snap.health?.signals || []).slice(0, 3).map(x => '・' + x.text); if (sg.length) L.push(...sg);
  const r5 = items.filter(i => isNum(i.ta?.ret5)).sort((a, b) => b.ta.ret5 - a.ta.ret5);
  if (r5.length) { L.push('', '【觀察清單本週】'); L.push('漲最多：' + r5.slice(0, 3).map(i => `${i.key} ${pct(i.ta.ret5)}`).join('、')); L.push('跌最多：' + r5.slice(-3).reverse().map(i => `${i.key} ${pct(i.ta.ret5)}`).join('、')); }
  const buys = items.filter(i => i.signal.sig === 'BUY').map(i => i.key), sells = items.filter(i => i.signal.sig === 'SELL').map(i => i.key);
  L.push(`目前買進訊號：${buys.join('、') || '無'}；賣出訊號：${sells.join('、') || '無'}`);
  const hcs = items.filter(i => i.conv?.high?.length).map(i => `${i.key}（${i.conv.dir < 0 ? '偏空' : '偏多'} ${i.conv.high[0].hit}%）`);
  L.push(`高信心訊號：${hcs.join('、') || '無（本來就少見，正常）'}`);
  if (P) {
    const H = P.holdings?.items || [], fx = snap.env?.find(e => e.key === 'twd')?.value || 32;
    if (H.length) {
      let mv = 0, wk = 0;
      for (const h of H) { const it = snap.items[h.key]; if (!it) continue; const v = it.price * h.shares * (it.market === 'us' ? fx : 1); mv += v; if (isNum(it.ta?.ret5)) wk += v - v / (1 + it.ta.ret5 / 100); }
      L.push('', '【我的部位】', `持股市值約 ${Math.round(mv).toLocaleString()} 元，本週約 ${wk >= 0 ? '+' : ''}${Math.round(wk).toLocaleString()} 元（${pct(mv ? wk / (mv - wk) * 100 : null)}）`);
    }
    const J = P.journal || {}, since = new Date(Date.now() - 7 * 86400000).toISOString();
    const dec = (J.decisions || []).filter(d => d.at >= since.slice(0, 10));
    const moods = (J.moods || []).filter(m => m.at >= since.slice(0, 10));
    L.push(`本週記錄：決定 ${dec.length} 筆、市場感覺 ${moods.length} 天`);
    const th = Object.entries(J.theses || {});
    const trig = th.map(([k, t]) => { const it = snap.items[k]; if (!it) return null; const h = (t.conds || []).map(c => condHit(c, it, P)).filter(x => x[0]).map(x => x[1]); return h.length ? `${k}（${h.join('、')}）` : null; }).filter(Boolean);
    L.push(`進行中的論點 ${th.length} 個${trig.length ? `，條件觸發：${trig.join('；')}` : '，沒有觸發'}`);
    // 已滿 5 個交易日的決定（以 bars 結算）
    const old = (J.decisions || []).filter(d => d.action !== 'hold');
    const res = old.map(d => { const b = readJSON(path.join(barsDir, `${d.key.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`), null); if (!b) return null; const i = b.dates.findIndex(x => x >= d.at.slice(0, 10)); if (i < 0 || i + 5 >= b.close.length) return null; const r = (b.close[i + 5] / d.price - 1) * 100 * (d.action === 'sell' ? -1 : 1); return r; }).filter(isNum);
    if (res.length) L.push(`累計已結算 ${res.length} 筆，5 日勝率 ${(res.filter(r => r > 0.5).length / res.length * 100).toFixed(0)}%、平均 ${pct(res.reduce((s, r) => s + r, 0) / res.length, 2)}`);
  }
  const day = tpeDay(), wk = (snap.calendar || []).filter(e => (Date.parse(e.date) - Date.parse(day)) / 86400000 <= 7 && e.importance >= 2);
  if (wk.length) { L.push('', '【本週行事曆】'); L.push(...wk.slice(0, 8).map(e => `${e.date.slice(5).replace('-', '/')} ${e.title}`)); }
  return L;
}


// ── 每月成績報告（每月 1 日早上）────────────────────────────────
async function loadLocal() {
  const id = process.env.LOCAL_GIST_ID; if (!id) return null;
  try {
    const g = await (await fetch(`https://api.github.com/gists/${id}`, { headers: { Accept: 'application/vnd.github+json' } })).json();
    const f = g.files?.['signal-local.json']; let c = f?.content; if (f?.truncated && f.raw_url) c = await (await fetch(f.raw_url)).text();
    return JSON.parse(c);
  } catch (e) { console.log('電腦運算結果讀取失敗：', e.message); return null; }
}
function monthly(snap, P, barsDir, PC) {
  const L = [], N = 21;
  const tw = barsRet(barsDir, '^TWII', N), sp = barsRet(barsDir, '^GSPC', N), b50 = barsRet(barsDir, '0050', N);
  L.push(`【市場】近一個月：加權 ${pct(tw)}、標普 500 ${pct(sp)}、0050 ${pct(b50)}`);
  if (P) {
    const H = P.holdings?.items || [], fx = snap.env?.find(e => e.key === 'twd')?.value || 32;
    let mv = 0, gain = 0, cover = 0;
    for (const h of H) { const it = snap.items[h.key]; if (!it) continue; const v = it.price * h.shares * (it.market === 'us' ? fx : 1); mv += v; const r = barsRet(barsDir, h.key, N); if (isNum(r)) { gain += v - v / (1 + r / 100); cover += v; } }
    if (cover) { const r = gain / (cover - gain) * 100; L.push('', '【我的部位】', `持股近一個月 ${pct(r)}（約 ${gain >= 0 ? '+' : ''}${Math.round(gain).toLocaleString()} 元），${isNum(b50) ? `${r >= b50 ? '贏' : '輸'} 0050 ${Math.abs(r - b50).toFixed(1)} 個百分點` : ''}`); }
    const J = P.journal || {}, m0 = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    const rz = (J.realized || []).filter(x => x.date >= m0), rzSum = rz.reduce((a, x) => a + (x.pnl || 0) * (x.cur === 'USD' ? fx : 1), 0);
    if (rz.length) L.push(`本月已實現損益 ${rzSum >= 0 ? '+' : ''}${Math.round(rzSum).toLocaleString()} 元（${rz.length} 筆賣出）`);
    const dec = (J.decisions || []).filter(d => d.action !== 'hold');
    const res = dec.map(d => { const b = readJSON(path.join(barsDir, `${d.key.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`), null); if (!b) return null; const i = b.dates.findIndex(x => x >= d.at.slice(0, 10)); if (i < 0 || i + 5 >= b.close.length) return null; return { at: d.at, r: (b.close[i + 5] / d.price - 1) * 100 * (d.action === 'sell' ? -1 : 1) }; }).filter(Boolean);
    const recent = res.filter(x => x.at.slice(0, 10) >= new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10));
    const wr = a => (a.length ? `${(a.filter(x => x.r > 0.5).length / a.length * 100).toFixed(0)}%（${a.length} 筆，平均 ${pct(a.reduce((s, x) => s + x.r, 0) / a.length, 2)}）` : '尚無已結算');
    L.push('', '【我的決策】', `近一個月 5 日勝率：${wr(recent)}`, `累計 5 日勝率：${wr(res)}`);
    const moods = (J.moods || []).filter(m => m.at >= m0); if (moods.length) L.push(`本月記錄市場感覺 ${moods.length} 天`);
  }
  const sc = snap.scorecard;
  if (sc) L.push('', '【系統訊號】', `近 30 天：隔日命中 ${sc.d30?.h1?.rate ?? '—'}%（${sc.d30?.h1?.n || 0}）、5 日 ${sc.d30?.h5?.rate ?? '—'}%（${sc.d30?.h5?.n || 0}）、20 日 ${sc.d30?.h20?.rate ?? '—'}%（${sc.d30?.h20?.n || 0}）`);
  if (PC) {
    const st = PC.score?.stats || {}, f = (e, h) => (st[e]?.[h]?.n ? `${st[e][h].rate}%` : '—');
    L.push('', '【電腦模型】', `5 日方向命中：NPU ${f('npu', 'd5')}、CPU ${f('cpu', 'd5')}、一直猜漲 ${f('base', 'd5')}（累積 ${PC.score?.days || 0} 個交易日）`);
    if (PC.train?.new) L.push(`最近一次重訓：新模型 ${PC.train.new.hit5}%、舊模型 ${PC.train.old?.hit5 ?? '—'}%，${PC.train.replaced ? '已換新' : '保留舊模型'}`);
    const c = PC.scan?.common?.[0]; if (c) L.push(`參數掃描最穩設定：${c.ma} 日線${c.rsi ? `＋RSI≤${c.rsi}` : ''}${c.stop ? `＋${c.stop}×ATR 停損` : ''}（驗證期 ${c.beatShare}% 股票贏過一直持有）`);
  }
  const day = tpeDay(), next = (snap.calendar || []).filter(e => (Date.parse(e.date) - Date.parse(day)) / 86400000 <= 31 && e.importance >= 2);
  if (next.length) { L.push('', '【本月重要事件】'); L.push(...next.slice(0, 8).map(e => `${e.date.slice(5).replace('-', '/')} ${e.title}`)); }
  return L;
}

// ── 勿擾時段 ──────────────────────────────────────────────────
function inQuiet(start, end) {
  const h = new Date(Date.now() + 8 * 3600000).getUTCHours();
  return start === end ? false : start < end ? h >= start && h < end : h >= start || h < end;
}

// ── 系統健康：同一個問題連續 3 次更新都發生才通知，恢復時也通知 ──
const HEALTH = {
  yahoo: ['報價（Yahoo）', v => { const m = String(v).match(/^(\d+)\/(\d+)/); return m ? +m[1] / +m[2] >= 0.8 : !/fail/.test(v); }],
  finmind: ['台股籌碼（FinMind）', v => !/fail|0\//.test(String(v))],
  news: ['新聞', v => !/fail/.test(String(v))],
  digest: ['全球快報', v => !/fail/.test(String(v))],
  ai: ['雲端 AI 解讀', v => !/fail/.test(String(v))],
  digestAI: ['全球快報 AI 摘要', v => !/fail/.test(String(v))],
  newsAI: ['新聞 AI 摘要', v => !/錯誤|fail/.test(String(v))],
  universe: ['全市場清單', v => !/fail/.test(String(v))],
};
function healthEvents(st, snap, notified) {
  const out = [], H = notified._health || {};
  if (!st?.status) return out;
  for (const [k, [label, ok]] of Object.entries(HEALTH)) {
    if (!(k in st.status)) continue;
    const v = String(st.status[k]), good = ok(v), h = H[k] || { n: 0, alerted: false };
    if (!good) {
      h.n++;
      if (h.n >= (/AI$|^ai$/.test(k) ? 4 : 3) && !h.alerted) { out.push({ id: `health:${k}:${tpeDay()}`, prio: 3, text: `⚙️ 系統：${label}連續 ${h.n} 次更新失敗（${v.slice(0, 80)}）` }); h.alerted = true; }
    } else {
      if (h.alerted) out.push({ id: `healthok:${k}:${Date.now()}`, prio: 2, text: `✅ 系統：${label}已恢復正常` });
      h.n = 0; h.alerted = false;
    }
    if (JSON.stringify(H[k]) !== JSON.stringify(h)) notified._healthChanged = true;
    H[k] = h;
  }
  notified._health = H; notified._healthChanged = notified._healthChanged || out.length > 0;
  return out;
}

// ── 持股／觀察清單的新聞：持股出現利空或多家媒體報導的重大新聞、觀察清單利空且當天大跌 ──
function newsEvents(N, snap, P, notified) {
  const out = []; if (!N) return out;
  const held = new Set((P?.holdings?.items || []).map(x => x.key));
  const idOf = t => { let h = 5381; const s = String(t).replace(/\s+/g, '').toLowerCase(); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
  const nameOf = k => snap.items[k]?.name || k;
  for (const [k, list] of Object.entries(N.per || {})) {
    const it = snap.items[k]; if (!it) continue;
    for (const n of (list || []).slice(0, 6)) {
      if (!n.at || Date.now() - Date.parse(n.at) > 24 * 3600000) continue;
      const id = 'news:' + idOf(n.title); if (notified[id]) continue;
      const t = n.zh || n.title, neg = n.imp === -1 || n.tone === -1;
      if (held.has(k) && neg) out.push({ id, prio: 3, text: `📰 持股利空 ${k} ${nameOf(k)}：${t}${n.sum ? `｜${n.sum.slice(0, 60)}` : ''}` });
      else if (!held.has(k) && neg && (it.changePct ?? 0) <= -3) out.push({ id, prio: 2, text: `📰 觀察清單 ${k} ${nameOf(k)}（${pct(it.changePct)}）：${t}` });
    }
  }
  // 全球重點新聞點名到持股，且有 3 家以上媒體報導
  for (const n of N.digest?.stories || []) {
    if ((n.n || 0) < 3) continue;
    const hit = (n.mk || []).map(m => [...held].find(k => m.includes(k) || m.includes(nameOf(k)))).find(Boolean);
    if (!hit) continue;
    const id = 'news:' + idOf(n.title); if (notified[id]) continue;
    out.push({ id, prio: 3, text: `📰 重大新聞（${n.n} 家報導）涉及持股 ${hit}：${n.zh || n.title}` });
  }
  return out.slice(0, 6);
}

module.exports = { send, decrypt, inQuiet, healthEvents, newsEvents, monthly };
if (require.main === module) (async () => {
  const snap = readJSON(String(args.snap || 'out/data/snapshot.json'), null);
  if (!snap) { console.log('沒有快照，略過通知'); return; }
  const P = await loadPersonal();
  if (args.weekly) { await send(`訊號終端週報 ${tpeDay()}`, weekly(snap, P, String(args.bars || 'out/data/bars'))); return; }
  if (args.monthly) { await send(`訊號終端月報 ${tpeDay().slice(0, 7)}`, monthly(snap, P, String(args.bars || 'out/data/bars'), await loadLocal())); return; }
  const stFile = path.join(String(args.state || 'state'), 'notified.json');
  const notified = readJSON(stFile, {});
  // 全球市場快報：早上（美股收盤後 05–10 點，低優先、不響鈴）與傍晚（台股收盤後 16–21 點）各推一次
  {
    const D = readJSON(path.join(path.dirname(String(args.snap || 'out/data/snapshot.json')), 'news.json'), null)?.digest;
    const h = new Date(Date.now() + 8 * 3600000).getUTCHours(), slot = h >= 5 && h < 10 ? 'am' : h >= 16 && h < 21 ? 'pm' : null;
    const id = `digest:${tpeDay()}:${slot}`;
    if (D && slot && !notified[id] && (D.stories || []).length >= 5) {
      const U = D.ai || D.rule || {};
      const lines = [U.headline, ...(U.bullets || []).slice(0, 6).map(b => '• ' + b), U.conclusion ? '結論：' + U.conclusion : null, (D.ai?.watch || []).length ? '接下來盯：' + D.ai.watch.join('｜') : null].filter(Boolean);
      if (await send(`${slot === 'am' ? '早安' : '收盤'}全球市場快報`, lines, { priority: slot === 'am' ? 2 : 3, tags: ['newspaper'] })) {
        notified[id] = tpeDay(); fs.mkdirSync(path.dirname(stFile), { recursive: true }); fs.writeFileSync(stFile, JSON.stringify(notified)); console.log('NOTIFIED_CHANGED');
      }
    }
  }
  const dataDir = path.dirname(String(args.snap || 'out/data/snapshot.json'));
  const ev = [...await events(snap, P, notified), ...healthEvents(readJSON(path.join(dataDir, 'status.json'), null), snap, notified), ...newsEvents(readJSON(path.join(dataDir, 'news.json'), null), snap, P, notified)].sort((a, b) => b.prio - a.prio);
  const save = () => { const cut = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10); for (const [k, v] of Object.entries(notified)) if (!k.startsWith('_') && v < cut) delete notified[k]; fs.mkdirSync(path.dirname(stFile), { recursive: true }); fs.writeFileSync(stFile, JSON.stringify(notified)); console.log('NOTIFIED_CHANGED'); };
  // 勿擾時段：只送重大（優先 4 以上），其他先存起來，時段結束後一次送出
  const L = P?.limits || {}, quiet = L.quietOn !== false && inQuiet(L.quietStart ?? 23, L.quietEnd ?? 7);
  let changed = notified._healthChanged; delete notified._healthChanged;
  const queue = notified._queue || [];
  const now = quiet ? ev.filter(e => e.prio >= 4) : ev, later = quiet ? ev.filter(e => e.prio < 4) : [];
  if (later.length) { for (const e of later) { queue.push(e.text); notified[e.id] = tpeDay(); } notified._queue = queue.slice(-40); changed = true; console.log(`勿擾時段：先存 ${later.length} 則`); }
  const flush = !quiet && queue.length ? queue : [];
  if (now.length || flush.length) {
    const top = now.some(e => e.prio >= 4) ? 4 : 3;
    const lines = [...now.map(e => e.text), ...(flush.length ? [`── 勿擾時段累積 ${flush.length} 則 ──`, ...flush] : [])];
    const sent = await send(lines.length === 1 ? '訊號終端' : `訊號終端：${now.length + flush.length} 則新消息`, lines, { priority: top, tags: top >= 4 ? ['warning'] : [] });
    if (sent) { for (const e of now) notified[e.id] = tpeDay(); if (flush.length) delete notified._queue; changed = true; }
  } else console.log('沒有新事件');
  if (changed) save();
})();
