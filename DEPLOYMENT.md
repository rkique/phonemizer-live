## 1. Provision a server

Any VPS works (DigitalOcean, Hetzner, Linode, Vultr, ...). Recommended:

- Ubuntu 22.04+ (or any recent Debian-based distro)

- **2GB+ RAM** — the two whisper models (`small.en` + `small`) are baked
  into the backend image and loaded into memory; 1GB will likely swap/OOM
  
- 20GB+ disk (Docker images + models + your recordings)

Install Docker on it:

```bash
curl -fsSL https://get.docker.com | sh
```

(That script also installs the `docker compose` plugin.)

## 2. Clone the repo on the server

```bash
sudo mkdir -p /opt/phonemizer-live
sudo chown $USER /opt/phonemizer-live
git clone <your-repo-url> /opt/phonemizer-live
```

The deploy path doesn't have to be `/opt/phonemizer-live` — whatever you
pick, use the same path for the `DEPLOY_PATH` secret below.

## 3. Point DNS at the server

Add these records at your DNS provider (wherever phonemizer.live is
registered), all pointing at the server's public IP:

| Type | Host | Value |
|------|------|-------|
| A | `phonemizer.live` | `<server IP>` |
| A | `www.phonemizer.live` | `<server IP>` |
| A | `api.phonemizer.live` | `<server IP>` |

Caddy (the reverse proxy) requests a Let's Encrypt certificate for each
hostname the **first time it starts** — DNS needs to already be pointing at
the server before that first `docker compose up`, or the initial cert
request will fail (Caddy will keep retrying automatically, so it's
self-healing, but don't expect HTTPS to work within the first few minutes
of a fresh DNS record — propagation + retries take a bit).

## 4. Open the firewall

Ports 80 and 443 need to be reachable from the internet (80 is used for
the ACME HTTP challenge and to redirect to HTTPS).

```bash
sudo ufw allow 80,443/tcp
```

## 5. Generate a deploy SSH key

From your own machine (not the server):

```bash
ssh-keygen -t ed25519 -f ./phonemizer_deploy_key -C "phonemizer-live-deploy" -N ""
```

Add the **public** key to the server:

```bash
ssh-copy-id -i ./phonemizer_deploy_key.pub <user>@<server IP>
# or manually append phonemizer_deploy_key.pub to ~/.ssh/authorized_keys on the server
```

Keep the **private** key (`phonemizer_deploy_key`, no extension) — it goes
into a GitHub secret next. Delete both files from your machine once it's
in GitHub (`rm ./phonemizer_deploy_key ./phonemizer_deploy_key.pub`).

## 6. Add GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository
secret**:

| Secret | Value |
|--------|-------|
| `DEPLOY_HOST` | server's IP or hostname |
| `DEPLOY_USER` | the SSH user you added the key for (e.g. `root` or a non-root deploy user) |
| `DEPLOY_SSH_KEY` | contents of the private key file (`cat phonemizer_deploy_key`) |
| `DEPLOY_PATH` | where you cloned the repo on the server, e.g. `/opt/phonemizer-live` |
| `DEPLOY_PORT` | *(optional)* only if SSH isn't on port 22 |

Optional but recommended: create a GitHub **Environment** named
`production` (repo → Settings → Environments) and add required reviewers
if you want a manual approval step before every deploy. The workflow
already references `environment: production`, so this just adds protection
rules on top — nothing to change in the workflow file itself.

## 7. First deploy

Once the secrets are set, either:

- push to `main` (the workflow deploys automatically), or
- SSH in and run it yourself the first time to watch for errors:

```bash
cd /opt/phonemizer-live
docker compose up -d --build
```

The first build takes a while (whisper models get downloaded and baked
into the backend image during `docker build`) — expect several minutes,
mostly spent on that and ffmpeg's dependency chain via apt.

## 8. Verify

- `https://phonemizer.live` → the app should load
- `https://api.phonemizer.live/health` → `{"status":"ok"}`
- Record something and confirm it transcribes — this exercises the whole
  pipeline (mic → backend → whisper → phonemizer → SQLite volume)

## 9. Google sign-in / Drive sync (optional)

