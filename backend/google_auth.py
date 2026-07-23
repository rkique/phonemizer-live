import os

# google-auth-oauthlib validates that the granted scopes exactly match the
# requested ones; Google frequently reorders them or implicitly includes
# "openid", which trips that check. This is the documented workaround.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

import requests
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow

# drive.file (not the broad "drive" scope) — the app can only see/manage
# files it creates itself, never the rest of the user's Drive. Narrower
# scope, and Google's app-verification process for it is much lighter.
SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/drive.file",
]

USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo"

# Google's auth endpoint requires PKCE — the code_verifier used to build the
# authorization_url must be the exact same one presented at token exchange.
# build_auth_url() and exchange_code() necessarily run in separate requests
# (the user's browser round-trips through Google in between), so the
# verifier has to be stashed somewhere in between. Keyed by state (already a
# single-use, per-login-attempt token) since nothing else ties the two
# requests together.
_pending_code_verifiers: dict[str, str] = {}

#requires environment variables to be set to ID and Secret.
def is_configured() -> bool:
    return bool(os.environ.get("GOOGLE_CLIENT_ID") and os.environ.get("GOOGLE_CLIENT_SECRET"))


def _client_config() -> dict:
    return {
        "web": {
            "client_id": os.environ["GOOGLE_CLIENT_ID"],
            "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }


def _redirect_uri() -> str:
    return os.environ["GOOGLE_REDIRECT_URI"]


def build_auth_url(state: str) -> str:
    flow = Flow.from_client_config(_client_config(), scopes=SCOPES, redirect_uri=_redirect_uri())
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        # Forces Google to reissue a refresh token even for a returning
        # user — without this, a second login only returns an access
        # token, and upsert_user() would have nothing to fall back on if
        # the first refresh token was ever lost.
        prompt="consent",
        state=state,
    )
    _pending_code_verifiers[state] = flow.code_verifier
    return auth_url


def exchange_code(code: str, state: str) -> Credentials:
    code_verifier = _pending_code_verifiers.pop(state, None)
    flow = Flow.from_client_config(
        _client_config(), scopes=SCOPES, redirect_uri=_redirect_uri(), code_verifier=code_verifier
    )
    flow.fetch_token(code=code)
    return flow.credentials


def get_userinfo(credentials: Credentials) -> dict:
    resp = requests.get(
        USERINFO_ENDPOINT,
        headers={"Authorization": f"Bearer {credentials.token}"},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def credentials_from_user_row(row) -> Credentials:
    return Credentials(
        token=row["access_token"],
        refresh_token=row["refresh_token"],
        token_uri="https://oauth2.googleapis.com/token",
        client_id=os.environ["GOOGLE_CLIENT_ID"],
        client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
        scopes=SCOPES,
    )
