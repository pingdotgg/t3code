import { LoaderCircleIcon, PauseIcon, PlayIcon, TriangleAlertIcon } from "lucide-react";
import { createContext, useContext, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { middleTruncateAttachmentName } from "../composerInlineChip";

export const AudioPreviewUnmountContext = createContext<((audio: HTMLAudioElement) => void) | null>(
  null,
);

type AudioPreviewProps = {
  readonly src: string;
  readonly name: string;
  readonly onError?: () => void;
  readonly compact?: boolean;
  readonly failed?: boolean;
  readonly onOpen?: (() => void) | undefined;
  readonly onRetry?: () => void;
};

export function AudioPreview(props: AudioPreviewProps) {
  const onUnmount = useContext(AudioPreviewUnmountContext);
  const audioRef = useStableCallback((audio: HTMLAudioElement | null) => {
    if (audio) return () => onUnmount?.(audio);
  });
  if (props.compact) return <AudioChip key={`${props.src}:${!!props.failed}`} {...props} />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={props.src}
        aria-label={props.name}
        className="w-full max-w-xl"
        onError={props.onError}
      />
    </div>
  );
}

function audioTime(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function AudioChip(props: AudioPreviewProps) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const onUnmount = useContext(AudioPreviewUnmountContext);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const audioRef = useStableCallback((element: HTMLAudioElement | null) => {
    audio.current = element;
    if (element)
      return () => {
        element.pause();
        onUnmount?.(element);
        audio.current = null;
      };
  });
  const loading = !props.failed && !ready;
  const open = props.onOpen ?? (props.failed ? props.onRetry : undefined);
  const action = props.failed
    ? props.onOpen
      ? "Open"
      : "Retry"
    : loading
      ? "Loading"
      : playing
        ? "Pause"
        : "Play";
  const Icon = props.failed
    ? TriangleAlertIcon
    : loading
      ? LoaderCircleIcon
      : playing
        ? PauseIcon
        : PlayIcon;

  return (
    <ContextChip
      kind="file"
      {...(props.failed ? { state: "invalid" as const } : {})}
      className="relative isolate overflow-hidden has-[button:enabled]:hover:border-(--context-chip-border-hover) has-[button:enabled]:hover:bg-(--context-chip-accent)/17"
      title={props.failed ? "Audio unavailable. Open the file or retry playback." : props.name}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 -z-10 bg-(--context-chip-accent)/17"
        style={{ width: `${duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0}%` }}
      />
      <ContextChipAction
        className="ml-0 [&_svg]:size-[1.17em]"
        aria-label={`${props.failed ? "Audio unavailable. " : ""}${action} ${props.name}`}
        disabled={loading}
        onClick={() => {
          if (props.failed) {
            open?.();
            return;
          }
          const element = audio.current;
          if (!element) return;
          if (!element.paused) element.pause();
          else
            void element.play().catch((error: unknown) => {
              if (!(error instanceof DOMException && error.name === "AbortError"))
                props.onError?.();
            });
        }}
      >
        <Icon aria-hidden className={loading && props.src ? "animate-spin" : undefined} />
      </ContextChipAction>
      <ContextChipLabel className="max-w-72">
        {open ? (
          <button
            type="button"
            className="block max-w-full cursor-pointer truncate rounded-sm text-left focus-visible:outline-2 focus-visible:outline-foreground"
            onClick={open}
            aria-label={`${props.failed && !props.onOpen ? "Retry" : "Preview"} ${props.name}`}
          >
            {middleTruncateAttachmentName(props.name)}
          </button>
        ) : (
          middleTruncateAttachmentName(props.name)
        )}
      </ContextChipLabel>
      <span className="shrink-0 text-3xs text-current">
        {props.failed
          ? "Unavailable"
          : loading
            ? "..."
            : duration > 0
              ? elapsed > 0 || playing
                ? `${audioTime(elapsed)} / ${audioTime(duration)}`
                : audioTime(duration)
              : audioTime(elapsed)}
      </span>
      {props.src && !props.failed ? (
        <audio
          ref={audioRef}
          hidden
          preload="metadata"
          src={props.src}
          aria-label={props.name}
          onLoadedMetadata={(event) => {
            setReady(true);
            const value = event.currentTarget.duration;
            setDuration(Number.isFinite(value) ? value : 0);
          }}
          onLoadedData={() => setReady(true)}
          onCanPlay={() => setReady(true)}
          onDurationChange={(event) => {
            const value = event.currentTarget.duration;
            setDuration(Number.isFinite(value) ? value : 0);
          }}
          onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={props.onError}
        />
      ) : null}
    </ContextChip>
  );
}
