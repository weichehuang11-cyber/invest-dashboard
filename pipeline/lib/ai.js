'use strict';
/**
 * 雲端 AI 解讀（GitHub Models，用 Actions 內建的 GITHUB_TOKEN，免費額度，不需另外申請）
 * 收盤後完整更新時產生一次：今日市場解讀＋觀察清單逐檔一句話點評。電腦沒開也看得到。
 * 只用公開的市場資料；你的持股與論點不會送出。
 */
const MODEL = process.env.AI_MODEL || 'openai/gpt-4.1-mini';

async function chat(messages, { json = false, timeout = 60000 } = {}) {
  const token = process.env.GH_MODELS_TOKEN;
  if (!token) throw new Error('沒有 GH_MODELS_TOKEN');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch('https://models.github.ai/inference/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.4, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
  } finally { clearTimeout(t); }
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
  const j = JSON.parse(txt);
  return { model: MODEL, at: new Date().toISOString(), verdict: String(j.verdict || '').trim(), stocks: Object.fromEntries(Object.entries(j.stocks || {}).map(([k, v]) => [String(k).toUpperCase(), String(v).trim()])) };
}

module.exports = { chat, commentary, MODEL };
