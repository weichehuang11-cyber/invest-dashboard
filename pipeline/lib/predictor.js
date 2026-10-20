'use strict';
/**
 * predictor.js — Node.js ONNX 即時推理模組（雙市場版）
 * ======================================================
 * 支援美股（14 特徵）與台股（23 特徵 = 14 TA + 9 籌碼）
 * 使用與 ml/train.py 完全相同的特徵計算邏輯
 * 支援 AMD Ryzen AI（DirectML）/ CPU fallback
 *
 * 依賴：
 *   npm install onnxruntime-node
 *
 * 台股符號識別：
 *   symbol.endsWith('.TW') 或 /^\d{4,6}$/.test(symbol)
 *   例：'2330'、'2330.TW' → 台股模型（23 維）
 *       'AAPL'、'BTC-USD'  → 美股模型（14 維）
 *
 * 台股籌碼特徵（14–22）：
 *   推理時若無籌碼資料（Node.js 無法即時呼叫 FinMind），
 *   此 9 個特徵預設填 0（降級為純 TA 模式）。
 *   如需真實籌碼特徵，請在台股訓練時確保 FinMind 資料完整，
 *   或由外部資料源傳入 chipFeatures 陣列。
 *
 * 特徵順序（美股 14 維，與 ml/features.py FEATURE_NAMES 完全一致）：
 *   0  ret1   1  ret5   2  ret10  3  ret20
 *   4  rsi14  5  macd_pct  6  macdSig_pct  7  macdHist
 *   8  bb_pct  9  bb_width  10 ema_ratio
 *   11 vol_ratio  12 hl_pct  13 body_pct
 *
 * 台股擴充（23 維，在 14 維基礎上額外追加）：
 *   14 foreign_net_ratio  15 trust_net_ratio  16 dealer_net_ratio
 *   17 inst_net_ratio     18 foreign_net_ma5
 *   19 margin_balance_chg 20 short_balance_chg
 *   21 margin_short_ratio 22 near_limit
 */

const path = require('path');
const fs   = require('fs');

// ── 模型路徑設定 ────────────────────────────────────────────────────
const ML_DIR      = path.join(__dirname, '..', '..', 'ml', 'models');
const MODEL_US    = path.join(ML_DIR, 'signal_model.onnx');
const SCALER_US   = path.join(ML_DIR, 'scaler.json');
const MODEL_TW    = path.join(ML_DIR, 'signal_model_tw.onnx');
const SCALER_TW   = path.join(ML_DIR, 'scaler_tw.json');

const N_FEATURES_US = 14;
const N_FEATURES_TW = 23;
const MIN_BARS      = 50;

const LABEL_MAP = { 0: 'SELL', 1: 'HOLD', 2: 'BUY' };

// ── 模組狀態（雙 session）───────────────────────────────────────────
let _sessionUS  = null;   // 美股 ONNX session（14 維）
let _scalerUS   = null;   // { mean, std }
let _readyUS    = false;
let _versionUS  = '未載入';

let _sessionTW  = null;   // 台股 ONNX session（23 維）
let _scalerTW   = null;
let _readyTW    = false;
let _versionTW  = '未載入';

let _device     = 'none';
let _loadErr    = null;

// ── 台股符號識別 ─────────────────────────────────────────────────────

function isTaiwanSymbol(symbol) {
  if (!symbol) return false;
  const s = String(symbol).toUpperCase().replace(/^TW_/, '');
  if (s.endsWith('.TW') || s.endsWith('.TWO')) return true;
  // 台灣證券代號：4–6 位數字（含台股 ETF 如 00878）
  return /^\d{4,6}$/.test(s);
}

// ── scaler 載入 ──────────────────────────────────────────────────────

function _loadScaler(scalerPath) {
  if (!fs.existsSync(scalerPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(scalerPath, 'utf8'));
    return {
      mean   : new Float32Array(meta.scaler_mean),
      std    : new Float32Array(meta.scaler_std),
      version: meta.version || '1.0.0',
      metrics: meta.metrics || null,          // 依時間切分的驗證指標（新版訓練才有）
      trainedAt: meta.trained_at || null,
    };
  } catch (e) {
    console.warn('[Predictor] scaler 讀取失敗：', scalerPath, e.message);
    return null;
  }
}

