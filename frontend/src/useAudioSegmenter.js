import { useCallback, useRef, useState } from "react";

const SILENCE_THRESHOLD = 0.02;
const SILENCE_DURATION_MS = 700;
const MIN_UTTERANCE_MS = 300;

export function useAudioSegmenter(onUtterance, onLevel, onElapsed) {
  const [isListening, setIsListening] = useState(false);

  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const rafRef = useRef(null);
  const recordingStartRef = useRef(0);

  const silenceStartRef = useRef(null);
  const speechStartRef = useRef(null);
  const hasSpeechRef = useRef(false);

  const startRecorder = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
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
      if (now - silenceStartRef.current > SILENCE_DURATION_MS) {
        finalizeUtterance();
      }
    }

    rafRef.current = requestAnimationFrame(monitor);
  }, [finalizeUtterance, onLevel, onElapsed]);

  const start = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    analyserRef.current = analyser;

    recordingStartRef.current = performance.now();
    onElapsed?.(0);
    startRecorder();
    setIsListening(true);
    rafRef.current = requestAnimationFrame(monitor);
  }, [monitor, startRecorder, onElapsed]);

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

    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close();
    streamRef.current = null;
  }, [onUtterance]);

  return { isListening, start, stop };
}
