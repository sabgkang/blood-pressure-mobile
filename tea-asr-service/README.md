# TEA-ASR-1.1 Docker API

適用於 Ubuntu 24.04 與 NVIDIA RTX 4090。主機需先安裝 NVIDIA 驅動程式、Docker Engine 與 NVIDIA Container Toolkit。

## 建置

```bash
cd tea-asr-service
docker build -t tea-asr-api:1.1 .
```

## 啟動

```bash
docker run -d \
  --name tea-asr-api \
  --restart unless-stopped \
  --gpus all \
  --shm-size=4g \
  -p 8000:8000 \
  -e ASR_API_KEY='replace-with-a-long-random-key' \
  -v tea-asr-models:/models \
  tea-asr-api:1.1
```

第一次啟動會從 Hugging Face 下載約 2B 參數的模型，因此健康檢查需等待模型下載及載入完成。
API 會先用 FFmpeg 將 WebM、M4A、MP3、OGG 或 WAV 統一轉換成 16 kHz 單聲道 WAV，再交給模型辨識。

## 驗證

```bash
curl http://127.0.0.1:8000/health

curl -X POST http://127.0.0.1:8000/v1/audio/transcriptions \
  -H 'Authorization: Bearer replace-with-a-long-random-key' \
  -F 'file=@sample.webm' \
  -F 'model=JacobLinCool/TEA-ASR-1.1' \
  -F 'language=Chinese'
```

若 Ubuntu 防火牆已啟用，只允許區域網路連入：

```bash
sudo ufw allow from 10.3.56.0/21 to any port 8000 proto tcp
```
