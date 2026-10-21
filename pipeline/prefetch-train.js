'use strict';
/**
 * 重新訓練模型前，先用 yahoo-finance2（會處理 Yahoo 的 cookie／crumb）下載訓練用日 K，
 * 寫成 ml/train.py 的快取格式（ml/data_cache/<代號>.csv，Close 為還原收盤價），
 * train.py 讀到 1 天內的快取就不會自己連 Yahoo（GitHub 主機直接連常被擋）。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'ml', 'train.py'), 'utf8');
const list = name => { const m = src.match(new RegExp(name + '\\s*=\\s*\\[([\\s\\S]*?)\\]')); return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : []; };
const US = list('US_SYMBOLS'), TW = list('TW_SYMBOLS').map(s => s + '.TW');
const dir = path.join(ROOT, 'ml', 'data_cache'); fs.mkdirSync(dir, { recursive: true });

(async () => {
  const YF = require('yahoo-finance2').default;
  const yf = typeof YF === 'function' ? new YF({ suppressNotices: ['yahooSurvey', 'ripHistorical'] }) : YF;
  let ok = 0, fail = [];
  for (const s of [...US, ...TW]) {
    try {
      const r = await yf.chart(s, { period1: new Date(Date.now() - 800 * 86400000), interval: '1d' }, { validateResult: false });
      const q = (r.quotes || []).filter(x => x.close != null);
      if (q.length < 60) throw new Error('資料不足');
      const rows = q.map(x => [new Date(x.date).toISOString().slice(0, 10), x.open, x.high, x.low, x.adjclose ?? x.close, x.volume ?? 0].join(','));
      fs.writeFileSync(path.join(dir, s.replace('/', '_') + '.csv'), 'Date,Open,High,Low,Close,Volume\n' + rows.join('\n') + '\n');
      ok++;
    } catch (e) { fail.push(s); }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`訓練資料：成功 ${ok} 檔，失敗 ${fail.length} 檔 ${fail.join(' ')}`);
  if (ok < 20) process.exit(1);
})();
