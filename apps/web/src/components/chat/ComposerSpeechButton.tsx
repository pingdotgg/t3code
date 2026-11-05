import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { MicIcon, MicOffIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { useNavigate } from "@tanstack/react-router";
import type { useEnvironmentSpeechInput } from "~/speech/useEnvironmentSpeechInput";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { COMPOSER_PILL_BUTTON_CLASS_NAME } from "./ComposerPrimaryActions";

type SpeechLevel = ReturnType<typeof useEnvironmentSpeechInput>["level"];

// Each bar reads the level a sample apart so the three never move in lockstep.
const BAR_SAMPLE_OFFSETS = [1, 0, 2] as const;
const RESTING_SCALE = 0.4;
const STATIC_SCALE = 0.7;

export function shouldShowComposerFooter(
  collapsed: boolean,
  phase: VoiceInputState<true>["phase"],
): boolean {
  return phase !== "idle" || !collapsed;
}

/** Three vertical bars that follow the microphone level while `active`, and settle when not. */
function SpeechBars(props: { level: SpeechLevel; active: boolean }) {
  const { level, active } = props;
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish microphone samples to the bar DOM while recording, without rerendering React per sample.
  useEffect(() => {
    const paint = (scale: (index: number) => number) => {
      barsRef.current.forEach((bar, index) => {
        if (bar) bar.style.transform = `scaleY(${scale(index)})`;
      });
    };
    if (!active) {
      paint(() => RESTING_SCALE);
      return;
    }
    if (prefersReducedMotion) {
      paint(() => STATIC_SCALE);
      return;
    }
    const history = [0, 0, 0];
    const sample = () => {
      history.copyWithin(0, 1);
      history[2] = level.getSnapshot();
      paint((index) => {
        const value = history[2 - BAR_SAMPLE_OFFSETS[index]!] ?? 0;
        return RESTING_SCALE + (1 - RESTING_SCALE) * Math.min(1, value);
      });
    };
    sample();
    return level.subscribe(sample);
  }, [active, level, prefersReducedMotion]);

  return (
    <span aria-hidden className="flex h-4 items-center justify-center gap-0.5">
      {BAR_SAMPLE_OFFSETS.map((offset, index) => (
        <span
          key={offset}
          ref={(bar) => {
            barsRef.current[index] = bar;
          }}
          className="h-full w-0.75 origin-center rounded-full bg-current transition-transform duration-100 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleY(${RESTING_SCALE})` }}
        />
      ))}
    </span>
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

/**
 * The one dictation control on every surface. The mic morphs into three level bars
 * while recording, shows a spinner while the engine is busy, and clicking it again stops.
 */
export function ComposerSpeechMicButton(props: {
  state: VoiceInputState<true>;
  level: SpeechLevel;
  appearance?: "pill" | "field";
  shortcutLabel?: string | null;
  disabled?: boolean;
  onStart(): void;
  onStop(): void;
  onCancel(): void;
  onSkipPostProcessing(): void;
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
        : phase === "post-processing"
          ? "Skip post-processing"
          : isBusy
            ? "Transcribing"
            : "Start voice input";
  const showShortcut = (phase === "idle" || phase === "error" || isRecording) && !openSettings;
  const isPill = (props.appearance ?? "pill") === "pill";
  const onClick = () => {
    if (openSettings) {
      props.onCancel();
      void navigate({ to: "/settings/voice" });
    } else if (isRecording) {
      props.onStop();
    } else if (phase === "preparing") {
      props.onCancel();
    } else if (phase === "post-processing") {
      props.onSkipPostProcessing();
    } else if (!isBusy) {
      props.onStart();
    }
  };
  const disabled = (props.disabled && phase === "idle") || phase === "transcribing";
  const glyph = (
    // The mic and the bars share one cell and cross-fade, so the button never changes size.
    <span aria-hidden className={cn("flex", isPill ? "text-composer-icon" : "text-current")}>
      {isBusy ? (
        <Spinner size="sm" />
      ) : (
        <span className="grid size-4 place-items-center *:col-start-1 *:row-start-1">
          <MicIcon
            className={cn(
              "size-3.5 transition-[opacity,transform] duration-150 motion-reduce:transition-none",
              isRecording ? "scale-75 opacity-0" : "opacity-100",
            )}
          />
          <span
            className={cn(
              "transition-[opacity,transform] duration-150 motion-reduce:transition-none",
              isRecording ? "opacity-100" : "scale-75 opacity-0",
            )}
          >
            <SpeechBars level={props.level} active={isRecording} />
          </span>
        </span>
      )}
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          isPill ? (
            <button
              type="button"
              aria-label={label}
              aria-pressed={isRecording}
              disabled={disabled}
              onPointerDown={(event) => event.preventDefault()}
              onClick={onClick}
              data-listening={isRecording || undefined}
              className={cn(COMPOSER_PILL_BUTTON_CLASS_NAME, "w-8")}
            />
          ) : (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={label}
              aria-pressed={isRecording}
              disabled={disabled}
              onPointerDown={(event) => event.preventDefault()}
              onClick={onClick}
              data-listening={isRecording || undefined}
              className="shrink-0"
            />
          )
        }
      >
        {glyph}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {label}
        {showShortcut && props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
        {isBusy ? " (Esc cancels)" : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
