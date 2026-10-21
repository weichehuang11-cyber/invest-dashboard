#!/bin/bash
# ─────────────────────────────────────────────────────────────
# NAS 一次性安裝：讓 NAS 成為「訊號終端」的備援與歷史封存
#   bash setup.sh            （在 NAS 上以 SSH 執行；可重複執行，用來更新）
# 會做：下載／更新程式 → 安裝套件 → 第一次完整產生資料 → 用 pm2 常駐備援伺服器（含排程）
# ─────────────────────────────────────────────────────────────
set -e
HOME_DIR="${HOME_DIR:-/volume2/homes}"
APP="$HOME_DIR/invest-dashboard"
NODE="$(command -v node || echo /usr/local/bin/node)"
PM2="$(command -v pm2 || echo /usr/local/bin/pm2)"
echo "▶ 1/4 下載或更新程式"
if [ -d "$APP/.git" ]; then git -C "$APP" pull -q --ff-only; else git clone -q https://github.com/weichehuang11-cyber/invest-dashboard.git "$APP"; fi
cd "$APP"
echo "▶ 2/4 安裝套件"
ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev --no-audit --no-fund
echo "▶ 3/4 第一次完整產生資料（約 3–5 分鐘）"
bash nas/run-backup.sh all || echo "⚠ 第一次產生失敗，伺服器啟動後會再試"
tail -3 "$HOME_DIR/invest-backup/run.log" 2>/dev/null || true
echo "▶ 4/4 啟動備援伺服器"
if "$PM2" describe invest >/dev/null 2>&1; then
  echo "  發現舊的 invest 主程式，停用它（資料仍保留在 $HOME_DIR/invest，每日也會打包備份）"
  "$PM2" stop invest >/dev/null 2>&1 || true
  "$PM2" delete invest >/dev/null 2>&1 || true
fi
"$PM2" delete signal-backup >/dev/null 2>&1 || true
"$PM2" start "$APP/nas/server.js" --name signal-backup --interpreter "$NODE"
"$PM2" save
echo
echo "✅ 完成。檢查：curl http://localhost:8765/backup/status.json"
echo "   下一步（讓 GitHub 網站讀得到 NAS）：sudo tailscale serve --bg 8765"
