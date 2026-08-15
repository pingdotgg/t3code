import {
  resolveVoiceTranscriptionAction,
  type VoiceTranscriptionAction,
} from "@t3tools/shared/voiceTranscription";
import { useCallback, useEffect, useRef, useState } from "react";

import { transcribeVoiceRecording, type VoiceTranscriptionConfig } from "../lib/voiceTranscription";

const LEVEL_COUNT = 160;
const MIN_RECORDING_MS = 250;
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
  onTranscriptInsert,
  onTranscriptSend,
}: {
  readonly config: VoiceTranscriptionConfig;
  readonly onTranscriptInsert: (text: string) => void;
  readonly onTranscriptSend: (text: string) => void;
}) {
  const [status, setStatus] = useState<VoiceTranscriptionStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState<readonly number[]>(FLAT_LEVELS);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const statusRef = useRef(status);
  const startingRef = useRef(false);
  const cancelStartingRef = useRef(false);
  const restartAfterCancellationRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const intervalsRef = useRef<number[]>([]);
  const timeoutRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const transcriptionAttemptRef = useRef(0);
  const terminalActionRef = useRef<VoiceTranscriptionAction | null>(null);
  const mountedRef = useRef(true);
  const configRef = useRef(config);
  const onTranscriptInsertRef = useRef(onTranscriptInsert);
  const onTranscriptSendRef = useRef(onTranscriptSend);
  const startRef = useRef<() => Promise<void>>(async () => undefined);
  statusRef.current = status;
  configRef.current = config;
  onTranscriptInsertRef.current = onTranscriptInsert;
  onTranscriptSendRef.current = onTranscriptSend;

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
      restartAfterCancellationRef.current = false;
      transcriptionAttemptRef.current += 1;
      terminalActionRef.current = "abort";
      const recorder = recorderRef.current;
      if (recorder?.state === "recording") recorder.stop();
      cleanupCapture();
    };
  }, [cleanupCapture]);

  const stop = useCallback(
    (action: Exclude<VoiceTranscriptionAction, "abort"> = "insert") => {
      terminalActionRef.current = resolveVoiceTranscriptionAction(
        terminalActionRef.current,
        action,
      );
      if (startingRef.current) {
        // Permission acquisition is already in flight. Preserve the requested
        // action and apply it as soon as MediaRecorder starts.
        return;
      }
      const recorder = recorderRef.current;
      if (recorder?.state === "recording") recorder.stop();
    },
    [cleanupCapture],
  );

  const cancel = useCallback(() => {
    terminalActionRef.current = "abort";
    if (startingRef.current) {
      cancelStartingRef.current = true;
      cleanupCapture();
      if (mountedRef.current) {
        statusRef.current = "idle";
        setStatus("idle");
        setElapsedMs(0);
      }
      return;
    }
    if (statusRef.current === "transcribing") {
      transcriptionAttemptRef.current += 1;
      terminalActionRef.current = null;
      statusRef.current = "idle";
      setStatus("idle");
      setElapsedMs(0);
      return;
    }
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  }, [cleanupCapture]);

  const start = useCallback(async () => {
    if (startingRef.current) {
      if (cancelStartingRef.current) restartAfterCancellationRef.current = true;
      return;
    }
    if (statusRef.current !== "idle") return;
    startingRef.current = true;
    terminalActionRef.current = null;
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
    restartAfterCancellationRef.current = false;
    statusRef.current = "recording";
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
        terminalActionRef.current = null;
        const shouldRestart = restartAfterCancellationRef.current;
        restartAfterCancellationRef.current = false;
        if (shouldRestart && mountedRef.current) {
          queueMicrotask(() => void startRef.current());
        }
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
        terminalActionRef.current = null;
        if (mountedRef.current) {
          setStatus("idle");
          setError("The microphone stopped unexpectedly.");
        }
      });
      recorder.addEventListener("stop", () => {
        const durationMs = Date.now() - startedAtRef.current;
        const requestedAction = terminalActionRef.current ?? "insert";
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        cleanupCapture();
        if (!mountedRef.current || recordingFailed) return;
        if (requestedAction === "abort" || durationMs < MIN_RECORDING_MS || blob.size === 0) {
          terminalActionRef.current = null;
          statusRef.current = "idle";
          setStatus("idle");
          setElapsedMs(0);
          return;
        }

        const transcriptionAttempt = ++transcriptionAttemptRef.current;
        statusRef.current = "transcribing";
        setStatus("transcribing");
        void transcribeVoiceRecording(blob, configRef.current)
          .then((text) => {
            if (!mountedRef.current || transcriptionAttempt !== transcriptionAttemptRef.current) {
              return;
            }
            const finalAction = terminalActionRef.current ?? requestedAction;
            if (text && finalAction !== "abort") {
              if (finalAction === "send") onTranscriptSendRef.current(text);
              else onTranscriptInsertRef.current(text);
            }
            terminalActionRef.current = null;
            statusRef.current = "idle";
            setStatus("idle");
            setElapsedMs(0);
          })
          .catch((cause: unknown) => {
            if (!mountedRef.current || transcriptionAttempt !== transcriptionAttemptRef.current) {
              return;
            }
            terminalActionRef.current = null;
            setError(cause instanceof Error ? cause.message : "Voice transcription failed.");
            statusRef.current = "idle";
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
      timeoutRef.current = window.setTimeout(() => {
        terminalActionRef.current = terminalActionRef.current ?? "insert";
        if (recorder.state === "recording") recorder.stop();
      }, MAX_RECORDING_MS);
      recorder.start(250);
      startingRef.current = false;
      const pendingAction = terminalActionRef.current;
      if (
        (pendingAction === "insert" || pendingAction === "send") &&
        recorder.state === "recording"
      ) {
        recorder.stop();
      }
    } catch (cause) {
      startingRef.current = false;
      cleanupCapture();
      terminalActionRef.current = null;
      if (cancelStartingRef.current) {
        cancelStartingRef.current = false;
        const shouldRestart = restartAfterCancellationRef.current;
        restartAfterCancellationRef.current = false;
        if (shouldRestart && mountedRef.current) {
          queueMicrotask(() => void startRef.current());
        }
        return;
      }
      statusRef.current = "idle";
      setStatus("idle");
      setError(
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow access and try again."
          : "Could not start the microphone.",
      );
    }
  }, [cleanupCapture]);
  startRef.current = start;

  return { status, elapsedMs, levels, error, start, stop, cancel } as const;
}
