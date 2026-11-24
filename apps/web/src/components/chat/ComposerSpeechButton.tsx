import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { msg, useGT, useMessages } from "gt-react";
import { CircleAlertIcon, MicIcon } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

import {
  COMPOSER_PILL_SLOT_BUTTON_ACTIVE_CLASS_NAME,
  COMPOSER_PILL_SLOT_BUTTON_CLASS_NAME,
  COMPOSER_PILL_SLOT_BUTTON_UNAVAILABLE_CLASS_NAME,
} from "./ComposerPrimaryActions";
import { contextMenuSourceOf } from "~/contextMenuSource";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { m, type MessageResolver } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";
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
  resolve: MessageResolver = m,
): { status: string | null; active: boolean } {
  switch (state.phase) {
    case "idle":
      return { status: null, active: false };
    case "error":
      return { status: state.error ?? resolve(msg("Voice input failed")), active: false };
    case "preparing":
      return {
        status: progress
          ? resolve(
              msg("Downloading model {percent}%", {
                percent: Math.round((progress.downloaded / Math.max(1, progress.total)) * 100),
              }),
            )
          : resolve(msg("Starting…")),
        active: true,
      };
    case "recording":
      return {
        status: resolve(msg("Recording", { $context: "voice input status" })),
        active: true,
      };
    case "transcribing":
      return { status: resolve(msg("Transcribing…")), active: true };
    case "post-processing":
      return { status: resolve(msg("Cleaning up…")), active: true };
  }
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
        "flex items-center justify-center gap-0.5 text-foreground",
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

/**
 * The one dictation control. Its own glyph and tone show the phase: mic, spinner, level bars,
 * or an alert. Clicking it starts, finishes, skips cleanup or retries; Esc and its context menu
 * cancel or dismiss. In the send pill it is one 32px slot; elsewhere a quiet icon button.
 */
export function ComposerSpeechButton(props: {
  inPill?: boolean;
  state: VoiceInputState;
  shortcutLabel?: string | null;
  disabled?: boolean;
  /** Compact matches the `xs` buttons beside text-field editors. */
  size?: "default" | "compact";
  /** Set when voice input cannot start here yet: the mic shows dimmed and the tooltip says why. */
  unavailableReason?: string | null | undefined;
  dictation: { level: number; onStop(): void; onCancel(): void; onSkipPostProcessing(): void };
  onStart(): void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const inPill = props.inPill ?? false;
  const { state, dictation } = props;
  const { phase } = state;

  const unavailable = phase === "idle" ? (props.unavailableReason ?? null) : null;
  const isError = phase === "error";
  const isRecording = phase === "recording";
  const isBusy = phase === "preparing" || phase === "transcribing";
  const isActive = phase !== "idle" && !isError;
  const openSettings = isError && state.errorAction === "settings";
  const errorMessage = state.error ?? gt("Voice input failed");

  const label = isRecording
    ? gt("Finish voice input")
    : phase === "preparing"
      ? gt("Preparing voice input")
      : phase === "transcribing"
        ? gt("Transcribing")
        : phase === "post-processing"
          ? gt("Skip post-processing")
          : openSettings
            ? gt("Open voice settings")
            : isError
              ? state.errorCode === "transcription-failed"
                ? gt("Retry transcription")
                : gt("Record again")
              : gt("Start voice input");
  const showsShortcut = (phase === "idle" || isRecording) && !unavailable;
  const cancelLabel = isError ? gt("Dismiss voice input error") : gt("Cancel voice input");

  const glyph = isRecording ? (
    <ComposerSpeechBars level={dictation.level} inPill={inPill} />
  ) : isError ? (
    <CircleAlertIcon
      aria-hidden
      className={cn("text-destructive-foreground", inPill ? "size-3.5" : "size-4")}
    />
  ) : phase === "idle" ? (
    <MicIcon aria-hidden className={cn("text-composer-icon", inPill && "size-3.5")} />
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
    if (isRecording) dictation.onStop();
    else if (phase === "post-processing") dictation.onSkipPostProcessing();
    else if (openSettings) {
      dictation.onCancel();
      void navigate({ to: "/settings/voice" });
    } else if ((phase === "idle" || isError) && !props.disabled && !unavailable) props.onStart();
  };
  // Right-click or long-press reaches cancel without a second button in the pill.
  const onContextMenu = async (event: MouseEvent) => {
    if (phase === "idle") return;
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [
        ...(isRecording ? ([{ id: "finish", label: gt("Finish voice input") }] as const) : []),
        { id: "cancel", label: cancelLabel },
      ] as const,
      { x: event.clientX, y: event.clientY },
      contextMenuSourceOf(event),
    );
    if (clicked === "finish") dictation.onStop();
    else if (clicked === "cancel") dictation.onCancel();
  };
  const disabled = (phase === "idle" || isError) && props.disabled;
  // Focus on the mic itself keeps Esc meaningful wherever it sits, even without a window shortcut.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || phase === "idle") return;
    event.preventDefault();
    event.stopPropagation();
    dictation.onCancel();
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            inPill ? (
              <button
                type="button"
                {...accessibilityProps}
                aria-pressed={isActive}
                data-voice-phase={phase}
                disabled={disabled}
                onPointerDown={keepFocus}
                onClick={onClick}
                onContextMenu={(event) => void onContextMenu(event)}
                onKeyDown={onKeyDown}
                className={
                  unavailable
                    ? COMPOSER_PILL_SLOT_BUTTON_UNAVAILABLE_CLASS_NAME
                    : isActive
                      ? COMPOSER_PILL_SLOT_BUTTON_ACTIVE_CLASS_NAME
                      : COMPOSER_PILL_SLOT_BUTTON_CLASS_NAME
                }
              />
            ) : (
              <Button
                type="button"
                size={props.size === "compact" ? "icon-xs" : "icon-sm"}
                variant={isActive ? "secondary" : "ghost"}
                {...accessibilityProps}
                aria-pressed={isActive}
                data-voice-phase={phase}
                disabled={disabled}
                onPointerDown={keepFocus}
                onClick={onClick}
                onContextMenu={(event) => void onContextMenu(event)}
                onKeyDown={onKeyDown}
                className="shrink-0"
              />
            )
          }
        >
          {glyph}
        </TooltipTrigger>
        <TooltipPopup side="top">
          {isError ? <div>{errorMessage}</div> : null}
          <div>
            {unavailable ?? label}
            {showsShortcut && props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
          </div>
          {phase !== "idle" ? (
            <div>
              {isError ? gt("Dismiss ({shortcut})", { shortcut: "Esc" }) : `${cancelLabel} (Esc)`}
            </div>
          ) : null}
        </TooltipPopup>
      </Tooltip>
      {/* The button's name says what a click does; this says what is happening. */}
      <span role="status" className="sr-only">
        {isError
          ? errorMessage
          : isBusy || phase === "post-processing"
            ? resolveSpeechPresentation(state, null, messages).status
            : ""}
      </span>
    </>
  );
}
