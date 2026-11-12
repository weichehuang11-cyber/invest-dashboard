#!/bin/bash
# ─────────────────────────────────────────────────────────────
# NAS 健康檢查：搬移資料夾、換儲存區、重灌套件之後跑一次
#   bash nas/check.sh          只檢查，列出問題與修正指令
#   bash nas/check.sh --fix    自動修正能修的項目（pm2 路徑、Tailscale 容器、套件）
# 不需要知道舊位置：一律以「這個腳本所在的資料夾」為準
# ─────────────────────────────────────────────────────────────
FIX=0; [ "$1" = "--fix" ] && FIX=1
APP="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${INVEST_BACKUP_BASE:-$(cd "$APP/.." && pwd)/invest-backup}"
NODE="$(command -v node || echo /usr/local/bin/node)"
PM2="$(command -v pm2 || echo /usr/local/bin/pm2)"
DOCKER="$(command -v docker || echo /usr/local/bin/docker)"
OK=0; BAD=0; FIXES=()
ok()  { echo "  ✓ $*"; OK=$((OK+1)); }
bad() { echo "  ✕ $1"; BAD=$((BAD+1)); [ -n "$2" ] && FIXES+=("$2"); }
info(){ echo "  · $*"; }

echo "▶ 位置"
info "程式資料夾：$APP"
info "備援資料：  $BASE"
[ -d "$APP/.git" ] && ok "程式是 git 資料夾" || bad "找不到 $APP/.git（程式不完整）" "重新下載：git clone https://github.com/weichehuang11-cyber/invest-dashboard.git \"$APP\""
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q 2>/dev/null && { L=$(git -C "$APP" rev-parse HEAD); R=$(git -C "$APP" rev-parse @{u} 2>/dev/null); [ "$L" = "$R" ] && ok "程式是最新版" || bad "程式不是最新版" "cd \"$APP\" && git pull"; } || bad "git 連不到 GitHub（網路或權限）"
  [ -z "$(git -C "$APP" status --porcelain --untracked-files=no)" ] && ok "沒有被改動的程式檔" || bad "有程式檔被改動，git pull 可能失敗" "cd \"$APP\" && git status   # 確認後 git checkout -- ."
fi
[ -d "$BASE" ] && ok "備援資料夾存在" || bad "備援資料夾不存在（第一次執行或搬移後沒跟著搬）" "mkdir -p \"$BASE\" && bash \"$APP/nas/run-backup.sh\" all"
if [ -d "$BASE" ]; then
  W=$(touch "$BASE/.w" 2>&1 && rm -f "$BASE/.w"); [ -z "$W" ] && ok "備援資料夾可寫入" || bad "備援資料夾無法寫入（權限）" "sudo chown -R $(id -un) \"$BASE\""
  FREE=$(df -Pm "$BASE" | awk 'NR==2{print $4}'); [ "${FREE:-0}" -gt 2048 ] && ok "所在儲存區剩餘 $((FREE/1024)) GB" || bad "所在儲存區剩餘不到 2 GB（$FREE MB）"
  if [ -f "$BASE/run.log" ]; then info "最後一次備援：$(tail -1 "$BASE/run.log" | cut -c1-90)"; fi
fi

echo "▶ 執行環境"
[ -x "$NODE" ] && ok "Node.js $("$NODE" -v)" || bad "找不到 node" "到套件中心重新安裝 Node.js"
[ -d "$APP/node_modules" ] && ok "套件已安裝" || bad "套件沒安裝（node_modules 不見了）" "cd \"$APP\" && ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev --no-audit --no-fund"

echo "▶ 備援伺服器（pm2：signal-backup）"
if [ -x "$PM2" ] && "$PM2" describe signal-backup >/dev/null 2>&1; then
  P=$("$PM2" jlist 2>/dev/null | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s).find(x=>x.name==='signal-backup');console.log((a?.pm2_env?.pm_exec_path||'')+'|'+(a?.pm2_env?.status||'')+'|'+(a?.pm2_env?.env?.INVEST_BACKUP_BASE||''))})")
  SP="${P%%|*}"; REST="${P#*|}"; ST="${REST%%|*}"; EB="${REST#*|}"
  [ "$SP" = "$APP/nas/server.js" ] && ok "執行的是這個資料夾的程式" || bad "pm2 執行的程式在別的位置：$SP" "$PM2 delete signal-backup && $PM2 start \"$APP/nas/server.js\" --name signal-backup --interpreter \"$NODE\" && $PM2 save"
  [ -f "$SP" ] || bad "pm2 記錄的程式檔已經不存在（資料夾搬走了）"
  [ "$ST" = "online" ] && ok "狀態 online" || bad "狀態是 $ST" "$PM2 restart signal-backup"
  [ -n "$EB" ] && [ "$EB" != "$BASE" ] && bad "pm2 設定的備援資料夾是 $EB，和預期的 $BASE 不同"
else
  bad "pm2 裡沒有 signal-backup" "$PM2 start \"$APP/nas/server.js\" --name signal-backup --interpreter \"$NODE\" && $PM2 save"
