'use strict';
/**
 * 全球市場快報：只收有公信力的財經媒體，涵蓋全球股、債、匯、原物料、央行與地緣政治。
 *   新聞：Google 新聞（限定媒體網域）＋ CNBC RSS
 *   行情：Yahoo 全球指數、殖利率、美元、原油、黃金、比特幣
 *   摘要：有 AI 金鑰時由 AI 寫成繁中摘要與結論；沒有時用規則產生（行情數字＋多家媒體同時報導的頭條）
 */
const { get } = require('./http');
const { parseRss } = require('./news');

const EN_SITES = 'site:reuters.com OR site:bloomberg.com OR site:cnbc.com OR site:wsj.com OR site:ft.com OR site:apnews.com OR site:marketwatch.com OR site:barrons.com OR site:asia.nikkei.com';
const ZH_SITES = 'site:cna.com.tw OR site:money.udn.com OR site:ctee.com.tw OR site:news.cnyes.com OR site:wealth.com.tw OR site:bnext.com.tw OR site:technews.tw';
const CREDIBLE = /Reuters|路透|Bloomberg|彭博|CNBC|Wall Street Journal|WSJ|華爾街日報|Financial Times|FT|AP News|Associated Press|MarketWatch|Barron|Nikkei|日經|中央社|CNA|經濟日報|工商時報|鉅亨|財訊|數位時代|科技新報|聯合新聞網/i;

const Q_ZH = ['國際股市', '美股 收盤', '美債 殖利率', '聯準會', '油價', '金價', '美元 匯率', '日股 OR 日經指數', '陸股 OR 港股', '歐股', '央行 利率', '關稅 OR 地緣政治'];
const Q_EN = ['stock market', 'Wall Street stocks', 'Treasury yields', 'Federal Reserve', 'oil prices', 'gold prices', 'dollar currencies', 'Asian markets', 'European stocks', 'China economy'];
const CNBC = { 'CNBC 頭條': 100003114, 'CNBC 市場': 20409666, 'CNBC 經濟': 20910258 };

const CATS = [
  ['美股', /美股|華爾街|道瓊|標普|那斯達克|費半|Wall Street|S&P|Nasdaq|Dow|stocks? (rise|fall|close|rally|slip)|equities/i],
  ['利率與央行', /聯準會|Fed\b|FOMC|鮑爾|Powell|降息|升息|利率|殖利率|美債|公債|Treasur|yield|rate cut|rate hike|central bank|央行|ECB|BOJ|日銀|歐洲央行|PBOC|人行/i],
  ['匯率', /美元|匯率|日圓|日元|歐元|人民幣|台幣|新台幣|dollar|yen|euro|yuan|currenc|forex/i],
  ['能源', /油價|原油|布蘭特|OPEC|天然氣|oil|crude|Brent|OPEC|natural gas|energy/i],
  ['黃金與原物料', /金價|黃金|白銀|銅價|鐵礦|原物料|gold|silver|copper|commodit/i],
  ['亞洲', /日股|日經|港股|恒生|陸股|上證|A股|韓股|KOSPI|台股|亞股|Nikkei|Hang Seng|Shanghai|Kospi|Asia|China|中國|日本|南韓/i],
  ['歐洲', /歐股|歐洲|英國|德國|法國|STOXX|DAX|FTSE|Europe|UK|Germany|France/i],
  ['政策與地緣', /關稅|貿易|制裁|戰爭|衝突|選舉|白宮|川普|tariff|trade war|sanction|war|election|White House|Trump|geopolit|中東|俄|烏克蘭|以色列|伊朗/i],
  ['科技與 AI', /AI|人工智慧|輝達|Nvidia|半導體|晶片|chip|semiconductor|蘋果|Apple|微軟|Microsoft|Google|Alphabet|Meta|Amazon|特斯拉|Tesla|台積電|TSMC/i],
  ['加密貨幣', /比特幣|加密|以太|bitcoin|crypto|ether/i],
];
const catOf = t => (CATS.find(([, re]) => re.test(t)) || ['其他'])[0];

