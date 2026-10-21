'use strict';
/**
 * 財報重點：近 8 季損益、資產負債、現金流 → 關鍵比率與白話檢查清單
 *   美股：yahoo-finance2 fundamentalsTimeSeries（季報）＋ quoteSummary（EPS 驚喜、分析師預估修正、比率）
 *   台股：FinMind 綜合損益表、資產負債表、現金流量表（有權杖用權杖，沒有就用免權杖額度）
 * 欄位依名稱比對；抓不到的欄位就留空，不影響其他項目。
 */
const { get } = require('./http');
const FM = 'https://api.finmindtrade.com/api/v4/data';
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const r2 = (v, d = 2) => (isNum(v) ? +v.toFixed(d) : null);
const sum = a => (a.length && a.every(isNum) ? a.reduce((s, v) => s + v, 0) : null);
const since = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

// ── 美股 ────────────────────────────────────────────────────
async function us(yf, sym) {
  const ts = await yf.fundamentalsTimeSeries(sym, { period1: since(1100), type: 'quarterly', module: 'all' }, { validateResult: false });
  const pick = (o, ...ks) => { for (const k of ks) if (isNum(o[k])) return o[k]; return null; };
  const quarters = (ts || []).map(o => ({
    date: new Date(o.date).toISOString().slice(0, 10),
    rev: pick(o, 'totalRevenue', 'operatingRevenue'), gp: pick(o, 'grossProfit'), op: pick(o, 'operatingIncome', 'totalOperatingIncomeAsReported'),
    ni: pick(o, 'netIncomeCommonStockholders', 'netIncome'), eps: pick(o, 'dilutedEPS', 'basicEPS'),
    ocf: pick(o, 'operatingCashFlow', 'cashFlowFromContinuingOperatingActivities'), capex: pick(o, 'capitalExpenditure'), fcf: pick(o, 'freeCashFlow'),
    debt: pick(o, 'totalDebt'), equity: pick(o, 'stockholdersEquity', 'commonStockEquity'), cash: pick(o, 'cashAndCashEquivalents', 'cashCashEquivalentsAndShortTermInvestments'),
    ca: pick(o, 'currentAssets'), cl: pick(o, 'currentLiabilities'), assets: pick(o, 'totalAssets'),
  })).filter(q => isNum(q.rev) || isNum(q.eps)).sort((a, b) => a.date.localeCompare(b.date));
  for (const q of quarters) if (!isNum(q.fcf) && isNum(q.ocf) && isNum(q.capex)) q.fcf = q.ocf + q.capex;
  let extra = {};
  try {
    const s = await yf.quoteSummary(sym, { modules: ['earningsHistory', 'earningsTrend', 'financialData', 'defaultKeyStatistics'] }, { validateResult: false });
    const eh = (s.earningsHistory?.history || []).map(h => ({ quarter: h.quarter ? new Date(h.quarter).toISOString().slice(0, 10) : null, actual: h.epsActual ?? null, estimate: h.epsEstimate ?? null, surprisePct: h.surprisePercent != null ? h.surprisePercent * 100 : null })).filter(h => isNum(h.actual));
    const tr = (s.earningsTrend?.trend || []);
    const y0 = tr.find(t => t.period === '0y'), q0 = tr.find(t => t.period === '0q'), y1 = tr.find(t => t.period === '+1y');
    const rev = t => { const e = t?.epsTrend; if (!e || !isNum(e.current)) return null; const p = e['30daysAgo'], p90 = e['90daysAgo']; return { current: e.current, d30: isNum(p) && p ? (e.current / p - 1) * 100 : null, d90: isNum(p90) && p90 ? (e.current / p90 - 1) * 100 : null, up30: t.epsRevisions?.upLast30days ?? null, down30: t.epsRevisions?.downLast30days ?? null, growth: t.earningsEstimate?.growth != null ? t.earningsEstimate.growth * 100 : null }; };
    const fd = s.financialData || {}, ks = s.defaultKeyStatistics || {};
    extra = {
      surprises: eh.slice(-4), revisions: { q0: rev(q0), y0: rev(y0), y1: rev(y1) },
      ratios: { roe: fd.returnOnEquity != null ? fd.returnOnEquity * 100 : null, debtToEquity: fd.debtToEquity ?? null, currentRatio: fd.currentRatio ?? null,
        grossMargin: fd.grossMargins != null ? fd.grossMargins * 100 : null, opMargin: fd.operatingMargins != null ? fd.operatingMargins * 100 : null,
        peg: ks.pegRatio ?? null, pb: ks.priceToBook ?? null, evEbitda: ks.enterpriseToEbitda ?? null },
    };
  } catch (_) { /* 只用季報 */ }
  return { quarters, ...extra, source: 'Yahoo' };
}

