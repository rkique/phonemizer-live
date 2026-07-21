import { useCallback, useEffect, useRef, useState } from "react";

const SILENCE_THRESHOLD = 0.02;
// 700ms was cutting recordings into multiple pieces on ordinary
// mid-sentence pauses/breaths — most natural speech pauses fall well
// under 1.5s, so this only splits on a genuinely finished utterance.
export const DEFAULT_SILENCE_DURATION_MS = 1500;
const MIN_UTTERANCE_MS = 300;

export interface UseAudioSegmenterResult {
  isListening: boolean;
  start: () => Promise<void>;
  stop: () => void;
}

export function useAudioSegmenter(
  onUtterance: (blob: Blob) => void,
  onLevel: ((rms: number) => void) | undefined,
  onElapsed: ((seconds: number) => void) | undefined,
  silenceDurationMs = DEFAULT_SILENCE_DURATION_MS
): UseAudioSegmenterResult {
  const [isListening, setIsListening] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const streamPromiseRef = useRef<Promise<MediaStream> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const recordingStartRef = useRef(0);

  const silenceStartRef = useRef<number | null>(null);
  const speechStartRef = useRef<number | null>(null);
  const hasSpeechRef = useRef(false);

  const startRecorder = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    chunksRef.current = [];
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.start();
    recorderRef.current = recorder;
    hasSpeechRef.current = false;
    speechStartRef.current = null;
    silenceStartRef.current = null;
  }, []);

  const finalizeUtterance = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    const hadSpeech = hasSpeechRef.current;
    recorder.onstop = () => {
      if (hadSpeech && chunksRef.current.length > 0) {
        onUtterance(new Blob(chunksRef.current, { type: "audio/webm" }));
      }
      if (streamRef.current) startRecorder();
    };
    recorder.stop();
  }, [onUtterance, startRecorder]);

  const monitor = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);

    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    const now = performance.now();
    onLevel?.(rms);
    onElapsed?.((now - recordingStartRef.current) / 1000);

    if (rms > SILENCE_THRESHOLD) {
      if (!speechStartRef.current) speechStartRef.current = now;
      if (now - speechStartRef.current > MIN_UTTERANCE_MS) hasSpeechRef.current = true;
      silenceStartRef.current = null;
    } else if (hasSpeechRef.current) {
      if (!silenceStartRef.current) silenceStartRef.current = now;
      if (now - silenceStartRef.current > silenceDurationMs) {
        finalizeUtterance();
      }
    }

    rafRef.current = requestAnimationFrame(monitor);
  }, [finalizeUtterance, onLevel, onElapsed, silenceDurationMs]);

  // Acquiring the mic + building the analyser graph is the only async work
  // between a click and audio actually being captured. 
  
  // Device negotiation(especially for an external mic) can take a real amount of time, so we
  // do this once, eagerly, and keep the stream warm for the session instead
  // of paying that cost on every "New Transcript" click.

  const ensureStream = useCallback(() => {
    if (streamRef.current) return Promise.resolve(streamRef.current);

    // StrictMode (or a double-click) can call this before the first
    // getUserMedia resolves — cache the in-flight promise so only one
    // request ever goes out, instead of racing two live streams.

    if (!streamPromiseRef.current) {
      streamPromiseRef.current = (async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;

        const audioCtx = new AudioContext();
        audioCtxRef.current = audioCtx;
        if (audioCtx.state === "suspended") {
          // Creating the context after the getUserMedia await can leave it
          // suspended in some Chrome versions — the analyser would then
          // read flat silence for the whole session, breaking both the
          // live level meter and (more importantly) the RMS-based
          // speech/silence timing that decides when to auto-segment. Never
          // let a rejection here block recording itself.
          audioCtx.resume().catch(() => {});
        }
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        analyserRef.current = analyser;

        return stream;
      })();
    }
    return streamPromiseRef.current;
  }, []);

  // Pre-warm as soon as this hook is mounted, so the very first click is
  // just as instant as subsequent ones. Released on actual page unload
  // (not React effect cleanup) — StrictMode's dev-only synthetic
  // mount/unmount/remount would otherwise tear this down and force a
  // second, duplicate getUserMedia call right after the first.
  useEffect(() => {
    ensureStream().catch(() => {});
    const releaseOnUnload = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      audioCtxRef.current?.close();
    };
    window.addEventListener("pagehide", releaseOnUnload);
    return () => window.removeEventListener("pagehide", releaseOnUnload);
  }, [ensureStream]);

  const start = useCallback(async () => {
    await ensureStream();
    recordingStartRef.current = performance.now();
    onElapsed?.(0);
    startRecorder();
    setIsListening(true);
    rafRef.current = requestAnimationFrame(monitor);
  }, [ensureStream, monitor, startRecorder, onElapsed]);

  const stop = useCallback(() => {
    setIsListening(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      const hadSpeech = hasSpeechRef.current;
      recorder.onstop = () => {
        if (hadSpeech && chunksRef.current.length > 0) {
          onUtterance(new Blob(chunksRef.current, { type: "audio/webm" }));
        }
      };
      recorder.stop();
    }
    // Deliberately don't stop the stream or close the AudioContext here —
    // they stay warm so the next "New Recording" click is instant too.
  }, [onUtterance]);

  return { isListening, start, stop };
}
