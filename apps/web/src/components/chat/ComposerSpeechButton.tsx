import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { CheckIcon, MicIcon, RotateCcwIcon, SettingsIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { VoiceInputPill, VoiceWaveform } from "./VoiceInputPill";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const VOICE_ERROR_LABELS: Record<string, string> = {
  "This draft is no longer available.": "Draft unavailable",
  "Another voice recording is already active.": "Another recording active",
  "Voice transcription is not available.": "Voice input unavailable",
  "Microphone access is required for voice input.": "Microphone access needed",
  "Voice transcription is still finishing. Try again shortly.": "Transcription still busy",
  "Voice transcription is not available for this language.": "Language unsupported",
  "Could not prepare voice transcription.": "Couldn’t prepare dictation",
  "Could not start voice recording.": "Couldn’t start recording",
  "Voice recording was interrupted.": "Recording interrupted",
  "Voice input stopped when the app moved to the background.": "Recording stopped in background",
  "Could not finish voice recording.": "Couldn’t finish recording",
  "Could not transcribe this recording.": "Transcription failed",
  "The draft changed while voice input was running. The transcript was not added.": "Draft changed",
  "No speech was detected.": "No speech detected",
  "Microphone processing failed.": "Microphone processing failed",
  "The microphone disconnected.": "Microphone disconnected",
  "Could not prepare voice input.": "Couldn’t prepare dictation",
  "Reconnect the project environment to load its dictionary.": "Project disconnected",
  "Personal and project dictionaries together cannot exceed 100 words.":
    "Dictionary exceeds 100 words",
};

function voiceErrorLabel(error: string | null): string {
  return (error && VOICE_ERROR_LABELS[error]) || "Voice input failed";
}

type SpeechPresentation = {
  status: string | null;
  showsCancel: boolean;
  showsConfirm: boolean;
  confirmEnabled: boolean;
  showsSend: boolean;
};

export function shouldShowComposerFooter(
  collapsed: boolean,
  approval: boolean,
  phase: VoiceInputState<true>["phase"],
): boolean {
  return phase !== "idle" || (!collapsed && !approval);
}

export function resolveSpeechPresentation(
  state: VoiceInputState<true>,
  progress: { downloaded: number; total: number } | null,
): SpeechPresentation {
  switch (state.phase) {
    case "idle":
      return {
        status: null,
        showsCancel: false,
        showsConfirm: false,
        confirmEnabled: false,
        showsSend: true,
      };
    case "error":
      return {
        status: state.error ?? "Voice input failed",
        showsCancel: false,
        showsConfirm: false,
        confirmEnabled: false,
        showsSend: true,
      };
    case "preparing":
      return {
        status: progress
          ? `Downloading speech model ${Math.round((progress.downloaded / Math.max(1, progress.total)) * 100)}%`
          : "Preparing",
        showsCancel: true,
        showsConfirm: true,
        confirmEnabled: false,
        showsSend: true,
      };
    case "recording":
      return {
        status: "Recording",
        showsCancel: true,
        showsConfirm: true,
        confirmEnabled: true,
        showsSend: true,
      };
    case "transcribing":
      return {
        status: "Transcribing",
        showsCancel: true,
        showsConfirm: true,
        confirmEnabled: false,
        showsSend: true,
      };
    case "post-processing":
      return {
        status: "Post-processing",
        showsCancel: true,
        showsConfirm: true,
        confirmEnabled: false,
        showsSend: true,
      };
  }
}

function formatElapsed(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function RecordingStatus(props: { level: number; recordingLimitSeconds?: number | undefined }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000)),
      250,
    );
    return () => window.clearInterval(timer);
  }, []);

  return (
    <>
      <VoiceWaveform level={props.level} />
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
      <span className="shrink-0 text-secondary-label text-xs tabular-nums">
        {formatElapsed(elapsedSeconds)}
        {props.recordingLimitSeconds !== undefined
          ? ` / ${formatElapsed(props.recordingLimitSeconds)}`
          : ""}
      </span>
    </>
  );
}

export function ComposerSpeechStatus(props: {
  state: VoiceInputState<true>;
  progress: { downloaded: number; total: number } | null;
  level: number;
  recordingLimitSeconds?: number | undefined;
}) {
  const presentation = resolveSpeechPresentation(props.state, props.progress);

  if (!presentation.status) return null;
  const isRecording = props.state.phase === "recording";
  const isError = props.state.phase === "error";

  return (
    <div
      className="flex h-7 min-w-0 flex-1 items-center gap-2"
      role="status"
      aria-live={isRecording ? "off" : "polite"}
      aria-label={presentation.status}
    >
      {isRecording ? (
        <RecordingStatus level={props.level} recordingLimitSeconds={props.recordingLimitSeconds} />
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-right text-sm text-secondary-label",
            isError && "text-destructive",
          )}
        >
          {presentation.status}
        </span>
      )}
    </div>
  );
}

