import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { CheckIcon, MicIcon, MicOffIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { COMPOSER_PILL_BUTTON_CLASS_NAME } from "./ComposerPrimaryActions";

const WAVEFORM_BAR_COUNT = 28;
const WAVEFORM_BAR_IDS = Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => String(index));

type SpeechPresentation = {
  status: string | null;
  showsCancel: boolean;
  showsConfirm: boolean;
  confirmEnabled: boolean;
  showsSend: boolean;
};

export function shouldShowComposerFooter(
  collapsed: boolean,
  phase: VoiceInputState<true>["phase"],
): boolean {
  return phase !== "idle" || !collapsed;
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
        showsSend: false,
      };
    case "recording":
      return {
        status: "Recording",
        showsCancel: true,
        showsConfirm: true,
        confirmEnabled: true,
        showsSend: false,
      };
    case "transcribing":
      return {
        status: "Transcribing",
        showsCancel: true,
        showsConfirm: true,
        confirmEnabled: false,
        showsSend: false,
      };
    case "post-processing":
      return {
        status: "Post-processing",
        showsCancel: true,
        showsConfirm: true,
        confirmEnabled: false,
        showsSend: false,
      };
  }
}

function formatElapsed(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function VoiceWaveform(props: { level: number }) {
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const levelsRef = useRef(Array<number>(WAVEFORM_BAR_COUNT).fill(0));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish microphone samples to the waveform DOM after React commits.
  useEffect(() => {
    const levels = levelsRef.current;
    levels.copyWithin(0, 1);
    levels[levels.length - 1] = props.level;
    barsRef.current.forEach((bar, index) => {
      if (!bar) return;
      const level = levels[index] ?? 0;
      bar.style.opacity = String(0.22 + level * 0.78);
      bar.style.transform = `scaleY(${prefersReducedMotion ? 0.35 : Math.max(0.08, level)})`;
    });
  }, [prefersReducedMotion, props.level]);

  return (
    <div
      aria-hidden
      className="flex h-5 min-w-0 flex-1 items-center justify-between gap-px overflow-hidden"
    >
      {WAVEFORM_BAR_IDS.map((id, index) => (
        <span
          key={id}
          ref={(bar) => {
            barsRef.current[index] = bar;
          }}
          className="h-full w-0.5 shrink-0 origin-center rounded-full bg-primary opacity-25 transition-[transform,opacity] duration-100 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleY(${prefersReducedMotion ? 0.35 : 0.08})` }}
        />
      ))}
    </div>
  );
}

function RecordingStatus(props: { level: number }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Run the elapsed recording clock only while the recording status is mounted.
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
      <span className="shrink-0 text-secondary-label text-meta tabular-nums">
        {formatElapsed(elapsedSeconds)}
      </span>
    </>
  );
}

