'use strict';
/** 共用 HTTP：逾時、重試、統一 User-Agent。Node 20+ 內建 fetch。 */
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, { timeout = 15000, retries = 2, headers = {}, as = 'json' } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeout);
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*', ...headers }, signal: ctl.signal });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.fatal = true; throw e; }
      return as === 'text' ? await res.text() : await res.json();
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      await sleep(1000 * (i + 1) * (i + 1));
    }
  }
  throw lastErr;
}

/** 依序執行（避免同時大量請求被封鎖） */
async function mapSeries(items, fn, gapMs = 250) {
  const out = [];
  for (const it of items) {
    try { out.push(await fn(it)); } catch (e) { out.push(null); }
    if (gapMs) await sleep(gapMs);
  }
  return out;
}

module.exports = { get, sleep, mapSeries };
