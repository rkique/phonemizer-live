import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioSegmenter } from "./useAudioSegmenter";
import Sidebar from "./Sidebar";
import SpectrogramView from "./SpectrogramView";
import PhonemeInventory from "./PhonemeInventory";
import "./App.css";

const API_BASE = "http://127.0.0.1:8000";

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
  const recordControlRef = useRef(null);

  const loadPhonemes = useCallback(() => {
    fetch(`${API_BASE}/phonemes`)
      .then((r) => r.json())
      .then((data) => setInventory(data.inventory ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/history`)
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
      try {
        const form = new FormData();
        form.append("audio", blob, "utterance.webm");
        form.append("language", language);
        const res = await fetch(`${API_BASE}/transcribe`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        if (data.text) {
          setTranscripts((prev) => [...prev, data]);
          setSelectedId(data.id);
          loadPhonemes();
        }
      } catch (e) {
        setError("Transcription failed — is the backend running on :8000?");
      } finally {
        setPending((p) => p - 1);
      }
    },
    [loadPhonemes, language]
  );

  const { isListening, start, stop } = useAudioSegmenter(handleUtterance, setLevel, setElapsed);

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
          fetch(`${API_BASE}/transcripts/${id}`, { method: "DELETE" }).catch(() => {})
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
    window.location.href = `${API_BASE}/export/bulk?ids=${ids.join(",")}`;
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

  return (
    <div className="app">
      <Sidebar
        transcripts={transcripts}
        selectedId={selectedId}
        view={view}
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
          <div className="brand">
            <h1>Sonority</h1>
            <p className="subtitle">Live IPA transcription</p>
          </div>

          <div className="controls">
            <div className="record-control" ref={recordControlRef}>
              <button
                className={isListening ? "btn listening" : "btn"}
                onClick={toggle}
              >
                <span className="btn-label">{isListening ? "Stop" : "New Recording"}</span>
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

            <div className={isListening ? "rec-indicator active" : "rec-indicator"}>
              <span className="rec-dot" />
              {isListening ? (pending > 0 ? "Transcribing…" : "Recording") : "Idle"}
            </div>

            {isListening && <span className="rec-timer">{elapsed.toFixed(2)}s</span>}

            <div className="level-meter">
              <div
                className="level-fill"
                style={{ width: `${Math.min(level * 400, 100)}%` }}
              />
            </div>
          </div>
        </div>

        {error && <p className="error">{error}</p>}

        <div className="stage">
          {view === "inventory" ? (
            <PhonemeInventory
              inventory={inventory}
              onExampleClick={jumpToExample}
              apiBase={API_BASE}
            />
          ) : selected ? (
            <SpectrogramView
              transcript={selected}
              apiBase={API_BASE}
              seekRequest={seekRequest?.transcriptId === selected.id ? seekRequest : null}
            />
          ) : (
            <p className="empty">Nothing yet — press New Recording and talk.</p>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
