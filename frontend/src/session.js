const SESSION_STORAGE_KEY = "phonemizer-session-id";

// Anonymous per-browser identifier, generated once and kept in
// localStorage — not an account, just a partition key so the backend never
// mixes one visitor's recordings with another's.
export function getSessionId() {
  let id = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_STORAGE_KEY, id);
  }
  return id;
}