export function ComposerSpeechStatus(props: {
  state: VoiceInputState<true>;
  progress: { downloaded: number; total: number } | null;
  level: number;
}) {
  const presentation = resolveSpeechPresentation(props.state, props.progress);

  if (!presentation.status) return null;
  const isRecording = props.state.phase === "recording";
  const isError = props.state.phase === "error";

  return (
    <div
      className="flex min-h-7 min-w-0 flex-1 items-center gap-2"
      role="status"
      aria-live={isRecording ? "off" : "polite"}
      aria-label={presentation.status}
    >
      {isRecording ? (
        <RecordingStatus level={props.level} />
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 text-right text-body text-secondary-label",
            // Errors wrap so the whole fix stays readable in a narrow composer.
            isError ? "text-destructive" : "truncate",
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
  const navigate = useNavigate();
  const presentation = resolveSpeechPresentation(props.state, props.progress);
  const openSettings = props.state.phase === "error" && props.state.errorAction === "settings";
  const label = openSettings ? "Open voice settings" : "Start voice input";

  if (presentation.showsConfirm) return null;

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
              if (openSettings) {
                props.onCancel();
                void navigate({ to: "/settings/voice" });
                return;
              }
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
        {!openSettings && props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
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
  onStop(): void;
  onCancel(): void;
  onSkipPostProcessing(): void;
}) {
  const presentation = resolveSpeechPresentation(props.state, props.progress);
  if (!presentation.showsConfirm) return null;

  const label = presentation.confirmEnabled
    ? "Finish voice input"
    : (presentation.status ?? "Voice input is busy");

  return (
    <div className="flex h-10 w-48 min-w-0 items-center gap-2 rounded-full border border-border/50 bg-background/80 p-1 sm:h-9 sm:w-64">
      <ComposerSpeechCancelButton
        state={props.state}
        shortcutLabel={props.cancelShortcutLabel ?? null}
        onCancel={props.onCancel}
      />
      <ComposerSpeechStatus state={props.state} progress={props.progress} level={props.level} />
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
    </div>
  );
}

/** A disabled mic in the send pill whose tooltip says why voice input is off here. */
export function ComposerSpeechUnavailableMic(props: { reason: string }) {
  return (
    <Tooltip>
      {/* A span trigger keeps the reason reachable on hover while the button is disabled. */}
      <TooltipTrigger render={<span className="flex h-full" />}>
        <button
          type="button"
          disabled
          aria-label={`Voice input unavailable: ${props.reason}`}
          className={cn(COMPOSER_PILL_BUTTON_CLASS_NAME, "w-8")}
        >
          <span aria-hidden className="flex text-composer-icon">
            <MicOffIcon className="size-3.5" />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

/** The dictation mic that leads the composer's send and stop pill. */
export function ComposerSpeechMicButton(props: {
  state: VoiceInputState<true>;
  shortcutLabel?: string | null;
  disabled?: boolean;
  onStart(): void;
  onStop(): void;
  onCancel(): void;
}) {
  const navigate = useNavigate();
  const { phase } = props.state;
  const openSettings = phase === "error" && props.state.errorAction === "settings";
  const isRecording = phase === "recording";
  const isBusy = phase === "preparing" || phase === "transcribing" || phase === "post-processing";
  const label = openSettings
    ? "Open voice settings"
    : isRecording
      ? "Finish voice input"
      : phase === "preparing"
        ? "Cancel voice input"
        : isBusy
          ? "Transcribing"
          : "Start voice input";
  const showShortcut = (phase === "idle" || phase === "error" || isRecording) && !openSettings;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={isRecording}
            disabled={(props.disabled && phase === "idle") || phase === "transcribing"}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (openSettings) {
                props.onCancel();
                void navigate({ to: "/settings/voice" });
              } else if (isRecording) {
                props.onStop();
              } else if (phase === "preparing") {
                props.onCancel();
              } else if (!isBusy) {
                props.onStart();
              }
            }}
            data-listening={isRecording || undefined}
            className={cn(COMPOSER_PILL_BUTTON_CLASS_NAME, "w-8")}
          />
        }
      >
        {/* The spinner takes its color from this wrapper; the listening color marks a live recording. */}
        <span
          aria-hidden
          className={cn("flex", isRecording ? "text-(--pill-listening)" : "text-composer-icon")}
        >
          {isBusy ? <Spinner size="sm" /> : <MicIcon className="size-3.5" />}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {label}
        {showShortcut && props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Live transcript and voice status under the composer prompt while dictating. */
export function ComposerSpeechTray(props: {
  state: VoiceInputState<true>;
  progress: { downloaded: number; total: number } | null;
  level: number;
  preview: { committed: string; tentative: string } | null;
  onCancel(): void;
  onSkipPostProcessing(): void;
}) {
  if (props.state.phase === "idle" && !props.preview) return null;
  return (
    <div data-chat-composer-speech="true" className="flex flex-col gap-1 px-3 pb-2 sm:px-4">
      {props.preview ? (
        <div
          aria-label="Live transcription"
          className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-body leading-relaxed"
        >
          <span>{props.preview.committed}</span>
          <span className="text-muted-foreground">{props.preview.tentative}</span>
        </div>
      ) : null}
      {props.state.phase === "idle" ? null : (
        <div className="flex min-h-7 min-w-0 items-center gap-2">
          <ComposerSpeechStatus state={props.state} progress={props.progress} level={props.level} />
          {props.state.phase === "post-processing" ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onSkipPostProcessing}
            >
              Skip cleanup
            </Button>
          ) : null}
          <ComposerSpeechCancelButton
            state={props.state}
            shortcutLabel="Esc"
            onCancel={props.onCancel}
          />
        </div>
      )}
    </div>
  );
}
