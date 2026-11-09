import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { useEffect, useState, type PointerEvent, type ReactElement } from "react";

import { VoiceInputErrorPill } from "./VoiceInputErrorPill";
import { VoiceInputPill, VoiceWaveform } from "./VoiceInputPill";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type DownloadProgress = { downloaded: number; total: number } | null;

const keepFocus = (event: PointerEvent) => event.preventDefault();

/** One short status line per phase; also mirrored into the preview annotation editor. */
export function resolveSpeechPresentation(
  state: VoiceInputState,
  progress: DownloadProgress,
): { status: string | null; active: boolean } {
  switch (state.phase) {
    case "idle":
      return { status: null, active: false };
    case "error":
      return { status: state.error ?? "Voice input failed", active: false };
    case "preparing":
      return {
        status: progress
          ? `Downloading model ${Math.round((progress.downloaded / Math.max(1, progress.total)) * 100)}%`
          : "Starting…",
        active: true,
      };
    case "recording":
      return { status: "Recording", active: true };
    case "transcribing":
      return { status: "Transcribing…", active: true };
    case "post-processing":
      return { status: "Cleaning up…", active: true };
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
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive" />
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatElapsed(elapsedSeconds)}
        {props.recordingLimitSeconds !== undefined
          ? ` / ${formatElapsed(props.recordingLimitSeconds)}`
          : ""}
      </span>
      <div className="me-1.5 flex w-16 min-w-0 shrink">
        <VoiceWaveform level={props.level} />
      </div>
    </>
  );
}

function ShortcutTooltip(props: {
  label: string;
  shortcut?: string | null | undefined;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="top">
        {props.label}
        {props.shortcut ? ` (${props.shortcut})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ComposerSpeechButton(props: {
  state: VoiceInputState;
  shortcutLabel?: string | null;
  disabled?: boolean;
  /** Compact matches the `xs` buttons beside text-field editors. */
  size?: "default" | "compact";
  onStart(): void;
}) {
  if (props.state.phase !== "idle") return null;
  const label = "Start voice input";

  return (
    <ShortcutTooltip label={label} shortcut={props.shortcutLabel}>
      <Button
        type="button"
        size={props.size === "compact" ? "icon-xs" : "icon-sm"}
        variant="ghost"
        aria-label={label}
        disabled={props.disabled}
        onPointerDown={keepFocus}
        onClick={() => {
          if (!props.disabled) props.onStart();
        }}
        className="shrink-0"
      >
        <MicIcon />
      </Button>
    </ShortcutTooltip>
  );
}

export function ComposerSpeechRecordingPill(props: {
  state: VoiceInputState;
  progress: DownloadProgress;
  finishShortcutLabel?: string | null;
  cancelShortcutLabel?: string | null;
  level: number;
  recordingLimitSeconds?: number | undefined;
  /** Compact matches the `xs` buttons beside text-field editors. */
  size?: "default" | "compact";
  onStart(): void;
  disabled?: boolean;
  onStop(): void;
  onCancel(): void;
  onSkipPostProcessing(): void;
}) {
  const { phase } = props.state;
  const compact = props.size === "compact";
  if (phase === "error") {
    return (
      <VoiceInputErrorPill
        size={props.size}
        error={props.state.error}
        errorAction={props.state.errorAction}
        disabled={props.disabled ?? false}
        cancelShortcutLabel={props.cancelShortcutLabel ?? null}
        onRetry={props.onStart}
        onDismiss={props.onCancel}
      />
    );
  }
  const presentation = resolveSpeechPresentation(props.state, props.progress);
  if (!presentation.active) return null;
  const recording = phase === "recording";
  const trailing = recording || phase === "post-processing";

  return (
    <VoiceInputPill size={props.size}>
      <ShortcutTooltip label="Cancel voice input" shortcut={props.cancelShortcutLabel}>
        <Button
          type="button"
          size={compact ? "icon-xs" : "icon-sm-pill"}
          variant="ghost"
          aria-label="Cancel voice input"
          onPointerDown={keepFocus}
          onClick={props.onCancel}
          className="shrink-0"
        >
          <XIcon />
        </Button>
      </ShortcutTooltip>
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 overflow-hidden",
          !trailing && "pe-2.5",
        )}
        role="status"
        aria-live={recording ? "off" : "polite"}
        aria-label={presentation.status ?? undefined}
      >
        {recording ? (
          <RecordingStatus
            level={props.level}
            recordingLimitSeconds={props.recordingLimitSeconds}
          />
        ) : (
          <>
            <Spinner aria-hidden size="sm" tone="muted" className="shrink-0" />
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {presentation.status}
            </span>
          </>
        )}
      </div>
      {phase === "post-processing" ? (
        <Button
          type="button"
          size={compact ? "xs" : "sm-pill"}
          variant="ghost"
          onPointerDown={keepFocus}
          onClick={props.onSkipPostProcessing}
          className="shrink-0"
        >
          Skip
        </Button>
      ) : recording ? (
        <ShortcutTooltip label="Finish voice input" shortcut={props.finishShortcutLabel}>
          <Button
            type="button"
            size={compact ? "icon-xs" : "icon-sm-pill"}
            aria-label="Finish voice input"
            onPointerDown={keepFocus}
            onClick={props.onStop}
            className="shrink-0"
          >
            <CheckIcon />
          </Button>
        </ShortcutTooltip>
      ) : null}
    </VoiceInputPill>
  );
}
