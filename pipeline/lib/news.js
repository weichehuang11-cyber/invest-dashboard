'use strict';
/**
 * 市場新聞與熱門題材
 *   來源：Google 新聞 RSS（中文、英文）、FinMind 台股個股新聞（有權杖時）、Yahoo 財經（美股個股）
 *   熱門題材：config/themes.json 的關鍵字＋新聞標題中的「XX概念股／XX族群」自動擷取
 *   相關個股：題材新聞標題裡出現的股票名稱（台股全市場名稱、美股觀察清單與大型股）
 */
const { get, mapSeries } = require('./http');

const decode = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
function parseRss(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1], tag = t => decode((it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`)) || [])[1]);
    let title = tag('title'), source = tag('source');
    if (!source && / - [^-]+$/.test(title)) source = title.split(' - ').pop();
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    const t = Date.parse(tag('pubDate'));
    out.push({ title, link: tag('link'), source, at: Number.isFinite(t) ? new Date(t).toISOString() : null });
  }
  return out;
}
const gnews = (q, lang = 'zh') => get(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}${lang === 'zh' ? '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' : '&hl=en-US&gl=US&ceid=US:en'}`, { as: 'text', timeout: 20000, retries: 1 }).then(parseRss);

async function finmindNews(id, token) {
  const d0 = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const j = await get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockNews&data_id=${id}&start_date=${d0}&token=${encodeURIComponent(token)}`, { timeout: 20000, retries: 1 });
  return (j?.data || []).map(r => ({ title: decode(r.title), link: r.link, source: r.source || 'FinMind', at: r.date ? new Date(String(r.date).replace(' ', 'T') + '+08:00').toISOString() : null }));
}

function tone(title, dict) {
  const p = (dict.positive || []).some(w => title.includes(w)), n = (dict.negative || []).some(w => title.includes(w));
  return p && !n ? 1 : n && !p ? -1 : 0;
}
const dedupe = list => { const seen = new Set(); return list.filter(x => { const k = x.title.replace(/\s/g, '').slice(0, 40); if (!x.title || seen.has(k)) return false; seen.add(k); return true; }); };

/**
 * @param names  { key: name }（台股全市場＋美股），用來在標題裡找相關個股
 * @param watch  觀察清單 [{key, name, market}]
 */
async function collect({ names, watch, dict, token, yf, log = () => {} }) {
  const status = {};
  // 1. 市場新聞（多個查詢合併）
  const marketQ = [['台股 when:1d', 'zh'], ['台股 概念股 when:2d', 'zh'], ['族群 漲停 when:2d', 'zh'], ['美股 when:1d', 'zh'], ['半導體 when:1d', 'zh'], ['stock market when:1d', 'en']];
  let market = [];
  for (const [q, l] of marketQ) { try { market.push(...(await gnews(q, l)).map(x => ({ ...x, q }))); } catch (e) { status.gnewsErr = e.message; } }
  market = dedupe(market).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  status.market = market.length;

  // 2. 觀察清單個股新聞
  const per = {};
  await mapSeries(watch, async w => {
    let list = [];
    if (w.market === 'tw' && token) { try { list = await finmindNews(w.key, token); } catch (_) {} }
    if (list.length < 3) { try { list.push(...await gnews(`${w.market === 'tw' ? w.name : w.key + ' ' + w.name} 股 when:3d`, 'zh')); } catch (_) {} }
    if (w.market === 'us' && yf) { try { const r = await yf.search(w.key, { newsCount: 8, quotesCount: 0 }, { validateResult: false }); list.push(...(r.news || []).map(n => ({ title: n.title, link: n.link, source: n.publisher, at: n.providerPublishTime ? new Date(n.providerPublishTime).toISOString() : null }))); } catch (_) {} }
    per[w.key] = dedupe(list).sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 12).map(x => ({ ...x, tone: tone(x.title, dict) }));
  }, 250);
  status.stocks = Object.values(per).filter(x => x.length).length;

  // 3. 熱門題材：字典＋自動擷取「XX概念股／XX族群」
  const all = dedupe([...market, ...Object.values(per).flat()]);
  const themeMap = new Map();
  for (const t of dict.themes || []) themeMap.set(t.name, { name: t.name, kw: t.kw, auto: false });
  const autoCount = new Map();
  for (const n of all) for (const m of n.title.matchAll(/([一-龥A-Za-z0-9]{2,6})(概念股|族群|供應鏈)/g)) {
    const k = m[1].replace(/^(的|與|和|及|等|帶動|點火|領軍|力挺)/, ''); if (k.length < 2 || /台股|個股|相關|今日|多檔|這些|哪些|強勢|弱勢|熱門/.test(k)) continue;
    autoCount.set(k, (autoCount.get(k) || 0) + 1);
  }
  for (const [k, c] of autoCount) {
    if (c < 2) continue;
    const exists = [...themeMap.values()].some(t => t.kw.some(w => w.includes(k) || k.includes(w.replace(/\s/g, ''))));
    if (!exists) themeMap.set(k + '概念', { name: k + '概念', kw: [k], auto: true });
  }
  const nameList = Object.entries(names).filter(([, n]) => n && n.length >= 2 && !/^(股|ETF)/.test(n));
  const themes = [];
  for (const t of themeMap.values()) {
    const hits = all.filter(n => t.kw.some(w => n.title.toLowerCase().includes(w.toLowerCase())));
    if (!hits.length) continue;
    const stockCount = new Map();
    for (const n of hits) for (const [k, nm] of nameList) if (n.title.includes(nm) || (/^[A-Z]{2,5}$/.test(k) && new RegExp(`\\b${k}\\b`).test(n.title))) stockCount.set(k, (stockCount.get(k) || 0) + 1);
    themes.push({ name: t.name, auto: t.auto, count: hits.length, tone: hits.reduce((s, n) => s + tone(n.title, dict), 0),
      stocks: [...stockCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([key, c]) => ({ key, mentions: c })),
      news: hits.slice(0, 5).map(n => ({ title: n.title, link: n.link, source: n.source, at: n.at, tone: tone(n.title, dict) })) });
  }
  themes.sort((a, b) => b.count - a.count);
  return { at: new Date().toISOString(), status, market: market.slice(0, 40).map(x => ({ ...x, tone: tone(x.title, dict) })), per, themes: themes.slice(0, 15) };
}

module.exports = { collect, parseRss, tone };
