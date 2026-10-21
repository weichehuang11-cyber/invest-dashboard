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

module.exports = { send, decrypt };
if (require.main === module) (async () => {
  const snap = readJSON(String(args.snap || 'out/data/snapshot.json'), null);
  if (!snap) { console.log('沒有快照，略過通知'); return; }
  const P = await loadPersonal();
  if (args.weekly) { await send(`訊號終端週報 ${tpeDay()}`, weekly(snap, P, String(args.bars || 'out/data/bars'))); return; }
  const stFile = path.join(String(args.state || 'state'), 'notified.json');
  const notified = readJSON(stFile, {});
  const ev = (await events(snap, P, notified)).sort((a, b) => b.prio - a.prio);
  if (!ev.length) { console.log('沒有新事件'); return; }
  const top = ev[0].prio >= 4 ? 4 : 3;
  const sent = await send(ev.length === 1 ? '訊號終端' : `訊號終端：${ev.length} 則新消息`, ev.map(e => e.text), { priority: top, tags: top >= 4 ? ['warning'] : [] });
  if (sent) {
    const day = tpeDay(), cut = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    for (const e of ev) notified[e.id] = day;
    for (const [k, v] of Object.entries(notified)) if (v < cut) delete notified[k];
    fs.mkdirSync(path.dirname(stFile), { recursive: true });
    fs.writeFileSync(stFile, JSON.stringify(notified));
    console.log('NOTIFIED_CHANGED');
  }
})();
