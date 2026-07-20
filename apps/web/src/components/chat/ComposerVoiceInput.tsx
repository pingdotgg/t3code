import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { MicIcon, SquareIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary";
import { runPrimaryHttp } from "../../lib/runtime";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const preferredRecorderMimeType = (): string | undefined => {
  const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
};

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string") return error.message;
    if ("cause" in error) return errorMessage(error.cause);
  }
  return "Voice transcription failed.";
};

export const ComposerVoiceInput = memo(function ComposerVoiceInput(props: {
  providerInstanceId: ProviderInstanceId;
  hasCodexOauth: boolean;
  disabled: boolean;
  onTranscribed: (text: string) => void;
}) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const operationRef = useRef(0);
  const [state, setState] = useState<"idle" | "requesting" | "recording" | "transcribing">("idle");
  const captureSupported =
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getUserMedia !== undefined &&
    typeof MediaRecorder !== "undefined";
  const unavailableReason = !props.hasCodexOauth
    ? "Voice input requires a Codex ChatGPT OAuth login"
    : !captureSupported
      ? "Voice input is not supported in this browser"
      : props.disabled
        ? "Voice input is unavailable while the composer is disabled"
        : null;

  const releaseCapture = useCallback((stopRecorder = false) => {
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- this component owns the recorder and its single handlers
      recorder.onerror = null;
      if (stopRecorder && recorder.state !== "inactive") recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(
    () => () => {
      operationRef.current += 1;
      releaseCapture(true);
    },
    [releaseCapture],
  );

  const transcribe = async (audioBlob: Blob, operation: number) => {
    setState("transcribing");
    try {
      const audio = new Uint8Array(await audioBlob.arrayBuffer());
      const result = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.voice.transcribe({
              payload: {
                providerInstanceId: props.providerInstanceId,
                audio,
                mimeType: audioBlob.type || "audio/webm",
              },
              headers: {},
            }),
          ),
        ),
      );
      const text = result.text.trim();
      if (operation === operationRef.current && text.length > 0) props.onTranscribed(text);
    } catch (error) {
      if (operation === operationRef.current) {
        toastManager.add({ type: "error", title: errorMessage(error) });
      }
    } finally {
      if (operation === operationRef.current) setState("idle");
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  };

  const startRecording = async () => {
    const operation = ++operationRef.current;
    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (operation !== operationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = preferredRecorderMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        releaseCapture();
        void transcribe(blob, operation);
      };
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- this component owns the recorder and its single handlers
      recorder.onerror = () => {
        releaseCapture();
        setState("idle");
        toastManager.add({ type: "error", title: "Microphone recording failed." });
      };
      recorder.start();
      setState("recording");
    } catch (error) {
      if (operation !== operationRef.current) return;
      releaseCapture();
      setState("idle");
      toastManager.add({
        type: "error",
        title:
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "Microphone access was denied."
            : "Could not access the microphone.",
      });
    }
  };

  const label =
    state === "recording"
      ? "Stop recording"
      : state === "requesting"
        ? "Starting voice input"
        : state === "transcribing"
          ? "Transcribing voice input"
          : (unavailableReason ?? "Start voice input");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={state === "recording" ? "destructive" : "ghost"}
            size="icon-sm"
            className="rounded-full"
            disabled={
              state === "requesting" ||
              state === "transcribing" ||
              (state !== "recording" && unavailableReason !== null)
            }
            aria-label={label}
            aria-pressed={state === "recording"}
            onClick={state === "recording" ? stopRecording : () => void startRecording()}
          />
        }
      >
        {state === "requesting" || state === "transcribing" ? (
          <Spinner className="size-3.5" aria-hidden="true" />
        ) : state === "recording" ? (
          <SquareIcon className="size-3.5 fill-current" />
        ) : (
          <MicIcon className="size-4" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
});
