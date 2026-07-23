import io
import json
import os
import shutil
import sqlite3
import tempfile
import zipfile
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

import drive
import google_auth
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
SAMPLE_AUDIO_DIR = Path(__file__).parent / "sample_audio"

# Sibling to AUDIO_DIR (not nested inside it) so these per-template files
# are never reachable through the /media static mount, which is scoped to
# AUDIO_DIR only.

TEMPLATE_DIR = Path(__file__).parent / "data" / "_templates"
TEMPLATE_MANIFEST = TEMPLATE_DIR / "manifest.json"

# Where /auth/google/callback sends the browser back to once sign-in
# finishes. Defaults to the Vite dev URL so local testing works with no
# env var set; production sets this explicitly.
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:5173")

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


def _session_dir(session_id: str) -> Path:
    d = AUDIO_DIR / session_id
    d.mkdir(parents=True, exist_ok=True)
    return d


# Gives every endpoint that needs to actually read wav bytes (spectrogram
# cropping, export, playback) a real local path to work with, regardless of
# whether the recording lives on disk or in the owner's Drive — downloads
# to a temp file in the Drive case and cleans it up on exit.
@contextmanager
def _wav_local_path(row: sqlite3.Row):
    if row["drive_wav_id"]:
        user_row = storage.get_user(row["session_id"])
        creds = drive.get_valid_credentials(user_row)
        data = drive.download_file(creds, row["drive_wav_id"])
        with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
            tmp.write(data)
            tmp.flush()
            yield Path(tmp.name)
    elif row["audio_path"]:
        yield Path(row["audio_path"])
    else:
        raise HTTPException(status_code=404, detail="no audio for this recording")


# For handlers that hand bytes off to something outside this function's own
# scope (FileResponse streams asynchronously after return, zipfile just
# wants bytes) — a temp file from _wav_local_path would already be deleted
# by then, so this reads fully into memory instead. Recordings here are
# short clips, not large media, so that's not a real cost.
def _get_wav_bytes(row: sqlite3.Row) -> bytes | None:
    if row["drive_wav_id"]:
        user_row = storage.get_user(row["session_id"])
        creds = drive.get_valid_credentials(user_row)
        return drive.download_file(creds, row["drive_wav_id"])
    if row["audio_path"] and Path(row["audio_path"]).exists():
        return Path(row["audio_path"]).read_bytes()
    return None


# Every endpoint that touches recordings requires this — an anonymous
# per-browser identifier the frontend generates once and keeps in
# localStorage. 

# This is a partition key so recordings from different visitors never mix. 
# #Plain <a>/<img>-driven requests (exports,segment thumbnails) 
# can't attach a custom header, so those fall back to a query param instead.
def require_session_id(
    x_session_id: str | None = Header(default=None),
    session_id: str | None = Query(default=None),
) -> str:
    sid = x_session_id or session_id
    if not sid or len(sid) > 128:
        raise HTTPException(status_code=400, detail="Missing or invalid session id")
    return sid

# Makes the file recognizable at a glance in Drive's own file list, where
# only the name is visible without opening each one. media_id (the DB's
# actual dedup key) intentionally left out of the visible name — falls back
# to it only if a recording somehow has no IPA to label with.
def _drive_filename(media_id: int, ipa: str, ext: str) -> str:
    label = ipa.strip().replace("/", "-")[:60]
    return f"{label}.{ext}" if label else f"{media_id}.{ext}"


#serialize a sqlite3.Row to a machine-readable version
# Intended for over-the-wire use in frontend.
def _serialize(row: sqlite3.Row) -> dict:
    sid = row["session_id"]
    return {
        "id": row["id"],
        "text": row["text"],
        "ipa": row["ipa"],
        "duration": row["duration"],
        "units": json.loads(row["units_json"]) if row["units_json"] else [],
        "words": json.loads(row["words_json"]) if row["words_json"] else [],
        "audio_url": f"/media/{sid}/{row['id']}.wav" if (row["audio_path"] or row["drive_wav_id"]) else None,
        "spectrogram_url": f"/media/{sid}/{row['id']}.png" if row["spectrogram_path"] else None,
        "created_at": row["created_at"],
        "language": row["language"],
        "language_label": _LANGUAGE_LABELS.get(row["language"], row["language"]),
        "is_sample": bool(row["is_sample"]),
    }

