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
        }
        for column, ddl in migrations.items():
            if column not in existing:
                conn.execute(ddl)


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
    text: str, ipa: str, duration: float, units_json: str, words_json: str
) -> sqlite3.Row:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO transcripts (text, ipa, duration, units_json, words_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (text, ipa, duration, units_json, words_json),
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


def get_transcript(transcript_id: int) -> sqlite3.Row:
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM transcripts WHERE id = ?", (transcript_id,)
        ).fetchone()


def list_transcripts(limit: int = 200) -> list[sqlite3.Row]:
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM transcripts ORDER BY id DESC LIMIT ?", (limit,)
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
