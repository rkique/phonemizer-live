# syntax=docker/dockerfile:1
FROM python:3.11-slim

# ffmpeg: audio format conversion. espeak-ng: phonemizer's G2P backend.
# build-essential: safety net for any package without a prebuilt wheel on
# this architecture (e.g. ctranslate2 on non-x86_64 hosts).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      espeak-ng \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the whisper models into the image at build time instead of on first
# request, so a fresh deploy doesn't stall a user's first transcription on a
# ~500MB download. small.en covers English (the default); small is the
# multilingual model used for every other supported language. Deliberately
# placed before `COPY . .` so a code-only change doesn't invalidate this
# layer and force a re-download on every deploy — only a requirements.txt
# change (e.g. bumping faster-whisper) does.
RUN python -c "from faster_whisper import WhisperModel; \
WhisperModel('small.en', device='cpu', compute_type='int8'); \
WhisperModel('small', device='cpu', compute_type='int8')"

COPY . .

RUN mkdir -p /app/data/audio

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