#Text export with additional tagging.
def _text_export(row: sqlite3.Row) -> str:
    return (
        f"Text: {row['text']}\n"
        f"IPA: {row['ipa']}\n"
        f"Recorded: {row['created_at']}\n"
        f"Duration: {row['duration']:.2f}s\n"
    )


# Fetch-and-verify in one step: returns the same 404 whether the id doesn't
# exist at all or just doesn't belong to this session, so a caller can't
# distinguish "not found" from "not yours" by probing.
def _get_owned_transcript(transcript_id: int, session_id: str) -> sqlite3.Row:
    row = storage.get_transcript(transcript_id)
    if row is None or row["session_id"] != session_id:
        raise HTTPException(status_code=404, detail="not found")
    return row


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/auth/google/login")
def google_login(session_id: str = Depends(require_session_id)):
    if not google_auth.is_configured():
        raise HTTPException(status_code=503, detail="Google sign-in isn't configured on this server")
    # The current (anonymous, most likely) session_id rides along as the
    # OAuth "state" param so the callback knows whose recordings to fold
    # into the signed-in account. Low-stakes if tampered with — session ids
    # aren't secret, just partition keys, so the worst case is claiming
    # someone else's anonymous (never-signed-in) history, not a real
    # account takeover.
    auth_url = google_auth.build_auth_url(state=session_id)
    return RedirectResponse(auth_url)


@app.get("/auth/google/callback")
def google_callback(code: str, state: str):
    old_session_id = state
    creds = google_auth.exchange_code(code, state)
    userinfo = google_auth.get_userinfo(creds)
    google_sub = userinfo["sub"]
    email = userinfo.get("email", "")

    storage.upsert_user(
        google_sub,
        email,
        creds.token,
        creds.refresh_token,
        creds.expiry.isoformat() if creds.expiry else "",
    )
    storage.rekey_session_to_user(old_session_id, google_sub)

    return RedirectResponse(f"{FRONTEND_URL}/?google_session={google_sub}")


@app.get("/auth/me")
def auth_me(session_id: str = Depends(require_session_id)) -> dict:
    user_row = storage.get_user(session_id)
    if user_row is None:
        return {"linked": False, "email": None, "drive_folder_url": None}
    # drive_folder_id is only set on the first recording made after linking
    # (see drive.ensure_app_folder) — null until then, not a bug.
    folder_id = user_row["drive_folder_id"]
    folder_url = f"https://drive.google.com/drive/folders/{folder_id}" if folder_id else None
    return {"linked": True, "email": user_row["email"], "drive_folder_url": folder_url}


# Shared by /transcribe and sample seeding: takes a WAV file, runs the full
# pipeline, and stores it under the given session. Consumes (moves)
# wav_path — callers that want to keep their original file should pass in
# a copy.
def _ingest_wav(
    wav_path: Path, language: str, session_id: str, is_sample: bool = False
) -> sqlite3.Row | None:
    text, words, duration = transcribe_audio_with_words(
        str(wav_path), whisper_language_for(language)
    )
    if not text:
        return None

    if language == "cmn":
        for w in words:
            w["pinyin"] = word_to_pinyin(w["word"])

    units = build_units(words, duration, language)
    ipa = units_to_ipa(units)

    row = storage.insert_transcript(
        text, ipa, duration, json.dumps(units), json.dumps(words),
        language, session_id, is_sample,
    )
    media_id = row["id"]

    # A Google-linked session (session_id == google_sub — see
    # rekey_session_to_user) gets its audio uploaded to their own Drive
    # instead of the local data volume. The spectrogram is a cheap-to-derive
    # cache artifact, not something worth persisting to the user's Drive —
    # it's kept on the local data volume same as the anonymous path, and
    # regenerated from the wav on disk if that volume is ever wiped.
    user_row = storage.get_user(session_id)
    if user_row is not None:
        creds = drive.get_valid_credentials(user_row)
        folder_id = drive.ensure_app_folder(user_row, creds)
        wav_file_id = drive.upload_file(
            creds, folder_id, wav_path, _drive_filename(media_id, ipa, "wav"), "audio/wav"
        )
        storage.update_drive_ids(media_id, wav_file_id, None)

        png_path = _session_dir(session_id) / f"{media_id}.png"
        render_spectrogram(str(wav_path), str(png_path))
        storage.update_spectrogram_path(media_id, str(png_path))
    else:
        final_wav = _session_dir(session_id) / f"{media_id}.wav"
        # Path.replace() is a bare os.rename(), which can't cross a
        # filesystem boundary — tmp_dir lives on the container's own
        # filesystem while AUDIO_DIR is a separate mounted volume in
        # production, so this raises "Invalid cross-device link" there
        # (never showed up locally, where both paths share one filesystem).
        # shutil.move() falls back to copy+delete when os.rename fails.
        shutil.move(str(wav_path), str(final_wav))
        png_path = _session_dir(session_id) / f"{media_id}.png"
        render_spectrogram(str(final_wav), str(png_path))
        storage.update_media_paths(media_id, str(final_wav), str(png_path))

    return storage.get_transcript(media_id)


