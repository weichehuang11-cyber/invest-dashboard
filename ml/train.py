#!/usr/bin/env python3
"""
ML Signal Model Training Script (urllib直接版)
訓練美股(14特徵) / 台股(23特徵) ONNX 分類模型
標籤: SELL(0) HOLD(1) BUY(2)

用法:
  cd /volume2/homes/invest
  python3 ml/train.py --market us
  python3 ml/train.py --market tw
  python3 ml/train.py --market all

依賴 (不需要 yfinance):
  python3 -m pip install scikit-learn skl2onnx onnxruntime --break-system-packages
"""

import os, sys, json, time, argparse, warnings, ssl
warnings.filterwarnings('ignore')
import urllib.request, urllib.parse
import numpy as np
import pandas as pd

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR   = os.path.dirname(SCRIPT_DIR)
MODEL_DIR  = os.path.join(SCRIPT_DIR, 'models')
CACHE_DIR  = os.path.join(SCRIPT_DIR, 'data_cache')
os.makedirs(MODEL_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)

US_SYMBOLS = [
    'AAPL','MSFT','NVDA','META','GOOGL','AMZN','TSLA','AVGO','AMD','INTC',
    'QCOM','TSM','ASML','AMAT','LRCX','KLAC','MU','MRVL','ARM','SMCI',
    'JPM','BAC','GS','MS','V','MA','JNJ','UNH','XOM','CVX',
    'WMT','COST','HD','MCD','KO','PEP','DIS','NFLX','ADBE','CRM',
    'SPY','QQQ','SOXX','XLK','XLF'
]

TW_SYMBOLS = [
    '2330','2317','2454','2382','2308','2303','2357','2379','2395','2408',
    '3711','3034','3008','2301','2337','2345','2376','2377','3037','3081',
    '1301','1303','1326','6505','2002','2882','2881','2886','2891','2892',
    '5880','2912','2207','2609','2615','2618','2603','3045','4904','2412'
]

US_FEATURES = [
    'ret1','ret5','ret10','ret20',
    'rsi14',
    'macd_pct','macdSig_pct','macdHist',
    'bb_pct','bb_width',
    'ema_ratio','vol_ratio',
    'hl_pct','body_pct'
]
TW_CHIP_FEATURES = [
    'foreign_net_ratio','trust_net_ratio','dealer_net_ratio','inst_net_ratio',
    'foreign_net_ma5','margin_balance_chg','short_balance_chg',
    'margin_short_ratio','near_limit'
]
TW_FEATURES = US_FEATURES + TW_CHIP_FEATURES

# ── SSL context (忽略憑證，Synology 有時有問題) ───────────────────────────
_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

_YF_COOKIE = ''
_YF_CRUMB  = ''

def _get_crumb():
    global _YF_COOKIE, _YF_CRUMB
    if _YF_CRUMB:
        return
    try:
        # Step1: cookie
        req = urllib.request.Request(
            'https://fc.yahoo.com/',
            headers={'User-Agent': 'Mozilla/5.0'}
        )
        with urllib.request.urlopen(req, context=_ssl_ctx, timeout=10) as r:
            cookies = r.headers.get_all('Set-Cookie') or []
            _YF_COOKIE = '; '.join(c.split(';')[0] for c in cookies)
        # Step2: crumb
        req2 = urllib.request.Request(
            'https://query1.finance.yahoo.com/v1/test/getcrumb',
            headers={'User-Agent': 'Mozilla/5.0', 'Cookie': _YF_COOKIE}
        )
        with urllib.request.urlopen(req2, context=_ssl_ctx, timeout=10) as r:
            _YF_CRUMB = r.read().decode().strip()
        if not _YF_CRUMB or len(_YF_CRUMB) > 30 or ' ' in _YF_CRUMB:
            _YF_CRUMB = ''
        else:
            print('[Crumb] OK:', _YF_CRUMB[:4] + '...')
    except Exception as e:
        print('[Crumb] 獲取失敗:', e)
        _YF_CRUMB = ''


