import asyncio
import hmac
import logging
import os
import subprocess
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import torch
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from qwen_asr import Qwen3ASRModel

MODEL_ID = os.getenv("MODEL_ID", "JacobLinCool/TEA-ASR-1.1")
ASR_API_KEY = os.getenv("ASR_API_KEY", "")
MAX_AUDIO_BYTES = int(os.getenv("MAX_AUDIO_BYTES", str(15 * 1024 * 1024)))
MAX_NEW_TOKENS = int(os.getenv("MAX_NEW_TOKENS", "256"))
FFMPEG_TIMEOUT_SECONDS = int(os.getenv("FFMPEG_TIMEOUT_SECONDS", "60"))
API_VERSION = "1.1.2-debug"
logger = logging.getLogger("uvicorn.error")
CONTENT_TYPE_SUFFIXES = {
    "audio/webm": ".webm",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU is required; start Docker with --gpus all")
    app.state.model = await asyncio.to_thread(
        Qwen3ASRModel.from_pretrained,
        MODEL_ID,
        dtype=torch.bfloat16,
        device_map="cuda:0",
        max_inference_batch_size=1,
        max_new_tokens=MAX_NEW_TOKENS,
    )
    app.state.inference_lock = asyncio.Lock()
    yield
    app.state.model = None
    torch.cuda.empty_cache()


app = FastAPI(title="TEA-ASR API", version="1.0.0", lifespan=lifespan)


def authorize(authorization: str | None) -> None:
    if not ASR_API_KEY:
        return
    expected = "Bearer " + ASR_API_KEY
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Invalid API key")


def transcribe_file(model, audio_path: str, language: str, context: str | None):
    kwargs = {"audio": audio_path, "language": language}
    if context:
        kwargs["context"] = context
    result = model.transcribe(**kwargs)[0]
    return {
        "text": result.text,
        "language": getattr(result, "language", language),
        "model": MODEL_ID,
    }


def convert_to_wav(source_path: str, wav_path: str) -> None:
    process = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            source_path,
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            wav_path,
        ],
        capture_output=True,
        text=True,
        timeout=FFMPEG_TIMEOUT_SECONDS,
        check=False,
    )
    if process.returncode != 0:
        raise ValueError("FFmpeg conversion failed: " + process.stderr.strip()[-1000:])


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "api_version": API_VERSION,
        "model": MODEL_ID,
        "cuda": torch.cuda.get_device_name(0),
    }


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: str = Form(default=MODEL_ID),
    language: str = Form(default="Chinese"),
    context: str | None = Form(default=None),
    authorization: str | None = Header(default=None),
):
    authorize(authorization)
    if model not in {MODEL_ID, "tea-asr-1.1", "JacobLinCool/TEA-ASR-1.1"}:
        raise HTTPException(status_code=400, detail="Unsupported model")

    content_type = (file.content_type or "").split(";", 1)[0].lower()
    suffix = CONTENT_TYPE_SUFFIXES.get(content_type)
    if not suffix:
        suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".webm", ".m4a", ".mp4", ".mp3", ".ogg", ".wav"}:
        raise HTTPException(status_code=415, detail="Unsupported audio format")

    audio = await file.read(MAX_AUDIO_BYTES + 1)
    await file.close()
    if not audio:
        raise HTTPException(status_code=400, detail="Empty audio file")
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio file exceeds size limit")

    temp_path = None
    wav_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp:
            temp.write(audio)
            temp_path = temp.name
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as wav:
            wav_path = wav.name
        try:
            await asyncio.to_thread(convert_to_wav, temp_path, wav_path)
        except Exception as error:
            logger.exception(
                "Audio conversion failed: content_type=%s size=%d suffix=%s",
                content_type,
                len(audio),
                suffix,
            )
            raise HTTPException(
                status_code=422,
                detail="Audio conversion failed: " + str(error)[-500:],
            ) from error

        try:
            async with app.state.inference_lock:
                return await asyncio.to_thread(
                    transcribe_file,
                    app.state.model,
                    wav_path,
                    language,
                    context,
                )
        except Exception as error:
            logger.exception(
                "Model inference failed: content_type=%s size=%d",
                content_type,
                len(audio),
            )
            raise HTTPException(
                status_code=500,
                detail="Model inference failed: " + type(error).__name__ + ": " + str(error)[-500:],
            ) from error
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("Unexpected transcription error")
        raise HTTPException(status_code=500, detail="Unexpected transcription error") from error
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)
        if wav_path:
            Path(wav_path).unlink(missing_ok=True)