// ── 台股（FinMind）──────────────────────────────────────────
async function fmData(ds, id, token) {
  const url = `${FM}?dataset=${ds}&data_id=${encodeURIComponent(id)}&start_date=${since(1200)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  const j = await get(url, { timeout: 25000 });
  if (j?.status !== 200) throw new Error('FinMind ' + (j?.msg || j?.status));
  return j.data || [];
}
/** 依 type（英文）或 origin_name（中文）找值；排除百分比列（_per） */
function fmPivot(rows, spec) {
  const by = {};
  for (const r of rows) {
    const t = String(r.type || ''), o = String(r.origin_name || '').replace(/\s/g, '');
    if (/_per$/.test(t)) continue;
    const d = String(r.date).slice(0, 10);
    for (const [k, [types, re]] of Object.entries(spec)) {
      if (types.includes(t) || (re && re.test(o))) { by[d] = by[d] || { date: d }; if (by[d][k] == null) by[d][k] = +r.value; }
    }
  }
  return by;
}
async function tw(id, token) {
  const [inc, bal, cf] = await Promise.all([
    fmData('TaiwanStockFinancialStatements', id, token),
    fmData('TaiwanStockBalanceSheet', id, token).catch(() => []),
    fmData('TaiwanStockCashFlowsStatement', id, token).catch(() => []),
  ]);
  const I = fmPivot(inc, {
    rev: [['Revenue', 'OperatingRevenue'], /^營業收入合計$|^營業收入$|^收益合計$/],
    gp: [['GrossProfit'], /^營業毛利（毛損）$|^營業毛利/],
    op: [['OperatingIncome'], /^營業利益（損失）$|^營業利益/],
    ni: [['EquityAttributableToOwnersOfParent', 'IncomeAfterTaxes', 'NetIncome'], /^歸屬於母公司業主之淨利|^本期淨利（淨損）$|^本期淨利/],
    eps: [['EPS'], /^基本每股盈餘/],
  });
  const B = fmPivot(bal, {
    assets: [['TotalAssets'], /^資產總額$|^資產總計$/], liab: [['Liabilities', 'TotalLiabilities'], /^負債總額$|^負債總計$/],
    equity: [['Equity', 'TotalEquity'], /^權益總額$|^權益總計$/], ca: [['CurrentAssets'], /^流動資產合計$/], cl: [['CurrentLiabilities'], /^流動負債合計$/],
    cash: [['CashAndCashEquivalents'], /^現金及約當現金$/],
  });
  const C = fmPivot(cf, {
    ocf: [['CashFlowsFromOperatingActivities', 'NetCashInflowFromOperatingActivities'], /^營業活動之淨現金流入（流出）$|^營業活動之淨現金流入/],
    capex: [['PropertyAndPlantAndEquipment', 'AcquisitionOfPropertyPlantAndEquipment'], /^取得不動產、廠房及設備$/],
  });
  // 現金流量表是年初至今累計 → 換算成單季
  const cfd = Object.keys(C).sort();
  const cfq = {};
  for (const d of cfd) {
    const prev = cfd.filter(x => x < d && x.slice(0, 4) === d.slice(0, 4)).pop();
    const m = +d.slice(5, 7);
    cfq[d] = { ocf: m > 3 && prev ? sub(C[d].ocf, C[prev].ocf) : C[d].ocf, capex: m > 3 && prev ? sub(C[d].capex, C[prev].capex) : C[d].capex };
  }
  const dates = [...new Set([...Object.keys(I)])].sort();
  const quarters = dates.map(d => {
    const q = { date: d, ...I[d], ...(B[d] || {}), ...(cfq[d] || {}) };
    if (isNum(q.capex) && q.capex > 0) q.capex = -q.capex;
    q.fcf = isNum(q.ocf) && isNum(q.capex) ? q.ocf + q.capex : null;
    q.debt = isNum(q.liab) ? q.liab : null;   // 台股以總負債衡量
    return q;
  }).filter(q => isNum(q.rev) || isNum(q.eps));
  return { quarters, source: 'FinMind' };
}
const sub = (a, b) => (isNum(a) && isNum(b) ? a - b : null);

// ── 分析 ───────────────────────────────────────────────────
function analyze(raw, { market, sector } = {}) {
  if (!raw?.quarters?.length) return null;
  const Q = raw.quarters.slice(-12);
  const yoyOf = (i, k) => { const a = Q[i]?.[k], b = Q[i - 4]?.[k]; return isNum(a) && isNum(b) && b !== 0 ? (a / Math.abs(b) - 1) * 100 * (b < 0 && a > b ? 1 : 1) : null; };
  const rows = Q.map((q, i) => ({
    date: q.date, rev: q.rev, eps: r2(q.eps, 2), ni: q.ni,
    gm: isNum(q.gp) && q.rev ? r2(q.gp / q.rev * 100, 1) : null, om: isNum(q.op) && q.rev ? r2(q.op / q.rev * 100, 1) : null, nm: isNum(q.ni) && q.rev ? r2(q.ni / q.rev * 100, 1) : null,
    revYoY: (v => (isNum(v) && Math.abs(v) < 300 ? r2(v, 1) : null))(yoyOf(i, 'rev')), epsYoY: isNum(q.eps) && isNum(Q[i - 4]?.eps) && Q[i - 4].eps > 0 ? r2((q.eps / Q[i - 4].eps - 1) * 100, 1) : null,
    fcf: q.fcf,
  }));
  const L = Q.length - 1, q = Q[L], last = rows[L], ly = rows[L - 4];
  const isFin = !rows.some(r => isNum(r.gm)) && market === 'tw';   // 金融股沒有毛利，營收定義也不同
  const t4 = k => sum(Q.slice(-4).map(x => x[k]));
  const ttm = { rev: t4('rev'), ni: t4('ni'), eps: t4('eps'), ocf: t4('ocf'), fcf: t4('fcf') };
  const ratios = {
    roe: isNum(ttm.ni) && isNum(q.equity) && q.equity > 0 ? ttm.ni / q.equity * 100 : raw.ratios?.roe ?? null,
    debtToEquity: market === 'us' ? (raw.ratios?.debtToEquity ?? (isNum(q.debt) && q.equity > 0 ? q.debt / q.equity * 100 : null)) : (isNum(q.liab) && q.equity > 0 ? q.liab / q.equity * 100 : null),
    currentRatio: isNum(q.ca) && isNum(q.cl) && q.cl > 0 ? q.ca / q.cl : raw.ratios?.currentRatio ?? null,
    fcfMargin: isNum(ttm.fcf) && ttm.rev ? ttm.fcf / ttm.rev * 100 : null,
    cashToDebt: isNum(q.cash) && isNum(q.debt) && q.debt > 0 ? q.cash / q.debt : null,
    peg: raw.ratios?.peg ?? null, pb: raw.ratios?.pb ?? null, evEbitda: raw.ratios?.evEbitda ?? null,
  };
  // 檢查清單
  const C = [], pos = t => C.push({ tone: 'pos', text: t }), neg = t => C.push({ tone: 'neg', text: t }), neu = t => C.push({ tone: 'neu', text: t });
  if (isNum(last.revYoY) && !isFin && Math.abs(last.revYoY) < 300) {
    let streak = 0; for (let i = L; i >= 4 && isNum(rows[i].revYoY) && rows[i].revYoY > 0; i--) streak++;
    if (last.revYoY >= 15) pos(`最新一季營收年增 ${last.revYoY.toFixed(0)}%${streak >= 3 ? `，連續 ${streak} 季成長` : ''}`);
    else if (last.revYoY < 0) neg(`最新一季營收年減 ${Math.abs(last.revYoY).toFixed(0)}%`);
    else neu(`最新一季營收年增 ${last.revYoY.toFixed(0)}%${streak >= 3 ? `，連續 ${streak} 季成長` : ''}`);
  }
  if (isNum(last.gm) && isNum(ly?.gm)) {
    const d = last.gm - ly.gm;
    let up = 0; for (let i = L; i >= 1 && isNum(rows[i].gm) && isNum(rows[i - 1].gm) && rows[i].gm > rows[i - 1].gm; i--) up++;
    if (d >= 1) pos(`毛利率 ${last.gm.toFixed(1)}%，比去年同期高 ${d.toFixed(1)} 個百分點${up >= 3 ? `（連 ${up} 季上升）` : ''}`);
    else if (d <= -1) neg(`毛利率 ${last.gm.toFixed(1)}%，比去年同期低 ${Math.abs(d).toFixed(1)} 個百分點`);
  }
  if (isNum(last.om) && isNum(ly?.om)) { const d = last.om - ly.om; if (d >= 1.5) pos(`營業利益率提升到 ${last.om.toFixed(1)}%（去年同期 ${ly.om.toFixed(1)}%），本業獲利能力變好`); else if (d <= -1.5) neg(`營業利益率降到 ${last.om.toFixed(1)}%（去年同期 ${ly.om.toFixed(1)}%）`); }
  if (isNum(last.epsYoY) && last.epsYoY < 300) { if (last.epsYoY >= 20) pos(`EPS 年增 ${last.epsYoY.toFixed(0)}%`); else if (last.epsYoY <= -10) neg(`EPS 年減 ${Math.abs(last.epsYoY).toFixed(0)}%`); }
  else if (isNum(q.eps) && q.eps < 0) neg(`最新一季虧損（EPS ${q.eps.toFixed(2)}）`);
  if (!isFin) {
    if (isNum(ttm.fcf)) { if (ttm.fcf > 0 && isNum(ratios.fcfMargin) && ratios.fcfMargin >= 10) pos(`近 4 季自由現金流為正，占營收 ${ratios.fcfMargin.toFixed(0)}%`); else if (ttm.fcf < 0) neg('近 4 季自由現金流為負（營運現金不足以支應資本支出）'); }
    if (isNum(ttm.ni) && isNum(ttm.ocf) && ttm.ni > 0 && ttm.ocf < ttm.ni * 0.7) neg('獲利品質偏弱：近 4 季營業現金流明顯低於淨利');
    if (isNum(ratios.currentRatio) && ratios.currentRatio < 1) neg(`流動比率 ${ratios.currentRatio.toFixed(2)}，短期償債能力偏弱`);
    if (isNum(ratios.debtToEquity) && ratios.debtToEquity > (market === 'tw' ? 200 : 200)) neg(`負債是股東權益的 ${(ratios.debtToEquity / 100).toFixed(1)} 倍，財務槓桿偏高`);
  }
  if (isNum(ratios.roe)) { if (ratios.roe >= 15) pos(`股東權益報酬率 ${ratios.roe.toFixed(0)}%（近 4 季）`); else if (ratios.roe < 5) neg(`股東權益報酬率僅 ${ratios.roe.toFixed(1)}%`); }
  const sp = raw.surprises || [];
  if (sp.length >= 3) {
    const beat = sp.filter(s => s.surprisePct > 1).length, miss = sp.filter(s => s.surprisePct < -1).length;
    if (beat >= 3) pos(`近 ${sp.length} 季 EPS 有 ${beat} 季優於分析師預期`); else if (miss >= 2) neg(`近 ${sp.length} 季 EPS 有 ${miss} 季低於分析師預期`);
  }
  const rv = raw.revisions?.y0;
  if (rv && isNum(rv.d30)) { if (rv.d30 >= 2) pos(`分析師近 30 日上修今年 EPS 預估 ${rv.d30.toFixed(1)}%`); else if (rv.d30 <= -2) neg(`分析師近 30 日下修今年 EPS 預估 ${Math.abs(rv.d30).toFixed(1)}%`); }
  const posN = C.filter(c => c.tone === 'pos').length, negN = C.filter(c => c.tone === 'neg').length, score = posN - negN;
  const grade = score >= 3 ? '體質強' : score >= 1 ? '體質良好' : score <= -2 ? '體質轉弱' : '普通';
  return {
    source: raw.source, asOf: q.date, isFinancial: isFin, grade, score, posN, negN, checks: C,
    quarters: rows.slice(-8), ttm: Object.fromEntries(Object.entries(ttm).map(([k, v]) => [k, r2(v, k === 'eps' ? 2 : 0)])),
    ratios: Object.fromEntries(Object.entries(ratios).map(([k, v]) => [k, r2(v, 2)])),
    surprises: sp.map(s => ({ ...s, surprisePct: r2(s.surprisePct, 1) })), revisions: raw.revisions || null,
  };
}

module.exports = { us, tw, analyze, fmPivot };