const GLOBAL = [
  ['^GSPC', '標普 500', 'eq'], ['^IXIC', '那斯達克', 'eq'], ['^DJI', '道瓊', 'eq'], ['^SOX', '費城半導體', 'eq'],
  ['^STOXX50E', '歐洲 STOXX 50', 'eq'], ['^GDAXI', '德國 DAX', 'eq'], ['^FTSE', '英國富時', 'eq'],
  ['^N225', '日經 225', 'eq'], ['^HSI', '恒生', 'eq'], ['000001.SS', '上證', 'eq'], ['^KS11', '南韓 KOSPI', 'eq'], ['^TWII', '台股加權', 'eq'],
  ['^TNX', '美債 10 年殖利率', 'yld'], ['DX-Y.NYB', '美元指數', 'fx'], ['JPY=X', '美元兌日圓', 'fx'], ['TWD=X', '美元兌台幣', 'fx'],
  ['CL=F', 'WTI 原油', 'cmd'], ['BZ=F', '布蘭特原油', 'cmd'], ['GC=F', '黃金', 'cmd'], ['HG=F', '銅', 'cmd'],
  ['BTC-USD', '比特幣', 'crypto'], ['^VIX', 'VIX 恐慌指數', 'vol'],
];

async function quotes(yf) {
  const r = await yf.quote(GLOBAL.map(g => g[0]), {}, { validateResult: false });
  const by = Object.fromEntries((Array.isArray(r) ? r : [r]).map(q => [q.symbol, q]));
  return GLOBAL.map(([sym, name, kind]) => { const q = by[sym] || {}; const p = q.regularMarketPrice, pc = q.regularMarketPreviousClose ?? q.chartPreviousClose;
    return { sym, name, kind, price: p ?? null, chg: Number.isFinite(q.regularMarketChangePercent) ? +q.regularMarketChangePercent.toFixed(2) : null, diff: Number.isFinite(p) && Number.isFinite(pc) ? +(p - pc).toFixed(3) : null, t: q.regularMarketTime ? new Date(q.regularMarketTime).toISOString() : null }; });
}

const gnews = (q, zh) => get(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:1d')}${zh ? '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' : '&hl=en-US&gl=US&ceid=US:en'}`, { as: 'text', timeout: 20000, retries: 1 }).then(parseRss);

const toks = t => { const s = t.toLowerCase(); const en = s.match(/[a-z]{4,}/g) || []; const zh = []; const c = s.replace(/[^一-龥]/g, ''); for (let i = 0; i < c.length - 1; i++) zh.push(c.slice(i, i + 2)); return new Set([...en, ...zh]); };
const jac = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); };