# Sample templates are transcribed once ever — the result is persisted to
# TEMPLATE_DIR on the data volume, so it survives container restarts and
# redeploys, not just the current process. Every brand-new session then
# gets its own copy (own DB row, own files) by copying these files and
# reusing the precomputed IPA/units — no whisper re-run per session. See
# sample_audio/ATTRIBUTION.md for provenance/licensing (CC BY 4.0).
def _ensure_sample_templates() -> list[dict]:
    if TEMPLATE_MANIFEST.exists():
        return json.loads(TEMPLATE_MANIFEST.read_text())
    if not SAMPLE_AUDIO_DIR.is_dir():
        return []

    TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)
    templates = []
    for wav_file in sorted(SAMPLE_AUDIO_DIR.glob("*.wav")):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_wav = Path(tmp_dir) / wav_file.name
            shutil.copy(wav_file, tmp_wav)
            text, words, duration = transcribe_audio_with_words(
                str(tmp_wav), whisper_language_for(DEFAULT_LANGUAGE)
            )
            if not text:
                continue
            units = build_units(words, duration, DEFAULT_LANGUAGE)
            ipa = units_to_ipa(units)

            final_wav = TEMPLATE_DIR / wav_file.name
            final_png = TEMPLATE_DIR / f"{wav_file.stem}.png"
            shutil.copy(tmp_wav, final_wav)
            render_spectrogram(str(final_wav), str(final_png))

            templates.append(
                {
                    "text": text,
                    "ipa": ipa,
                    "duration": duration,
                    "units": units,
                    "words": words,
                    "wav": str(final_wav),
                    "png": str(final_png),
                }
            )

    TEMPLATE_MANIFEST.write_text(json.dumps(templates))
    return templates


_SAMPLE_TEMPLATES = _ensure_sample_templates()


def _seed_session_samples(session_id: str) -> None:
    if not _SAMPLE_TEMPLATES:
        return
    session_dir = _session_dir(session_id)
    for tpl in _SAMPLE_TEMPLATES:
        row = storage.insert_transcript(
            tpl["text"], tpl["ipa"], tpl["duration"],
            json.dumps(tpl["units"]), json.dumps(tpl["words"]),
            DEFAULT_LANGUAGE, session_id, is_sample=True,
        )
        media_id = row["id"]
        final_wav = session_dir / f"{media_id}.wav"
        final_png = session_dir / f"{media_id}.png"
        shutil.copy(tpl["wav"], final_wav)
        shutil.copy(tpl["png"], final_png)
        storage.update_media_paths(media_id, str(final_wav), str(final_png))


#Wraps transcribe_audio_with_words from transcribe
@app.post("/transcribe")
async def transcribe(
    audio: UploadFile,
    language: str = Form(DEFAULT_LANGUAGE),
    session_id: str = Depends(require_session_id),
) -> dict:
    if language not in _LANGUAGE_CODES:
        language = DEFAULT_LANGUAGE
    suffix = Path(audio.filename or "clip.webm").suffix or ".webm"

    with tempfile.TemporaryDirectory() as tmp_dir:
        src_path = Path(tmp_dir) / f"clip{suffix}"
        src_path.write_bytes(await audio.read())

        wav_path = Path(tmp_dir) / "clip.wav"
        convert_to_wav(str(src_path), str(wav_path))

        row = _ingest_wav(wav_path, language, session_id)
        if row is None:
            return {"id": None, "text": "", "ipa": "", "units": [], "words": [], "duration": 0}

    return _serialize(row)


@app.get("/languages")
def languages() -> dict:
    return {"languages": SUPPORTED_LANGUAGES, "default": DEFAULT_LANGUAGE}


