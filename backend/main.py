import io
import json
import os
import sqlite3
import tempfile
import zipfile
from collections import defaultdict
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

import storage
from transcribe import (
    CANONICAL_INVENTORY,
    DEFAULT_LANGUAGE,
    SUPPORTED_LANGUAGES,
    build_units,
    convert_to_wav,
    normalize_phoneme,
    render_segment_spectrogram,
    render_spectrogram,
    transcribe_audio_with_words,
    units_to_ipa,
    whisper_language_for,
    word_to_pinyin,
)

_LANGUAGE_CODES = {lang["code"] for lang in SUPPORTED_LANGUAGES}
_LANGUAGE_LABELS = {lang["code"]: lang["label"] for lang in SUPPORTED_LANGUAGES}

AUDIO_DIR = Path(__file__).parent / "data" / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Sonority IPA Transcription")

# Local dev origins always allowed; production domain(s) come from the
# ALLOWED_ORIGINS env var (comma-separated) so this doesn't need a code
# change per deployment target.
_DEFAULT_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:5174",
    "https://phonemizer.live",
    "https://www.phonemizer.live",
]
_extra_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_DEFAULT_ORIGINS + _extra_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

storage.init_db()

#serialize a sqlite3.Row to a machine-readable version
# Intended for over-the-wire use in frontend.
def _serialize(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "text": row["text"],
        "ipa": row["ipa"],
        "duration": row["duration"],
        "units": json.loads(row["units_json"]) if row["units_json"] else [],
        "words": json.loads(row["words_json"]) if row["words_json"] else [],
        "audio_url": f"/media/{row['id']}.wav" if row["audio_path"] else None,
        "spectrogram_url": f"/media/{row['id']}.png" if row["spectrogram_path"] else None,
        "created_at": row["created_at"],
        "language": row["language"],
        "language_label": _LANGUAGE_LABELS.get(row["language"], row["language"]),
    }