def fetch_ohlcv(symbol, period_days=750):
    """從 Yahoo Finance chart API 獲取日線 OHLCV"""
    _get_crumb()
    cache_file = os.path.join(CACHE_DIR, symbol.replace('/', '_') + '.csv')
    # 使用快取 (1天內)
    if os.path.exists(cache_file):
        mtime = os.path.getmtime(cache_file)
        if time.time() - mtime < 86400:
            df = pd.read_csv(cache_file, index_col=0, parse_dates=True)
            if len(df) >= 60:
                return df

    end_ts   = int(time.time())
    start_ts = end_ts - period_days * 86400
    crumb_param = ('&crumb=' + urllib.parse.quote(_YF_CRUMB)) if _YF_CRUMB else ''
    url = ('https://query1.finance.yahoo.com/v8/finance/chart/'
           + urllib.parse.quote(symbol)
           + '?interval=1d&period1=' + str(start_ts)
           + '&period2=' + str(end_ts) + crumb_param)
    headers = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'}
    if _YF_COOKIE:
        headers['Cookie'] = _YF_COOKIE

    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, context=_ssl_ctx, timeout=20) as r:
                raw = json.loads(r.read())
            break
        except Exception as e:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)

    result = raw.get('chart', {}).get('result', [])
    if not result:
        raise ValueError('無資料: ' + str(raw.get('chart', {}).get('error')))

    r0 = result[0]
    timestamps = r0['timestamp']
    q = r0['indicators']['quote'][0]
    adjclose = r0['indicators'].get('adjclose', [{}])[0].get('adjclose', q.get('close'))

    df = pd.DataFrame({
        'Open':   q.get('open'),
        'High':   q.get('high'),
        'Low':    q.get('low'),
        'Close':  adjclose,
        'Volume': q.get('volume')
    }, index=pd.to_datetime(timestamps, unit='s').normalize())
    df.index.name = 'Date'
    df = df.dropna(subset=['Close'])
    df.to_csv(cache_file)
    return df


# ── 技術指標 ────────────────────────────────────────────────────────────────
def compute_rsi(close, period=14):
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period-1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period-1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - 100 / (1 + rs)

def compute_features_us(df):
    c = df['Close']; o = df['Open']; h = df['High']; l = df['Low']; v = df['Volume']
    out = pd.DataFrame(index=df.index)
    out['ret1']  = c.pct_change(1)
    out['ret5']  = c.pct_change(5)
    out['ret10'] = c.pct_change(10)
    out['ret20'] = c.pct_change(20)
    out['rsi14'] = compute_rsi(c, 14) / 100.0
    ema12 = c.ewm(span=12, adjust=False).mean()
    ema26 = c.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    macd_sig  = macd_line.ewm(span=9, adjust=False).mean()
    out['macd_pct']    = macd_line / c.replace(0, np.nan)
    out['macdSig_pct'] = macd_sig  / c.replace(0, np.nan)
    out['macdHist']    = (macd_line - macd_sig) / c.replace(0, np.nan)
    ma20  = c.rolling(20).mean()
    std20 = c.rolling(20).std()
    bb_upper = ma20 + 2 * std20
    bb_lower = ma20 - 2 * std20
    bb_range = (bb_upper - bb_lower).replace(0, np.nan)
    out['bb_pct']   = (c - bb_lower) / bb_range
    out['bb_width'] = bb_range / ma20.replace(0, np.nan)
    ema20 = c.ewm(span=20, adjust=False).mean()
    out['ema_ratio'] = c / ema20.replace(0, np.nan) - 1
    vol_ma20 = v.rolling(20).mean()
    out['vol_ratio'] = v / vol_ma20.replace(0, np.nan)
    hl = (h - l).replace(0, np.nan)
    out['hl_pct']   = hl / c.replace(0, np.nan)
    out['body_pct'] = (c - o).abs() / hl
    return out[US_FEATURES]

def compute_labels(close, threshold=0.005):
    fwd_ret = close.pct_change(1).shift(-1)
    label = np.where(fwd_ret > threshold, 2, np.where(fwd_ret < -threshold, 0, 1)).astype(float)
    label[np.isnan(fwd_ret.values)] = np.nan     # 最後一天沒有隔日報酬，不可當成 HOLD
    return pd.Series(label, index=close.index)


# ── 資料獲取 ────────────────────────────────────────────────────────────────
def fetch_us_data(symbols, period_days=750):
    all_feats = []; all_labels = []
    print('[US] 下載', len(symbols), '支股票 (urllib 直接模式)...')
    for i, sym in enumerate(symbols):
        try:
            df = fetch_ohlcv(sym, period_days)
            if len(df) < 60: print('  SKIP', sym, '(資料不足', len(df), '筆)'); continue
            feats = compute_features_us(df)
            labels = compute_labels(df['Close'])
            combined = feats.copy(); combined['_label'] = labels
            combined = combined.replace([np.inf, -np.inf], np.nan).dropna()
            if len(combined) < 30: continue
            all_feats.append(combined[US_FEATURES].values)
            all_labels.append(combined['_label'].values)
            print('  {:>6s}: {:4d}筆  [{}/{}]'.format(sym, len(combined), i+1, len(symbols)))
            time.sleep(0.5)
        except Exception as e:
            print('  ERR', sym, ':', str(e)[:80])
    if not all_feats: raise RuntimeError('無資料')
    print('[US] 共', sum(len(a) for a in all_labels), '筆，', len(all_feats), '檔')
    return list(zip(all_feats, all_labels))   # 每檔一個 block，依日期排序（供依時間切分）


