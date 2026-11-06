import type { TranslateFn } from "@t3tools/client-runtime/i18n";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useT } from "../../hooks/useI18n";
import { VoiceInputErrorPill } from "./VoiceInputErrorPill";
import { VoiceInputPill, VoiceWaveform } from "./VoiceInputPill";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type SpeechPresentation = {
  status: string | null;
  showsCancel: boolean;
  showsConfirm: boolean;
  confirmEnabled: boolean;
  showsSend: boolean;
};

export function resolveSpeechPresentation(
  state: VoiceInputState,
  progress: { downloaded: number; total: number } | null,
  t: TranslateFn,
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
        status: state.error ?? t("voice.chat.error.failed"),
        showsCancel: false,
        showsConfirm: false,
        confirmEnabled: false,
        showsSend: true,
      };
    case "preparing":
      return {
        status: progress
          ? t("voice.chat.speech.downloadingModel", {
              percent: Math.round((progress.downloaded / Math.max(1, progress.total)) * 100),
            })
          : t("voice.chat.speech.preparing"),
        showsCancel: true,
        showsConfirm: true,
        confirmEnabled: false,
        showsSend: true,
      };
    case "recording":
      return {
        status: t("voice.chat.speech.recording"),
        showsCancel: true,
        showsConfirm: true,
        confirmEnabled: true,
        showsSend: true,
      };
    case "transcribing":
      return {
        status: t("voice.chat.speech.transcribing"),
        showsCancel: true,
        showsConfirm: true,
        confirmEnabled: false,
        showsSend: true,
      };
    case "post-processing":
      return {
        status: t("voice.chat.speech.postProcessing"),
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the timer displaying the native recording duration
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

function ComposerSpeechStatus(props: {
  state: VoiceInputState;
  progress: { downloaded: number; total: number } | null;
  level: number;
  recordingLimitSeconds?: number | undefined;
}) {
  const t = useT();
  const presentation = resolveSpeechPresentation(props.state, props.progress, t);

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

function ComposerSpeechCancelButton(props: {
  state: VoiceInputState;
  shortcutLabel?: string | null;
  onCancel(): void;
}) {
  const t = useT();
  if (props.state.phase === "idle") return null;
  const label =
    props.state.phase === "error" ? t("voice.chat.error.dismiss") : t("voice.chat.speech.cancel");

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
  state: VoiceInputState;
  progress: { downloaded: number; total: number } | null;
  shortcutLabel?: string | null;
  disabled?: boolean;
  onStart(): void;
  onCancel(): void;
}) {
  const t = useT();
  const presentation = resolveSpeechPresentation(props.state, props.progress, t);
  const label = t("voice.chat.speech.start");

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
  state: VoiceInputState;
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
  const t = useT();
  const presentation = resolveSpeechPresentation(props.state, props.progress, t);
  if (props.state.phase === "error") {
    return (
      <VoiceInputErrorPill
        error={props.state.error}
        errorAction={props.state.errorAction}
        disabled={props.disabled ?? false}
        cancelShortcutLabel={props.cancelShortcutLabel ?? null}
        onRetry={props.onStart}
        onDismiss={props.onCancel}
      />
    );
  }
  if (!presentation.showsConfirm) return null;

  const label = presentation.confirmEnabled
    ? t("voice.chat.speech.finish")
    : (presentation.status ?? t("voice.chat.speech.busy"));

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
          {t("voice.chat.speech.skip")}
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
