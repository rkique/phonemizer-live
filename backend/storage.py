import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).parent / "data" / "transcripts.db"


def init_db() -> None:
    with connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS transcripts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                text TEXT NOT NULL,
                ipa TEXT NOT NULL
            )
            """
        )
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(transcripts)")}
        migrations = {
            "duration": "ALTER TABLE transcripts ADD COLUMN duration REAL NOT NULL DEFAULT 0",
            "units_json": "ALTER TABLE transcripts ADD COLUMN units_json TEXT",
            "audio_path": "ALTER TABLE transcripts ADD COLUMN audio_path TEXT",
            "spectrogram_path": "ALTER TABLE transcripts ADD COLUMN spectrogram_path TEXT",
            "words_json": "ALTER TABLE transcripts ADD COLUMN words_json TEXT",
            "language": "ALTER TABLE transcripts ADD COLUMN language TEXT NOT NULL DEFAULT 'en-us'",
            "session_id": "ALTER TABLE transcripts ADD COLUMN session_id TEXT NOT NULL DEFAULT ''",
            "is_sample": "ALTER TABLE transcripts ADD COLUMN is_sample INTEGER NOT NULL DEFAULT 0",
            # Drive-backed storage (set for Google-linked sessions) — mutually
            # exclusive with audio_path/spectrogram_path, which stay in use
            # for anonymous/local sessions. Never both populated at once.
            "drive_wav_id": "ALTER TABLE transcripts ADD COLUMN drive_wav_id TEXT",
            "drive_png_id": "ALTER TABLE transcripts ADD COLUMN drive_png_id TEXT",
        }
        for column, ddl in migrations.items():
            if column not in existing:
                conn.execute(ddl)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_transcripts_session_id ON transcripts (session_id)"
        )

        # google_sub becomes a session_id's value once a session signs in
        # (see rekey_session_to_user) — same partition key, just backed by a
        # real identity instead of an anonymous browser UUID.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                google_sub TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                access_token TEXT,
                refresh_token TEXT,
                token_expiry TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        existing_user_cols = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
        if "drive_folder_id" not in existing_user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN drive_folder_id TEXT")


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def insert_transcript(
    text: str,
    ipa: str,
    duration: float,
    units_json: str,
    words_json: str,
    language: str,
    session_id: str,
    is_sample: bool = False,
) -> sqlite3.Row:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO transcripts "
            "(text, ipa, duration, units_json, words_json, language, session_id, is_sample) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (text, ipa, duration, units_json, words_json, language, session_id, int(is_sample)),
        )
        return conn.execute(
            "SELECT * FROM transcripts WHERE id = ?", (cur.lastrowid,)
        ).fetchone()


def update_media_paths(transcript_id: int, audio_path: str, spectrogram_path: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE transcripts SET audio_path = ?, spectrogram_path = ? WHERE id = ?",
            (audio_path, spectrogram_path, transcript_id),
        )


def update_drive_ids(transcript_id: int, drive_wav_id: str, drive_png_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE transcripts SET drive_wav_id = ?, drive_png_id = ? WHERE id = ?",
            (drive_wav_id, drive_png_id, transcript_id),
        )


def upsert_user(
    google_sub: str,
    email: str,
    access_token: str,
    refresh_token: str | None,
    token_expiry: str,
) -> None:
    with connect() as conn:
        # A refresh token is only issued by Google on the *first* consent
        # (or after prompt=consent) — on later re-logins, keep whatever
        # refresh token we already have on file instead of clobbering it
        # with NULL.
        conn.execute(
            """
            INSERT INTO users (google_sub, email, access_token, refresh_token, token_expiry)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(google_sub) DO UPDATE SET
                email = excluded.email,
                access_token = excluded.access_token,
                refresh_token = COALESCE(excluded.refresh_token, users.refresh_token),
                token_expiry = excluded.token_expiry
            """,
            (google_sub, email, access_token, refresh_token, token_expiry),
        )


def get_user(google_sub: str) -> sqlite3.Row | None:
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM users WHERE google_sub = ?", (google_sub,)
        ).fetchone()


def update_user_drive_folder(google_sub: str, drive_folder_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE users SET drive_folder_id = ? WHERE google_sub = ?",
            (drive_folder_id, google_sub),
        )


def update_user_access_token(google_sub: str, access_token: str, token_expiry: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE users SET access_token = ?, token_expiry = ? WHERE google_sub = ?",
            (access_token, token_expiry, google_sub),
        )


def rekey_session_to_user(old_session_id: str, google_sub: str) -> None:
    # Anonymous recordings made before signing in follow the user into their
    # new Google-backed identity rather than being orphaned. If the account
    # was already used from another browser (google_sub already has rows),
    # both sets just merge under the same session_id — no special-casing
    # needed since session_id was always just a partition key, not
    # inherently tied to "one browser."
    if old_session_id == google_sub:
        return
    with connect() as conn:
        conn.execute(
            "UPDATE transcripts SET session_id = ? WHERE session_id = ?",
            (google_sub, old_session_id),
        )


def get_transcript(transcript_id: int) -> sqlite3.Row:
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM transcripts WHERE id = ?", (transcript_id,)
        ).fetchone()


def list_transcripts(session_id: str, limit: int = 200) -> list[sqlite3.Row]:
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM transcripts WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            (session_id, limit),
        ).fetchall()


def delete_transcript(transcript_id: int) -> sqlite3.Row | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM transcripts WHERE id = ?", (transcript_id,)
        ).fetchone()
        if row is None:
            return None
        conn.execute("DELETE FROM transcripts WHERE id = ?", (transcript_id,))
        return row