def fetch_tw_finmind(symbols, token, start_date='2022-01-01'):
    BASE_URL = 'https://api.finmindtrade.com/api/v4/data'
    results = {}
    for sym in symbols:
        params = ('?dataset=TaiwanStockInstitutionalInvestorsBuySell'
                  '&data_id=' + sym + '&start_date=' + start_date + '&token=' + token)
        try:
            req = urllib.request.Request(BASE_URL + params,
                headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, context=_ssl_ctx, timeout=15) as r:
                data = json.loads(r.read())
            if data.get('status') == 200:
                df = pd.DataFrame(data['data'])
                df['date'] = pd.to_datetime(df['date'])
                results[sym] = df
                print('  FinMind', sym, ':', len(df), '筆')
            else:
                print('  FinMind', sym, ': status', data.get('status'))
        except Exception as e:
            print('  FinMind ERR', sym, ':', str(e)[:60])
        time.sleep(0.3)
    return results


def fetch_tw_data(symbols, finmind_token=None, period_days=750):
    if finmind_token is None:
        env_path = os.path.join(BASE_DIR, '.env')
        if os.path.exists(env_path):
            with open(env_path) as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('FINMIND_TOKEN='):
                        finmind_token = line.split('=', 1)[1].strip().strip('"\'')
                        break
    chip_data = {}
    if finmind_token:
        print('[TW] 載入 FinMind 法人資料...')
        chip_data = fetch_tw_finmind(symbols, finmind_token)
    else:
        print('[TW] 無 FinMind Token，法人特徵填 0')
    all_feats = []; all_labels = []
    print('[TW] 下載', len(symbols), '支台股...')
    for i, sym in enumerate(symbols):
        yf_sym = sym + '.TW'
        try:
            df = fetch_ohlcv(yf_sym, period_days)
            if len(df) < 60: print('  SKIP', sym, '(資料不足)'); continue
            ta_feats = compute_features_us(df)
            chip_df = None
            if sym in chip_data:
                raw = chip_data[sym].copy()
                # FinMind 的 name 為英文；統一成中文類別再樞紐
                name_map = {'Foreign_Investor':'外資','Foreign_Dealer_Self':'外資',
                            'Investment_Trust':'投信',
                            'Dealer_self':'自營商','Dealer_Hedging':'自營商','Dealer':'自營商',
                            '外資':'外資','投信':'投信','自營商':'自營商'}
                raw['name'] = raw['name'].map(name_map)
                raw = raw.dropna(subset=['name'])
                raw = raw.groupby(['date','name'], as_index=False)[['buy','sell']].sum()
                pivot_buy  = raw.pivot(index='date', columns='name', values='buy').fillna(0)
                pivot_sell = raw.pivot(index='date', columns='name', values='sell').fillna(0)
                total_vol = df['Volume'].copy(); total_vol.index = pd.to_datetime(total_vol.index)
                def sc(p, n): return p[n] if n in p.columns else pd.Series(0, index=p.index)
                fn = sc(pivot_buy,'外資') - sc(pivot_sell,'外資')
                tn = sc(pivot_buy,'投信') - sc(pivot_sell,'投信')
                dn = sc(pivot_buy,'自營商') - sc(pivot_sell,'自營商')
                inst_n = fn + tn + dn
                av = total_vol.reindex(fn.index).fillna(1)
                chip_df = pd.DataFrame(index=fn.index)
                chip_df['foreign_net_ratio'] = fn / av.replace(0, np.nan)
                chip_df['trust_net_ratio']   = tn / av.replace(0, np.nan)
                chip_df['dealer_net_ratio']  = dn / av.replace(0, np.nan)
                chip_df['inst_net_ratio']    = inst_n / av.replace(0, np.nan)
                chip_df['foreign_net_ma5']   = chip_df['foreign_net_ratio'].rolling(5).mean()
                chip_df['margin_balance_chg'] = 0.0
                chip_df['short_balance_chg']  = 0.0
                chip_df['margin_short_ratio'] = 0.0
                pct = df['Close'].pct_change()
                near = ((pct > 0.065) | (pct < -0.065)).astype(float)
                near.index = pd.to_datetime(near.index)
                chip_df['near_limit'] = near.rolling(5).sum().reindex(chip_df.index).fillna(0)
                chip_df.index = pd.to_datetime(chip_df.index)
            ta_feats.index = pd.to_datetime(ta_feats.index)
            if chip_df is not None:
                combined = ta_feats.join(chip_df[TW_CHIP_FEATURES], how='left')
            else:
                for col in TW_CHIP_FEATURES: ta_feats[col] = 0.0
                combined = ta_feats
            labels = compute_labels(df['Close'])
            labels.index = pd.to_datetime(labels.index)
            combined['_label'] = labels
            # 先丟掉沒有 label / 報酬的列，再把籌碼缺值補 0（順序反了會把最後一天補成 SELL）
            combined = combined.replace([np.inf, -np.inf], np.nan).dropna(subset=['_label','ret1'])
            combined = combined.fillna(0)
            if len(combined) < 30: continue
            all_feats.append(combined[TW_FEATURES].values)
            all_labels.append(combined['_label'].values)
            print('  {:>5s}: {:4d}筆  [{}/{}]'.format(sym, len(combined), i+1, len(symbols)))
            time.sleep(0.5)
        except Exception as e:
            print('  ERR', sym, ':', str(e)[:80])
    if not all_feats: raise RuntimeError('無台股資料')
    print('[TW] 共', sum(len(a) for a in all_labels), '筆，', len(all_feats), '檔')
    return list(zip(all_feats, all_labels))


