import io
import subprocess
from functools import lru_cache
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel
from PIL import Image
from phonemizer import phonemize
from phonemizer.backend.espeak.wrapper import EspeakWrapper
from scipy.io import wavfile
from scipy.signal import spectrogram as sp_spectrogram

WHISPER_MODEL_SIZE_EN = "small.en"
WHISPER_MODEL_SIZE_MULTI = "small"

# Phonemizer/espeak-ng language codes offered in the UI, with the matching
# whisper language code for speech recognition. en-us stays the default;
# the rest cover the most widely spoken languages plus the two explicitly
# requested (Chinese, Spanish).
SUPPORTED_LANGUAGES = [
    {"code": "en-us", "whisper": "en", "label": "English (US)"},
    {"code": "cmn", "whisper": "zh", "label": "Chinese (Mandarin)"},
    {"code": "es", "whisper": "es", "label": "Spanish"},
    {"code": "hi", "whisper": "hi", "label": "Hindi"},
    {"code": "fr-fr", "whisper": "fr", "label": "French"},
    {"code": "ar", "whisper": "ar", "label": "Arabic"},
    {"code": "pt", "whisper": "pt", "label": "Portuguese"},
    {"code": "ru", "whisper": "ru", "label": "Russian"},
    {"code": "de", "whisper": "de", "label": "German"},
    {"code": "ja", "whisper": "ja", "label": "Japanese"},
]
DEFAULT_LANGUAGE = "en-us"
_WHISPER_LANGUAGE_BY_CODE = {lang["code"]: lang["whisper"] for lang in SUPPORTED_LANGUAGES}


def whisper_language_for(language_code: str) -> str:
    return _WHISPER_LANGUAGE_BY_CODE.get(language_code, "en")

# English diphthongs, affricates, and r-colored vowels espeak-ng emits as
# adjacent symbols but that phonetically act as a single unit.
_CLUSTERS = sorted(
    ["dʒ", "tʃ", "aʊ", "aɪ", "eɪ", "oʊ", "ɔɪ", "ɪɹ", "ɛɹ", "ʊɹ", "ɑɹ", "ɔɹ", "ɜɹ"],
    key=len,
    reverse=True,
)
_PREFIX_MARKS = {"ˈ", "ˌ"}
_SUFFIX_MARKS = {"ː"}

# General American English phoneme inventory, as emitted by espeak-ng's
# en-us voice (after stress-mark stripping via normalize_phoneme).
CANONICAL_INVENTORY = [
    {"symbol": s, "category": "consonant"}
    for s in [
        "p", "b", "t", "d", "k", "ɡ", "tʃ", "dʒ", "f", "v", "θ", "ð",
        "s", "z", "ʃ", "ʒ", "h", "m", "n", "ŋ", "l", "ɹ", "j", "w",
    ]
] + [
    {"symbol": s, "category": "vowel"}
    for s in ["iː", "ɪ", "ɛ", "æ", "ɑː", "ɔː", "ʊ", "uː", "ʌ", "ə", "ɐ", "ɚ", "ɜɹ"]
] + [
    {"symbol": s, "category": "diphthong"}
    for s in ["eɪ", "aɪ", "ɔɪ", "aʊ", "oʊ"]
] + [
    {"symbol": s, "category": "r-colored vowel"}
    for s in ["ɪɹ", "ɛɹ", "ʊɹ", "ɑɹ", "ɔɹ"]
]


def normalize_phoneme(ch: str) -> str:
    return ch.replace("ˈ", "").replace("ˌ", "")


def _find_espeak_library() -> str | None:
    candidates = [
        "/opt/homebrew/opt/espeak-ng/lib/libespeak-ng.dylib",
        "/usr/local/opt/espeak-ng/lib/libespeak-ng.dylib",
    ]
    for path in candidates:
        if Path(path).exists():
            return path
    try:
        prefix = subprocess.run(
            ["brew", "--prefix", "espeak-ng"], capture_output=True, text=True, check=True
        ).stdout.strip()
        lib = Path(prefix) / "lib" / "libespeak-ng.dylib"
        if lib.exists():
            return str(lib)
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    return None


