'use strict';
/**
 * 新聞逐則摘要：每則新聞產生繁體中文標題、兩句摘要、影響判斷（利多／利空／中性）與相關市場。
 * 只依標題與媒體提供的導言整理（付費牆媒體拿不到全文），結果快取在 state/newsai.json，只有新新聞才送 AI。
 */
const idOf = t => { let h = 5381; const s = String(t).replace(/\s+/g, '').toLowerCase(); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };

const SYS = '你是財經新聞編輯，替忙碌的投資人把新聞整理成繁體中文快讀。只能根據提供的內容（標題、導言、內文、其他媒體標題）；不要編造數字、日期或細節。全部用繁體中文（台灣用語），公司名可保留英文或常見中文譯名。';
const FORMAT = '{"id":"編號","t":"繁體中文標題，25 字內","s":"摘要：發生什麼、關鍵數字、原因，2～3 句、110 字內","k":["重點 1，25 字內","重點 2","最多 3 點，只寫內容裡有的事實"],"w":"對投資人的意義：影響哪些市場或產業、該注意什麼，40 字內","i":"利多／利空／中性","m":["相關市場或個股，最多 3 個；個股請寫「中文名（代號）」，例如 特斯拉（TSLA）、台積電（2330）"]}';
const ctxOf = x => [x.desc ? '導言：' + x.desc : '', x.body ? '內文：' + x.body.slice(0, 900) : '', x.alt?.length ? '其他媒體：' + x.alt.slice(0, 4).join('／') : ''].filter(Boolean).join('｜');
function save(cache, id, r, extra = {}) {
  cache.map[id] = { t: String(r.t || '').slice(0, 60), s: String(r.s || '').slice(0, 260), k: (r.k || []).map(String).filter(Boolean).slice(0, 3), w: String(r.w || '').slice(0, 100),
    i: /利多/.test(r.i) ? 1 : /利空/.test(r.i) ? -1 : 0, m: (r.m || []).map(String).slice(0, 3), at: Date.now(), v: 2, ...extra };
}
const parseJ = txt => JSON.parse((String(txt).match(/\{[\s\S]*\}/) || [txt])[0]);

/** 直接抓得到的原文（CNBC、鉅亨等非付費網站）補上內文 */
async function fetchBodies(items, { max = 15 } = {}) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
  const todo = items.filter(x => !x.body && x.link && !/news\.google\.com|wsj\.com|bloomberg\.com|ft\.com|barrons\.com/.test(x.link)).slice(0, max);
  await Promise.all(todo.map(async x => {
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(x.link, { headers: { 'User-Agent': UA }, signal: ctl.signal }); clearTimeout(t);
      if (!r.ok) return; const h = await r.text();
      const og = (h.match(/<meta[^>]+(?:property|name)="(?:og:)?description"[^>]+content="([^"]+)"/i) || [])[1] || '';
      const ps = [...h.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()).filter(p => p.length > 40).slice(0, 8).join(' ');
      const body = (og + ' ' + ps).trim(); if (body.length > 80) x.body = body.slice(0, 1500);
    } catch (_) {}
  }));
}

// 每批 20 則（40 則一批時回覆太長，常逾時或被 503 打斷）；每次最多 60 則，其餘留到下一輪
async function summarize(items, chat, cache, { max = 60, batch = 20, log = () => {} } = {}) {
  cache.map = cache.map || {};
  const todo = [], seen = new Set();
  for (const it of items) { const id = idOf(it.title); if (seen.has(id)) continue; seen.add(id); const c = cache.map[id]; if (!c || (c.v !== 2 && (it.body || it.alt))) todo.push({ id, ...it }); }
  const queue = todo.slice(0, max);
  await fetchBodies(queue);
  let added = 0, fails = 0; const errs = [];
  for (let i = 0; i < queue.length; i += batch) {
    const part = queue.slice(i, i + batch);
    const list = part.map(x => `${x.id}｜${x.source || ''}｜${x.title}${ctxOf(x) ? '｜' + ctxOf(x) : ''}`).join('\n');
    const user = `逐則整理以下新聞（格式：編號｜媒體｜標題｜補充內容）。補充內容越多，摘要要越具體（寫出數字、公司、原因）；只有標題時就簡短說明，不要硬湊：\n${list}\n\n輸出 JSON：{"items":[${FORMAT}]}，每一則都要有。`;
    try {
      const j = parseJ(await chat([{ role: 'system', content: SYS }, { role: 'user', content: user }], { json: true, timeout: 120000 }));
      for (const r of j.items || []) { const id = String(r.id || '').trim(); if (part.some(x => x.id === id)) { save(cache, id, r, { src: part.find(x => x.id === id).body ? 'body' : 'title' }); added++; } }
      fails = 0;
    } catch (e) { errs.push(e.message.slice(0, 160)); log('新聞摘要失敗', e.message); if (++fails >= 2) break; }  // 單批失敗就換下一批，連續兩批失敗才停
  }
  const cut = Date.now() - 4 * 86400000;
  for (const [k, v] of Object.entries(cache.map)) if (v.at < cut) delete cache.map[k];
  if (added) cache.at = new Date().toISOString();
  return { added, pending: todo.length - added, errs };
}

/** 重點新聞（多家媒體報導但抓不到內文）：讓 Gemini 用 Google 搜尋查證後寫完整摘要 */
async function deepen(stories, grounded, cache, { max = 8, log = () => {} } = {}) {
  const todo = stories.filter(x => !x.body).slice(0, 15).map(x => ({ id: idOf(x.title), ...x })).filter(x => !cache.map[x.id]?.g).slice(0, max);
  if (!todo.length) return { added: 0 };
  const list = todo.map(x => `${x.id}｜${x.sources?.join('、') || x.source}｜${x.title}`).join('\n');
  const prompt = `用 Google 搜尋查證下面每則新聞的實際內容（優先看路透、彭博、CNBC、華爾街日報、中央社、經濟日報等可信媒體），再逐則整理：\n${list}\n\n只輸出 JSON（不要其他文字）：{"items":[${FORMAT}]}`;
  try {
    const j = parseJ(await grounded(prompt, SYS + '查不到可靠來源時，就只依標題簡短整理，並在摘要開頭寫「（僅依標題）」。'));
    let n = 0; for (const r of j.items || []) { const id = String(r.id || '').trim(); if (todo.some(x => x.id === id)) { save(cache, id, r, { g: 1, src: 'search' }); n++; } }
    return { added: n };
  } catch (e) { log('查證摘要失敗', e.message); return { added: 0, err: e.message.slice(0, 160) }; }
}

/** 把摘要貼回每則新聞 */
function attach(list, cache) {
  for (const n of list || []) { const r = cache.map?.[idOf(n.title)]; if (r) { n.zh = r.t || undefined; n.sum = r.s || undefined; n.kp = r.k?.length ? r.k : undefined; n.why = r.w || undefined; n.imp = r.i; n.mk = r.m?.length ? r.m : undefined; n.ss = r.src || undefined; } }
  return list;
}
module.exports = { summarize, deepen, attach, idOf };

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
    t.stocks = t.stocks.filter(s => !(s.why && /未說明|無直接關聯|無關|未提及/.test(s.why)));
  }
  return themes;
}
module.exports.themeSummaries = themeSummaries;
module.exports.attachThemes = attachThemes;
