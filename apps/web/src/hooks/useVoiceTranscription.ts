import { useCallback, useEffect, useRef, useState } from "react";

import { transcribeVoiceRecording, type VoiceTranscriptionConfig } from "../lib/voiceTranscription";

const LEVEL_COUNT = 160;
const MAX_RECORDING_MS = 5 * 60 * 1_000;
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
const FLAT_LEVELS = Array<number>(LEVEL_COUNT).fill(0);

export type VoiceTranscriptionStatus = "idle" | "recording" | "transcribing";

function supportedMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

export function useVoiceTranscription({
  config,
  onTranscript,
}: {
  readonly config: VoiceTranscriptionConfig;
  readonly onTranscript: (text: string) => void;
}) {
  const [status, setStatus] = useState<VoiceTranscriptionStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState<readonly number[]>(FLAT_LEVELS);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const startingRef = useRef(false);
  const cancelStartingRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const intervalsRef = useRef<number[]>([]);
  const timeoutRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const mountedRef = useRef(true);
  const configRef = useRef(config);
  const onTranscriptRef = useRef(onTranscript);
  configRef.current = config;
  onTranscriptRef.current = onTranscript;

  const cleanupCapture = useCallback(() => {
    for (const interval of intervalsRef.current) window.clearInterval(interval);
    intervalsRef.current = [];
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      startingRef.current = false;
      cancelStartingRef.current = true;
      const recorder = recorderRef.current;
      if (recorder?.state === "recording") recorder.stop();
      cleanupCapture();
    };
  }, [cleanupCapture]);

  const stop = useCallback(() => {
    if (startingRef.current) {
      cancelStartingRef.current = true;
      cleanupCapture();
      if (mountedRef.current) {
        setStatus("idle");
        setElapsedMs(0);
      }
      return;
    }
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  }, [cleanupCapture]);

  const start = useCallback(async () => {
    if (startingRef.current || status !== "idle") return;
    startingRef.current = true;
    setError(null);
    setElapsedMs(0);
    setLevels(FLAT_LEVELS);
    if (!configRef.current.model.trim()) {
      startingRef.current = false;
      setError("Select a transcription model in Settings.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      startingRef.current = false;
      setError("Microphone recording is not supported on this device.");
      return;
    }

    cancelStartingRef.current = false;
    setStatus("recording");
    try {
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      if (audioContext.state === "suspended") {
        void audioContext.resume().catch(() => undefined);
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!mountedRef.current || cancelStartingRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        startingRef.current = false;
        cancelStartingRef.current = false;
        return;
      }

      streamRef.current = stream;
      const mimeType = supportedMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      let recordingFailed = false;
      recorderRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      recorder.addEventListener("error", () => {
        recordingFailed = true;
        cleanupCapture();
        if (mountedRef.current) {
          setStatus("idle");
          setError("The microphone stopped unexpectedly.");
        }
      });
      recorder.addEventListener("stop", () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        cleanupCapture();
        if (!mountedRef.current || recordingFailed) return;
        setStatus("transcribing");
        void transcribeVoiceRecording(blob, configRef.current)
          .then((text) => {
            if (!mountedRef.current) return;
            if (text) onTranscriptRef.current(text);
            setStatus("idle");
            setElapsedMs(0);
          })
          .catch((cause: unknown) => {
            if (!mountedRef.current) return;
            setError(cause instanceof Error ? cause.message : "Voice transcription failed.");
            setStatus("idle");
          });
      });

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      const silentOutput = audioContext.createGain();
      silentOutput.gain.value = 0;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      analyser.connect(silentOutput);
      silentOutput.connect(audioContext.destination);
      if (audioContext.state === "suspended") {
        void audioContext.resume().catch(() => undefined);
      }
      const samples = new Uint8Array(analyser.fftSize);
      intervalsRef.current.push(
        window.setInterval(() => {
          analyser.getByteTimeDomainData(samples);
          let squaredAmplitude = 0;
          for (const sample of samples) {
            const amplitude = (sample - 128) / 128;
            squaredAmplitude += amplitude * amplitude;
          }
          const rootMeanSquare = Math.sqrt(squaredAmplitude / samples.length);
          const nextLevel = Math.min(1, Math.max(0, (rootMeanSquare - 0.008) * 9));
          setLevels((current) => [...current.slice(1), nextLevel]);
        }, 50),
      );
      startedAtRef.current = Date.now();
      intervalsRef.current.push(
        window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 250),
      );
      timeoutRef.current = window.setTimeout(() => recorder.stop(), MAX_RECORDING_MS);
      recorder.start(250);
      startingRef.current = false;
    } catch (cause) {
      startingRef.current = false;
      cleanupCapture();
      if (cancelStartingRef.current) {
        cancelStartingRef.current = false;
        return;
      }
      setStatus("idle");
      setError(
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow access and try again."
          : "Could not start the microphone.",
      );
    }
  }, [cleanupCapture, status]);

  return { status, elapsedMs, levels, error, start, stop } as const;
}
