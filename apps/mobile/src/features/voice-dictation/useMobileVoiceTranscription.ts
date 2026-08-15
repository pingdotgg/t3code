import {
  resolveVoiceTranscriptionAction,
  type VoiceTranscriptionAction,
} from "@t3tools/shared/voiceTranscription";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type MobileVoiceTranscriptionConfig,
  transcribeMobileVoiceRecording,
} from "./mobileVoiceTranscription";

const LEVEL_COUNT = 36;
const FLAT_LEVELS = Array<number>(LEVEL_COUNT).fill(0);
const MIN_RECORDING_MS = 250;
const MAX_RECORDING_MS = 5 * 60 * 1_000;

export type MobileVoiceTranscriptionStatus = "idle" | "recording" | "transcribing";

export function useMobileVoiceTranscription(input: {
  readonly provider: MobileVoiceTranscriptionConfig["provider"];
  readonly apiKey: string;
  readonly model: string;
  readonly onTranscriptInsert: (text: string) => void;
  readonly onTranscriptSend: (text: string) => void;
}) {
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
    numberOfChannels: 1,
  });
  const recorderState = useAudioRecorderState(recorder, 50);
  const [status, setStatus] = useState<MobileVoiceTranscriptionStatus>("idle");
  const [levels, setLevels] = useState<readonly number[]>(FLAT_LEVELS);
  const [error, setError] = useState<string | null>(null);
  const statusRef = useRef(status);
  const startingRef = useRef(false);
  const cancelStartingRef = useRef(false);
  const restartAfterCancellationRef = useRef(false);
  const stopInFlightRef = useRef(false);
  const terminalActionRef = useRef<VoiceTranscriptionAction | null>(null);
  const transcriptionAttemptRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const configRef = useRef<MobileVoiceTranscriptionConfig>({
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
  });
  const onTranscriptInsertRef = useRef(input.onTranscriptInsert);
  const onTranscriptSendRef = useRef(input.onTranscriptSend);
  const startRef = useRef<() => Promise<void>>(async () => undefined);
  const stopRef = useRef<(action?: "insert" | "send") => Promise<void>>(async () => undefined);
  statusRef.current = status;
  configRef.current = {
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
  };
  onTranscriptInsertRef.current = input.onTranscriptInsert;
  onTranscriptSendRef.current = input.onTranscriptSend;

  const clearRecordingTimeout = useCallback(() => {
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const resetAudioMode = useCallback(async () => {
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(
      () => undefined,
    );
  }, []);

  const stop = useCallback(
    async (action: "insert" | "send" = "insert") => {
      let transcriptionAttempt: number | null = null;
      terminalActionRef.current = resolveVoiceTranscriptionAction(
        terminalActionRef.current,
        action,
      );
      if (startingRef.current) {
        // Permission and recorder preparation are already in flight. Keep the
        // requested terminal action and apply it as soon as recording starts.
        return;
      }
      if (statusRef.current !== "recording" || stopInFlightRef.current) return;
      stopInFlightRef.current = true;
      clearRecordingTimeout();
      try {
        const beforeStop = await recorder.getStatus();
        await recorder.stop();
        const uri = recorder.uri;
        await resetAudioMode();
        if (!mountedRef.current) return;
        if (
          terminalActionRef.current === "abort" ||
          beforeStop.durationMillis < MIN_RECORDING_MS ||
          !uri
        ) {
          if (mountedRef.current) {
            statusRef.current = "idle";
            setStatus("idle");
            setLevels(FLAT_LEVELS);
          }
          return;
        }

        if (mountedRef.current) setStatus("transcribing");
        statusRef.current = "transcribing";
        transcriptionAttempt = ++transcriptionAttemptRef.current;
        const text = await transcribeMobileVoiceRecording(uri, configRef.current);
        if (!mountedRef.current || transcriptionAttempt !== transcriptionAttemptRef.current) {
          return;
        }
        const finalAction = resolveVoiceTranscriptionAction(terminalActionRef.current, "insert");
        if (text && finalAction !== "abort") {
          if (finalAction === "send") onTranscriptSendRef.current(text);
          else onTranscriptInsertRef.current(text);
        }
        statusRef.current = "idle";
        setStatus("idle");
        setLevels(FLAT_LEVELS);
      } catch (cause) {
        if (
          transcriptionAttempt !== null &&
          transcriptionAttempt !== transcriptionAttemptRef.current
        ) {
          return;
        }
        await resetAudioMode();
        if (!mountedRef.current) return;
        setError(cause instanceof Error ? cause.message : "Voice transcription failed.");
        statusRef.current = "idle";
        setStatus("idle");
        setLevels(FLAT_LEVELS);
      } finally {
        if (
          transcriptionAttempt === null ||
          transcriptionAttempt === transcriptionAttemptRef.current
        ) {
          stopInFlightRef.current = false;
          terminalActionRef.current = null;
        }
      }
    },
    [clearRecordingTimeout, recorder, resetAudioMode],
  );
  stopRef.current = stop;

  const cancel = useCallback(async () => {
    terminalActionRef.current = "abort";
    if (startingRef.current) {
      cancelStartingRef.current = true;
      clearRecordingTimeout();
      statusRef.current = "idle";
      if (mountedRef.current) setStatus("idle");
      return;
    }
    if (statusRef.current === "transcribing") {
      transcriptionAttemptRef.current += 1;
      stopInFlightRef.current = false;
      terminalActionRef.current = null;
      statusRef.current = "idle";
      if (mountedRef.current) {
        setStatus("idle");
        setLevels(FLAT_LEVELS);
      }
      return;
    }
    if (statusRef.current !== "recording" || stopInFlightRef.current) return;
    stopInFlightRef.current = true;
    clearRecordingTimeout();
    try {
      await recorder.stop();
    } catch {
      // Cancellation is best-effort; the audio is discarded either way.
    } finally {
      await resetAudioMode();
      statusRef.current = "idle";
      stopInFlightRef.current = false;
      terminalActionRef.current = null;
      if (mountedRef.current) {
        setStatus("idle");
        setLevels(FLAT_LEVELS);
      }
    }
  }, [clearRecordingTimeout, recorder, resetAudioMode]);

  const start = useCallback(async () => {
    if (startingRef.current) {
      if (cancelStartingRef.current) restartAfterCancellationRef.current = true;
      return;
    }
    if (statusRef.current !== "idle") return;
    if (!configRef.current.apiKey.trim()) {
      setError("Save an API key in Settings first.");
      return;
    }

    startingRef.current = true;
    cancelStartingRef.current = false;
    restartAfterCancellationRef.current = false;
    terminalActionRef.current = null;
    setError(null);
    setLevels(FLAT_LEVELS);
    statusRef.current = "recording";
    setStatus("recording");
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error("Microphone permission was denied.");
      }
      if (cancelStartingRef.current || !mountedRef.current) {
        startingRef.current = false;
        cancelStartingRef.current = false;
        statusRef.current = "idle";
        if (mountedRef.current) setStatus("idle");
        const shouldRestart = restartAfterCancellationRef.current;
        restartAfterCancellationRef.current = false;
        if (shouldRestart && mountedRef.current) {
          queueMicrotask(() => void startRef.current());
        }
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (cancelStartingRef.current || !mountedRef.current) {
        startingRef.current = false;
        cancelStartingRef.current = false;
        await resetAudioMode();
        statusRef.current = "idle";
        if (mountedRef.current) setStatus("idle");
        const shouldRestart = restartAfterCancellationRef.current;
        restartAfterCancellationRef.current = false;
        if (shouldRestart && mountedRef.current) {
          queueMicrotask(() => void startRef.current());
        }
        return;
      }
      recorder.record();
      startingRef.current = false;
      const pendingAction = terminalActionRef.current;
      timeoutRef.current = setTimeout(() => {
        void stopRef.current("insert");
      }, MAX_RECORDING_MS);
      if (pendingAction === "insert" || pendingAction === "send") {
        void stopRef.current(pendingAction);
      }
    } catch (cause) {
      startingRef.current = false;
      await resetAudioMode();
      if (cancelStartingRef.current) {
        cancelStartingRef.current = false;
        statusRef.current = "idle";
        if (mountedRef.current) setStatus("idle");
        const shouldRestart = restartAfterCancellationRef.current;
        restartAfterCancellationRef.current = false;
        if (shouldRestart && mountedRef.current) {
          queueMicrotask(() => void startRef.current());
        }
        return;
      }
      if (!mountedRef.current) return;
      setError(cause instanceof Error ? cause.message : "Could not start the microphone.");
      statusRef.current = "idle";
      setStatus("idle");
    }
  }, [recorder, resetAudioMode]);
  startRef.current = start;

  useEffect(() => {
    if (status !== "recording") return;
    const metering = recorderState.metering ?? -60;
    const level = Math.min(1, Math.max(0, (metering + 60) / 60));
    setLevels((current) => [...current.slice(1), level]);
  }, [recorderState.metering, status]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      terminalActionRef.current = "abort";
      restartAfterCancellationRef.current = false;
      transcriptionAttemptRef.current += 1;
      clearRecordingTimeout();
      if (recorder.isRecording) void recorder.stop().catch(() => undefined);
      void resetAudioMode();
    };
  }, [clearRecordingTimeout, recorder, resetAudioMode]);

  return {
    status,
    levels,
    elapsedMs: recorderState.durationMillis,
    error,
    start,
    stop,
    cancel,
  } as const;
}
