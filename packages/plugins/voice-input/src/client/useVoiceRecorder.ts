import {
  PLUGIN_KEYBINDING_COMMAND_EVENT_TYPE,
  type PluginComposerActionContext,
  type PluginKeybindingCommandEventDetail,
} from "@t3tools/plugin-api/ui";

import { VOICE_INPUT_COMMANDS, VOICE_INPUT_KEYBINDING_COMMANDS } from "../shared/constants.ts";
import type { VoiceInputTranscribeResult } from "../shared/schema.ts";
import { useVoiceInputClientState, type VoiceInputClientState } from "./voiceInputClientState.ts";

type VoiceRecorderMode =
  | "loading"
  | "idle"
  | "recording"
  | "transcribing"
  | "dependencyMissing"
  | "unsupported"
  | "permissionDenied";

export interface VoiceRecorderState {
  readonly mode: VoiceRecorderMode;
  readonly elapsedSeconds: number;
  readonly tooltip: string;
  readonly enabled: boolean;
}

export const EMPTY_TRANSCRIPTION_MESSAGE =
  "Local Whisper returned an empty transcript. Try speaking closer to the microphone or recording a longer message.";

export function resolveTranscriptionText(
  result: Pick<VoiceInputTranscribeResult, "text">,
):
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Empty"; readonly message: string } {
  const text = result.text.trim();
  return text.length > 0
    ? { _tag: "Text", text }
    : { _tag: "Empty", message: EMPTY_TRANSCRIPTION_MESSAGE };
}

function preferredMimeType(): string {
  if (
    typeof MediaRecorder !== "undefined" &&
    MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
  ) {
    return "audio/webm;codecs=opus";
  }
  if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm")) {
    return "audio/webm";
  }
  return "";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = result.indexOf(",");
      resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1));
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Could not read audio.")),
    );
    reader.readAsDataURL(blob);
  });
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function dependencyTooltip(status: VoiceInputClientState["status"] | null): string {
  if (!status) return "Checking Local Whisper dependencies.";
  if (!status.python.available) return "Python is missing. Open Voice Input settings.";
  if (!status.fasterWhisper.available) {
    return "faster-whisper is missing. Open Voice Input settings.";
  }
  if (!status.selectedModelCached) return "Download the selected Whisper model in settings.";
  return "Voice input";
}

function modeForRecorderReadiness(
  settings: VoiceInputClientState["settings"] | null,
  status: VoiceInputClientState["status"] | null,
): VoiceRecorderMode {
  if (!settings) return "loading";
  if (!settings.enabled) return "idle";
  if (!status) return "dependencyMissing";
  return status.python.available && status.fasterWhisper.available && status.selectedModelCached
    ? "idle"
    : "dependencyMissing";
}

