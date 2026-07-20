import json
import sqlite3
from pathlib import Path

import requests
from google.auth.transport.requests import Request as GoogleAuthRequest

import storage
from google_auth import credentials_from_user_row

FOLDER_MIME = "application/vnd.google-apps.folder"
APP_FOLDER_NAME = "phonemizer.live recordings"

UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files"
FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files"


def get_valid_credentials(user_row: sqlite3.Row):
    creds = credentials_from_user_row(user_row)
    if creds.expired and creds.refresh_token:
        creds.refresh(GoogleAuthRequest())
        storage.update_user_access_token(
            user_row["google_sub"], creds.token, creds.expiry.isoformat()
        )
    return creds


def _auth_header(creds) -> dict:
    return {"Authorization": f"Bearer {creds.token}"}


def ensure_app_folder(user_row: sqlite3.Row, creds) -> str:
    if user_row["drive_folder_id"]:
        return user_row["drive_folder_id"]

    # drive.file scope only ever shows files/folders this app itself
    # created, so a name search here can't collide with some unrelated
    # folder of the user's — safe to search-then-create rather than
    # blindly creating a duplicate on every fresh install.
    resp = requests.get(
        FILES_ENDPOINT,
        headers=_auth_header(creds),
        params={
            "q": f"name = '{APP_FOLDER_NAME}' and mimeType = '{FOLDER_MIME}' and trashed = false",
            "fields": "files(id)",
        },
        timeout=10,
    )
    resp.raise_for_status()
    files = resp.json().get("files", [])
    if files:
        folder_id = files[0]["id"]
    else:
        create_resp = requests.post(
            FILES_ENDPOINT,
            headers=_auth_header(creds),
            json={"name": APP_FOLDER_NAME, "mimeType": FOLDER_MIME},
            timeout=10,
        )
        create_resp.raise_for_status()
        folder_id = create_resp.json()["id"]

    storage.update_user_drive_folder(user_row["google_sub"], folder_id)
    return folder_id


def upload_file(creds, folder_id: str, local_path: Path, name: str, mime_type: str) -> str:
    metadata = {"name": name, "parents": [folder_id]}
    with open(local_path, "rb") as f:
        resp = requests.post(
            UPLOAD_ENDPOINT,
            headers=_auth_header(creds),
            params={"uploadType": "multipart", "fields": "id"},
            files={
                "metadata": (None, json.dumps(metadata), "application/json"),
                "file": (name, f, mime_type),
            },
            timeout=60,
        )
    resp.raise_for_status()
    return resp.json()["id"]


def download_file(creds, file_id: str) -> bytes:
    resp = requests.get(
        f"{FILES_ENDPOINT}/{file_id}",
        headers=_auth_header(creds),
        params={"alt": "media"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.content


def delete_file(creds, file_id: str) -> None:
    requests.delete(
        f"{FILES_ENDPOINT}/{file_id}", headers=_auth_header(creds), timeout=10
    )
