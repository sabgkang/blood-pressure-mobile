# 血壓紀錄助手


---

master branch 是使用早期 Claude Code 開發，已使用一段時間，現在佈署在 Racknerd VPS。
2026-09-11 使用 Codex (5.5 Sol) 修正問題。但  Racknerd VPS 還是使用 master，有需要再用新版吧。
為測試起見，先將 PWA disabled

---

手機優先的 PWA。按住使用者按鈕錄音，伺服器會透過 OpenAI 語音轉文字，驗證血壓數值後保存至 `data/records.json`，並可選擇同步至 Webhook。

## 設定與啟動

1. 複製 `.env.example` 為 `.env`。
2. 設定 `OPENAI_API_KEY`、`APP_USERNAME` 與高強度的 `APP_PASSWORD`。
3. 如需遠端同步，設定 `WEBHOOK_URL`。Webhook 必須接受 JSON 格式的 POST：

   `{"UR":"A","BU":120,"BD":80,"HR":70}`

4. 安裝並啟動：

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

- 原始錄音會送至 OpenAI 進行轉錄，不會寫入本機磁碟。
- 血壓、心率、時間及使用者代號會保存於伺服器的 `data/records.json`。
- 設定 Webhook 後，相同的測量值會以 HTTPS POST 同步。
- `data/`、`.env` 與記錄檔已排除於 Git。
- 正式環境應在反向代理上啟用 HTTPS，並妥善備份及限制資料檔存取權。
