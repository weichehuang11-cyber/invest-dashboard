#!/bin/bash
# ─────────────────────────────────────────────────────────────
# NAS 備援 + 歷史資料：用和 GitHub 相同的程式在 NAS 上獨立產生一份資料
#
#   產出：$OUT/        完整備援網站（NAS 伺服器以 /backup/ 提供）
#         $ARCHIVE/    歷史封存：每次快照、每日收盤（永久保留）
#         $STATE/      NAS 自己的預測紀錄與快取
#
# 用法（Synology 控制台 → 任務排程表 → 使用者定義的指令碼）：
#   bash /volume2/homes/invest-dashboard/nas/run-backup.sh            盤中
#   bash /volume2/homes/invest-dashboard/nas/run-backup.sh tw         台股收盤後
#   bash /volume2/homes/invest-dashboard/nas/run-backup.sh us         美股收盤後
# ─────────────────────────────────────────────────────────────
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${INVEST_BACKUP_BASE:-$DIR/../invest-backup}"
OUT="$BASE/site"; STATE="$BASE/state"; ARCHIVE="$BASE/archive"; LOG="$BASE/run.log"
NODE="${NODE:-$(command -v node || echo /usr/local/bin/node)}"
NPM="${NPM:-$(command -v npm || echo /usr/local/bin/npm)}"
mkdir -p "$OUT" "$STATE" "$ARCHIVE"
exec >>"$LOG" 2>&1
echo "──── $(date '+%F %T') 開始 ${1:-盤中}"

# 1. 取得最新程式（公開專案，不需要權杖）
cd "$DIR" || exit 1
OLD_LOCK=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1)
git pull -q --ff-only || echo "⚠ git pull 失敗，用現有版本繼續"
NEW_LOCK=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "$OLD_LOCK" != "$NEW_LOCK" ]; then
  ONNXRUNTIME_NODE_INSTALL=skip "$NPM" ci --omit=dev --no-audit --no-fund || echo "⚠ npm ci 失敗"
fi

# 2. 產生資料（FINMIND_TOKEN 從 NAS 的 invest/.env 讀取）
if [ -z "${FINMIND_TOKEN:-}" ] && [ -f "$DIR/../invest/.env" ]; then
  FINMIND_TOKEN=$(grep -E '^FINMIND_TOKEN=' "$DIR/../invest/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"'\r')
  export FINMIND_TOKEN
fi
ARGS=(--out="$OUT/data" --state="$STATE" --archive="$ARCHIVE")
[ -n "${1:-}" ] && ARGS+=(--full="$1")
[ -f "$STATE/heavy.json" ] || ARGS+=(--full=all)
"$NODE" pipeline/build.js "${ARGS[@]}" || { echo "✕ 產生資料失敗"; exit 1; }
cp -r site/. "$OUT/"

# 3. 每天一次：備份 NAS 主程式的紀錄（預測紀錄、籌碼快取、設定），保留 60 天
TODAY=$(date +%F)
if [ -d "$DIR/../invest" ] && [ ! -f "$ARCHIVE/backup/invest-$TODAY.tar.gz" ]; then
  mkdir -p "$ARCHIVE/backup"
  tar czf "$ARCHIVE/backup/invest-$TODAY.tar.gz" -C "$DIR/.." \
    --exclude='invest/node_modules' --exclude='invest/logs' \
    invest/_chip_cache invest/watchlist.json invest/portfolio.json invest/paper_trades.json 2>/dev/null
  find "$ARCHIVE/backup" -name 'invest-*.tar.gz' -mtime +60 -delete
fi
echo "✓ $(date '+%T') 完成"