@app.get("/history")
def history(limit: int = 200, session_id: str = Depends(require_session_id)) -> list[dict]:
    if not storage.list_transcripts(session_id=session_id, limit=1):
        _seed_session_samples(session_id)
    return [_serialize(r) for r in storage.list_transcripts(session_id=session_id, limit=limit)]


@app.get("/phonemes")
def phonemes(session_id: str = Depends(require_session_id)) -> dict:
    occurrences: dict[str, list[dict]] = defaultdict(list)

    for row in storage.list_transcripts(session_id=session_id, limit=100000):
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
def segment_spectrogram(
    transcript_id: int, start: float, end: float, session_id: str = Depends(require_session_id)
) -> Response:
    row = _get_owned_transcript(transcript_id, session_id)
    with _wav_local_path(row) as wav_path:
        png_bytes = render_segment_spectrogram(str(wav_path), start, end)
    return Response(content=png_bytes, media_type="image/png")

#OK
@app.delete("/transcripts/{transcript_id}")
def delete_transcript(transcript_id: int, session_id: str = Depends(require_session_id)) -> dict:
    row = _get_owned_transcript(transcript_id, session_id)
    storage.delete_transcript(transcript_id)
    for key in ("audio_path", "spectrogram_path"):
        path = row[key]
        if path:
            Path(path).unlink(missing_ok=True)
    if row["drive_wav_id"] or row["drive_png_id"]:
        user_row = storage.get_user(row["session_id"])
        if user_row is not None:
            creds = drive.get_valid_credentials(user_row)
            for file_id in (row["drive_wav_id"], row["drive_png_id"]):
                if file_id:
                    drive.delete_file(creds, file_id)
    return {"deleted": transcript_id}

#Todo: make more robust
@app.get("/transcripts/{transcript_id}/export.txt")
def export_txt(transcript_id: int, session_id: str = Depends(require_session_id)) -> Response:
    row = _get_owned_transcript(transcript_id, session_id)
    return Response(
        content=_text_export(row),
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{transcript_id}.txt"'},
    )


@app.get("/transcripts/{transcript_id}/export.wav")
def export_wav(transcript_id: int, session_id: str = Depends(require_session_id)) -> Response:
    row = _get_owned_transcript(transcript_id, session_id)
    data = _get_wav_bytes(row)
    if data is None:
        raise HTTPException(status_code=404, detail="no audio for this recording")
    return Response(
        content=data,
        media_type="audio/wav",
        headers={"Content-Disposition": f'attachment; filename="{transcript_id}.wav"'},
    )


@app.get("/export/bulk")
def export_bulk(ids: str, session_id: str = Depends(require_session_id)) -> Response:
    id_list = [int(x) for x in ids.split(",") if x.strip()]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for transcript_id in id_list:
            row = storage.get_transcript(transcript_id)
            if row is None or row["session_id"] != session_id:
                continue
            zf.writestr(f"{transcript_id}.txt", _text_export(row))
            wav_bytes = _get_wav_bytes(row)
            if wav_bytes is not None:
                zf.writestr(f"{transcript_id}.wav", wav_bytes)

    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="sonority_export.zip"'},
    )


@app.get("/media/{session_id}/{filename}")
def serve_media(session_id: str, filename: str) -> Response:
    # Local recordings are also reachable via the StaticFiles mount below,
    # but every request needs to go through here first so a Drive-backed
    # recording (no file ever touching this disk) can be proxied
    # transparently — same /media/{session}/{id}.{ext} URL shape either way,
    # so the frontend never needs to know which storage backend served it.
    stem, _, ext = filename.rpartition(".")
    if not stem.isdigit() or ext not in ("wav", "png"):
        raise HTTPException(status_code=404, detail="not found")
    row = _get_owned_transcript(int(stem), session_id)

    drive_file_id = row["drive_wav_id"] if ext == "wav" else row["drive_png_id"]
    if drive_file_id:
        user_row = storage.get_user(session_id)
        creds = drive.get_valid_credentials(user_row)
        data = drive.download_file(creds, drive_file_id)
        return Response(content=data, media_type="audio/wav" if ext == "wav" else "image/png")

    local_path = row["audio_path"] if ext == "wav" else row["spectrogram_path"]
    if not local_path or not Path(local_path).exists():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(local_path)


app.mount("/media", StaticFiles(directory=AUDIO_DIR), name="media")
