import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const WAVEFORM_BAR_COUNT = 28;
const WAVEFORM_BAR_IDS = Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => String(index));

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
  }
}

function formatElapsed(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const VoiceWaveform = memo(function VoiceWaveform(props: { level: number }) {
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const levelsRef = useRef(Array<number>(WAVEFORM_BAR_COUNT).fill(0));

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
      className="flex h-8 min-w-16 flex-1 items-center justify-between gap-1 overflow-hidden"
    >
      {WAVEFORM_BAR_IDS.map((id, index) => (
        <span
          key={id}
          ref={(bar) => {
            barsRef.current[index] = bar;
          }}
          className="h-full w-0.5 shrink-0 origin-center rounded-full bg-foreground opacity-25 transition-[transform,opacity] duration-100 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleY(${prefersReducedMotion ? 0.35 : 0.08})` }}
        />
      ))}
    </div>
  );
});

function RecordingStatus(props: { level: number }) {
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
      <span className="shrink-0 text-secondary-label text-xs tabular-nums">
        {formatElapsed(elapsedSeconds)}
      </span>
    </>
  );
}

export function ComposerSpeechStatus(props: {
  state: VoiceInputState;
  progress: { downloaded: number; total: number } | null;
  level: number;
}) {
  const presentation = resolveSpeechPresentation(props.state, props.progress);

  if (!presentation.status) return null;
  const isRecording = props.state.phase === "recording";
  const isError = props.state.phase === "error";

  return (
    <div
      className="me-2 flex h-9 min-w-0 flex-1 items-center gap-2"
      role="status"
      aria-live={isRecording ? "off" : "polite"}
      aria-label={presentation.status}
    >
      {isRecording ? (
        <RecordingStatus level={props.level} />
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

export function ComposerSpeechCancelButton(props: { state: VoiceInputState; onCancel(): void }) {
  if (props.state.phase === "idle") return null;
  const label = props.state.phase === "error" ? "Dismiss voice input error" : "Cancel voice input";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
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
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function ComposerSpeechButton(props: {
  state: VoiceInputState;
  progress: { downloaded: number; total: number } | null;
  disabled?: boolean;
  onStart(): void;
  onStop(): void;
  onCancel(): void;
}) {
  const navigate = useNavigate();
  const presentation = resolveSpeechPresentation(props.state, props.progress);
  const openSettings = props.state.phase === "error" && props.state.errorAction === "settings";
  const confirmDisabled = presentation.showsConfirm && !presentation.confirmEnabled;
  const label = presentation.showsConfirm
    ? presentation.confirmEnabled
      ? "Finish voice input"
      : (presentation.status ?? "Voice input is busy")
    : openSettings
      ? "Open voice settings"
      : "Start voice input";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant={presentation.showsConfirm ? "default" : "ghost"}
            aria-label={label}
            aria-disabled={props.disabled || confirmDisabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (props.disabled || confirmDisabled) return;
              if (presentation.showsConfirm) return props.onStop();
              if (openSettings) {
                props.onCancel();
                void navigate({ to: "/settings/voice" });
                return;
              }
              props.onStart();
            }}
            className={cn(
              "relative shrink-0",
              (props.disabled || confirmDisabled) &&
                "cursor-not-allowed opacity-64 hover:bg-transparent!",
            )}
          >
            {presentation.showsConfirm ? (
              presentation.confirmEnabled ? (
                <CheckIcon />
              ) : (
                <Spinner aria-hidden />
              )
            ) : (
              <MicIcon />
            )}
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
