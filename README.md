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

## 市場健康度、事件行事曆、組合分析

- **市場健康度**（總覽）：台股漲跌家數、站上 20／60 日線比例、20 日新高新低（收盤歷史存在 `data` 分支，第一次自動往回補 25 個交易日）；外資台指期未平倉、台指選擇權 P/C 比（期交所）、VIX 期限結構；外資累計與融資餘額；台股本益比中位數、標普本益比與股債利差；美國高收益債利差、金融壓力指數（FRED）。異常會自動列入「今天有什麼變了」與今日判斷。
- **事件行事曆**：FOMC、CPI、非農、央行（`config/events.json`，可自行修改）＋自動推算的台指期結算、美股選擇權到期、月營收截止＋觀察清單財報日。
- **組合分析**（持股頁）：今日損益歸因、對照同配置大盤的績效、波動與最大回撤、組合 Beta、有效持股數、持股相關係數。
- **我的市場感覺**：總覽可每天記錄對台股、美股的感覺（極度恐慌～過熱）；決策紀錄可標註「依據市場感覺」。「我的成績」會統計你的感覺是順勢還是反向指標。

## 指數走勢與推論

總覽的「指數走勢與推論」（加權、標普 500、那斯達克、費城半導體）與每個個股頁的「技術解讀與走勢推論」：

- **技術解讀**：均線排列、季線／年線突破、MACD、KD、RSI、布林通道、量價、支撐壓力，規則化產生中文評論（描述現況）。
- **走勢推論**：波動調整的歷史模擬，給出 5 日與 20 日的中位數、50%／80% 區間，以及「過去相同趨勢狀態下」的上漲機率。
- **可靠度**：每天滾動回測（只用當時以前的資料），顯示 80%／50% 區間實際涵蓋率與方向命中率，並和「單純猜測」基準比較。指數用 10 年日 K。

## 我的論點與成績單

讓這個 dashboard 反映你自己的判斷，而不只是通用訊號（全部只存在你的裝置，不上傳）：

- **我的論點**（個股頁）：寫下理由、目標價、出場條件（跌破價格、虧損超過 %、跌破均線、外資連賣、營收年減、財報前…）。每次資料更新自動檢查，觸發就排在總覽最上面。
- **記錄我的決定**（個股頁）：按「我買了／我賣了／決定不動」，連同理由與當時情境存下來。
- **我的成績單**（底部「我的」）：用之後 1／5／20 個交易日的實際收盤結算，算出你的勝率、是否贏大盤、和系統比較，並找出你的習慣（例如追高、跌破均線買進的平均結果）。
- 持股頁的「匯出／匯入」會一起帶走論點、決策紀錄、自選與提醒。

## 本機加速

在你的 Windows 電腦對專案 `invest` 裡的 `install-autostart.bat` 按兩下（只要一次），之後每次登入 Windows 都會在背景啟動 NPU 8766、CPU 8767、語言模型 8768。用同一台電腦打開網站，右上角會顯示「本機加速：NPU、CPU、語言模型」：

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