export function ComposerSpeechCancelButton(props: {
  state: VoiceInputState<true>;
  shortcutLabel?: string | null;
  onCancel(): void;
}) {
  if (props.state.phase === "idle") return null;
  const label = props.state.phase === "error" ? "Dismiss voice input error" : "Cancel voice input";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm-pill"
            variant="ghost"
            aria-label={label}
            onPointerDown={(event) => event.preventDefault()}
            onClick={props.onCancel}
            className="shrink-0"
          >
            <XIcon />
          </Button>
        }
      />
      <TooltipPopup side="top">
        {label}
        {props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ComposerSpeechButton(props: {
  state: VoiceInputState<true>;
  progress: { downloaded: number; total: number } | null;
  shortcutLabel?: string | null;
  disabled?: boolean;
  onStart(): void;
  onCancel(): void;
}) {
  const presentation = resolveSpeechPresentation(props.state, props.progress);
  const label = "Start voice input";

  if (presentation.showsConfirm || props.state.phase === "error") return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            disabled={props.disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (props.disabled) return;
              props.onStart();
            }}
            className="relative shrink-0"
          >
            <MicIcon />
          </Button>
        }
      />
      <TooltipPopup side="top">
        {label}
        {props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ComposerSpeechRecordingPill(props: {
  state: VoiceInputState<true>;
  progress: { downloaded: number; total: number } | null;
  finishShortcutLabel?: string | null;
  cancelShortcutLabel?: string | null;
  level: number;
  recordingLimitSeconds?: number | undefined;
  onStart(): void;
  disabled?: boolean;
  onStop(): void;
  onCancel(): void;
  onSkipPostProcessing(): void;
}) {
  const presentation = resolveSpeechPresentation(props.state, props.progress);
  const navigate = useNavigate();
  if (props.state.phase === "error") {
    const openSettings = props.state.errorAction === "settings";
    const actionLabel = openSettings
      ? "Open voice settings"
      : props.state.error === "Could not transcribe this recording."
        ? "Retry transcription"
        : "Record again";
    return (
      <VoiceInputPill>
        <ComposerSpeechCancelButton
          state={props.state}
          shortcutLabel={props.cancelShortcutLabel ?? null}
          onCancel={props.onCancel}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                role="status"
                aria-label={props.state.error ?? "Voice input failed"}
                className="min-w-0 flex-1 truncate text-sm text-destructive"
              />
            }
          >
            {voiceErrorLabel(props.state.error)}
          </TooltipTrigger>
          <TooltipPopup side="top">{props.state.error ?? "Voice input failed"}</TooltipPopup>
        </Tooltip>
        {props.state.errorAction ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm-pill"
                  variant="ghost"
                  aria-label={actionLabel}
                  disabled={props.disabled}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (openSettings) {
                      props.onCancel();
                      void navigate({ to: "/settings/voice" });
                    } else {
                      props.onStart();
                    }
                  }}
                />
              }
            >
              {openSettings ? <SettingsIcon /> : <RotateCcwIcon />}
            </TooltipTrigger>
            <TooltipPopup side="top">{actionLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
      </VoiceInputPill>
    );
  }
  if (!presentation.showsConfirm) return null;

  const label = presentation.confirmEnabled
    ? "Finish voice input"
    : (presentation.status ?? "Voice input is busy");

  return (
    <VoiceInputPill>
      <ComposerSpeechCancelButton
        state={props.state}
        shortcutLabel={props.cancelShortcutLabel ?? null}
        onCancel={props.onCancel}
      />
      <ComposerSpeechStatus
        state={props.state}
        progress={props.progress}
        level={props.level}
        recordingLimitSeconds={props.recordingLimitSeconds}
      />
      {props.state.phase === "post-processing" ? (
        <Button
          type="button"
          size="sm-pill"
          variant="ghost"
          onPointerDown={(event) => event.preventDefault()}
          onClick={props.onSkipPostProcessing}
          className="shrink-0"
        >
          Skip
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm-pill"
                aria-label={label}
                disabled={!presentation.confirmEnabled}
                onPointerDown={(event) => event.preventDefault()}
                onClick={props.onStop}
                className="shrink-0"
              >
                {presentation.confirmEnabled ? <CheckIcon /> : <Spinner aria-hidden />}
              </Button>
            }
          />
          <TooltipPopup side="top">
            {label}
            {presentation.confirmEnabled && props.finishShortcutLabel
              ? ` (${props.finishShortcutLabel})`
              : ""}
          </TooltipPopup>
        </Tooltip>
      )}
    </VoiceInputPill>
  );
}