Signing in with Google is optional — without it, recordings just stay
partitioned by the anonymous per-browser session id and stored on the
server as before. To enable it:

**Create OAuth credentials in Google Cloud Console:**

1. [console.cloud.google.com](https://console.cloud.google.com) → create
   a project (or pick an existing one).
2. **APIs & Services → Library** → enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → configure it. User type
   **External**. Fill in:
   - App name, support email, developer contact email
   - **App home page**: `https://phonemizer.live`
   - **App privacy policy link**: `https://phonemizer.live/privacy.html`
   - **App terms of service link**: `https://phonemizer.live/terms.html`
   - **Authorized domain**: `phonemizer.live`
4. **APIs & Services → Credentials → Create credentials → OAuth client
   ID** → application type **Web application**.
5. Add an **Authorized redirect URI**:
   `https://api.phonemizer.live/auth/google/callback` (swap in your own
   domain if different; use `http://localhost:8000/auth/google/callback`
   too if you also want Google sign-in to work against a local backend).
6. Save, then copy the generated **Client ID** and **Client secret**.

**Publishing status matters.** A brand-new consent screen starts in
**Testing** — only email addresses you explicitly add under "Test users"
can complete the OAuth flow; everyone else is blocked at the consent
screen. To let *any* Google account sign in, click **Publish App** (OAuth
consent screen page) to move it to **In production**.

Publishing alone lets anyone log in, but shows a "Google hasn't verified
this app" interstitial first. To remove that screen entirely, submit for
**verification** (button appears once published):

- Requires the privacy policy / home page links above to already be live
  at their public URLs (they are, once you deploy — `privacy.html` and
  `terms.html` ship in `frontend/public/`).
- Requires proving domain ownership: add `phonemizer.live` in
  [Google Search Console](https://search.google.com/search-console)
  under the *same* Google account used for the Cloud project, and verify
  it (DNS TXT record or HTML file upload).
- Because `drive.file` is a "sensitive" (not "restricted") scope, this
  goes through Google's standard review rather than the heavier CASA
  security assessment required for broader Drive/Gmail scopes — but
  Google may still ask for a short screen-recording demo of the OAuth
  consent flow and how the app uses the granted access.
- Review typically takes a few days to a few weeks. The app keeps working
  in the interim — production status doesn't require verification to be
  complete, verification only controls whether the warning interstitial
  shows.

**Configure the server:**

Create a `.env` file in the deploy directory (same directory as
`docker-compose.yml` on the server — `docker compose` loads it
automatically, and it's gitignored so it never gets committed):

```bash
# /opt/phonemizer-live/.env
FRONTEND_URL=https://phonemizer.live
GOOGLE_CLIENT_ID=<your client id>
GOOGLE_CLIENT_SECRET=<your client secret>
GOOGLE_REDIRECT_URI=https://api.phonemizer.live/auth/google/callback
```

Then redeploy (`docker compose up -d --build`) so the backend container
picks up the new environment variables. Until these are set, the
"Connect Google Drive" button in the app's settings panel will fail with
a 503 (`google_auth.is_configured()` returns `False`) — that's the
expected fallback, not a bug.

## Notes

- **Data persistence**: recordings and the SQLite DB live in the
  `backend_data` named Docker volume (mounted at `/app/data` in the
  container), not a bind mount — it survives `docker compose up --build`
  redeploys. To back it up: `docker run --rm -v phonemizer-live_backend_data:/data -v $(pwd):/backup alpine tar czf /backup/backend_data.tar.gz -C /data .`
  (adjust the volume name — check the actual name with `docker volume ls`,
  it's prefixed with the compose project directory name).
- **CORS**: the production domains are already allowed by default in
  `backend/main.py`. If you ever serve the frontend from somewhere else
  too, add it via the `ALLOWED_ORIGINS` env var (comma-separated) in
  `docker-compose.yml` instead of editing code.
- **Redeploys** rebuild both images (`docker compose up -d --build`) every
  time — fine for a low-traffic personal app. The whisper-model download in
  `backend/Dockerfile` is deliberately placed *before* `COPY . .`, so a
  code-only change reuses that cached layer instead of re-downloading ~1GB
  of models on every deploy — only a `requirements.txt` change busts it.
