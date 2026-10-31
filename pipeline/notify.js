'use strict';
/**
 * 推播通知與每週投資週報（GitHub Actions 執行）
 *
 *   node pipeline/notify.js --snap=out/data/snapshot.json --state=state          每次更新後：送出新事件
 *   node pipeline/notify.js --weekly --snap=… --bars=out/data/bars --state=…      每週一：投資週報
 *   node pipeline/notify.js --premarket=tw|us --snap=…                           盤前資訊（推播＋選用電子郵件：MAIL_TO，或 SMTP_USER＋SMTP_PASS）
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
// ── 週日週報：本週回顧＋下週方向 ─────────────────────────────
function weeklyFacts(snap, barsDir) {   // 不含個人資料，給 AI 寫「下週方向」用
  const ix = k => snap.indices?.[k], o = k => ix(k)?.outlook;
  const idx = [['^TWII', '加權'], ['^GSPC', '標普 500'], ['^IXIC', '那斯達克'], ['^SOX', '費半']].map(([k, n]) => {
    const f = o(k)?.forecast?.h5, sr = o(k)?.sr;
    return `${n}：本週 ${pct(barsRet(barsDir, k, 5))}，${o(k)?.stateZh || ''}，下週上漲機率 ${f?.upProb ?? '—'}%，80% 區間 ${f ? `${pct(f.qPct[0])}～${pct(f.qPct[4])}` : '—'}，支撐 ${sr?.support?.[0] ? px(sr.support[0].p) : '—'}、壓力 ${sr?.resistance?.[0] ? px(sr.resistance[0].p) : '—'}`;
  });
  const env = (snap.env || []).map(e => `${e.label} ${e.value}${e.unit || ''}（${e.meaning}）`).join('；');
  return { idx, env };
}
function weekly(snap, N, P, barsDir, aiDir) {
  const S = [], items = Object.values(snap.items || {}), day = tpeDay();
  const title = `訊號終端週報 ${day.slice(5).replace('-', '/')}：本週回顧與下週方向`;
  // 本週市場
  const r = k => pct(barsRet(barsDir, k, 5));
  const env = Object.fromEntries((snap.env || []).map(e => [e.key, e]));
  S.push({ h: '本週市場', lines: [`加權 ${r('^TWII')}、標普 500 ${r('^GSPC')}、那斯達克 ${r('^IXIC')}、費半 ${r('^SOX')}（近 5 個交易日）`,
    [env.vix && `VIX ${env.vix.value}（${env.vix.meaning}）`, env.twd && `台幣 ${env.twd.value}`, env.foreign && `外資 ${env.foreign.meaning}`].filter(Boolean).join('、'),
    `目前判斷：${snap.verdict?.headline || '—'}`, ...(snap.health?.signals || []).slice(0, 3).map(x => '・' + x.text)].filter(Boolean) });
  // 觀察清單
  const r5 = items.filter(i => isNum(i.ta?.ret5)).sort((a, b) => b.ta.ret5 - a.ta.ret5), L = [];
  if (r5.length) { L.push('漲最多：' + r5.slice(0, 3).map(i => `${i.key} ${i.name} ${pct(i.ta.ret5)}`).join('、')); L.push('跌最多：' + r5.slice(-3).reverse().map(i => `${i.key} ${i.name} ${pct(i.ta.ret5)}`).join('、')); }
  const buys = items.filter(i => i.signal.sig === 'BUY').map(i => i.key), sells = items.filter(i => i.signal.sig === 'SELL').map(i => i.key);
  L.push(`買進訊號：${buys.join('、') || '無'}；賣出訊號：${sells.join('、') || '無'}`);
  const hcs = items.filter(i => i.conv?.high?.length).map(i => `${i.key}（${i.conv.dir < 0 ? '偏空' : '偏多'} ${i.conv.high[0].hit}%）`);
  L.push(`高信心訊號：${hcs.join('、') || '無（本來就少見，正常）'}`);
  S.push({ h: '觀察清單本週', lines: L });
  // 本週新聞主軸
  const D = N?.digest, U = D?.ai || D?.rule, th = (N?.themes || []).slice(0, 4);
  if (U || th.length) S.push({ h: '本週新聞主軸', lines: [U?.headline, ...(U?.bullets || []).slice(0, 4).map(b => '• ' + b), th.length ? '熱門題材：' + th.map(t => `${t.name}${t.avgChg != null ? `（${pct(t.avgChg)}）` : ''}`).join('、') : null].filter(Boolean) });
  // 我的部位（個人）
  if (P) {
    const PL = [], H = P.holdings?.items || [], fx = env.twd?.value || 32;
    if (H.length) {
      let mv = 0, wk = 0; const rows = [];
      for (const h of H) { const it = snap.items[h.key]; if (!it) continue; const v = it.price * h.shares * (it.market === 'us' ? fx : 1); mv += v; if (isNum(it.ta?.ret5)) { wk += v - v / (1 + it.ta.ret5 / 100); rows.push(`${it.key} ${pct(it.ta.ret5)}`); } }
      PL.push(`持股市值約 ${Math.round(mv).toLocaleString()} 元，本週約 ${wk >= 0 ? '+' : ''}${Math.round(wk).toLocaleString()} 元（${pct(mv ? wk / (mv - wk) * 100 : null)}）`);
      if (rows.length) PL.push('各檔本週：' + rows.join('、'));
    }
    const J = P.journal || {}, since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    PL.push(`本週記錄：決定 ${(J.decisions || []).filter(d => d.at >= since).length} 筆、市場感覺 ${(J.moods || []).filter(m => m.at >= since).length} 天`);
    const thz = Object.entries(J.theses || {});
    const trig = thz.map(([k, t]) => { const it = snap.items[k]; if (!it) return null; const h = (t.conds || []).map(c => condHit(c, it, P)).filter(x => x[0]).map(x => x[1]); return h.length ? `${k}（${h.join('、')}）` : null; }).filter(Boolean);
    PL.push(`進行中的論點 ${thz.length} 個${trig.length ? `，條件觸發：${trig.join('；')}` : '，沒有觸發'}`);
    const res = (J.decisions || []).filter(d => d.action !== 'hold').map(d => { const b = readJSON(path.join(barsDir, `${d.key.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`), null); if (!b) return null; const i = b.dates.findIndex(x => x >= d.at.slice(0, 10)); if (i < 0 || i + 5 >= b.close.length) return null; return (b.close[i + 5] / d.price - 1) * 100 * (d.action === 'sell' ? -1 : 1); }).filter(isNum);
    if (res.length) PL.push(`累計已結算 ${res.length} 筆，5 日勝率 ${(res.filter(x => x > 0.5).length / res.length * 100).toFixed(0)}%、平均 ${pct(res.reduce((a, x) => a + x, 0) / res.length, 2)}`);
    S.push({ h: '我的部位', lines: PL, priv: true });
    // 持股下週關鍵價位
    const lv = H.map(h => snap.items[h.key]).filter(Boolean).map(it => { const o = it.outlook, sp = o?.sr?.support?.[0], rs = o?.sr?.resistance?.[0], f = o?.forecast?.h5; return `${it.key} ${it.name} ${px(it.price)}｜撐 ${sp ? px(sp.p) : '—'}・壓 ${rs ? px(rs.p) : '—'}${f ? `｜下週上漲機率 ${f.upProb}%、80% 區間 ${px(f.q[0])}～${px(f.q[4])}` : ''}${it.signal?.stop ? `｜停損參考 ${px(it.signal.stop)}` : ''}`; });
    if (lv.length) S.push({ h: '持股下週關鍵價位', lines: lv, priv: true });
  }
  // 下週方向
  const F = weeklyFacts(snap, barsDir);
  S.push({ h: '下週方向', lines: [...(aiDir ? [aiDir, ''] : []), ...F.idx] });
  // 下週行事曆
  const wk = (snap.calendar || []).filter(e => e.date > day && (Date.parse(e.date) - Date.parse(day)) / 86400000 <= 7 && e.importance >= 2);
  S.push({ h: '下週行事曆', lines: wk.length ? wk.slice(0, 10).map(e => `${e.date.slice(5).replace('-', '/')} ${e.title}`) : ['沒有重要排定事件'] });
  return { title, sections: S };
}
async function weeklyAI(snap, N, barsDir) {
  if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const AI = require('./lib/ai'), F = weeklyFacts(snap, barsDir), D = N?.digest, U = D?.ai || D?.rule || {};
    const user = `以下是本週收盤後的數據（指數的上漲機率與區間是經回測校正的統計推論）：
${F.idx.join('\n')}
市場環境：${F.env}
規則判斷：${snap.verdict?.headline || ''}（${snap.verdict?.detail || ''}）
健康度警訊：${(snap.health?.signals || []).map(x => x.text).join('；') || '無'}
本週新聞：${U.headline || ''}；${(U.bullets || []).slice(0, 6).join('；')}
接下來要盯：${(D?.ai?.watch || []).join('；') || '—'}
下週行事曆：${(snap.calendar || []).filter(e => e.importance >= 2).slice(0, 8).map(e => `${e.date} ${e.title}`).join('；') || '—'}

請用繁體中文寫「下週方向」，4～5 句、200 字以內：①本週市場的主線一句話；②下週台股與美股的基本情境（偏多／偏空／盤整，引用上面的機率與區間）；③會讓情境改變的關鍵事件或價位；④下週操作上最該注意的一件事。只根據上面的數據，不要編造，不要加免責聲明。直接輸出文字。`;
    const t = await AI.chat([{ role: 'system', content: '你是專業的台股與美股分析師，寫給個人投資人，口語但精準。' }, { role: 'user', content: user }], { timeout: 90000 });
    return String(t || '').trim().replace(/^["「]|["」]$/g, '') || null;
  } catch (e) { console.log('AI 下週方向失敗：', e.message); return null; }
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

// ── 盤前資訊（台股 08:15、美股開盤前）──────────────────────────
// 回傳 { title, sections: [{ h, lines, priv }] }；priv＝含個人資料，只進推播／信件，不印到公開的執行紀錄
function premarket(snap, N, P, market, live = {}) {
  const S = [], items = snap.items || {}, env = Object.fromEntries((snap.env || []).map(e => [e.key, e]));
  const ix = k => snap.indices?.[k];
  const day = tpeDay(), wd = '日一二三四五六'[new Date(Date.now() + 8 * 3600000).getUTCDay()];
  const tw = market === 'tw';
  const title = `${tw ? '台股' : '美股'}盤前 ${day.slice(5).replace('-', '/')}（${wd}）`;
  // 1. 前一個市場的收盤
  if (tw) {
    const L = [['^GSPC', '標普 500'], ['^IXIC', '那斯達克'], ['^SOX', '費城半導體']].map(([k, n]) => ix(k) && `${n} ${px(ix(k).price)}（${pct(ix(k).changePct, 2)}）`).filter(Boolean);
    const tsm = items.TSM; if (tsm) L.push(`台積電 ADR ${px(tsm.price)}（${pct(tsm.changePct, 2)}）`);
    const ex = [env.vix && `VIX ${env.vix.value}（${env.vix.meaning}）`, env.twd && `美元兌台幣 ${env.twd.value}（${env.twd.meaning}）`, env.dxy && `美元指數 ${env.dxy.value}`].filter(Boolean);
    S.push({ h: '隔夜美股', lines: [L.join('、'), ex.join('、')].filter(Boolean) });
  } else {
    const t = ix('^TWII'), L = [t && `加權指數 ${px(t.price)}（${pct(t.changePct, 2)}）`, env.foreign && `外資 ${env.foreign.meaning} ${Math.abs(env.foreign.value)} 億`, env.twd && `台幣 ${env.twd.value}（${env.twd.meaning}）`].filter(Boolean);
    const twm = Object.values(items).filter(i => i.market === 'tw' && isNum(i.changePct)).sort((a, b) => b.changePct - a.changePct);
    if (twm.length) L.push(`觀察清單：${twm.slice(0, 2).map(i => `${i.name} ${pct(i.changePct)}`).join('、')} 最強；${twm.slice(-2).reverse().map(i => `${i.name} ${pct(i.changePct)}`).join('、')} 最弱`);
    const ex = [env.vix && `VIX ${env.vix.value}`, env.curve && `美債利差 ${env.curve.value} 百分點`].filter(Boolean);
    S.push({ h: '今天台股收盤', lines: [...L, ex.join('、')].filter(Boolean) });
  }
  // 1b. 送出當下的即時訊號（期貨、亞洲／歐洲盤）
  {
    const Q = live.q || {}, f = (sym, n, d = 2) => { const x = Q[sym]; return x && isNum(x.price) ? `${n} ${px(x.price)}（${pct(x.chg, d)}）` : null; };
    const L = [];
    if (tw) {
      const tx = live.tx;
      if (tx && isNum(tx.last)) L.push(`台指期夜盤 ${px(tx.last)}（${tx.diff >= 0 ? '+' : ''}${Math.round(tx.diff)} 點，${pct(tx.pct, 2)}）→ 暗示今天開盤${Math.abs(tx.pct) < 0.3 ? '平盤附近' : tx.pct > 0 ? '偏高' : '偏低'}`);
      L.push([f('ES=F', '標普期貨'), f('NQ=F', '那斯達克期貨')].filter(Boolean).join('、'));
      L.push([f('^N225', '日經'), f('^KS11', '韓國綜合')].filter(Boolean).join('、'));
    } else {
      L.push([f('ES=F', '標普期貨'), f('NQ=F', '那斯達克期貨'), f('YM=F', '道瓊期貨')].filter(Boolean).join('、'));
      L.push([f('^GDAXI', '德國 DAX'), f('^STOXX50E', '歐洲 50')].filter(Boolean).join('、'));
      const tnx = Q['^TNX']; L.push([tnx && isNum(tnx.price) ? `美債 10 年 ${tnx.price.toFixed(2)}%` : null, f('CL=F', '原油', 1), f('GC=F', '黃金', 1)].filter(Boolean).join('、'));
    }
    const lines = L.filter(Boolean); if (lines.length) S.push({ h: '現在的即時訊號', lines });
  }
  // 2. 今日判斷
  S.push({ h: '今日判斷', lines: [snap.verdict?.headline, snap.ai?.verdict ? `AI：${snap.ai.verdict}` : null, ...(snap.health?.signals || []).slice(0, 2).map(x => '・' + x.text)].filter(Boolean) });
  // 3. 全球新聞重點
  const D = N?.digest, U = D?.ai || D?.rule;
  if (U) S.push({ h: '全球新聞重點', lines: [U.headline, ...(U.bullets || []).slice(0, 5).map(b => '• ' + b), (D.ai?.watch || []).length ? '接下來盯：' + D.ai.watch.slice(0, 4).join('｜') : null].filter(Boolean) });
  // 4. 關鍵價位：持股優先，沒有持股就用觀察清單
  const held = (P?.holdings?.items || []).map(h => h.key).filter(k => items[k]?.market === market);
  const keys = held.length ? held : Object.values(items).filter(i => i.market === market).sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0)).slice(0, 6).map(i => i.key);
  const lv = keys.map(k => {
    const it = items[k], o = it.outlook, s = o?.sr?.support?.[0], r = o?.sr?.resistance?.[0], up = o?.forecast?.h5?.upProb;
    const lq = live.q?.[k], preTxt = !tw && lq && isNum(lq.pre) ? `｜盤前 ${px(lq.pre)}（${pct(lq.preChg)}）` : '';
    return `${it.key} ${it.name} ${px(it.price)}（${pct(it.changePct)}）${preTxt}${SIG[it.signal?.sig] || ''}｜撐 ${s ? px(s.p) : '—'}・壓 ${r ? px(r.p) : '—'}${isNum(up) ? `｜5 日上漲機率 ${up}%` : ''}${it.signal?.stop ? `｜停損參考 ${px(it.signal.stop)}` : ''}`;
  });
  if (lv.length) S.push({ h: held.length ? '我的持股關鍵價位' : '觀察清單關鍵價位', lines: lv, priv: !!held.length });
  // 5. 持股相關新聞（24 小時內）
  if (held.length && N?.per) {
    const L = [];
    for (const k of held) for (const n of (N.per[k] || []).slice(0, 3)) if (n.at && Date.now() - Date.parse(n.at) < 24 * 3600000) L.push(`${k}：${n.zh || n.title}${n.imp === -1 || n.tone === -1 ? '（偏空）' : n.imp === 1 || n.tone === 1 ? '（偏多）' : ''}`);
    if (L.length) S.push({ h: '持股新聞', lines: L.slice(0, 8), priv: true });
  }
  // 6. 今天的事件
  const ev = (snap.calendar || []).filter(e => e.date === day && (e.region === market || e.importance >= 2)).map(e => `${e.title}${e.time ? ` ${e.time}` : ''}`);
  const near = (snap.calendar || []).filter(e => e.date > day && (Date.parse(e.date) - Date.parse(day)) / 86400000 <= 3 && e.importance >= 2).map(e => `${e.date.slice(5).replace('-', '/')} ${e.title}`);
  S.push({ h: '今天的事件', lines: [...(ev.length ? ev : ['沒有特別排定的事件']), ...(near.length ? ['接下來 3 天：' + near.slice(0, 4).join('、')] : [])] });
  // 7. 論點條件（個人）
  if (P) {
    const trig = Object.entries(P.journal?.theses || {}).map(([k, t]) => { const it = items[k]; if (!it || it.market !== market) return null; const h = (t.conds || []).map(c => condHit(c, it, P)).filter(x => x[0]).map(x => x[1]); return h.length ? `${k}：${h.join('、')}` : null; }).filter(Boolean);
    if (trig.length) S.push({ h: '論點條件已觸發', lines: trig, priv: true });
  }
  return { title, sections: S };
}
const briefText = (B, { pub = false } = {}) => B.sections.filter(s => !(pub && s.priv)).flatMap(s => [`【${s.h}】`, ...s.lines, '']).slice(0, -1);
function briefHtml(B) {
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const sec = B.sections.map(s => `<h3 style="margin:18px 0 6px;font-size:15px;color:#0f766e;border-bottom:1px solid #e5e7eb;padding-bottom:4px">${esc(s.h)}</h3>` + s.lines.map(l => `<div style="margin:3px 0">${esc(l)}</div>`).join('')).join('');
  return `<div style="font-family:-apple-system,'PingFang TC','Microsoft JhengHei',sans-serif;font-size:14px;line-height:1.6;color:#111;max-width:640px"><h2 style="margin:0 0 4px;font-size:18px">${esc(B.title)}</h2>${sec}${SITE ? `<p style="margin-top:20px"><a href="${SITE}" style="color:#0f766e">打開訊號終端</a></p>` : ''}</div>`;
}
// 寄信：有 SMTP（例如 Gmail 應用程式密碼）就寄排版過的信；否則有 MAIL_TO 就透過 ntfy 轉寄純文字信
async function sendMail(B) {
  const to = process.env.MAIL_TO || process.env.SMTP_USER; if (!to) return null;
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const nm = require('nodemailer');
      const t = nm.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: +(process.env.SMTP_PORT || 465), secure: +(process.env.SMTP_PORT || 465) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
      await t.sendMail({ from: `訊號終端 <${process.env.SMTP_USER}>`, to, subject: B.title, text: briefText(B).join('\n'), html: briefHtml(B) });
      return 'email ok';
    } catch (e) { console.log('寄信失敗：', e.message); return 'email fail'; }
  }
  if (process.env.NTFY_TOPIC) {
    const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
    const r = await fetch(server, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: process.env.NTFY_TOPIC, title: B.title, message: briefText(B).join('\n').slice(0, 3900), email: to, priority: 1 }) }).catch(e => ({ ok: false, statusText: e.message }));
    return 'email(ntfy) ' + (r.ok ? 'ok' : 'fail ' + (r.status || r.statusText));
  }
  return null;
}

module.exports = { send, decrypt, inQuiet, healthEvents, newsEvents, monthly, premarket, weekly, briefText, briefHtml };
if (require.main === module) (async () => {
  const snap = readJSON(String(args.snap || 'out/data/snapshot.json'), null);
  if (!snap) { console.log('沒有快照，略過通知'); return; }
  const P = await loadPersonal();
  if (args.weekly) {
    const bars = String(args.bars || 'out/data/bars'), N = readJSON(path.join(path.dirname(String(args.snap || 'out/data/snapshot.json')), 'news.json'), null);
    const B = weekly(snap, N, P, bars, await weeklyAI(snap, N, bars));
    console.log(briefText(B, { pub: true }).join('\n'));
    if (args.print) return;
    await send(B.title, briefText(B), { priority: 3, tags: ['calendar'] });
    const m = await sendMail(B); if (m) console.log(m);
    return;
  }
  if (args.monthly) { await send(`訊號終端月報 ${tpeDay().slice(0, 7)}`, monthly(snap, P, String(args.bars || 'out/data/bars'), await loadLocal())); return; }
  if (args.premarket) {
    const mk = args.premarket === 'us' ? 'us' : 'tw', N = readJSON(path.join(path.dirname(String(args.snap || 'out/data/snapshot.json')), 'news.json'), null);
    const Live = require('./lib/live');
    const usKeys = Object.values(snap.items || {}).filter(i => i.market === 'us').map(i => i.key);
    const syms = mk === 'tw' ? ['ES=F', 'NQ=F', '^N225', '^KS11'] : ['ES=F', 'NQ=F', 'YM=F', '^GDAXI', '^STOXX50E', '^TNX', 'CL=F', 'GC=F', ...usKeys];
    const [q, tx] = await Promise.all([Live.quotes(syms), mk === 'tw' ? Live.taifexNight() : null]);
    console.log(`::notice::即時報價 ${Object.keys(q).length}/${syms.length}${mk === 'tw' ? `、台指期夜盤 ${tx ? tx.last + '（' + (tx.pct ?? 0).toFixed(2) + '%）' : '失敗'}` : ''}`);
    const B = premarket(snap, N, P, mk, { q, tx });
    console.log(briefText(B, { pub: true }).join('\n'));   // 公開紀錄只印不含個人資料的部分
    if (args.print) return;
    if (args.push !== 'no') await send(B.title, briefText(B), { priority: 3, tags: ['sunrise'] });
    const m = await sendMail(B); if (m) console.log(m);
    return;
  }
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