# ── 訓練 & 轉換 ONNX ────────────────────────────────────────────────────────
def train_and_export(X, y, feature_names, model_path, scaler_path, mkt):
    from sklearn.preprocessing import StandardScaler
    from sklearn.ensemble import GradientBoostingClassifier
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import classification_report
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
    print('\n[' + mkt + '] 訓練... X=' + str(X.shape)
          + '  SELL=' + str(int((y==0).sum()))
          + '  HOLD=' + str(int((y==1).sum()))
          + '  BUY='  + str(int((y==2).sum())))
    mask = np.isfinite(X).all(axis=1)
    X, y = X[mask], y[mask]
    print('  清洗後:', X.shape[0], '筆')
    scaler = StandardScaler()
    X_sc = scaler.fit_transform(X)
    X_tr, X_val, y_tr, y_val = train_test_split(X_sc, y, test_size=0.2, random_state=42, stratify=y)
    clf = GradientBoostingClassifier(n_estimators=200, max_depth=4, learning_rate=0.05,
                                      subsample=0.8, min_samples_leaf=20, random_state=42, verbose=0)
    clf.fit(X_tr, y_tr)
    y_pred = clf.predict(X_val)
    print('\n[' + mkt + '] 驗證結果:')
    print(classification_report(y_val, y_pred, target_names=['SELL','HOLD','BUY'], zero_division=0))
    print('[' + mkt + '] 轉換 ONNX...')
    n_feat = X.shape[1]
    options = {type(clf): {'zipmap': False}}
    onnx_mdl = convert_sklearn(clf,
        initial_types=[('float_input', FloatTensorType([None, n_feat]))],
        options=options, target_opset=12)
    with open(model_path, 'wb') as f:
        f.write(onnx_mdl.SerializeToString())
    scaler_data = {
        'scaler_mean': scaler.mean_.tolist(),
        'scaler_std':  scaler.scale_.tolist(),
        'version': '1.0',
        'features': feature_names,
        'n_features': n_feat,
        'trained_at': pd.Timestamp.now().isoformat()
    }
    with open(scaler_path, 'w') as f:
        json.dump(scaler_data, f, indent=2)
    print('[' + mkt + '] 儲存: ' + model_path)
    print('[' + mkt + '] 儲存: ' + scaler_path)
    try:
        import onnxruntime as ort
        sess = ort.InferenceSession(model_path)
        sample = X_sc[:3].astype(np.float32)
        out = sess.run(None, {'float_input': sample})
        print('[' + mkt + '] ONNX OK, shape: ' + str(out[1].shape) + '  sample: ' + str(out[1][0].round(3)))
    except Exception as e:
        print('[' + mkt + '] ONNX 驗證: ' + str(e))


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trainlib


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--market', choices=['us','tw','all'], default='us')
    ap.add_argument('--symbols', nargs='+')
    ap.add_argument('--days', type=int, default=750, help='歷史資料天數 (預設750=約3年)')
    ap.add_argument('--finmind-token', default=None)
    args = ap.parse_args()
    markets = ['us','tw'] if args.market == 'all' else [args.market]
    for market in markets:
        if market == 'us':
            syms = args.symbols or US_SYMBOLS
            blocks = fetch_us_data(syms, period_days=args.days)
            trainlib.train_and_export(blocks, US_FEATURES,
                os.path.join(MODEL_DIR,'signal_model.onnx'),
                os.path.join(MODEL_DIR,'scaler.json'), 'US')
        elif market == 'tw':
            syms = args.symbols or TW_SYMBOLS
            blocks = fetch_tw_data(syms, finmind_token=args.finmind_token, period_days=args.days)
            trainlib.train_and_export(blocks, TW_FEATURES,
                os.path.join(MODEL_DIR,'signal_model_tw.onnx'),
                os.path.join(MODEL_DIR,'scaler_tw.json'), 'TW')
    print('\n[完成] 模型儲存至: ' + MODEL_DIR)
    print('重啟: pm2 restart invest')

if __name__ == '__main__':
    main()