_lib_path = _find_espeak_library()
if _lib_path:
    EspeakWrapper.set_library(_lib_path)

#Cache the model as WhisperModel on CPU. small.en is English-only but more
#accurate; non-English languages need the multilingual "small" model.
@lru_cache(maxsize=2)
def _model(multilingual: bool) -> WhisperModel:
    size = WHISPER_MODEL_SIZE_MULTI if multilingual else WHISPER_MODEL_SIZE_EN
    return WhisperModel(size, device="cpu", compute_type="int8")

#Instantiate subprocess for converting waveform from src -> dst.
def convert_to_wav(src_path: str, dst_path: str) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-i", src_path, "-ar", "16000", "-ac", "1", "-f", "wav", dst_path],
        check=True,
        capture_output=True,
    )


def transcribe_audio_with_words(
    path: str, whisper_language: str = "en"
) -> tuple[str, list[dict], float]:
    segments, info = _model(whisper_language != "en").transcribe(
        path, language=whisper_language, vad_filter=True, word_timestamps=True
    )
    words: list[dict] = []
    text_parts: list[str] = []
    # for each segment, concatenate stripped form.
    for segment in segments:
        stripped = segment.text.strip()
        if stripped:
            text_parts.append(stripped)
        for w in segment.words or []:
            word = w.word.strip()
            if word:
                words.append({"word": word, "start": w.start, "end": w.end})
    text = " ".join(text_parts).strip();
    duration = info.duration if info and info.duration else (words[-1]["end"] if words else 0.0)
    return text, words, duration

#text to IPA.
def text_to_ipa(text: str, language: str = DEFAULT_LANGUAGE) -> str:
    if not text:
        return ""
    result = phonemize(
        [text],
        language=language,
        backend="espeak",
        with_stress=True,
        strip=True,
        preserve_punctuation=False,
    )
    return result[0] if result else ""


def split_ipa_units(ipa: str) -> list[str]:
    units: list[str] = []
    prefix = ""
    i, n = 0, len(ipa)
    #build prefix + token segments for appending to units.
    while i < n:
        ch = ipa[i]
        if ch in _PREFIX_MARKS:
            prefix += ch
            i += 1
            continue
        if ch == " ":
            i += 1
            continue
        token = ch
        for cluster in _CLUSTERS:
            if ipa.startswith(cluster, i):
                token = cluster
                break
        units.append(prefix + token)
        prefix = ""
        i += len(token)
        while i < n and ipa[i] in _SUFFIX_MARKS:
            units[-1] += ipa[i]
            i += 1
    if prefix:
        if units:
            units[-1] += prefix
        else:
            units.append(prefix)
    return units


def build_units(
    words: list[dict], duration: float, language: str = DEFAULT_LANGUAGE
) -> list[dict]:
    units: list[dict] = []
    prev_end = 0.0
    eps = 0.02

    for w in words:
        start, end = w["start"], w["end"]
        if start - prev_end > eps:
            units.append({"ch": "", "start": prev_end, "end": start, "kind": "gap"})

        word_text = w["word"].strip(".,!?;:\"'")
        if not word_text:
            prev_end = max(prev_end, end)
            continue

        phon_units = split_ipa_units(text_to_ipa(word_text, language))
        count = len(phon_units)
        span = max(end - start, 0.01)
        step = span / count if count else span
        for i, unit in enumerate(phon_units):
            s = start + i * step
            units.append(
                {
                    "ch": unit,
                    "start": s,
                    "end": s + step,
                    "kind": "phoneme",
                    "word_start": i == 0,
                }
            )
        prev_end = end

    if duration - prev_end > eps:
        units.append({"ch": "", "start": prev_end, "end": duration, "kind": "gap"})

    return units


