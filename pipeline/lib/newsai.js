'use strict';
/**
 * 新聞逐則摘要：每則新聞產生繁體中文標題、兩句摘要、影響判斷（利多／利空／中性）與相關市場。
 * 只依標題與媒體提供的導言整理（付費牆媒體拿不到全文），結果快取在 state/newsai.json，只有新新聞才送 AI。
 */
const idOf = t => { let h = 5381; const s = String(t).replace(/\s+/g, '').toLowerCase(); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };

async function summarize(items, chat, cache, { max = 120, batch = 40, log = () => {} } = {}) {
  cache.map = cache.map || {};
  const todo = [];
  const seen = new Set();
  for (const it of items) { const id = idOf(it.title); if (seen.has(id)) continue; seen.add(id); if (!cache.map[id]) todo.push({ id, ...it }); }
  const queue = todo.slice(0, max);
  let added = 0; const errs = [];
  for (let i = 0; i < queue.length; i += batch) {
    const part = queue.slice(i, i + batch);
    const list = part.map(x => `${x.id}｜${x.source || ''}｜${x.title}${x.desc ? '｜導言：' + x.desc : ''}`).join('\n');
    const sys = '你是財經新聞編輯，替忙碌的投資人把新聞整理成繁體中文快讀。只能根據提供的標題與導言，不要編造數字、日期或細節；資訊不足時就只說標題講的事與它可能的影響。全部用繁體中文（台灣用語），公司名可保留英文或常見中文譯名。';
    const user = `逐則整理以下新聞（格式：編號｜媒體｜標題｜導言）：\n${list}\n\n輸出 JSON：{"items":[{"id":"編號","t":"繁體中文標題，25 字內","s":"摘要：發生什麼＋為什麼重要，2 句、70 字內","i":"利多／利空／中性（對相關市場或個股）","m":["相關市場或標的，例如 美股、台股、債市、美元、原油、黃金、台積電，最多 3 個"]}]}，每一則都要有。`;
    try {
      const txt = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true, timeout: 120000 });
      const j = JSON.parse((txt.match(/\{[\s\S]*\}/) || [txt])[0]);
      for (const r of j.items || []) {
        const id = String(r.id || '').trim(); if (!part.some(x => x.id === id)) continue;
        cache.map[id] = { t: String(r.t || '').slice(0, 60), s: String(r.s || '').slice(0, 200), i: /利多/.test(r.i) ? 1 : /利空/.test(r.i) ? -1 : 0, m: (r.m || []).map(String).slice(0, 3), at: Date.now() };
        added++;
      }
    } catch (e) { errs.push(e.message.slice(0, 160)); log('新聞摘要失敗', e.message); break; }
  }
  // 只保留 4 天內的
  const cut = Date.now() - 4 * 86400000;
  for (const [k, v] of Object.entries(cache.map)) if (v.at < cut) delete cache.map[k];
  if (added) cache.at = new Date().toISOString();
  return { added, pending: todo.length - added, errs };
}
/** 把摘要貼回每則新聞 */
function attach(list, cache) {
  for (const n of list || []) { const r = cache.map?.[idOf(n.title)]; if (r) { n.zh = r.t || undefined; n.sum = r.s || undefined; n.imp = r.i; n.mk = r.m?.length ? r.m : undefined; } }
  return list;
}
module.exports = { summarize, attach, idOf };

/** 題材摘要：為什麼熱、對誰有利，以及每檔相關個股一句話看點（全部繁體中文） */
async function themeSummaries(themes, chat, cache, { log = () => {} } = {}) {
  cache.themes = cache.themes || {};
  const sig = t => idOf(t.name + '|' + t.news.slice(0, 5).map(n => n.title).join('|') + '|' + t.stocks.slice(0, 8).map(s => s.key).join(','));
  const todo = themes.slice(0, 12).filter(t => cache.themes[t.name]?.sig !== sig(t));
  if (!todo.length) return { added: 0 };
  const body = todo.map((t, i) => `【${i + 1}】${t.name}（${t.count} 則新聞${t.avgChg != null ? `，相關股今日平均 ${t.avgChg}%` : ''}）
新聞：${t.news.slice(0, 5).map(n => n.zh || n.title).join('；')}
相關個股：${t.stocks.slice(0, 8).map(s => `${s.key} ${s.name}${s.p != null ? `（今日 ${s.p}%${s.r20 != null ? `，20 日 ${s.r20}%` : ''}）` : ''}`).join('、') || '無'}`).join('\n\n');
  const sys = '你是台股產業分析師，用繁體中文（台灣用語）寫給個人投資人。只根據提供的新聞與數字，不要編造營收、訂單或價格；不確定時寫「新聞未說明」。';
  const user = `${body}\n\n逐一整理上面每個題材，輸出 JSON：{"themes":[{"name":"題材名稱（照抄）","sum":"為什麼現在熱、驅動因素是什麼，2 句、70 字內","phase":"剛起漲／發酵中／過熱／降溫 四選一（依新聞量與漲幅判斷）","stocks":{"代號":"這檔和題材的關係或看點，25 字內；如果新聞看不出它和題材有關，就只寫「無直接關聯」"}}]}`;
  try {
    const txt = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true, timeout: 120000 });
    const j = JSON.parse((txt.match(/\{[\s\S]*\}/) || [txt])[0]);
    let n = 0;
    for (const r of j.themes || []) {
      const t = todo.find(x => x.name === String(r.name || '').trim()) || todo[(j.themes || []).indexOf(r)];
      if (!t) continue;
      cache.themes[t.name] = { sig: sig(t), sum: String(r.sum || '').slice(0, 200), phase: String(r.phase || '').slice(0, 6), stocks: Object.fromEntries(Object.entries(r.stocks || {}).map(([k, v]) => [String(k).toUpperCase().trim(), String(v).slice(0, 60)])), at: Date.now() };
      n++;
    }
    const cut = Date.now() - 7 * 86400000;
    for (const [k, v] of Object.entries(cache.themes)) if (v.at < cut) delete cache.themes[k];
    return { added: n };
  } catch (e) { log('題材摘要失敗', e.message); return { added: 0, err: e.message.slice(0, 160) }; }
}
function attachThemes(themes, cache) {
  for (const t of themes || []) {
    const r = cache.themes?.[t.name]; if (!r) continue;
    t.sum = r.sum || undefined; t.phase = r.phase || undefined;
    for (const s of t.stocks) if (r.stocks?.[s.key]) s.why = r.stocks[s.key];
    // AI 判斷和題材沒有實際關聯的（只是剛好出現在同一則綜合新聞）就拿掉
    t.stocks = t.stocks.filter(s => !(s.why && /未說明|無直接關聯|無關/.test(s.why) && (s.mentions || 0) < 2));
  }
  return themes;
}
module.exports.themeSummaries = themeSummaries;
module.exports.attachThemes = attachThemes;
