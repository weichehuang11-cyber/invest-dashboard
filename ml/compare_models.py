#!/usr/bin/env python3
"""比較新舊模型的驗證成績：新模型的 balanced accuracy 比舊的差超過 0.01（或接近隨機），就還原舊模型。"""
import json, os, shutil, sys
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models')
B = sys.argv[1]  # 舊模型備份資料夾
report = []
for mkt, onnx, sc in [('美股', 'signal_model.onnx', 'scaler.json'), ('台股', 'signal_model_tw.onnx', 'scaler_tw.json')]:
    new = json.load(open(os.path.join(D, sc))) if os.path.exists(os.path.join(D, sc)) else {}
    old = json.load(open(os.path.join(B, sc))) if os.path.exists(os.path.join(B, sc)) else {}
    nb = (new.get('metrics') or {}).get('val_balanced_accuracy'); ob = (old.get('metrics') or {}).get('val_balanced_accuracy')
    if new.get('trained_at') == old.get('trained_at'):
        report.append(f'{mkt}：沒有重新訓練'); continue
    keep = nb is not None and nb > 0.36 and (ob is None or nb >= ob - 0.01)
    if not keep:
        for f in (onnx, sc):
            if os.path.exists(os.path.join(B, f)): shutil.copy(os.path.join(B, f), os.path.join(D, f))
        report.append(f'{mkt}：新模型 balanced={nb} 不如舊模型 {ob}，保留舊模型')
    else:
        report.append(f'{mkt}：採用新模型 balanced={nb}（舊 {ob}）')
print('\n'.join(report))
open(os.path.join(B, 'report.txt'), 'w').write('\n'.join(report))
