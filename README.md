# 訊號終端（GitHub 主站）

投資 dashboard 的主站。網站放在 GitHub Pages，資料由 GitHub 雲端排程產生；NAS 負責備援與歷史資料；在自己的電腦上打開時，自動使用本機的 NPU、CPU 與語言模型。

| 角色 | 放在哪裡 | 做什麼 |
|---|---|---|
| 主站 | GitHub Pages | 手機、電腦用同一個網址打開 |
| 資料更新 | GitHub 雲端排程（`.github/workflows/update.yml`） | 台股、美股盤中每 30 分鐘；收盤後各一次完整更新 |
| 備援＋歷史 | NAS（`nas/run-backup.sh`） | 用同一套程式獨立產生資料、永久封存每次快照、每日備份 |
| 加速 | 你的電腦 | 自動偵測 `localhost` 的 NPU（8766）、CPU（8767）、語言模型（8768） |

> 這個網站是公開的。持股、成本只存在你自己裝置的瀏覽器裡，不會上傳。

## 第一次設定

1. **開啟網站**：專案 **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
2. **FinMind 權杖（建議）**：**Settings → Secrets and variables → Actions → New repository secret**，名稱 `FINMIND_TOKEN`，填入 FinMind 權杖。沒有也能跑，只是台股沒有法人歷史與月營收。
3. **第一次更新**：**Actions → 更新資料並發布網站 → Run workflow**，「完整更新」填 `all`。約 2–3 分鐘後網站就有資料。
4. 網址：`https://<你的帳號>.github.io/invest-dashboard/`

## 觀察清單

編輯 `config/watchlist.json`（可以直接在 GitHub 網頁上改），存檔後會自動重新產生資料。

## 排程（台北時間）

| 時間 | 內容 |
|---|---|
| 週一至週五 09:07–13:37，每 30 分鐘 | 台股盤中更新 |
| 週一至週五 16:47 | 台股收盤後完整更新（三大法人、FinMind、記錄當日訊號） |
| 週一至週五 21:07–04:37，每 30 分鐘 | 美股盤中更新 |
| 週二至週六 05:37 | 美股收盤後完整更新（基本面、財報日、記錄當日訊號） |

GitHub 排程偶爾會延遲幾分鐘。預測紀錄、昨日訊號等狀態存在 `data` 分支。

## NAS 備援

在 NAS 上（SSH）：

```
cd /volume2/homes
git clone https://github.com/<你的帳號>/invest-dashboard.git
cd invest-dashboard
ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev
bash nas/run-backup.sh all          # 第一次完整產生
```

DSM **控制台 → 任務排程表 → 新增 → 排定的任務 → 使用者定義的指令碼**，建立三個任務（使用者選你的帳號）：

| 任務 | 時間 | 指令 |
|---|---|---|
| 盤中備援 | 每天、每 30 分鐘 | `bash /volume2/homes/invest-dashboard/nas/run-backup.sh` |
| 台股收盤 | 週一至週五 16:55 | `bash /volume2/homes/invest-dashboard/nas/run-backup.sh tw` |
| 美股收盤 | 週二至週六 05:45 | `bash /volume2/homes/invest-dashboard/nas/run-backup.sh us` |

產出在 `/volume2/homes/invest-backup/`：

- `site/`：完整備援網站，NAS 伺服器以 `http://NAS:8765/backup/` 提供
- `archive/snapshots/日期/時間.json`：每次快照，永久保留
- `archive/daily/日期.json`：每日收盤
- `archive/backup/`：NAS 主程式紀錄的每日備份（保留 60 天）

### 讓 GitHub 網站能讀到 NAS（Tailscale）

GitHub 網站是 https，只能讀 https 網址的 NAS。

1. DSM **套件中心**安裝 **Tailscale**，登入你的 Tailscale 帳號。
2. 到 Tailscale 管理後台 **DNS**，開啟 **MagicDNS** 與 **HTTPS Certificates**。
3. NAS 上（SSH）執行：`sudo tailscale serve --bg 8765`（找不到指令時改用 `sudo /var/packages/Tailscale/target/bin/tailscale serve --bg 8765`）
4. 網址會是 `https://<NAS 名稱>.<你的 tailnet>.ts.net`。在網站 **設定 → NAS 備援網址** 填入，按「測試連線」。
5. 手機、電腦要安裝 Tailscale App 並登入同一個帳號，才連得到（NAS 不會暴露在公開網路上）。

## 本機加速

在你的 Windows 電腦執行專案 `invest` 裡的 `start-local-infer.bat`（啟動 NPU 8766、CPU 8767、語言模型 8768）。用同一台電腦打開網站，右上角會顯示「本機加速：NPU、CPU、語言模型」：

- 機會清單與個股頁多出「本機 1 日／5 日預測」
- 今日判斷與個股頁多出「本機 AI 解讀」

第一次 Chrome／Edge 可能詢問「是否允許存取區域網路上的裝置」，請按允許。手機或其他電腦打開時會自動略過，改用雲端計算的結果。

## 開發

```
npm ci
node pipeline/build.js --full=all --out=out/data --state=state   # 產生資料
cp -r site/. out/ && npx serve out                                 # 本機預覽
node -r ./pipeline/test/mock-fetch.js pipeline/build.js --full=all  # 用模擬資料測試（不連網）
```
