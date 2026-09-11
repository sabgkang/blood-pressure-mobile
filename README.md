# 血壓紀錄助手

---

master branch 是使用早期 Claude Code 開發，已使用一段時間，現在佈署在 Racknerd VPS。
2026-09-11 使用 Codex (5.5 Sol) 修正問題。但  Racknerd VPS 還是使用 master，有需要再用新版吧。
為測試起見，先將 PWA disabled

---

手機優先的血壓紀錄網頁。按住使用者按鈕錄音，伺服器會透過區域網路內的 TEA-ASR-1.1 API 將語音轉成文字，驗證血壓數值後保存至 `data/records.json`，並可選擇同步至 Webhook。

## 設定與啟動

1. 複製 `.env.example` 為 `.env`。
2. 設定 `ASR_API_URL=https://tea-asr4090.yo3dp.cc/v1/audio/transcriptions`。
3. 若 TEA-ASR Docker 有設定 `ASR_API_KEY`，此處必須設定相同金鑰。
4. 設定 `APP_USERNAME` 與至少 12 字元的 `APP_PASSWORD`。
5. 如需遠端同步，設定 `WEBHOOK_URL` 與 `WEBHOOK_METHOD`。目前 n8n 端點使用 GET query：

   `?UR=A&BU=120&BD=80&HR=70`

6. 安裝並啟動：

   ```sh
   npm install
   npm start
   ```

瀏覽 `http://localhost:3000`，使用瀏覽器的登入視窗輸入帳號密碼。非 localhost 部署必須使用 HTTPS，否則手機瀏覽器不會開放麥克風。

## 測試

```sh
npm test
```

## 資料與隱私

- 原始錄音會傳送至 `ASR_API_URL` 的 TEA-ASR 服務；Node App 不會將錄音寫入磁碟。
- 血壓、心率、時間及使用者代號會保存於伺服器的 `data/records.json`。
- 設定 Webhook 後，相同的測量值會以 HTTPS GET 同步。
- `data/`、`.env`、`.env.local` 與記錄檔已排除於 Git。
- 正式環境應在反向代理上啟用 HTTPS，並妥善備份及限制資料檔存取權。

TEA-ASR Docker 的建置與執行方式請參考 [tea-asr-service/README.md](tea-asr-service/README.md)。
