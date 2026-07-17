import { useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import SpectrogramPlugin from "wavesurfer.js/dist/plugins/spectrogram.esm.js";

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA"]);
const WAVE_HEIGHT = 32;

const STATIC_TABS = [
  { id: "ipa-words", label: "Words" },
  { id: "ipa-phonemes", label: "Phonemes" },
];

function groupUnitsByWord(units) {
  const groups = [];
  for (const u of units ?? []) {
    if (u.kind !== "phoneme") continue;
    //keep track of groups
    if (u.word_start || groups.length === 0) {
      groups.push({ ch: u.ch, start: u.start, end: u.end });
    } else {
      const last = groups[groups.length - 1];
      last.ch += u.ch;
      last.end = u.end;
    }
  }
  return groups;
}

function SpectrogramView({ transcript, apiBase, sessionId, seekRequest }) {
  const containerRef = useRef(null);
  const audioRef = useRef(null);
  //wavesurfer timestamp
  const wsRef = useRef(null);
  const readyRef = useRef(false);
  const pendingSeekRef = useRef(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [mode, setMode] = useState("words");
  const [hoverUnit, setHoverUnit] = useState(null);
  const [hoverZone, setHoverZone] = useState(null);
  const [hoverTime, setHoverTime] = useState(null);
  // Mirrors hoverUnit/hoverZone for the keydown handler below, which is
  // bound once inside the wavesurfer-setup effect and would otherwise only
  // ever see the hover state from the moment it was attached.
  const hoverUnitRef = useRef(null);
  const hoverZoneRef = useRef(null);
  const [audioLoading, setAudioLoading] = useState(false);

  const { text, units, words, audio_url: audioPath, language_label: languageLabel } = transcript;
  const audioUrl = audioPath ? `${apiBase}${audioPath}` : undefined;
  const tabs = useMemo(
    () => [{ id: "words", label: languageLabel ?? "English" }, ...STATIC_TABS],
    [languageLabel]
  );

  useEffect(() => {
    if (!audioUrl || !containerRef.current || !audioRef.current) return undefined;

    const specHeight = Math.max(containerRef.current.clientHeight - WAVE_HEIGHT, 120);
    // Read the accent color from CSS so wavesurfer's inline-style options
    // (which can't take var()) stay in sync with the theme's single source
    // of truth instead of duplicating a hardcoded color here.
    const accentRgb = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent-rgb")
      .trim();

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      media: audioRef.current,
      url: audioUrl,
      height: WAVE_HEIGHT,
      waveColor: "#4b5563",
      progressColor: `rgba(${accentRgb}, 0.5)`,
      cursorColor: "#e04b4b",
      cursorWidth: 2,
      plugins: [
        regions,
        SpectrogramPlugin.create({ height: specHeight, scale: "mel", colorMap: "roseus" }),
      ],
    });
    wsRef.current = ws;
    readyRef.current = false;

    setCurrentTime(0);
    setDuration(0);
    setAudioLoading(true);

    const unsubReady = ws.on("ready", (dur) => {
      setDuration(dur);
      for (const u of units ?? []) {
        if (u.kind !== "phoneme") continue;
        regions.addRegion({
          start: u.start,
          end: u.end,
          content: u.ch,
          drag: false,
          resize: false,
          color: `rgba(${accentRgb}, 0.12)`,
        });
      }
      readyRef.current = true;
      setAudioLoading(false);
      if (pendingSeekRef.current != null) {
        ws.setTime(pendingSeekRef.current);
        pendingSeekRef.current = null;
      }
    });

    const unsubError = ws.on("error", () => setAudioLoading(false));

    const unsubTime = ws.on("timeupdate", (time) => setCurrentTime(time));

    // Regions otherwise swallow the click before wavesurfer's own precise
    // seek runs, snapping playback to the region's start — seek to the
    // exact clicked position instead so hover and click always agree.
    const unsubClick = regions.on("region-clicked", (region, e) => {
      e.stopPropagation();
      const rect = containerRef.current.getBoundingClientRect();
      const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
      ws.setTime(fraction * ws.getDuration());
    });

    const handleKeydown = (e) => {
      if (e.code !== "Space") return;
      const target = e.target;
      if (target && (EDITABLE_TAGS.has(target.tagName) || target.isContentEditable)) return;
      e.preventDefault();

      if (ws.isPlaying()) {
        ws.pause();
        return;
      }

      // While a segment is masked (hovered via the transcript or the audio
      // line), space previews just that segment instead of playing through
      // to the end of the whole recording.
      const unit = hoverUnitRef.current;
      if (unit && hoverZoneRef.current === "waveform") {
        const current = ws.getCurrentTime();
        const from = current >= unit.start && current < unit.end ? current : unit.start;
        ws.play(from, unit.end);
      } else {
        ws.play();
      }
    };
    window.addEventListener("keydown", handleKeydown);

    return () => {
      unsubReady();
      unsubError();
      unsubTime();
      unsubClick();
      window.removeEventListener("keydown", handleKeydown);
      ws.destroy();
    };
  }, [audioUrl, units]);

  useEffect(() => {
    if (!seekRequest) return;
    if (readyRef.current && wsRef.current) {
      wsRef.current.setTime(seekRequest.time);
    } else {
      pendingSeekRef.current = seekRequest.time;
    }
  }, [seekRequest]);

  const wordIpaSegments = useMemo(() => groupUnitsByWord(units), [units]);
  const phonemeSegments = useMemo(
    () => (units ?? []).filter((u) => u.kind === "phoneme"),
    [units]
  );

  const handleMouseMove = (e) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    const time = fraction * duration;
    const unit = phonemeSegments.find((u) => time >= u.start && time < u.end);
    const zone = e.clientY - rect.top <= WAVE_HEIGHT ? "waveform" : "spectrogram";
    setHoverUnit(unit ?? null);
    setHoverZone(zone);
    setHoverTime(time);
    hoverUnitRef.current = unit ?? null;
    hoverZoneRef.current = zone;
  };

  const handleMouseLeave = () => {
    setHoverUnit(null);
    setHoverZone(null);
    setHoverTime(null);
    hoverUnitRef.current = null;
    hoverZoneRef.current = null;
  };

  let segments;
  if (mode === "words") segments = words ?? [];
  else if (mode === "ipa-words") segments = wordIpaSegments;
  else segments = phonemeSegments;

  return (
    <div className="spectrogram-view">
      <div className="pill-row">
        <div className="pills-block">
          <div className="transcript-tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={mode === tab.id ? "transcript-tab active" : "transcript-tab"}
                onClick={() => setMode(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="pills-body">
            <div className="pills">
              {segments.length > 0 ? (
                segments.map((seg, i) => (
                  <button
                    key={i}
                    className={mode === "words" ? "pill" : "pill pill-ipa"}
                    onClick={() => wsRef.current?.setTime(seg.start)}
                    onMouseEnter={() => {
                      setHoverUnit(seg);
                      setHoverZone("waveform");
                      hoverUnitRef.current = seg;
                      hoverZoneRef.current = "waveform";
                    }}
                    onMouseLeave={() => {
                      setHoverUnit(null);
                      setHoverZone(null);
                      hoverUnitRef.current = null;
                      hoverZoneRef.current = null;
                    }}
                  >
                    {mode === "words" ? (
                      seg.pinyin ? (
                        <span className="pill-cjk">
                          <span className="pill-cjk-hanzi">{seg.word}</span>
                          <span className="pill-cjk-pinyin">{seg.pinyin}</span>
                        </span>
                      ) : (
                        seg.word
                      )
                    ) : (
                      seg.ch
                    )}
                  </button>
                ))
              ) : (
                <span className="pill-empty">{text}</span>
              )}
            </div>
          </div>
        </div>

        <div className="pill-row-side">
          {audioUrl && (
            <span className="time-readout">
              {currentTime.toFixed(3)}s / {duration.toFixed(3)}s
            </span>
          )}
          <div className="export-actions">
            <a href={`${apiBase}/transcripts/${transcript.id}/export.txt?session_id=${sessionId}`}>
              Export IPA
            </a>
            {audioUrl && (
              <a href={`${apiBase}/transcripts/${transcript.id}/export.wav?session_id=${sessionId}`}>
                Export Audio
              </a>
            )}
          </div>
        </div>
      </div>

      {audioUrl ? (
        <>
          <div
            className="wavesurfer-wrapper"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            <div ref={containerRef} className="wavesurfer-container" />
            {audioLoading && (
              <div className="wavesurfer-loading">
                <span className="wavesurfer-loading-dot" />
                Loading audio…
              </div>
            )}
            {hoverUnit && duration > 0 && (
              <>
                {hoverZone === "waveform" && (
                  <>
                    <div
                      className="hover-mask"
                      style={{ left: 0, width: `${(hoverUnit.start / duration) * 100}%` }}
                    />
                    <div
                      className="hover-mask"
                      style={{ left: `${(hoverUnit.end / duration) * 100}%`, right: 0 }}
                    />
                  </>
                )}
                <div
                  className="hover-highlight"
                  style={{
                    left: `${(hoverUnit.start / duration) * 100}%`,
                    width: `${((hoverUnit.end - hoverUnit.start) / duration) * 100}%`,
                  }}
                />
              </>
            )}
            {hoverTime != null && duration > 0 && (
              <div
                className="hover-seek-line"
                style={{ left: `${(hoverTime / duration) * 100}%` }}
              />
            )}
          </div>
          <audio
            ref={audioRef}
            className="hidden-audio"
            crossOrigin="anonymous"
            src={audioUrl}
          />
        </>
      ) : (
        <p className="empty">No audio stored for this recording.</p>
      )}
    </div>
  );
}

export default SpectrogramView;