def units_to_ipa(units: list[dict]) -> str:
    parts: list[str] = []
    for u in units:
        if u["kind"] != "phoneme":
            continue
        if u.get("word_start") and parts:
            parts.append(" ")
        parts.append(u["ch"])
    return "".join(parts)


_MAGMA_STOPS = [
    (0.00, (0, 0, 4)),
    (0.20, (40, 11, 84)),
    (0.40, (101, 21, 110)),
    (0.60, (159, 42, 99)),
    (0.75, (212, 72, 66)),
    (0.90, (245, 125, 21)),
    (1.00, (252, 253, 191)),
]


def _build_colormap_lut() -> np.ndarray:
    lut = np.zeros((256, 3), dtype=np.uint8)
    for i in range(256):
        t = i / 255
        for (t0, c0), (t1, c1) in zip(_MAGMA_STOPS, _MAGMA_STOPS[1:]):
            if t0 <= t <= t1:
                frac = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
                lut[i] = [c0[ch] + (c1[ch] - c0[ch]) * frac for ch in range(3)]
                break
    return lut


_COLORMAP_LUT = _build_colormap_lut()


def _load_wav_samples(wav_path: str) -> tuple[int, np.ndarray]:
    sr, samples = wavfile.read(wav_path)
    if samples.dtype.kind == "i":
        samples = samples.astype(np.float32) / (np.iinfo(samples.dtype).max + 1)
    else:
        samples = samples.astype(np.float32)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    return sr, samples


def _spectrogram_image(
    samples: np.ndarray,
    sr: int,
    height: int,
    nperseg: int = 400,
    noverlap: int = 320,
    min_width: int = 1,
    relative_db: bool = False,
    dynamic_range_db: float = 50.0,
) -> Image.Image:
    nperseg = min(nperseg, max(len(samples), 2))
    noverlap = min(noverlap, nperseg - 1)

    _freqs, _times, sxx = sp_spectrogram(
        samples, fs=sr, nperseg=nperseg, noverlap=noverlap, mode="magnitude"
    )
    db = 20 * np.log10(sxx + 1e-6)

    if relative_db:
        # Scale to this clip's own peak rather than an absolute loudness
        # reference, so quiet or short phonemes still show their shape
        # instead of clipping to near-black.
        peak = db.max()
        floor = peak - dynamic_range_db
    else:
        peak, floor = 0.0, -80.0

    db = np.clip(db, floor, peak)
    span = max(peak - floor, 1e-6)
    normalized = ((db - floor) / span * 255).astype(np.uint8)
    normalized = np.flipud(normalized)

    rgb = _COLORMAP_LUT[normalized]
    img = Image.fromarray(rgb, mode="RGB")
    return img.resize((max(img.width, min_width), height), Image.LANCZOS)


def render_spectrogram(wav_path: str, out_path: str, height: int = 220) -> None:
    sr, samples = _load_wav_samples(wav_path)
    img = _spectrogram_image(samples, sr, height)
    img.save(out_path, format="PNG")


def render_segment_spectrogram(
    wav_path: str, start: float, end: float, height: int = 120
) -> bytes:
    sr, samples = _load_wav_samples(wav_path)
    start_idx = max(int(start * sr), 0)
    end_idx = min(int(end * sr), len(samples))
    segment = samples[start_idx:end_idx]
    if len(segment) < 2:
        segment = np.zeros(2, dtype=np.float32)

    # Short phoneme-length clips need a much finer analysis window than the
    # full-recording view, or they'd collapse to a handful of time columns.
    # relative_db auto-levels to the clip's own peak so quiet/unstressed
    # phonemes still show their shape instead of clipping to near-black.
    img = _spectrogram_image(
        segment, sr, height, nperseg=128, noverlap=120, min_width=80, relative_db=True
    )
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
