'use strict';
/**
 * NAS 盤中即時警報：用 NAS 每 10 秒抓到的行情，比對網站算好的支撐壓力、推論區間、停損與你的提醒價
 *   ・指數（加權、標普、那斯達克、費半）跌破支撐／突破壓力／超出 5 日推論區間
 *   ・持股跌破停損參考價、單日漲跌超過 ±5%
 *   ・你在網站設定的提醒價（到價）
 * 同一件事一天只通知一次；勿擾時段只送重要的（停損、提醒價）。
 * 需要 nas/.env：NTFY_TOPIC（推播）；要看持股與提醒價再加 BACKUP_GIST_ID、BACKUP_PASSPHRASE（和 GitHub 的同一組）
 */
const fs = require('fs');
const path = require('path');

const IDX = { TWII: '^TWII', GSPC: '^GSPC', IXIC: '^IXIC', SOX: '^SOX' };
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const fx = v => (!isNum(v) ? '—' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v >= 100 ? v.toFixed(1) : v.toFixed(2));
const pct = v => (!isNum(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const tpeDay = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const inQuiet = (s, e) => { const h = new Date(Date.now() + 8 * 3600000).getUTCHours(); return s === e ? false : s < e ? h >= s && h < e : h >= s || h < e; };

function create({ base, send, loadPersonal, log = console.log }) {
  const stFile = path.join(base, 'live-alerts.json');
  let sent = {}; try { sent = JSON.parse(fs.readFileSync(stFile, 'utf8')); } catch (_) {}
  let snap = null, snapAt = 0, P = null, pAt = 0;
  const save = () => { const d = tpeDay(); for (const k of Object.keys(sent)) if (!k.endsWith(d) && !k.endsWith(new Date(Date.now() - 864e5 + 8 * 3600000).toISOString().slice(0, 10))) delete sent[k]; try { fs.writeFileSync(stFile, JSON.stringify(sent)); } catch (_) {} };

  async function refresh() {
    if (Date.now() - snapAt > 5 * 60000) { try { snap = JSON.parse(fs.readFileSync(path.join(base, 'site', 'data', 'snapshot.json'), 'utf8')); snapAt = Date.now(); } catch (_) {} }
    if (loadPersonal && Date.now() - pAt > 15 * 60000) { pAt = Date.now(); try { P = (await loadPersonal()) || P; } catch (_) {} }
  }
  /** 同一份持股合併（股數相加） */
  function holdings() {
    const m = new Map(); for (const h of P?.holdings?.items || []) { if (!h?.key) continue; const x = m.get(h.key) || { key: h.key, shares: 0 }; x.shares += +h.shares || 0; m.set(h.key, x); }
    return [...m.values()];
  }
  /** 給 livefeed：要抓的個股（觀察清單＋持股） */
  function stockList(universe) {
    const ex = {}; for (const u of universe || []) ex[u.k] = u.x === 'TPEx' ? 'otc' : 'tse';
    const keys = new Set([...Object.keys(snap?.items || {}), ...holdings().map(h => h.key)]);
    return [...keys].map(k => { const it = snap?.items?.[k], m = it?.market || (/^\d/.test(k) ? 'tw' : 'us'); return { key: k, m, ex: ex[k] || 'tse' }; });
  }

  async function check(live, stocks) {
    if (!snap) return;
    const day = tpeDay(), L = P?.limits || {}, quiet = L.quietOn !== false && inQuiet(L.quietStart ?? 23, L.quietEnd ?? 7);
    const out = [];
    const add = (id, prio, text) => { const k = `${id}:${day}`; if (sent[k]) return; sent[k] = 1; out.push({ prio, text }); };
    // 指數
    for (const [lk, ik] of Object.entries(IDX)) {
      const v = live.items[lk], o = snap.indices?.[ik]?.outlook, name = snap.indices?.[ik]?.name || lk;
      if (!v || v.state !== 'open' || !isNum(v.price) || !o) continue;
      const s = o.sr?.support?.[0], r = o.sr?.resistance?.[0], q = o.forecast?.h5?.q;
      if (s && v.price < s.p) add(`idx:${lk}:sup:${s.p}`, 3, `📉 ${name}跌破支撐 ${fx(s.p)}（${s.label}），現在 ${fx(v.price)}（${pct(v.chgPct)}）`);
      if (r && v.price > r.p) add(`idx:${lk}:res:${r.p}`, 3, `📈 ${name}突破壓力 ${fx(r.p)}（${r.label}），現在 ${fx(v.price)}（${pct(v.chgPct)}）`);
      if (q?.length === 5 && v.price <= q[0]) add(`idx:${lk}:q0`, 3, `⚠️ ${name}已跌到 5 日推論區間下緣 ${fx(q[0])}，現在 ${fx(v.price)}（${pct(v.chgPct)}）——跌幅超過平常 9 成情況`);
      if (q?.length === 5 && v.price >= q[4]) add(`idx:${lk}:q4`, 3, `🚀 ${name}已漲到 5 日推論區間上緣 ${fx(q[4])}，現在 ${fx(v.price)}（${pct(v.chgPct)}）`);
    }
    // 持股
    for (const h of holdings()) {
      const v = stocks[h.key], it = snap.items?.[h.key], name = it?.name || h.key;
      if (!v || v.state !== 'open' || !isNum(v.price)) continue;
      const stop = it?.signal?.stop;
      if (isNum(stop) && v.price < stop) add(`stop:${h.key}`, 4, `⛔ 持股 ${h.key} ${name} 跌破停損參考 ${fx(stop)}，現在 ${fx(v.price)}（${pct(v.chgPct)}）`);
      if (isNum(v.chgPct) && Math.abs(v.chgPct) >= 5) add(`mv:${h.key}:${v.chgPct > 0 ? 'u' : 'd'}`, 3, `${v.chgPct > 0 ? '📈' : '📉'} 持股 ${h.key} ${name} 盤中 ${pct(v.chgPct)}（${fx(v.price)}）`);
    }
    // 提醒價
    for (const [k, a] of Object.entries(P?.alerts || {})) {
      const v = stocks[k], name = snap.items?.[k]?.name || k; if (!v || v.state !== 'open' || !isNum(v.price)) continue;
      if (isNum(a.above) && v.price >= a.above) add(`al:${k}:a:${a.above}`, 4, `🔔 ${k} ${name} 漲到 ${fx(v.price)}（提醒價 ${a.above}）`);
      if (isNum(a.below) && v.price <= a.below) add(`al:${k}:b:${a.below}`, 4, `🔔 ${k} ${name} 跌到 ${fx(v.price)}（提醒價 ${a.below}）`);
    }
    if (!out.length) return;
    const go = quiet ? out.filter(e => e.prio >= 4) : out;
    if (go.length) {
      const top = Math.max(...go.map(e => e.prio));
      await send(go.length === 1 ? '訊號終端・即時' : `訊號終端・即時 ${go.length} 則`, go.map(e => e.text).join('\n'), top);
      log(new Date().toISOString(), '即時警報', go.length, '則');
    }
    save();
  }
  return { refresh, check, stockList, hasPersonal: () => !!P };
}

module.exports = { create };
