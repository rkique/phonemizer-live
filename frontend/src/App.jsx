import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SILENCE_DURATION_MS, useAudioSegmenter } from "./useAudioSegmenter";
import Sidebar from "./Sidebar";
import SpectrogramView from "./SpectrogramView";
import PhonemeInventory from "./PhonemeInventory";
// Temporarily disabled while isolating a recording-pipeline bug — untested,
// not implicated yet, just ruled out of the picture for now.
// import MobileNotice from "./MobileNotice";
// import MicPermissionModal from "./MicPermissionModal";
import LiveWaveform from "./LiveWaveform";
import SettingsPanel from "./SettingsPanel";
import Footer from "./Footer";
import { getSessionId } from "./session";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";
const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA"]);
const SILENCE_DURATION_STORAGE_KEY = "phonemizer-silence-duration-ms";
const SESSION_ID = getSessionId();

function App() {
  //array of phoneme transcripts
  const [transcripts, setTranscripts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState(null);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [view, setView] = useState("recordings");
  const [inventory, setInventory] = useState([]);
  const [seekRequest, setSeekRequest] = useState(null);
  const [languages, setLanguages] = useState([]);
  const [language, setLanguage] = useState("en-us");
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [silenceDurationMs, setSilenceDurationMs] = useState(() => {
    const saved = Number(localStorage.getItem(SILENCE_DURATION_STORAGE_KEY));
    return saved > 0 ? saved : DEFAULT_SILENCE_DURATION_MS;
  });
  const recordControlRef = useRef(null);

  const handleSilenceDurationChange = (ms) => {
    setSilenceDurationMs(ms);
    localStorage.setItem(SILENCE_DURATION_STORAGE_KEY, String(ms));
  };

  const loadPhonemes = useCallback(() => {
    fetch(`${API_BASE}/phonemes`, { headers: { "X-Session-Id": SESSION_ID } })
      .then((r) => r.json())
      .then((data) => setInventory(data.inventory ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/history`, { headers: { "X-Session-Id": SESSION_ID } })
      .then((r) => r.json())
      .then((rows) => {
        const ordered = rows.slice().reverse();
        setTranscripts(ordered);
        if (ordered.length > 0) setSelectedId(ordered[ordered.length - 1].id);
      })
      .catch(() => {});
    loadPhonemes();
    fetch(`${API_BASE}/languages`)
      .then((r) => r.json())
      .then((data) => {
        setLanguages(data.languages ?? []);
        if (data.default) setLanguage(data.default);
      })
      .catch(() => {});
  }, [loadPhonemes]);

  const handleUtterance = useCallback(
    async (blob) => {
      setPending((p) => p + 1);
      setError(null);
      try {
        const form = new FormData();
        form.append("audio", blob, "utterance.webm");
        form.append("language", language);
        const res = await fetch(`${API_BASE}/transcribe`, {
          method: "POST",
          headers: { "X-Session-Id": SESSION_ID },
          body: form,
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        if (data.text) {
          setTranscripts((prev) => [...prev, data]);
          setSelectedId(data.id);
          loadPhonemes();
        } else {
          setError("No speech detected in that recording — try again.");
        }
      } catch (e) {
        setError("Transcription failed — is the backend running on :8000?");
      } finally {
        setPending((p) => p - 1);
      }
    },
    [loadPhonemes, language]
  );

  const { isListening, start, stop } = useAudioSegmenter(
    handleUtterance,
    setLevel,
    setElapsed,
    silenceDurationMs
  );

  const toggle = async () => {
    setError(null);
    if (isListening) {
      stop();
      setLevel(0);
      setElapsed(0);
      return;
    }
    try {
      await start();
    } catch (e) {
      setError("Microphone access denied.");
    }
  };

  const jumpToExample = (transcriptId, time) => {
    setSelectedId(transcriptId);
    setSeekRequest({ transcriptId, time, key: Date.now() });
    setView("recordings");
  };

  const deleteIds = useCallback(
    async (ids) => {
      const idSet = new Set(ids);
      await Promise.all(
        ids.map((id) =>
          fetch(`${API_BASE}/transcripts/${id}`, {
            method: "DELETE",
            headers: { "X-Session-Id": SESSION_ID },
          }).catch(() => {})
        )
      );
      setTranscripts((prev) => {
        const remaining = prev.filter((t) => !idSet.has(t.id));
        setSelectedId((prevSelected) =>
          idSet.has(prevSelected)
            ? remaining.length > 0
              ? remaining[remaining.length - 1].id
              : null
            : prevSelected
        );
        return remaining;
      });
      loadPhonemes();
    },
    [loadPhonemes]
  );

  const handleDelete = useCallback((id) => deleteIds([id]), [deleteIds]);

  const exportIds = useCallback((ids) => {
    if (ids.length === 0) return;
    window.location.href = `${API_BASE}/export/bulk?ids=${ids.join(",")}&session_id=${SESSION_ID}`;
  }, []);

  useEffect(() => {
    if (!langMenuOpen) return undefined;
    const handleClickOutside = (e) => {
      if (recordControlRef.current && !recordControlRef.current.contains(e.target)) {
        setLangMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [langMenuOpen]);

  const selected = transcripts.find((t) => t.id === selectedId) ?? null;
  const currentLanguage = languages.find((l) => l.code === language);
  const orderedTranscripts = transcripts.slice().reverse();

  useEffect(() => {
    const handleKeydown = (e) => {
      const target = e.target;
      if (target && (EDITABLE_TAGS.has(target.tagName) || target.isContentEditable)) return;

      if (e.code === "ArrowUp" || e.code === "ArrowDown") {
        if (orderedTranscripts.length === 0) return;
        e.preventDefault();
        const currentIndex = orderedTranscripts.findIndex((t) => t.id === selectedId);
        let nextIndex;
        if (currentIndex === -1) nextIndex = 0;
        else nextIndex = e.code === "ArrowUp" ? currentIndex - 1 : currentIndex + 1;
        nextIndex = Math.max(0, Math.min(orderedTranscripts.length - 1, nextIndex));
        setSelectedId(orderedTranscripts[nextIndex].id);
        setView("recordings");
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  });

  return (
    <div className="app-shell">
      {/* <MobileNotice /> */}
      {/* <MicPermissionModal /> */}
      <div className="app">
        <Sidebar
          transcripts={transcripts}
          selectedId={selectedId}
          view={view}
          pending={pending}
          onSelect={(id) => {
            setSelectedId(id);
            setView("recordings");
          }}
          onViewChange={setView}
          onDelete={handleDelete}
          onDeleteMany={deleteIds}
          onExportMany={exportIds}
        />

        <main className="main">
        <div className="topbar">
          <div className={isListening ? "controls recording" : "controls"}>
            <span className="controls-spacer" />

            <div className="controls-cluster">
              <div className={isListening ? "rec-indicator active" : "rec-indicator"}>
                <span className="rec-dot" />
              </div>

              {isListening && (
                <>
                  <LiveWaveform level={level} />
                  <span className="rec-timer">{elapsed.toFixed(2)}s</span>
                </>
              )}

              <div
                className={isListening ? "record-control listening" : "record-control"}
                ref={recordControlRef}
              >
                <button
                  className="btn"
                  onClick={toggle}
                >
                  <span className="btn-label">{isListening ? "Stop" : "New Transcript"}</span>
                  <span className="btn-subtitle">{currentLanguage?.label ?? language}</span>
                </button>

                <button
                  className="lang-caret"
                  type="button"
                  disabled={isListening}
                  aria-label="Change recording language"
                  onClick={() => setLangMenuOpen((open) => !open)}
                >
                  ▾
                </button>

                {langMenuOpen && (
                  <div className="lang-menu">
                    {languages.map((lang) => (
                      <button
                        key={lang.code}
                        className={
                          lang.code === language ? "lang-menu-item active" : "lang-menu-item"
                        }
                        onClick={() => {
                          setLanguage(lang.code);
                          setLangMenuOpen(false);
                        }}
                      >
                        {lang.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <span className="controls-spacer" />
          </div>

          <div className="brand">
            <SettingsPanel
              silenceDurationMs={silenceDurationMs}
              onSilenceDurationChange={handleSilenceDurationChange}
            />
            <h1>phonemizer.live</h1>
          </div>
        </div>

        {error && <p className="error">{error}</p>}

        <div className="stage">
          {view === "inventory" ? (
            <PhonemeInventory
              inventory={inventory}
              onExampleClick={jumpToExample}
              apiBase={API_BASE}
              sessionId={SESSION_ID}
            />
          ) : selected ? (
            <SpectrogramView
              transcript={selected}
              apiBase={API_BASE}
              sessionId={SESSION_ID}
              seekRequest={seekRequest?.transcriptId === selected.id ? seekRequest : null}
            />
          ) : (
            <p className="empty">Nothing yet — press New Recording and talk.</p>
          )}
        </div>
        </main>
      </div>
      <Footer />
    </div>
  );
}

export default App;
