import { useState } from "react";
import LiveWaveform from "./LiveWaveform";
import type { Language, Transcript, TranscriptUnit } from "./types";

type TranscriptTabId = "words" | "ipa-words" | "ipa-phonemes";

interface GroupedIpaUnit {
  ch: string;
  start: number;
  end: number;
}

// Renderable regardless of which of words/wordIpaSegments/phonemeSegments it
// came from — only one of word/ch applies depending on the source array.
interface DisplaySegment {
  start: number;
  end: number;
  word?: string;
  pinyin?: string;
  ch?: string;
}

function formatTime(createdAt: string): string {
  if (!createdAt) return "";
  const d = new Date(createdAt.replace(" ", "T") + "Z");
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function groupUnitsByWord(units: TranscriptUnit[] | undefined): GroupedIpaUnit[] {
  const groups: GroupedIpaUnit[] = [];
  for (const u of units ?? []) {
    if (u.kind !== "phoneme") continue;
    if (u.word_start || groups.length === 0) {
      groups.push({ ch: u.ch, start: u.start, end: u.end });
    } else {
      groups[groups.length - 1].ch += u.ch;
    }
  }
  return groups;
}

interface MobileRecordingRowProps {
  entry: Transcript;
  expanded: boolean;
  onToggle: (id: number) => void;
  onDelete: (id: number) => void;
  apiBase: string;
  sessionId: string;
}

// Replacement for Sidebar.jsx on mobile
function MobileRecordingRow({
  entry,
  expanded,
  onToggle,
  onDelete,
  apiBase,
  sessionId,
}: MobileRecordingRowProps) {
  const [mode, setMode] = useState<TranscriptTabId>("words");

  const wordIpaSegments = groupUnitsByWord(entry.units);
  const phonemeSegments = (entry.units ?? []).filter((u) => u.kind === "phoneme");

  let segments: DisplaySegment[];
  if (mode === "words") segments = entry.words ?? [];
  else if (mode === "ipa-words") segments = wordIpaSegments;
  else segments = phonemeSegments;

  return (
    <div className={expanded ? "mobile-accordion-item open" : "mobile-accordion-item"}>
      <button
        className="mobile-accordion-header"
        onClick={() => onToggle(entry.id)}
      >
        <div className="mobile-accordion-summary">
          <div className="mobile-accordion-ipa">{entry.ipa}</div>
          <div className="mobile-accordion-meta">
            <span>{entry.duration ? `${entry.duration.toFixed(1)}s` : ""}</span>
            <span>{formatTime(entry.created_at)}</span>
          </div>
        </div>
        <span className="mobile-accordion-chevron">{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div className="mobile-accordion-body">
          {entry.audio_url && (
            <audio
              className="mobile-audio-player"
              controls
              src={`${apiBase}${entry.audio_url}`}
            />
          )}

          <div className="mobile-transcript-tabs">
            {(
              [
                { id: "words", label: entry.language_label ?? "English" },
                { id: "ipa-words", label: "Words" },
                { id: "ipa-phonemes", label: "Phonemes" },
              ] satisfies { id: TranscriptTabId; label: string }[]
            ).map((tab) => (
              <button
                key={tab.id}
                className={mode === tab.id ? "mobile-transcript-tab active" : "mobile-transcript-tab"}
                onClick={() => setMode(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="mobile-pills">
            {segments.length > 0 ? (
              segments.map((seg, i) => (
                <span key={i} className={mode === "words" ? "mobile-pill" : "mobile-pill mobile-pill-ipa"}>
                  {mode === "words" ? seg.word : seg.ch}
                </span>
              ))
            ) : (
              <span className="mobile-pill-empty">{entry.text}</span>
            )}
          </div>

          <div className="mobile-accordion-actions">
            <a
              className="mobile-action-link"
              href={`${apiBase}/transcripts/${entry.id}/export.txt?session_id=${sessionId}`}
            >
              Export IPA
            </a>
            {entry.audio_url && (
              <a
                className="mobile-action-link"
                href={`${apiBase}/transcripts/${entry.id}/export.wav?session_id=${sessionId}`}
              >
                Export Audio
              </a>
            )}
            <button
              className="mobile-action-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(entry.id);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface MobileAppProps {
  transcripts: Transcript[];
  pending: number;
  isListening: boolean;
  toggle: () => void;
  level: number;
  elapsed: number;
  error: string | null;
  language: string;
  languages: Language[];
  onLanguageChange: (code: string) => void;
  onDelete: (id: number) => void;
  apiBase: string;
  sessionId: string;
}

function MobileApp({
  transcripts,
  pending,
  isListening,
  toggle,
  level,
  elapsed,
  error,
  language,
  languages,
  onLanguageChange,
  onDelete,
  apiBase,
  sessionId,
}: MobileAppProps) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const ordered = transcripts.slice().reverse();

  const toggleExpanded = (id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className="mobile-app">
      <div className="mobile-topbar">
        <h1>phonemizer.live</h1>
        <select
          className="mobile-lang-select"
          value={language}
          disabled={isListening}
          onChange={(e) => onLanguageChange(e.target.value)}
        >
          {languages.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mobile-record-row">
        <button
          className={isListening ? "mobile-tap-btn listening" : "mobile-tap-btn"}
          onClick={toggle}
        >
          <span className="mobile-tap-dot" />
          {isListening ? "Stop" : "Tap to speak"}
        </button>
        {isListening && (
          <div className="mobile-record-status">
            <LiveWaveform level={level} />
            <span className="mobile-record-timer">{elapsed.toFixed(1)}s</span>
          </div>
        )}
        {!isListening && pending > 0 && (
          <div className="mobile-record-status">Transcribing…</div>
        )}
      </div>

      {error && <p className="mobile-error">{error}</p>}

      <div className="mobile-accordion-list">
        {ordered.length === 0 && (
          <p className="mobile-empty">No recordings yet — tap the button above and talk.</p>
        )}
        {ordered.map((entry) => (
          <MobileRecordingRow
            key={entry.id}
            entry={entry}
            expanded={expandedId === entry.id}
            onToggle={toggleExpanded}
            onDelete={onDelete}
            apiBase={apiBase}
            sessionId={sessionId}
          />
        ))}
      </div>
    </div>
  );
}

export default MobileApp;
