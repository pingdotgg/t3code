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
  readonly revision?: string | null;
  readonly onError?: () => void;
  readonly compact?: boolean;
  readonly failed?: boolean;
  readonly onOpen?: (() => void) | undefined;
  readonly onRetry?: () => void;
};

export function AudioPreview(props: AudioPreviewProps) {
  return props.compact ? (
    <AudioChip key={`${props.revision ?? props.src}:${!!props.failed}`} {...props} />
  ) : (
    <StandardAudioPreview {...props} />
  );
}

function StandardAudioPreview(props: AudioPreviewProps) {
  const onUnmount = useContext(AudioPreviewUnmountContext);
  const audioRef = useStableCallback((audio: HTMLAudioElement | null) => {
    if (audio) return () => onUnmount?.(audio);
  });
  const [loadedSource, setLoadedSource] = useState<{ src: string; revision: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const revision = props.revision ?? null;
  // Changed files load once playback pauses.
  if (loadedSource !== null && loadedSource.revision !== revision && !playing) {
    setLoadedSource(revision === null ? null : { src: props.src, revision });
  }
  const src = loadedSource?.src ?? props.src;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={src}
        aria-label={props.name}
        className="w-full max-w-xl"
        onLoadedMetadata={() => {
          if (revision !== null && loadedSource === null) setLoadedSource({ src, revision });
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setPlaying(false);
          setLoadedSource(null);
          if (src === props.src) props.onError?.();
        }}
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
  const [loadedSource, setLoadedSource] = useState<string | null>(null);
  const src = loadedSource ?? props.src;
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
      className="relative isolate overflow-hidden"
      title={props.failed ? "Audio unavailable. Open the file or retry playback." : props.name}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 -z-10 bg-(--context-chip-accent)/17"
        style={{ width: `${duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0}%` }}
      />
      <ContextChipAction
        className="ml-0 [&_svg]:size-[1em]"
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
      <span className="shrink-0 self-baseline text-3xs text-current">
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
          src={src}
          aria-label={props.name}
          onLoadedMetadata={(event) => {
            setLoadedSource(src);
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
          onError={() => {
            if (src === props.src) props.onError?.();
            else {
              setPlaying(false);
              setReady(false);
              setLoadedSource(null);
            }
          }}
        />
      ) : null}
    </ContextChip>
  );
}
