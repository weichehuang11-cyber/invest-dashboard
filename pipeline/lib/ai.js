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
/** 免費額度每分鐘次數有限：兩次呼叫至少間隔 13 秒 */
async function gemThrottle() { const w = GEM_LAST + 13000 - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w)); GEM_LAST = Date.now(); }
/** 目前模型持續忙碌（503）或不存在時，改用下一個可用模型 */
function nextGemini() { const i = GEM_LIST.indexOf(GEM_MODEL); if (i >= 0 && i + 1 < GEM_LIST.length) { GEM_MODEL = GEM_LIST[i + 1]; return true; } return false; }
/** 找出這把金鑰能用的最新 Flash 模型（Google 會淘汰舊模型名稱，所以每次執行自動挑） */
async function geminiModel(key) {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  if (GEM_MODEL) return GEM_MODEL;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    const j = await r.json();
    const names = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''))
      .filter(n => /^gemini-[\d.]+-flash(-lite)?(-latest)?$|^gemini-flash(-lite)?-latest$/.test(n) && !/image|tts|live|exp|preview|thinking/.test(n));
    const ver = n => parseFloat((n.match(/gemini-([\d.]+)/) || [])[1] || '0');
    // 先用一般 Flash（新到舊），額度用完或忙碌時再退到 Flash-Lite（每個模型的免費額度分開計算）
    names.sort((a, b) => (a.includes('lite') - b.includes('lite')) || ver(b) - ver(a) || (a.includes('latest') ? 1 : -1));
    GEM_LIST = names.length ? names : ['gemini-flash-latest'];
    GEM_MODEL = GEM_LIST[0];
  } catch (_) { GEM_MODEL = 'gemini-flash-latest'; }
  return GEM_MODEL;
}
/** Google Gemini（免費額度；到 aistudio.google.com 申請 API key，設成 GEMINI_API_KEY） */
async function gemini(messages, json, timeout) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const key = process.env.GEMINI_API_KEY;
  const model = await geminiModel(key);
  await gemThrottle();
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', signal: ctl.signal,
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { temperature: 0.4, ...(json ? { responseMimeType: 'application/json' } : {}) } }) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${model} HTTP ${r.status} ${text.slice(0, 160)}`);
    const out = JSON.parse(text).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!out) throw new Error('沒有回覆內容');
    chat.lastGem = model;
    return out;
  } finally { clearTimeout(t); }
}
/** Gemini＋Google 搜尋（讓 AI 自己查證新聞內容再摘要）；只回傳文字 */
async function grounded(prompt, sys, timeout = 120000) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error('沒有 GEMINI_API_KEY');
  let model = await geminiModel(key);
  for (let k = 0; k < 3; k++) {
    await gemThrottle();
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', signal: ctl.signal,
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.3 } }) });
      const text = await r.text();
      if (!r.ok) {
        if ((r.status === 404 || r.status === 429 || (/^(500|503)$/.test(String(r.status)) && k === 1)) && nextGemini()) { model = GEM_MODEL; continue; }
        if (/^(429|500|503)$/.test(String(r.status)) && k < 2) { await new Promise(z => setTimeout(z, 8000 * (k + 1))); continue; }
        throw new Error(`${model} HTTP ${r.status} ${text.slice(0, 160)}`);
      }
      return JSON.parse(text).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    } finally { clearTimeout(t); }
  }
  throw new Error('Gemini 忙碌');
}
/** 依序嘗試：Anthropic → Gemini（有哪個金鑰就用哪個） */
async function chat(messages, { json = false, timeout = 90000 } = {}) {
  const errs = [];
  if (process.env.ANTHROPIC_API_KEY) { try { const r = await claude(messages, timeout); chat.last = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5'; return r; } catch (e) { errs.push('anthropic: ' + e.message); } }
  if (process.env.GEMINI_API_KEY) {
    for (let k = 0; k < 8; k++) {
      try { const r = await gemini(messages, json, timeout); chat.last = chat.lastGem; return r; }
      catch (e) {
        if (/HTTP (404|429)/.test(e.message) && nextGemini()) continue;                // 模型停用或額度用完：換下一個                      // 額度用完：換下一個模型（額度分開）
        if (/HTTP (500|503)/.test(e.message) && k === 1 && nextGemini()) continue;   // 第二次還忙就換下一個模型
        if (/HTTP (429|500|503)/.test(e.message) && k < 2) { await new Promise(r => setTimeout(r, 15000 * (k + 1))); continue; }
        errs.push('gemini: ' + e.message); break;
      }
    }
  }
  throw new Error(errs.join(' ｜ ') || '沒有可用的 AI（請設定 GEMINI_API_KEY 或 ANTHROPIC_API_KEY）');
}

const SIG = { BUY: '買進', SELL: '賣出', HOLD: '觀望' };
async function commentary(snap) {
  const env = snap.env.map(e => `${e.label} ${e.value}${e.unit || ''}${e.changePct != null ? ` (${e.changePct > 0 ? '+' : ''}${e.changePct}%)` : ''} ${e.meaning}`).join('；');
  const health = (snap.health?.signals || []).map(x => x.text).join('；') || '無';
  const facts = snap.ranking.map(k => {
    const it = snap.items[k], o = it.outlook, f = it.fin;
    return `${k} ${it.name}｜${it.price}（${it.changePct}%）｜${SIG[it.signal.sig]} ${it.signal.score} 分｜${o?.stateZh || ''}｜${(o?.comments || []).slice(0, 3).map(c => c.text).join('，')}｜財報：${f?.grade || '—'}${f?.checks?.[0] ? '，' + f.checks[0].text : ''}`;
  }).join('\n');
  const sys = '你是專業的台股與美股分析師，用繁體中文、口語但精準地寫給個人投資人。只根據提供的數據，不要編造新聞或數字，不要加免責聲明。';
  const user = `今日判斷：${snap.verdict.headline}（${snap.verdict.detail}）
市場環境：${env}
市場健康度警訊：${health}
觀察清單：
${facts}

請輸出 JSON：{"verdict": "3 句話以內的今日市場解讀：重點、原因、該怎麼做（不超過 120 字）", "stocks": {"代號": "一句話點評，30 字以內，說出最關鍵的一件事"}}，stocks 要涵蓋上面每一檔。`;
  const txt = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true });
  const j = JSON.parse((txt.match(/\{[\s\S]*\}/) || [txt])[0]);
  return { model: chat.last || MODEL, at: new Date().toISOString(), verdict: String(j.verdict || '').trim(), stocks: Object.fromEntries(Object.entries(j.stocks || {}).map(([k, v]) => [String(k).toUpperCase(), String(v).trim()])) };
}

module.exports = { chat, grounded, commentary, MODEL };
