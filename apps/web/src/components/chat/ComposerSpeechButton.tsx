import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  COMPOSER_PILL_SLOT_BUTTON_CLASS_NAME,
  COMPOSER_PILL_SLOT_BUTTON_UNAVAILABLE_CLASS_NAME,
} from "./ComposerPrimaryActions";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { VoiceInputErrorPill } from "./VoiceInputErrorPill";
import { VoiceInputPill, VoiceWaveform } from "./VoiceInputPill";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Text } from "../ui/text";
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
      <Text variant="meta" tone="muted" numeric>
        {formatElapsed(elapsedSeconds)}
        {props.recordingLimitSeconds !== undefined
          ? ` / ${formatElapsed(props.recordingLimitSeconds)}`
          : ""}
      </Text>
    </>
  );
}

function ComposerSpeechStatus(props: {
  state: VoiceInputState;
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
        <span className="min-w-0 flex-1 truncate text-right">
          <Text tone={isError ? "destructive" : "muted"}>{presentation.status}</Text>
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

// Each bar reads the level a sample apart, so the three never move in lockstep, and the
// middle bar reaches highest so loud speech reads as a wave rather than a flat block.
const SPEECH_BAR_SAMPLE_OFFSETS = [1, 0, 2] as const;
const SPEECH_BAR_GAINS = [0.7, 1, 0.85] as const;
const SPEECH_BAR_RESTING_SCALE = 0.25;
const SPEECH_BAR_STATIC_SCALE = 0.6;

/** The mic glyph while recording: three bars whose heights follow the microphone level. */
function ComposerSpeechBars(props: { level: number; inPill: boolean }) {
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const historyRef = useRef([0, 0, 0]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes microphone levels to the bar transforms; mounted only while recording
  useEffect(() => {
    const history = historyRef.current;
    history.copyWithin(0, 1);
    history[2] = props.level;
    barsRef.current.forEach((bar, index) => {
      if (!bar) return;
      const value = Math.min(1, history[2 - SPEECH_BAR_SAMPLE_OFFSETS[index]!] ?? 0);
      // The curve spreads the loud end, where speech levels bunch up.
      const scale = prefersReducedMotion
        ? SPEECH_BAR_STATIC_SCALE
        : SPEECH_BAR_RESTING_SCALE +
          (1 - SPEECH_BAR_RESTING_SCALE) * value ** 1.5 * SPEECH_BAR_GAINS[index]!;
      bar.style.transform = `scaleY(${scale})`;
    });
  }, [prefersReducedMotion, props.level]);

  return (
    <span
      aria-hidden
      className={cn(
        "flex items-center justify-center gap-0.5 text-composer-icon",
        props.inPill ? "size-3.5" : "size-4",
      )}
    >
      {SPEECH_BAR_SAMPLE_OFFSETS.map((offset, index) => (
        <span
          key={offset}
          ref={(bar) => {
            barsRef.current[index] = bar;
          }}
          className="h-full w-0.5 origin-center rounded-full bg-current transition-transform duration-100 ease-out motion-reduce:transition-none"
          style={{
            transform: `scaleY(${prefersReducedMotion ? SPEECH_BAR_STATIC_SCALE : SPEECH_BAR_RESTING_SCALE})`,
          }}
        />
      ))}
    </span>
  );
}

// In the send pill the mic is one of its 32px slots; elsewhere it is a quiet icon button.
export function ComposerSpeechButton(props: {
  inPill?: boolean;
  state: VoiceInputState;
  shortcutLabel?: string | null;
  disabled?: boolean;
  /** Set when voice input cannot start here yet: the mic shows dimmed and the tooltip says why. */
  unavailableReason?: string | null | undefined;
  /**
   * Keeps the mic in place while dictation runs: level bars while recording (click finishes),
   * a spinner while busy (click skips post-processing). Without it the mic hides and the
   * recording pill takes over.
   */
  dictation?: { level: number; onStop(): void; onSkipPostProcessing(): void } | undefined;
  onStart(): void;
}) {
  const inPill = props.inPill ?? false;
  const { phase } = props.state;
  const { dictation } = props;
  if (phase === "error" || (phase !== "idle" && !dictation)) return null;

  const unavailable = phase === "idle" ? (props.unavailableReason ?? null) : null;
  const isRecording = phase === "recording";
  const isBusy = phase === "preparing" || phase === "transcribing";
  const label = isRecording
    ? "Finish voice input"
    : phase === "preparing"
      ? "Preparing voice input"
      : phase === "transcribing"
        ? "Transcribing"
        : phase === "post-processing"
          ? "Skip post-processing"
          : "Start voice input";
  const showsShortcut = (phase === "idle" || isRecording) && !unavailable;

  const glyph = isRecording ? (
    <ComposerSpeechBars level={dictation?.level ?? 0} inPill={inPill} />
  ) : phase === "idle" ? (
    <MicIcon className={cn("text-composer-icon", inPill && "size-3.5")} />
  ) : (
    // The spinner draws in currentColor, so the wrapper gives it the mic glyph's colour.
    <span aria-hidden className="flex text-composer-icon">
      <Spinner size={inPill ? "sm" : "md"} />
    </span>
  );
  const accessibilityProps = unavailable
    ? ({ "aria-disabled": true, "aria-label": unavailable } as const)
    : isBusy
      ? ({ "aria-disabled": true, "aria-label": label } as const)
      : { "aria-label": label };
  const onClick = () => {
    if (isRecording) dictation?.onStop();
    else if (phase === "post-processing") dictation?.onSkipPostProcessing();
    else if (phase === "idle" && !props.disabled && !unavailable) props.onStart();
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          inPill ? (
            <button
              type="button"
              {...accessibilityProps}
              disabled={phase === "idle" && props.disabled}
              onPointerDown={(event) => event.preventDefault()}
              onClick={onClick}
              className={
                unavailable
                  ? COMPOSER_PILL_SLOT_BUTTON_UNAVAILABLE_CLASS_NAME
                  : COMPOSER_PILL_SLOT_BUTTON_CLASS_NAME
              }
            />
          ) : (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              {...accessibilityProps}
              disabled={phase === "idle" && props.disabled}
              onPointerDown={(event) => event.preventDefault()}
              onClick={onClick}
              className="relative shrink-0"
            />
          )
        }
      >
        {glyph}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {unavailable ?? label}
        {showsShortcut && props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
        {phase !== "idle" && !isRecording ? " (Esc cancels)" : ""}
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
  const presentation = resolveSpeechPresentation(props.state, props.progress);
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
