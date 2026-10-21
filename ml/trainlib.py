"""
ml/trainlib.py — 共用訓練流程（ml/train.py 與 ml/train_tw_chip.py 都用這支）

與舊版差異：
  1. 依時間切分驗證：每檔股票各自取「最後 20%」日期當驗證集，中間留 1 天間隔
     （label 是隔日報酬，避免最後一筆訓練資料偷看到驗證期）。
     舊版用 train_test_split 隨機打散，驗證分數會因時間洩漏而偏高。
  2. 類別權重：依 SELL/HOLD/BUY 比例自動平衡，避免模型偏向多數類別（例如一直判 BUY）。
  3. StandardScaler 只用訓練集擬合；驗證完後用全部資料重訓再匯出。
  4. 驗證指標寫進 scaler json（metrics），伺服器 /api/predict/status 可顯示。

輸出格式不變：ONNX（輸入 float_input，輸出 label / probabilities）+ scaler json，
Node 端 modules/predictor.js 會先套 scaler 再推論。
"""
import json
import numpy as np
import pandas as pd

LABELS = ['SELL', 'HOLD', 'BUY']


def time_split(blocks, val_frac=0.2, gap=1):
    """blocks: [(X_i, y_i)]，每個 block 是一檔股票、依日期由舊到新排序。"""
    Xtr, ytr, Xva, yva = [], [], [], []
    for X, y in blocks:
        n = len(y)
        if n < 30:
            continue
        cut = int(n * (1 - val_frac))
        Xtr.append(X[:cut]); ytr.append(y[:cut])
        Xva.append(X[cut + gap:]); yva.append(y[cut + gap:])
    return (np.vstack(Xtr), np.concatenate(ytr), np.vstack(Xva), np.concatenate(yva))


def _clean(X, y):
    m = np.isfinite(X).all(axis=1)
    return X[m].astype(np.float32), y[m].astype(np.int64)


def train_and_export(blocks, feature_names, model_path, scaler_path, mkt, version='2.0'):
    from sklearn.preprocessing import StandardScaler
    from sklearn.ensemble import GradientBoostingClassifier
    from sklearn.metrics import classification_report, accuracy_score, balanced_accuracy_score
    from sklearn.utils.class_weight import compute_sample_weight
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType

    Xtr, ytr, Xva, yva = time_split(blocks)
    Xtr, ytr = _clean(Xtr, ytr)
    Xva, yva = _clean(Xva, yva)
    dist = {LABELS[k]: int((ytr == k).sum()) for k in range(3)}
    print(f'\n[{mkt}] 訓練 {len(ytr)} 筆 / 驗證 {len(yva)} 筆（依時間切分）  類別分佈 {dist}')

    params = dict(n_estimators=200, max_depth=3, learning_rate=0.05, subsample=0.8,
                  min_samples_leaf=50, random_state=42, verbose=0)

    # ── 1) 驗證：scaler 只看訓練集 ─────────────────────────────
    sc = StandardScaler().fit(Xtr)
    clf = GradientBoostingClassifier(**params)
    clf.fit(sc.transform(Xtr), ytr, sample_weight=compute_sample_weight('balanced', ytr))
    pred = clf.predict(sc.transform(Xva))
    acc = accuracy_score(yva, pred)
    bal = balanced_accuracy_score(yva, pred)
    majority = max(np.mean(yva == k) for k in range(3))
    pred_dist = {LABELS[k]: round(float(np.mean(pred == k)), 3) for k in range(3)}
    print(classification_report(yva, pred, labels=[0, 1, 2], target_names=LABELS, zero_division=0))
    print(f'[{mkt}] 驗證 accuracy={acc:.3f}  balanced={bal:.3f}  多數類基準={majority:.3f}  預測分佈={pred_dist}')
    if bal <= 1 / 3 + 0.02:
        print(f'[{mkt}] ⚠ balanced accuracy 接近隨機（0.333），模型幾乎沒有預測力，請謹慎使用。')

    # ── 2) 用全部資料重訓後匯出 ────────────────────────────────
    Xall = np.vstack([Xtr, Xva]); yall = np.concatenate([ytr, yva])
    scaler = StandardScaler().fit(Xall)
    final = GradientBoostingClassifier(**params)
    final.fit(scaler.transform(Xall), yall, sample_weight=compute_sample_weight('balanced', yall))

    n_feat = Xall.shape[1]
    onnx_mdl = convert_sklearn(final, initial_types=[('float_input', FloatTensorType([None, n_feat]))],
                               options={type(final): {'zipmap': False}}, target_opset=12)
    with open(model_path, 'wb') as f:
        f.write(onnx_mdl.SerializeToString())
    meta = {
        'scaler_mean': scaler.mean_.tolist(),
        'scaler_std': scaler.scale_.tolist(),
        'version': version,
        'features': feature_names,
        'n_features': n_feat,
        'trained_at': pd.Timestamp.now().isoformat(),
        'metrics': {
            'split': 'time (last 20% per symbol, 1-day gap)',
            'val_accuracy': round(float(acc), 4),
            'val_balanced_accuracy': round(float(bal), 4),
            'val_majority_baseline': round(float(majority), 4),
            'val_pred_distribution': pred_dist,
            'train_class_counts': dist,
            'n_train': int(len(ytr)), 'n_val': int(len(yva)),
        },
    }
    with open(scaler_path, 'w') as f:
        json.dump(meta, f, indent=2)
    print(f'[{mkt}] 儲存: {model_path}\n[{mkt}] 儲存: {scaler_path}')
    return meta
