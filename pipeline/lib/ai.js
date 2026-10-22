'use strict';
/**
 * 雲端 AI 解讀（GitHub Models，用 Actions 內建的 GITHUB_TOKEN，免費額度，不需另外申請）
 * 收盤後完整更新時產生一次：今日市場解讀＋觀察清單逐檔一句話點評。電腦沒開也看得到。
 * 只用公開的市場資料；你的持股與論點不會送出。
 */
const MODEL = process.env.AI_MODEL || 'openai/gpt-4.1-mini';

async function post(url, model, messages, json, token, timeout) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctl.signal, redirect: 'manual',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ model, messages, temperature: 0.4, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 100)}`);
    let j; try { j = JSON.parse(text); } catch (_) { throw new Error(`回應不是 JSON（${r.status}）：${text.slice(0, 40)}`); }
    const c = j.choices?.[0]?.message?.content;
    if (!c) throw new Error('沒有回覆內容');
    return c;
  } finally { clearTimeout(t); }
}
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
let GEM_MODEL = null;
/** 找出這把金鑰能用的最新 Flash 模型（Google 會淘汰舊模型名稱，所以每次執行自動挑） */
async function geminiModel(key) {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  if (GEM_MODEL) return GEM_MODEL;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    const j = await r.json();
    const names = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''))
      .filter(n => /^gemini-[\d.]+-flash(-latest)?$|^gemini-flash-latest$/.test(n) && !/lite|image|tts|live|exp|preview|thinking/.test(n));
    const ver = n => parseFloat((n.match(/gemini-([\d.]+)/) || [])[1] || '0');
    names.sort((a, b) => ver(b) - ver(a) || (a.includes('latest') ? 1 : -1));
    GEM_MODEL = names[0] || 'gemini-flash-latest';
  } catch (_) { GEM_MODEL = 'gemini-flash-latest'; }
  return GEM_MODEL;
}
/** Google Gemini（免費額度；到 aistudio.google.com 申請 API key，設成 GEMINI_API_KEY） */
async function gemini(messages, json, timeout) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const key = process.env.GEMINI_API_KEY;
  const model = await geminiModel(key);
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', signal: ctl.signal,
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { temperature: 0.4, ...(json ? { responseMimeType: 'application/json' } : {}) } }) });
    const text = await r.text();
    if (!r.ok) { if (r.status === 404) GEM_MODEL = null; throw new Error(`${model} HTTP ${r.status} ${text.slice(0, 160)}`); }
    const out = JSON.parse(text).candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!out) throw new Error('沒有回覆內容');
    chat.lastGem = model;
    return out;
  } finally { clearTimeout(t); }
}
/** 依序嘗試：Anthropic → Gemini → GitHub Models（有哪個金鑰就用哪個） */
async function chat(messages, { json = false, timeout = 90000 } = {}) {
  const errs = [];
  if (process.env.ANTHROPIC_API_KEY) { try { const r = await claude(messages, timeout); chat.last = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5'; return r; } catch (e) { errs.push('anthropic: ' + e.message); } }
  if (process.env.GEMINI_API_KEY) {
    for (let k = 0; k < 3; k++) {
      try { const r = await gemini(messages, json, timeout); chat.last = chat.lastGem; return r; }
      catch (e) { if (/HTTP (429|500|503)/.test(e.message) && k < 2) { await new Promise(r => setTimeout(r, 8000 * (k + 1))); continue; } errs.push('gemini: ' + e.message); break; }
    }
  }
  const token = process.env.GH_MODELS_TOKEN;
  if (token && !process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) for (const [url, model] of [['https://models.github.ai/inference/chat/completions', MODEL]]) { try { const r = await post(url, model, messages, json, token, timeout); chat.last = model; return r; } catch (e) { errs.push(`${new URL(url).host}: ${e.message}`); } }
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

module.exports = { chat, commentary, MODEL };
