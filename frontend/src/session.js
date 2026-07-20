const SESSION_STORAGE_KEY = "phonemizer-session-id";

// Anonymous per-browser identifier, generated once and kept in
// localStorage — not an account, just a partition key so the backend never
// mixes one visitor's recordings with another's. Once someone signs in
// with Google, this same key holds their google_sub instead — the backend
// treats it identically either way (see main.py's require_session_id).
export function getSessionId() {
  adoptGoogleSessionFromUrl();

  let id = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_STORAGE_KEY, id);
  }
  return id;
}

// /auth/google/callback redirects back here with ?google_session=<sub> —
// adopt it as this browser's session id (replacing the anonymous one) and
// scrub the query param so it doesn't linger in the address bar/history.
function adoptGoogleSessionFromUrl() {
  const url = new URL(window.location.href);
  const googleSession = url.searchParams.get("google_session");
  if (!googleSession) return;

  localStorage.setItem(SESSION_STORAGE_KEY, googleSession);
  url.searchParams.delete("google_session");
  window.history.replaceState({}, "", url.toString());
}

// Drops back to a fresh anonymous session — signing in again with the same
// Google account will pick the same recordings right back up server-side,
// this only changes what this browser currently uses as its identity.
export function resetToAnonymousSession() {
  localStorage.removeItem(SESSION_STORAGE_KEY);
  return getSessionId();
}