// ── 初始化（非同步，伺服器啟動時呼叫）─────────────────────────────

async function init() {
  // 載入 onnxruntime-node
  let ort;
  try {
    ort = require('onnxruntime-node');
  } catch (e) {
    _loadErr = 'onnxruntime-node 未安裝，請執行：npm install onnxruntime-node';
    console.warn('[Predictor]', _loadErr);
    return false;
  }

  // 執行提供者：DirectML（AMD，僅 Windows）優先，失敗則 CPU，再失敗用預設
  // onnxruntime-node 的名稱是 'dml' / 'cpu'（不是 Python 版的 'CPUExecutionProvider'）
  const providerPref = process.env.NPU_PROVIDER || 'cpu';   // 雲端排程只有 CPU

  const _createSession = async (modelPath) => {
    // 1. 若明確指定 CPU，直接用 CPU
    if (providerPref === 'cpu') {
      return ort.InferenceSession.create(modelPath, {
        executionProviders    : ['cpu'],
        graphOptimizationLevel: 'all',
        enableCpuMemArena     : true,
      });
    }
    // 2. 嘗試 DirectML
    try {
      return await ort.InferenceSession.create(modelPath, {
        executionProviders    : ['dml'],
        graphOptimizationLevel: 'all',
      });
    } catch (_) {}
    // 3. 嘗試明確 CPU
    try {
      return await ort.InferenceSession.create(modelPath, {
        executionProviders    : ['cpu'],
        graphOptimizationLevel: 'all',
        enableCpuMemArena     : true,
      });
    } catch (_) {}
    // 4. 最後用 onnxruntime-node 預設（不指定 provider）
    return ort.InferenceSession.create(modelPath);
  };

  const _detectDevice = (sess) => {
    const usedEPs = sess.handler?._executionProviders || [];
    return usedEPs.some(p => /dml/i.test(String(p)))
      ? 'AMD DirectML (Ryzen AI)' : 'CPU';
  };

  let anyLoaded = false;

  // ── 美股模型 ───────────────────────────────────────────────────────
  if (fs.existsSync(MODEL_US)) {
    const sc = _loadScaler(SCALER_US);
    if (sc) {
      try {
        _sessionUS = await _createSession(MODEL_US);
        _scalerUS  = sc;
        _versionUS = sc.version;
        _readyUS   = true;
        _device    = _detectDevice(_sessionUS);
        anyLoaded  = true;
        console.log(`[Predictor] ✓ 美股模型  裝置=${_device}  版本=${_versionUS}`);
      } catch (e) {
        console.warn('[Predictor] 美股模型載入失敗：', e.message);
      }
    }
  } else {
    console.warn(`[Predictor] 美股模型不存在：${MODEL_US}（執行 python ml/train.py 訓練）`);
  }

  // ── 台股模型 ───────────────────────────────────────────────────────
  if (fs.existsSync(MODEL_TW)) {
    const sc = _loadScaler(SCALER_TW);
    if (sc) {
      try {
        _sessionTW = await _createSession(MODEL_TW);
        _scalerTW  = sc;
        _versionTW = sc.version;
        _readyTW   = true;
        if (!anyLoaded) _device = _detectDevice(_sessionTW);
        anyLoaded  = true;
        console.log(`[Predictor] ✓ 台股模型  裝置=${_device}  版本=${_versionTW}`);
      } catch (e) {
        console.warn('[Predictor] 台股模型載入失敗：', e.message);
      }
    }
  } else {
    console.warn(
      `[Predictor] 台股模型不存在：${MODEL_TW}\n` +
      `  （執行 python ml/train.py --market tw 訓練）`
    );
  }

  if (!anyLoaded) {
    _loadErr = '美股與台股模型均未就緒，請先執行訓練腳本';
    console.warn('[Predictor]', _loadErr);
  }
  return anyLoaded;
}