export function useVoiceRecorder(ctx: PluginComposerActionContext): VoiceRecorderState & {
  readonly toggle: () => void;
  readonly cancel: () => void;
} {
  const React = ctx.react;
  const clientState = useVoiceInputClientState(ctx);
  const settings = clientState.settings;
  const status = clientState.status;
  const [mode, setMode] = React.useState<VoiceRecorderMode>("loading");
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const elapsedTimerRef = React.useRef<number | null>(null);
  const maxDurationTimerRef = React.useRef<number | null>(null);
  const requestIdRef = React.useRef(0);
  const ctxRef = React.useRef(ctx);
  const settingsRef = React.useRef(settings);
  const statusRef = React.useRef(status);
  const composerIdRef = React.useRef(ctx.composer.composerId);

  ctxRef.current = ctx;
  settingsRef.current = settings;
  statusRef.current = status;
  composerIdRef.current = ctx.composer.composerId;

  const stopTimers = React.useCallback(() => {
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    if (maxDurationTimerRef.current !== null) {
      window.clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }
  }, []);

  const stopStream = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  React.useEffect(() => {
    if (
      mode === "recording" ||
      mode === "transcribing" ||
      mode === "permissionDenied" ||
      mode === "unsupported"
    )
      return;
    setMode(
      clientState.error
        ? "dependencyMissing"
        : modeForRecorderReadiness(clientState.settings, clientState.status),
    );
  }, [clientState.error, clientState.settings, clientState.status, mode]);

  const teardownRecording = React.useCallback(() => {
    requestIdRef.current += 1;
    const recorder = recorderRef.current;
    chunksRef.current = [];
    stopTimers();
    stopStream();
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  }, [stopStream, stopTimers]);

  const cancel = React.useCallback(() => {
    teardownRecording();
    setElapsedSeconds(0);
    setMode(modeForRecorderReadiness(settingsRef.current, statusRef.current));
  }, [teardownRecording]);

  const finishRecording = React.useCallback(
    async (requestId: number, mimeType: string) => {
      stopTimers();
      stopStream();
      const activeSettings = settingsRef.current;
      if (!activeSettings || requestId !== requestIdRef.current) return;
      const blob = new Blob(chunksRef.current, { type: mimeType || "audio/webm" });
      chunksRef.current = [];
      if (blob.size === 0) {
        setMode("idle");
        return;
      }
      if (blob.size > activeSettings.maxUploadBytes) {
        ctxRef.current.toast.error(
          "Recording too large",
          "Shorten the message or raise the upload limit.",
        );
        setMode("idle");
        return;
      }

      setMode("transcribing");
      try {
        const audioBase64 = await blobToBase64(blob);
        const result = await ctxRef.current.api.invoke<VoiceInputTranscribeResult>(
          VOICE_INPUT_COMMANDS.transcribe,
          {
            audioBase64,
            mimeType: blob.type || mimeType || "audio/webm",
            sizeBytes: blob.size,
          },
        );
        const currentCtx = ctxRef.current;
        if (
          requestId !== requestIdRef.current ||
          composerIdRef.current !== currentCtx.composer.composerId
        ) {
          return;
        }
        const transcription = resolveTranscriptionText(result);
        if (transcription._tag === "Empty") {
          currentCtx.toast.error("No speech detected", transcription.message);
          setMode("idle");
          return;
        }
        const inserted = currentCtx.composer.insertText(transcription.text);
        if (inserted) {
          currentCtx.composer.focus();
        } else {
          currentCtx.toast.error(
            "Transcript was not inserted",
            "The transcription completed, but the composer did not accept the text.",
          );
        }
        setMode("idle");
      } catch (error) {
        if (requestId === requestIdRef.current) {
          ctxRef.current.toast.error(
            "Transcription failed",
            error instanceof Error ? error.message : "Local Whisper failed.",
          );
          setMode("idle");
        }
      }
    },
    [stopStream, stopTimers],
  );

  const stopRecording = React.useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
  }, []);

  const startRecording = React.useCallback(async () => {
    if (!settings?.enabled) return;
    if (mode === "dependencyMissing" || mode === "unsupported" || mode === "transcribing") {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMode("unsupported");
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (requestId !== requestIdRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener(
        "stop",
        () => {
          recorderRef.current = null;
          void finishRecording(requestId, mimeType);
        },
        { once: true },
      );
      recorder.start();
      setElapsedSeconds(0);
      setMode("recording");
      elapsedTimerRef.current = window.setInterval(() => {
        setElapsedSeconds((current) => current + 1);
      }, 1_000);
      maxDurationTimerRef.current = window.setTimeout(() => {
        stopRecording();
      }, settings.maxRecordingSeconds * 1_000);
    } catch {
      if (requestId !== requestIdRef.current) return;
      stopTimers();
      stopStream();
      recorderRef.current = null;
      chunksRef.current = [];
      setMode("permissionDenied");
    }
  }, [finishRecording, mode, settings, stopRecording, stopStream, stopTimers]);

  const toggle = React.useCallback(() => {
    if (mode === "recording") {
      stopRecording();
      return;
    }
    void startRecording();
  }, [mode, startRecording, stopRecording]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && recorderRef.current) {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel]);

  React.useEffect(() => {
    const onPluginCommand = (event: Event) => {
      const detail = (event as CustomEvent<PluginKeybindingCommandEventDetail>).detail;
      if (detail?.composerId !== undefined && detail.composerId !== composerIdRef.current) {
        return;
      }
      if (detail?.command === VOICE_INPUT_KEYBINDING_COMMANDS.toggleRecording) {
        toggle();
      }
      if (detail?.command === VOICE_INPUT_KEYBINDING_COMMANDS.cancelRecording) {
        cancel();
      }
    };
    window.addEventListener(PLUGIN_KEYBINDING_COMMAND_EVENT_TYPE, onPluginCommand);
    return () => window.removeEventListener(PLUGIN_KEYBINDING_COMMAND_EVENT_TYPE, onPluginCommand);
  }, [cancel, toggle]);

  React.useEffect(() => {
    if (mode === "recording") {
      ctx.composer.setActionState({
        blocksSend: true,
        label: "Voice recording",
        blockingReason: "Voice recording in progress",
      });
      return;
    }
    if (mode === "transcribing") {
      ctx.composer.setActionState({
        blocksSend: true,
        label: "Voice transcription",
        blockingReason: "Voice transcription in progress",
      });
      return;
    }
    ctx.composer.setActionState({ blocksSend: false });
  }, [ctx.composer, mode]);

  React.useEffect(() => {
    return () => {
      teardownRecording();
      ctxRef.current.composer.setActionState({ blocksSend: false });
    };
  }, [teardownRecording]);

  const enabled = settings?.enabled !== false;
  const tooltip =
    mode === "recording"
      ? `Stop recording ${formatElapsed(elapsedSeconds)}`
      : mode === "transcribing"
        ? "Transcribing voice input"
        : mode === "unsupported"
          ? "Voice input is not supported in this browser."
          : mode === "permissionDenied"
            ? "Microphone access failed. Click to retry."
            : mode === "dependencyMissing"
              ? dependencyTooltip(status)
              : "Voice input";

  return {
    mode,
    elapsedSeconds,
    tooltip,
    enabled,
    toggle,
    cancel,
  };
}

export { formatElapsed };
