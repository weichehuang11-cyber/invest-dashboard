'use strict';
/**
 * 雲端 AI（Google Gemini 免費額度，設定 GEMINI_API_KEY；或 Anthropic，設定 ANTHROPIC_API_KEY）
 * 收盤後完整更新時產生一次：今日市場解讀＋觀察清單逐檔一句話點評。電腦沒開也看得到。
 * 只用公開的市場資料；你的持股與論點不會送出。
 */
const MODEL = 'gemini';

/** Anthropic Claude（設定 ANTHROPIC_API_KEY 時優先使用；每天約 2 次呼叫，費用極低） */
async function claude(messages, timeout) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ctl.signal,
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens: 2000, system: sys, messages: messages.filter(m => m.role !== 'system') }) });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 120)}`);
    return JSON.parse(text).content?.map(c => c.text || '').join('') || '';
  } finally { clearTimeout(t); }
}
/** Google Gemini（免費額度；到 aistudio.google.com 申請 API key，設成 GEMINI_API_KEY） */
let GEM_MODEL = null, GEM_LIST = [], GEM_LAST = 0;
/** 整次排程花在 Gemini 的總時間上限（含重試；完整更新本身就要 10–15 分鐘，工作流程上限 20 分鐘） */
const GEM_TOTAL = +process.env.GEMINI_TOTAL_BUDGET_MS || 6 * 60000;
let GEM_SPENT = 0;
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
/** 免費額度每分鐘次數有限：兩次呼叫至少間隔 13 秒 */
async function gemThrottle() { const w = GEM_LAST + 13000 - Date.now(); if (w > 0) await sleep(w); GEM_LAST = Date.now(); }
/** 找出這把金鑰能用的 Flash 模型清單（Google 會淘汰舊模型名稱，所以每次執行自動挑）；有設 GEMINI_MODEL 就排第一個 */
async function geminiModel(key) {
  if (GEM_MODEL) return GEM_MODEL;
  let names = [];
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    const j = await r.json();
    names = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''))
      .filter(n => /^gemini-[\d.]+-flash(-lite)?(-latest)?$|^gemini-flash(-lite)?-latest$/.test(n) && !/image|tts|live|exp|preview|thinking/.test(n));
    const ver = n => parseFloat((n.match(/gemini-([\d.]+)/) || [])[1] || '0');
    // 先用一般 Flash（新到舊），忙碌、逾時或額度用完時再往舊版與 Flash-Lite 退（每個模型的免費額度與負載分開）
    names.sort((a, b) => (a.includes('lite') - b.includes('lite')) || ver(b) - ver(a) || (a.includes('latest') ? 1 : -1));
  } catch (_) {}
  if (!names.length) names = ['gemini-flash-latest'];
  const pin = process.env.GEMINI_MODEL;
  GEM_LIST = pin ? [pin, ...names.filter(n => n !== pin)] : names;
  GEM_MODEL = GEM_LIST[0];
  return GEM_MODEL;
}
/** 這次呼叫還沒試過的下一個模型（照清單順序）；全部試過就回傳 null */
function nextGemini(tried) { const n = GEM_LIST.find(m => !tried.has(m)); if (n) GEM_MODEL = n; return n || null; }
/** 可以重試的錯誤：忙碌（5xx）、額度（429）、模型停用（404）、逾時、連線中斷、空回覆 */
const RETRYABLE = /HTTP (404|408|429|500|502|503|504)\b|逾時|aborted|fetch failed|ECONNRESET|ETIMEDOUT|socket|沒有回覆內容/i;
/** 這幾種代表「這個模型現在不行」，不用在同一個模型上等，直接換下一個 */
const SWITCH_NOW = /HTTP (404|429)\b|逾時|aborted/i;
/**
 * 共用的 Gemini 重試流程：同一模型忙碌時退避重試一次（8 秒），再忙、逾時或額度用完就換下一個模型；
 * 整體有時間上限（budget），避免拖垮整個排程（工作流程上限 20 分鐘）。
 * once(model, timeoutMs) 只負責送一次請求，回傳文字或丟出錯誤。
 */
async function withGemini(once, { timeout, budget, lite }) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error('沒有 GEMINI_API_KEY');
  let model = await geminiModel(key);
  if (lite) { const l = GEM_LIST.find(m => m.includes('lite')); if (l) model = l; }   // 大量的新聞摘要先用 Flash-Lite（額度分開、比較不會用完）
  const t0 = Date.now(), tried = new Set([model]), deadline = t0 + Math.min(budget, GEM_TOTAL - GEM_SPENT), errs = [];
  let sameTries = 0;
  try {
  for (let k = 0; k < 12; k++) {
    const left = deadline - Date.now();
    if (left < 15000) { errs.push(GEM_SPENT + (Date.now() - t0) >= GEM_TOTAL - 15000 ? '本次排程的 AI 時間額度已用完' : '超過重試時間上限'); break; }
    await gemThrottle();
    const ms = Math.min(timeout, left);
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try { return { text: await once(model, ctl.signal), model }; }
    catch (e) {
      const msg = e.name === 'AbortError' ? `${model} 逾時（${Math.round(ms / 1000)} 秒）` : e.message;
      errs.push(msg.slice(0, 160));
      if (!RETRYABLE.test(msg)) break;
      if (SWITCH_NOW.test(msg) || sameTries >= 1) {
        const n = nextGemini(tried);
        if (n) { model = n; tried.add(n); sameTries = 0; continue; }
        if (sameTries >= 2) break;                       // 所有模型都試過、目前這個也重試過了
      }
      sameTries++;
      await sleep(Math.min(8000 * 2 ** (sameTries - 1), deadline - Date.now() - 15000));
    } finally { clearTimeout(t); }
  }
  } finally { GEM_SPENT += Date.now() - t0; }
  // 只回報第一個與最後一個錯誤，狀態欄位才看得懂
  throw new Error(errs.length > 1 ? `${errs[0]} …（共試 ${errs.length} 次，最後：${errs[errs.length - 1]}）` : errs[0] || 'Gemini 忙碌');
}
const gemBody = (sys, contents, extra) => JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents, ...extra });
async function gemPost(model, signal, body) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', signal,
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' }, body });
  const text = await r.text();
  if (!r.ok) throw new Error(`${model} HTTP ${r.status} ${text.slice(0, 160)}`);
  return JSON.parse(text).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
}
/** Google Gemini 一般對話 */
async function gemini(messages, json, timeout, budget, lite) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const body = gemBody(sys, messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    { generationConfig: { temperature: 0.4, ...(json ? { responseMimeType: 'application/json' } : {}) } });
  const r = await withGemini(async (model, signal) => { const out = await gemPost(model, signal, body); if (!out) throw new Error(`${model} 沒有回覆內容`); return out; }, { timeout, budget, lite });
  chat.lastGem = r.model;
  return r.text;
}
/** Gemini＋Google 搜尋（讓 AI 自己查證新聞內容再摘要）；只回傳文字 */
async function grounded(prompt, sys, timeout = 120000, budget = 3 * 60000) {
  const body = gemBody(sys, [{ role: 'user', parts: [{ text: prompt }] }], { tools: [{ google_search: {} }], generationConfig: { temperature: 0.3 } });
  return (await withGemini((model, signal) => gemPost(model, signal, body), { timeout, budget })).text;
}
/** 依序嘗試：Anthropic → Gemini（有哪個金鑰就用哪個） */
async function chat(messages, { json = false, timeout = 90000, budget = 3 * 60000, lite = false } = {}) {
  const errs = [];
  if (process.env.ANTHROPIC_API_KEY) { try { const r = await claude(messages, timeout); chat.last = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5'; return r; } catch (e) { errs.push('anthropic: ' + e.message); } }
  if (process.env.GEMINI_API_KEY) {
    try { const r = await gemini(messages, json, timeout, budget, lite); chat.last = chat.lastGem; return r; }
    catch (e) { errs.push('gemini: ' + e.message); }
  }
  throw new Error(errs.join(' ｜ ') || '沒有可用的 AI（請設定 GEMINI_API_KEY 或 ANTHROPIC_API_KEY）');
}

const SIG = { BUY: '買進', SELL: '賣出', HOLD: '觀望' };
/** AI 有時回「2886 兆豐金」當代號，只取開頭的代號 */
const aiKey = k => (String(k).trim().match(/^[\^A-Za-z0-9.\-]+/) || [String(k).trim()])[0].toUpperCase();
async function commentary(snap, news) {
  const env = snap.env.map(e => `${e.label} ${e.value}${e.unit || ''}${e.changePct != null ? ` (${e.changePct > 0 ? '+' : ''}${e.changePct}%)` : ''} ${e.meaning}`).join('；');
  const health = (snap.health?.signals || []).map(x => x.text).join('；') || '無';
  const facts = snap.ranking.map(k => {
    const it = snap.items[k], o = it.outlook, f = it.fin;
    return `${k} ${it.name}｜${it.price}（${it.changePct}%）｜${SIG[it.signal.sig]} ${it.signal.score} 分｜${o?.stateZh || ''}｜${(o?.comments || []).slice(0, 3).map(c => c.text).join('，')}｜財報：${f?.grade || '—'}${f?.checks?.[0] ? '，' + f.checks[0].text : ''}`;
  }).join('\n');
  const D = news?.digest, U = D?.ai || D?.rule || {};
  const ctx = [U.headline ? `全球快報：${U.headline}；${(U.bullets || []).slice(0, 5).join('；')}` : '', (D?.stories || []).filter(x => x.zh).slice(0, 8).map(x => `・${x.zh}${x.imp ? (x.imp > 0 ? '（利多）' : '（利空）') : ''}`).join('\n'),
    (news?.themes || []).slice(0, 5).map(t => `${t.name}${t.phase ? '（' + t.phase + '）' : ''}${t.avgChg != null ? ` 相關股平均 ${t.avgChg}%` : ''}`).join('、')].filter(Boolean).join('\n');
  const sys = '你是專業的台股與美股分析師，用繁體中文、口語但精準地寫給個人投資人。只根據提供的數據，不要編造新聞或數字，不要加免責聲明。你的價值在於補充規則系統看不到的東西，不要把「今日判斷」的理由換句話說再講一遍。';
  const user = `今日判斷（規則系統，已顯示在畫面上，不要重複）：${snap.verdict.headline}（${snap.verdict.detail}）
今天的新聞與題材：
${ctx || '（無）'}
市場環境：${env}
市場健康度警訊：${health}
觀察清單：
${facts}

請輸出 JSON：{"verdict": "3 句話以內：①新聞或題材上今天真正在推動市場的是什麼、②規則判斷可能沒反映到的風險或機會、③今天最該注意的一件事（不超過 120 字，不要重複今日判斷的理由）", "stocks": {"代號（只寫代號，例如 2330、NVDA）": "一句話點評，30 字以內，說出最關鍵的一件事"}}，stocks 要涵蓋上面每一檔。`;
  const txt = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true });
  const j = JSON.parse((txt.match(/\{[\s\S]*\}/) || [txt])[0]);
  return { model: chat.last || MODEL, at: new Date().toISOString(), verdict: String(j.verdict || '').trim(), stocks: Object.fromEntries(Object.entries(j.stocks || {}).map(([k, v]) => [aiKey(k), String(v).trim()])) };
}

module.exports = { chat, grounded, commentary, MODEL };