// ══════════════════════════════════════════════════════════════════════
// TA 特徵計算（與 ml/features.py 完全一致）
// ══════════════════════════════════════════════════════════════════════

/** EMA */
function _ema(arr, span) {
  const k = 2 / (span + 1);
  const out = new Array(arr.length);
  out[0] = arr[0];
  for (let i = 1; i < arr.length; i++) {
    out[i] = arr[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** RSI(period)：與 pandas ewm(com=period-1, adjust=True) 一致，回傳最後一個值（0–100） */
function _rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const alpha = 1 / period;
  let gNum = 0, lNum = 0, den = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gNum = gNum * (1 - alpha) + Math.max(0, d);
    lNum = lNum * (1 - alpha) + Math.max(0, -d);
    den  = den  * (1 - alpha) + 1;
  }
  const avgGain = gNum / den, avgLoss = lNum / den;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * 計算 14 個基礎 TA 特徵（美股模型使用）
 * @param {Object} bars - { closes, opens, highs, lows, volumes }
 *   每個欄位都是 number[]，最新一筆在陣列末尾
 * @returns {Float32Array|null}
 */
function computeFeatures({ closes, opens, highs, lows, volumes }) {
  const n = closes.length;
  if (n < MIN_BARS) return null;

  const c = closes, o = opens, h = highs, l = lows;
  const v = (volumes && volumes.length === n) ? volumes : new Array(n).fill(1);

  // 報酬率
  const safe = (i) => (i >= 0 ? c[i] : c[0]);
  const ret  = (lag) => (c[n-1] - safe(n-1-lag)) / (safe(n-1-lag) || 1);
  const ret1  = ret(1), ret5 = ret(5), ret10 = ret(10), ret20 = ret(20);

  // RSI
  const rsi14 = _rsi(c) / 100.0;

  // MACD(12,26,9)
  const emaFast = _ema(c, 12);
  const emaSlow = _ema(c, 26);
  const macdArr = emaFast.map((mv, i) => mv - emaSlow[i]);
  const sigArr  = _ema(macdArr, 9);
  const lastC   = c[n-1] || 1;
  const macd_pct    = macdArr[n-1] / lastC;
  const macdSig_pct = sigArr[n-1]  / lastC;
  const macdHist    = (macdArr[n-1] - sigArr[n-1]) / lastC;

  // Bollinger Bands(20,2)：與 pandas rolling(20).std() 一致（樣本標準差 ddof=1）
  let sum = 0;
  for (let i = n - 20; i < n; i++) sum += c[i];
  const mid = sum / 20;
  let ss = 0;
  for (let i = n - 20; i < n; i++) ss += (c[i] - mid) ** 2;
  const std2 = Math.sqrt(ss / 19);
  const upper = mid + 2 * std2;
  const lower = mid - 2 * std2;
  const bb_pct   = (upper - lower) > 0 ? (c[n-1] - lower) / (upper - lower) : 0.5;
  const bb_width = mid > 0 ? (upper - lower) / mid : 0;

  // EMA 趨勢：收盤 / EMA20 − 1（與訓練一致；舊版用 EMA9/EMA21）
  const ema20 = _ema(c, 20);
  const ema_ratio = ema20[n-1] > 0 ? c[n-1] / ema20[n-1] - 1 : 0;

  // 相對成交量：v / MA20（與訓練一致，不減 1）
  let volSum = 0;
  for (let i = n - 20; i < n; i++) volSum += v[i];
  const volMa20  = volSum / 20;
  const vol_ratio = volMa20 > 0 ? v[n-1] / volMa20 : 1;

  // K 棒形態：hl_pct = (H−L)/C；body_pct = |C−O|/(H−L)（與訓練一致）
  const hl = h[n-1] - l[n-1];
  const hl_pct   = lastC > 0 ? hl / lastC : 0;
  const body_pct = hl > 0 ? Math.abs(c[n-1] - o[n-1]) / hl : 0;

  return new Float32Array([
    ret1, ret5, ret10, ret20,
    rsi14,
    macd_pct, macdSig_pct, macdHist,
    bb_pct, bb_width,
    ema_ratio,
    vol_ratio,
    hl_pct, body_pct,
  ]);
}

/**
 * 計算 23 個台股特徵（14 TA + 9 籌碼）
 *
 * @param {Object} bars   - 同 computeFeatures 的 bars 物件
 * @param {Object} [chip] - 台股籌碼資料（可選，缺少時籌碼特徵填 0）
 *   {
 *     foreign_net_ratio  : number,  // 外資買賣超 / 成交量，[-1, 1]
 *     trust_net_ratio    : number,  // 投信買賣超 / 成交量，[-1, 1]
 *     dealer_net_ratio   : number,  // 自營商買賣超 / 成交量，[-1, 1]
 *     inst_net_ratio     : number,  // 三大法人合計 / 成交量，[-1, 1]
 *     foreign_net_ma5    : number,  // 外資 5 日累積買賣超趨勢，[-1, 1]
 *     margin_balance_chg : number,  // 融資餘額日變化率，[-0.5, 0.5]
 *     short_balance_chg  : number,  // 融券餘額日變化率，[-0.5, 0.5]
 *     margin_short_ratio : number,  // 融券 / 融資 比，[0, 2]
 *     near_limit         : number,  // 接近漲跌停：+1 / -1 / 0
 *   }
 * @returns {Float32Array|null}
 */
function computeFeaturesTW(bars, chip = {}) {
  const taFeatures = computeFeatures(bars);
  if (!taFeatures) return null;

  // 籌碼特徵（缺值填 0；訓練時未做截斷，這裡也不截斷）
  const z = v => (Number.isFinite(v) ? v : 0);
  const chipFeatures = new Float32Array([
    z(chip.foreign_net_ratio), z(chip.trust_net_ratio), z(chip.dealer_net_ratio),
    z(chip.inst_net_ratio), z(chip.foreign_net_ma5),
    z(chip.margin_balance_chg), z(chip.short_balance_chg), z(chip.margin_short_ratio),
    z(chip.near_limit),
  ]);

  // 合併 14 + 9 = 23 維
  const combined = new Float32Array(N_FEATURES_TW);
  combined.set(taFeatures, 0);
  combined.set(chipFeatures, N_FEATURES_US);
  return combined;
}

// ── 標準化：訓練時 StandardScaler 沒有打包進 ONNX，推論前必須自己套用 ──
function _applyScaler(features, scaler) {
  if (!scaler || !scaler.mean || scaler.mean.length !== features.length) {
    throw new Error(`scaler 維度不符（features=${features.length}, scaler=${scaler?.mean?.length}）`);
  }
  const out = new Float32Array(features.length);
  for (let i = 0; i < features.length; i++) {
    const sd = scaler.std[i] > 0 ? scaler.std[i] : 1;
    const v = (features[i] - scaler.mean[i]) / sd;
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

// ── 推理核心 ─────────────────────────────────────────────────────────

async function _runInference(session, features, nFeatures) {
  const ort    = require('onnxruntime-node');
  const tensor = new ort.Tensor('float32', features, [1, nFeatures]);
  const results = await session.run({ float_input: tensor });

  // ONNX 輸出 probabilities shape [1, 3]：[SELL, HOLD, BUY]
  const probs = results.probabilities?.data
             || results[Object.keys(results)[1]]?.data;
  if (!probs || probs.length < 3) throw new Error('ONNX 輸出格式不符');

  const [sellP, holdP, buyP] = [probs[0], probs[1], probs[2]];
  const maxP  = Math.max(sellP, holdP, buyP);
  const label = maxP === buyP ? 'BUY' : maxP === sellP ? 'SELL' : 'HOLD';
  return { label, buyP, holdP, sellP, maxP };
}

// ── 公開 API ─────────────────────────────────────────────────────────

/**
 * 對單一標的進行預測（自動識別台股 / 美股）
 *
 * @param {string} symbol
 * @param {Object} bars       - { closes, opens, highs, lows, volumes }
 * @param {Object} [chip={}]  - 台股籌碼資料（可省略，省略時籌碼特徵填 0）
 * @returns {Object} { symbol, mlSignal, buyProb, holdProb, sellProb,
 *                     confidence, device, version, market, error }
 */
async function predict(symbol, bars, chip = {}) {
  const isTW = isTaiwanSymbol(symbol);

  const base = {
    symbol, mlSignal: 'HOLD',
    buyProb: 0.33, holdProb: 0.34, sellProb: 0.33,
    confidence: 0.34,
    device : _device,
    version: isTW ? _versionTW : _versionUS,
    market : isTW ? 'tw' : 'us',
  };

  // 確認對應模型就緒
  if (isTW && !_readyTW) {
    return {
      ...base,
      error: _readyUS ? '台股模型未就緒（請執行 python ml/train.py --market tw）'
                       : '台股與美股模型均未就緒',
    };
  }
  if (!isTW && !_readyUS) {
    return {
      ...base,
      error: _readyTW ? '美股模型未就緒（請執行 python ml/train.py）'
                       : '台股與美股模型均未就緒',
    };
  }

  // 台股籌碼特徵由呼叫端（pipeline/build.js 依 FinMind 資料計算）傳入；沒有就填 0（純技術面）
  // 計算特徵
  const features = isTW
    ? computeFeaturesTW(bars, chip)
    : computeFeatures(bars);

  if (!features) {
    return { ...base, error: `資料不足（最少 ${MIN_BARS} 根 K 棒）` };
  }

  // 降級偵測：台股模型輸入若籌碼全為 0，加一個 flag 通知呼叫者
  const chipIsEmpty = isTW &&
    Object.keys(chip).length === 0;

  try {
    const session   = isTW ? _sessionTW : _sessionUS;
    const nFeatures = isTW ? N_FEATURES_TW : N_FEATURES_US;
    const scaled    = _applyScaler(features, isTW ? _scalerTW : _scalerUS);
    const { label, buyP, holdP, sellP, maxP } =
      await _runInference(session, scaled, nFeatures);

    return {
      symbol, mlSignal: label,
      buyProb :  parseFloat(buyP.toFixed(4)),
      holdProb: parseFloat(holdP.toFixed(4)),
      sellProb: parseFloat(sellP.toFixed(4)),
      confidence: parseFloat(maxP.toFixed(4)),
      device : _device,
      version: isTW ? _versionTW : _versionUS,
      market : isTW ? 'tw' : 'us',
      chipMode: isTW ? (chipIsEmpty ? 'ta_only' : 'full') : null,
    };
  } catch (e) {
    console.error(`[Predictor] ${symbol} 推理失敗：`, e.message);
    return { ...base, error: e.message };
  }
}

/**
 * 批次預測多個標的
 * @param {Array<{symbol, bars, chip?}>} items
 * @returns {Object} { [symbol]: predictionResult }
 */
async function predictBatch(items) {
  const results = {};
  await Promise.all(items.map(async ({ symbol, bars, chip }) => {
    results[symbol] = await predict(symbol, bars, chip || {});
  }));
  return results;
}

// ── 狀態查詢 ─────────────────────────────────────────────────────────

function status() {
  return {
    ready     : _readyUS || _readyTW,
    readyUS   : _readyUS,
    readyTW   : _readyTW,
    device    : _device,
    versionUS : _versionUS,
    versionTW : _versionTW,
    modelUS   : MODEL_US,
    modelTW   : MODEL_TW,
    metricsUS : _scalerUS?.metrics ?? null,
    metricsTW : _scalerTW?.metrics ?? null,
    trainedAtUS: _scalerUS?.trainedAt ?? null,
    trainedAtTW: _scalerTW?.trainedAt ?? null,
    error     : _loadErr,
  };
}

module.exports = {
  init,
  predict,
  predictBatch,
  computeFeatures,
  computeFeaturesTW,
  isTaiwanSymbol,
  status,
  MIN_BARS,
  N_FEATURES_US,
  N_FEATURES_TW,
};