async function headlines(log) {
  const all = [];
  for (const q of Q_ZH) { try { all.push(...(await gnews(`${q} (${ZH_SITES})`, true)).map(x => ({ ...x, lang: 'zh' }))); } catch (_) {} }
  for (const q of Q_EN) { try { all.push(...(await gnews(`${q} (${EN_SITES})`, false)).map(x => ({ ...x, lang: 'en' }))); } catch (_) {} }
  for (const [src, id] of Object.entries(CNBC)) { try { const r = parseRss(await get(`https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=${id}`, { as: 'text', timeout: 15000, retries: 1 })); all.push(...r.map(x => ({ ...x, source: x.source || 'CNBC', lang: 'en' }))); } catch (_) {} }
  const since = Date.now() - 36 * 3600000, seen = new Set();
  const NOISE = /速報|快訊|Market Talk|Roundup|盤中|個股|目標價|EPS預估|漲停|跌停|\(\d{4}(-TW)?\)|Podcast|Live:|LIVE|Quiz|Opinion|觀點|專欄/i;
  const list = all.filter(x => x.title && CREDIBLE.test(x.source || '') && !NOISE.test(x.title) && (!x.at || Date.parse(x.at) > since)).filter(x => { const k = x.title.toLowerCase().replace(/\W/g, '').slice(0, 50); if (seen.has(k)) return false; seen.add(k); return true; })
    .map(x => ({ ...x, cat: catOf(x.title), tk: toks(x.title) }));
  // 同一事件多家媒體報導 → 合併成一則，報導家數越多越重要
  const clusters = [];
  for (const n of list.sort((a, b) => (b.at || '').localeCompare(a.at || ''))) {
    const c = clusters.find(c => c.lang === n.lang && jac(c.tk, n.tk) >= 0.3);
    if (c) { c.items.push(n); c.sources.add(n.source); } else clusters.push({ lang: n.lang, tk: n.tk, items: [n], sources: new Set([n.source]) });
  }
  const stories = clusters.map(c => { const h = c.items[0]; const age = h.at ? (Date.now() - Date.parse(h.at)) / 3600000 : 12;
    return { title: h.title, desc: h.desc, link: h.link, source: h.source, at: h.at, lang: h.lang, cat: h.cat, sources: [...c.sources].slice(0, 5), n: c.items.length, score: c.sources.size * 4 + Math.min(c.items.length, 4) - age / 6 - (h.cat === '其他' ? 3 : 0) }; })
    .sort((a, b) => b.score - a.score);
  log && log(`全球新聞：原始 ${all.length}，可信來源 ${list.length}，事件 ${stories.length}`);
  return stories;
}

const f = (v, d = 2) => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(d) + '%');
/** 沒有 AI 時：用行情數字寫出快報與結論 */
function ruleSummary(Q, stories) {
  const g = s => Q.find(q => q.sym === s) || {};
  const line = (label, syms) => { const p = syms.map(g).filter(q => q.chg != null); return p.length ? `${label}：${p.map(q => `${q.name} ${f(q.chg)}`).join('、')}` : null; };
  const tnx = g('^TNX'), vix = g('^VIX'), oil = g('CL=F'), gold = g('GC=F'), dxy = g('DX-Y.NYB'), btc = g('BTC-USD');
  const bullets = [
    line('美股', ['^GSPC', '^IXIC', '^SOX']),
    line('歐股', ['^STOXX50E', '^GDAXI', '^FTSE']),
    line('亞股', ['^N225', '^HSI', '000001.SS', '^KS11', '^TWII']),
    tnx.price != null ? `債市：美債 10 年殖利率 ${tnx.price.toFixed(2)}%${tnx.diff != null ? `（${tnx.diff > 0 ? '+' : ''}${Math.round(tnx.diff * 100)} bp）` : ''}` : null,
    (() => { const fx = [dxy.price != null ? `美元指數 ${dxy.price.toFixed(2)}（${f(dxy.chg)}）` : null, g('JPY=X').price ? `美元兌日圓 ${g('JPY=X').price.toFixed(1)}（${f(g('JPY=X').chg)}）` : null, g('TWD=X').price ? `美元兌台幣 ${g('TWD=X').price.toFixed(2)}` : null].filter(Boolean); return fx.length ? '匯市：' + fx.join('、') : null; })(),
    line('原物料', ['CL=F', 'GC=F', 'HG=F']),
    btc.chg != null ? `加密貨幣：比特幣 ${f(btc.chg)}` : null,
  ].filter(Boolean);
  // 風險偏好：股漲、VIX 跌、金價跌、美元跌 → 偏多
  const eq = ['^GSPC', '^IXIC', '^STOXX50E', '^N225', '^HSI'].map(g).filter(q => q.chg != null);
  const eqAvg = eq.length ? eq.reduce((a, q) => a + q.chg, 0) / eq.length : 0;
  let s = 0; s += eqAvg > 0.3 ? 2 : eqAvg < -0.3 ? -2 : 0; s += vix.chg < -3 ? 1 : vix.chg > 5 ? -1 : 0; s += gold.chg > 1 ? -1 : 0; s += dxy.chg > 0.4 ? -1 : 0; s += oil.chg > 3 ? -0.5 : 0;
  const mood = s >= 2 ? '風險偏好（Risk-on）' : s <= -2 ? '避險情緒（Risk-off）' : '方向分歧';
  const lead = [...stories.filter(x => x.lang === 'zh').slice(0, 2), ...stories.filter(x => x.lang === 'en').slice(0, 3)].map(x => ({ title: x.title, link: x.link, sources: x.sources }));
  const big = Q.filter(q => q.chg != null && Math.abs(q.chg) >= (q.kind === 'crypto' ? 5 : q.kind === 'vol' ? 10 : 2)).map(q => `${q.name} ${f(q.chg)}`);
  const eqAll = Q.filter(q => q.kind === 'eq' && q.chg != null).sort((a, b) => b.chg - a.chg);
  const best = eqAll[0], worst = eqAll[eqAll.length - 1];
  const bp = tnx.diff != null ? Math.round(tnx.diff * 100) : null;
  const headline = `${mood}${best && worst ? `：${best.name} ${f(best.chg)} 最強、${worst.name} ${f(worst.chg)} 最弱` : ''}`;
  const parts = [`主要股市平均 ${f(eqAvg)}`];
  if (vix.price) parts.push(`VIX ${vix.price.toFixed(1)}${vix.chg != null ? `（${f(vix.chg, 1)}）` : ''}${vix.price >= 25 ? '，市場緊張' : vix.price <= 15 ? '，市場平靜' : ''}`);
  if (bp != null && Math.abs(bp) >= 3) parts.push(`美債殖利率${bp > 0 ? '上升' : '下降'} ${Math.abs(bp)} bp${bp > 0 ? '，對高估值科技股不利' : '，有利成長股'}`);
  if (dxy.chg != null && Math.abs(dxy.chg) >= 0.3) parts.push(`美元${dxy.chg > 0 ? '走強，資金偏向回流美國' : '走弱，有利新興市場與台股資金'}`);
  if (big.length) parts.push(`波動較大：${big.join('、')}`);
  const conclusion = parts.join('；') + '。';
  return { mood, headline, bullets, conclusion, lead, model: null };
}