#Text export with additional tagging.
def _text_export(row: sqlite3.Row) -> str:
    return (
        f"Text: {row['text']}\n"
        f"IPA: {row['ipa']}\n"
        f"Recorded: {row['created_at']}\n"
        f"Duration: {row['duration']:.2f}s\n"
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


#Wraps transcribe_audio_with_words from transcribe
@app.post("/transcribe")
async def transcribe(audio: UploadFile, language: str = Form(DEFAULT_LANGUAGE)) -> dict:
    if language not in _LANGUAGE_CODES:
        language = DEFAULT_LANGUAGE
    suffix = Path(audio.filename or "clip.webm").suffix or ".webm"

    with tempfile.TemporaryDirectory() as tmp_dir:
        src_path = Path(tmp_dir) / f"clip{suffix}"
        src_path.write_bytes(await audio.read())

        wav_path = Path(tmp_dir) / "clip.wav"
        convert_to_wav(str(src_path), str(wav_path))

        text, words, duration = transcribe_audio_with_words(
            str(wav_path), whisper_language_for(language)
        )
        if not text:
            return {"id": None, "text": "", "ipa": "", "units": [], "words": [], "duration": 0}

        if language == "cmn":
            for w in words:
                w["pinyin"] = word_to_pinyin(w["word"])

        units = build_units(words, duration, language)
        ipa = units_to_ipa(units)

        row = storage.insert_transcript(
            text, ipa, duration, json.dumps(units), json.dumps(words), language
        )
        media_id = row["id"]

        final_wav = AUDIO_DIR / f"{media_id}.wav"
        wav_path.replace(final_wav)
        png_path = AUDIO_DIR / f"{media_id}.png"
        render_spectrogram(str(final_wav), str(png_path))

        storage.update_media_paths(media_id, str(final_wav), str(png_path))
        row = storage.get_transcript(media_id)

    return _serialize(row)


@app.get("/languages")
def languages() -> dict:
    return {"languages": SUPPORTED_LANGUAGES, "default": DEFAULT_LANGUAGE}


@app.get("/history")
def history(limit: int = 200) -> list[dict]:
    return [_serialize(r) for r in storage.list_transcripts(limit)]


@app.get("/phonemes")
def phonemes() -> dict:
    occurrences: dict[str, list[dict]] = defaultdict(list)

    for row in storage.list_transcripts(limit=100000):
        if not row["units_json"]:
            continue
        units = json.loads(row["units_json"])
        words = json.loads(row["words_json"]) if row["words_json"] else []

        def word_at(t: float) -> str:
            for w in words:
                if w["start"] <= t < w["end"]:
                    return w["word"]
            return ""

        for u in units:
            if u["kind"] != "phoneme":
                continue
            symbol = normalize_phoneme(u["ch"])
            if not symbol or any(c.isdigit() or c in "()." for c in symbol):
                # Guards against stale rows recorded before tone-digit and
                # language-switch-tag stripping was fixed in text_to_ipa —
                # these aren't real phonemes and shouldn't show up here.
                continue
            occurrences[symbol].append(
                {
                    "transcript_id": row["id"],
                    "word": word_at(u["start"]),
                    "start": u["start"],
                    "end": u["end"],
                }
            )

    inventory = []
    seen = set()
    for entry in CANONICAL_INVENTORY:
        symbol = entry["symbol"]
        seen.add(symbol)
        examples = occurrences.get(symbol, [])
        inventory.append(
            {
                "symbol": symbol,
                "category": entry["category"],
                "count": len(examples),
                "examples": examples,
            }
        )

    for symbol in sorted(set(occurrences) - seen):
        examples = occurrences[symbol]
        inventory.append(
            {
                "symbol": symbol,
                "category": "other",
                "count": len(examples),
                "examples": examples,
            }
        )

    return {"inventory": inventory}


@app.get("/media/{transcript_id}/segment.png")
def segment_spectrogram(transcript_id: int, start: float, end: float) -> Response:
    row = storage.get_transcript(transcript_id)
    if row is None or not row["audio_path"]:
        raise HTTPException(status_code=404, detail="no audio for this recording")
    png_bytes = render_segment_spectrogram(row["audio_path"], start, end)
    return Response(content=png_bytes, media_type="image/png")


@app.delete("/transcripts/{transcript_id}")
def delete_transcript(transcript_id: int) -> dict:
    row = storage.delete_transcript(transcript_id)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    for key in ("audio_path", "spectrogram_path"):
        path = row[key]
        if path:
            Path(path).unlink(missing_ok=True)
    return {"deleted": transcript_id}


@app.get("/transcripts/{transcript_id}/export.txt")
def export_txt(transcript_id: int) -> Response:
    row = storage.get_transcript(transcript_id)
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    return Response(
        content=_text_export(row),
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{transcript_id}.txt"'},
    )


@app.get("/transcripts/{transcript_id}/export.wav")
def export_wav(transcript_id: int) -> FileResponse:
    row = storage.get_transcript(transcript_id)
    if row is None or not row["audio_path"] or not Path(row["audio_path"]).exists():
        raise HTTPException(status_code=404, detail="no audio for this recording")
    return FileResponse(
        row["audio_path"], media_type="audio/wav", filename=f"{transcript_id}.wav"
    )


@app.get("/export/bulk")
def export_bulk(ids: str) -> Response:
    id_list = [int(x) for x in ids.split(",") if x.strip()]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for transcript_id in id_list:
            row = storage.get_transcript(transcript_id)
            if row is None:
                continue
            zf.writestr(f"{transcript_id}.txt", _text_export(row))
            if row["audio_path"] and Path(row["audio_path"]).exists():
                zf.write(row["audio_path"], arcname=f"{transcript_id}.wav")

    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="sonority_export.zip"'},
    )


app.mount("/media", StaticFiles(directory=AUDIO_DIR), name="media")