fi
J=$(curl -fsS -m 5 http://127.0.0.1:8765/backup/status.json 2>/dev/null)
[ -n "$J" ] && ok "http://127.0.0.1:8765 有回應" || bad "8765 沒有回應（伺服器沒在跑或埠被占用）" "$PM2 logs signal-backup --lines 30"
L=$(curl -fsS -m 5 http://127.0.0.1:8765/live.json 2>/dev/null | head -c 200)
echo "$L" | grep -q '"items"' && ok "即時行情 /live.json 正常" || bad "即時行情 /live.json 沒有資料"
[ -f "$BASE/site/data/snapshot.json" ] && { A=$(( ($(date +%s) - $(stat -c %Y "$BASE/site/data/snapshot.json")) / 3600 )); [ $A -lt 72 ] && ok "備援資料 $A 小時前更新" || bad "備援資料已 $A 小時沒更新" "bash \"$APP/nas/run-backup.sh\" all"; } || bad "沒有備援資料（site/data/snapshot.json）" "bash \"$APP/nas/run-backup.sh\" all"

echo "▶ 即時警報（nas/.env）"
ENVF="$APP/nas/.env"
grep -q "^NTFY_TOPIC=." "$ENVF" 2>/dev/null && ok "推播已設定（NTFY_TOPIC）" || bad "nas/.env 沒有 NTFY_TOPIC，NAS 即時警報不會推播" "echo 'NTFY_TOPIC=你的主題' >> \"$ENVF\" && $PM2 restart signal-backup"
grep -q "^BACKUP_PASSPHRASE=." "$ENVF" 2>/dev/null && grep -q "^BACKUP_GIST_ID=." "$ENVF" 2>/dev/null && ok "已設定個人資料（持股停損、提醒價會即時通知）" || info "nas/.env 沒有 BACKUP_GIST_ID／BACKUP_PASSPHRASE：只會通知指數，不含持股與提醒價"
echo "▶ 獨立網址（Docker：ts-signal）"
TS="$APP/nas/tailscale"
SD="sudo"; [ "$(id -u)" = 0 ] && SD=""
[ -n "$CHECK_AUTO" ] && [ -n "$SD" ] && SD="sudo -n"   # 自動體檢不能輸入密碼
DOCKER_OK=1; if [ "$SD" = "sudo -n" ] && ! sudo -n true 2>/dev/null; then DOCKER_OK=0; fi
if [ $DOCKER_OK = 0 ]; then info "自動體檢沒有 sudo 權限，略過 Docker 檢查（手動執行時會檢查）"
elif $SD "$DOCKER" inspect ts-signal >/dev/null 2>&1; then
  RUN=$($SD "$DOCKER" inspect -f '{{.State.Running}}' ts-signal)
  [ "$RUN" = "true" ] && ok "容器執行中" || bad "容器沒有在執行" "cd \"$TS\" && sudo docker compose up -d"
  SRC=$($SD "$DOCKER" inspect -f '{{range .Mounts}}{{.Source}} {{end}}' ts-signal)
  echo "$SRC" | grep -q "$TS/state" && ok "容器用的是這個資料夾的設定" || bad "容器掛載的是舊位置：$SRC" "cd \"$TS\" && sudo docker compose down; sudo docker rm -f ts-signal; sudo docker compose up -d   # 登入狀態在 state 資料夾，有一起搬就不用重新登入"
  [ -f "$TS/state/tailscaled.state" ] && ok "登入狀態檔存在" || bad "state 資料夾沒有登入狀態（容器啟動後要重新授權）"
  IP=$(grep -o 'http://[0-9.]*:8765' "$TS/serve.json" | sed 's#http://##;s#:8765##')
  curl -fsS -m 5 "http://$IP:8765/backup/status.json" >/dev/null 2>&1 && ok "serve.json 指向的 $IP:8765 連得到" || bad "serve.json 指向的 $IP:8765 連不到（NAS 的 IP 變了？）" "編輯 $TS/serve.json 把 IP 改成 NAS 現在的區網 IP，再 cd \"$TS\" && sudo docker compose restart"
  H=$($SD "$DOCKER" exec ts-signal tailscale status --self --json 2>/dev/null | "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,''))}catch(_){}})")
  [ -n "$H" ] && { info "網址：https://$H"; curl -fsS -m 10 "https://$H/live.json" >/dev/null 2>&1 && ok "https://$H 從 NAS 連得到" || info "https://$H 從 NAS 本身測不到（NAS 沒裝 Tailscale 時正常，請用手機測）"; }
else
  bad "找不到 ts-signal 容器" "cd \"$TS\" && sudo docker compose up -d"
fi

echo "▶ 不再需要的東西"
[ $DOCKER_OK = 1 ] && { $SD "$DOCKER" inspect github-runner >/dev/null 2>&1 && bad "舊的 github-runner 容器還在" "sudo docker rm -f github-runner" || ok "沒有舊的 github-runner 容器"; }

echo
echo "結果：$OK 項正常、$BAD 項有問題"
if [ $BAD -gt 0 ] && [ ${#FIXES[@]} -gt 0 ]; then
  echo "建議修正："
  for f in "${FIXES[@]}"; do echo "  $f"; done
fi
if [ $FIX = 1 ] && [ $BAD -gt 0 ]; then
  echo; echo "▶ 自動修正"
  [ -d "$APP/node_modules" ] || (cd "$APP" && ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev --no-audit --no-fund)
  mkdir -p "$BASE" "$TS/state"
  "$PM2" delete signal-backup >/dev/null 2>&1
  "$PM2" start "$APP/nas/server.js" --name signal-backup --interpreter "$NODE" && "$PM2" save
  (cd "$TS" && sudo docker compose up -d --force-recreate)
  echo "完成，10 秒後重新檢查…"; sleep 10; exec bash "$0"
fi