async function aiSummary(chat, Q, stories) {
  const mk = Q.filter(q => q.price != null).map(q => `${q.name} ${q.price}${q.chg != null ? `（${f(q.chg)}）` : ''}`).join('；');
  const hl = stories.slice(0, 45).map((s, i) => `${i + 1}. [${s.cat}] ${s.title}（${s.sources.join('、')}${s.n > 1 ? `，${s.n} 則報導` : ''}）`).join('\n');
  const sys = '你是國際財經主編，用繁體中文替忙碌的投資人寫全球市場快報。只根據提供的行情與標題，不要編造數字或事件，不要加免責聲明。英文標題請翻成中文再使用。';
  const user = `全球行情：${mk}\n\n可信媒體頭條（多家報導者較重要）：\n${hl}\n\n輸出 JSON：{"headline":"一句話總結今天全球市場（30 字內）","mood":"風險偏好／避險／分歧 三選一","bullets":["5～7 點重點，每點 40 字內，先講發生什麼、再講為什麼重要，涵蓋股、債、匯、原物料、央行、地緣政治中真正重要的"],"conclusion":"結論：對台股與美股投資人的意義與接下來要盯的事（80 字內）","watch":["接下來要注意的 2～4 件事，各 20 字內"]}`;
  const txt = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true });
  const j = JSON.parse((txt.match(/\{[\s\S]*\}/) || [txt])[0]);
  return { headline: String(j.headline || ''), mood: String(j.mood || ''), bullets: (j.bullets || []).map(String).slice(0, 8), conclusion: String(j.conclusion || ''), watch: (j.watch || []).map(String).slice(0, 4) };
}

module.exports = { quotes, headlines, ruleSummary, aiSummary, catOf, GLOBAL };
