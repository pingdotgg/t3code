import {
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  TriangleAlertIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { MediaScrubber, useMediaPlayback } from "~/components/media/MediaTransport";
import {
  formatMediaSize,
  formatPlaybackTime,
  mediaFormatLabel,
  mediaMetadataLine,
} from "~/components/media/mediaFileInfo";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { InlineButton } from "../ui/button";
import { middleTruncateAttachmentName } from "../composerInlineChip";

const WAVEFORM_BARS = 60;
/** Files above this are not downloaded for a waveform; the transport still works. */
const WAVEFORM_MAX_BYTES = 16 * 1024 * 1024;
const WAVEFORM_MAX_SECONDS = 120;
const WAVEFORM_SAMPLE_RATE = 8_000;
const WAVEFORM_MAX_SAMPLES = WAVEFORM_SAMPLE_RATE * WAVEFORM_MAX_SECONDS * 2;
const WAVEFORM_SAMPLES_PER_BAR = 256;

interface AudioSummary {
  readonly peaks: ReadonlyArray<number> | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly sizeBytes: number | null;
}

/** Native sample rate from a RIFF/WAVE header; decoded buffers are resampled, so only the header knows it. */
function wavSampleRate(bytes: ArrayBuffer): number | null {
  if (bytes.byteLength < 28) return null;
  const view = new DataView(bytes);
  const riff = view.getUint32(0, false) === 0x52494646 && view.getUint32(8, false) === 0x57415645;
  return riff ? view.getUint32(24, true) : null;
}

function channelLabel(channels: number | null): string | null {
  if (channels === null) return null;
  if (channels === 1) return "mono";
  if (channels === 2) return "stereo";
  return `${channels} channels`;
}

function sampleRateLabel(sampleRate: number | null): string | null {
  if (sampleRate === null) return null;
  const kiloHertz = sampleRate / 1000;
  return `${Number.isInteger(kiloHertz) ? kiloHertz : kiloHertz.toFixed(1)} kHz`;
}

// Audio decoding runs in the audio engine; the peak scan is bounded and never animates.
function useAudioSummary(src: string, duration: number): AudioSummary | null {
  const [summary, setSummary] = useState<{ src: string; value: AudioSummary } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fetch and decode waveform metadata for the current external media URL, aborting on cleanup.
  useEffect(() => {
    // Metadata arrives through the playback element. Never decode long or unknown recordings.
    if (!Number.isFinite(duration) || duration <= 0 || duration > WAVEFORM_MAX_SECONDS) return;
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(src, { signal: controller.signal });
      const declaredSize = Number(response.headers.get("content-length"));
      const knownSize = Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : null;
      if (!response.ok || knownSize === null || knownSize > WAVEFORM_MAX_BYTES) {
        controller.abort();
        setSummary({
          src,
          value: { peaks: null, sampleRate: null, channels: null, sizeBytes: knownSize },
        });
        return;
      }
      const bytes = await response.arrayBuffer();
      if (controller.signal.aborted) return;
      if (bytes.byteLength > WAVEFORM_MAX_BYTES) return;
      const sampleRate = wavSampleRate(bytes);
      const context = new OfflineAudioContext(1, 1, WAVEFORM_SAMPLE_RATE);
      const buffer = await context.decodeAudioData(bytes);
      if (controller.signal.aborted) return;
      if (
        buffer.duration > WAVEFORM_MAX_SECONDS ||
        buffer.length * buffer.numberOfChannels > WAVEFORM_MAX_SAMPLES
      )
        return;
      const samples = buffer.getChannelData(0);
      const bucket = Math.max(1, Math.floor(samples.length / WAVEFORM_BARS));
      const stride = Math.max(1, Math.ceil(bucket / WAVEFORM_SAMPLES_PER_BAR));
      const peaks: number[] = [];
      let loudest = 0;
      for (let bar = 0; bar < WAVEFORM_BARS; bar++) {
        let peak = 0;
        const end = Math.min(samples.length, (bar + 1) * bucket);
        for (let index = bar * bucket; index < end; index += stride) {
          const value = Math.abs(samples[index] ?? 0);
          if (value > peak) peak = value;
        }
        peaks.push(peak);
        if (peak > loudest) loudest = peak;
      }
      if (controller.signal.aborted) return;
      setSummary({
        src,
        value: {
          peaks: peaks.map((peak) => (loudest > 0 ? peak / loudest : 0)),
          sampleRate,
          channels: buffer.numberOfChannels,
          sizeBytes: bytes.byteLength,
        },
      });
    })().catch(() => {
      if (controller.signal.aborted) return;
      setSummary({
        src,
        value: { peaks: null, sampleRate: null, channels: null, sizeBytes: null },
      });
    });
    return () => controller.abort();
  }, [src, duration]);
  return summary?.src === src ? summary.value : null;
}

export const AudioPreviewUnmountContext = createContext<((audio: HTMLAudioElement) => void) | null>(
  null,
);

type AudioPreviewProps = {
  readonly src: string;
  readonly name: string;
  readonly revision?: string | null;
  readonly onError?: () => void;
  readonly compact?: boolean;
  readonly variant?: "chip" | "bubble";
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
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const audioRef = useStableCallback((element: HTMLAudioElement | null) => {
    setAudio(element);
    if (element) return () => onUnmount?.(element);
  });
  const [loadedSource, setLoadedSource] = useState<{ src: string; revision: string } | null>(null);
  const [metadataSource, setMetadataSource] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const revision = props.revision ?? null;
  // Changed files load once playback pauses.
  if (loadedSource !== null && loadedSource.revision !== revision && !playing) {
    setLoadedSource(revision === null ? null : { src: props.src, revision });
  }
  const src = loadedSource?.src ?? props.src;
  const { state, togglePlay, seek, toggleMuted } = useMediaPlayback(audio);
  const summary = useAudioSummary(src, metadataSource === src ? state.duration : 0);
  const progress = state.duration > 0 ? state.currentTime / state.duration : 0;
  const peaks = summary?.peaks ?? null;
  // Short clips need hundredths to show the playhead moving at all.
  const precise = state.duration > 0 && state.duration < 10;
  const metadata = mediaMetadataLine([
    mediaFormatLabel(props.name),
    sampleRateLabel(summary?.sampleRate ?? null),
    channelLabel(summary?.channels ?? null),
    formatMediaSize(summary?.sizeBytes ?? null),
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 py-10">
      <audio
        ref={audioRef}
        preload="metadata"
        src={src}
        aria-label={props.name}
        className="hidden"
        onLoadedMetadata={() => {
          setMetadataSource(src);
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
      <div className="w-full max-w-xl">
        {peaks ? (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="flex h-20 w-full cursor-pointer"
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              if (bounds.width > 0 && state.duration > 0) {
                seek(((event.clientX - bounds.left) / bounds.width) * state.duration);
              }
            }}
          >
            <span className="flex size-full items-center justify-center gap-0.75">
              {peaks.map((peak, index) => (
                <span
                  // oxlint-disable-next-line react/no-array-index-key -- Waveform bars are fixed positions.
                  key={index}
                  className={cn(
                    "min-w-px max-w-[3px] flex-1 rounded-full",
                    (index + 0.5) / peaks.length <= progress
                      ? "bg-warning-foreground"
                      : "bg-foreground/15",
                  )}
                  style={{ height: `${Math.max(10, peak * 100)}%` }}
                />
              ))}
            </span>
          </button>
        ) : (
          <div aria-hidden className="h-20" />
        )}
        <div className="mt-4 flex items-center gap-3">
          <Button
            type="button"
            variant="default"
            size="icon-sm"
            aria-label={state.paused ? "Play" : "Pause"}
            onClick={togglePlay}
          >
            {state.paused ? (
              <PlayIcon aria-hidden className="size-3.5 fill-current" />
            ) : (
              <PauseIcon aria-hidden className="size-3.5 fill-current" />
            )}
          </Button>
          <span className="shrink-0 font-mono text-caption text-foreground tabular-nums">
            {formatPlaybackTime(state.currentTime, precise)}
          </span>
          <MediaScrubber
            state={state}
            onSeek={seek}
            label="Seek audio"
            trackClassName="bg-foreground/10"
            playedClassName="bg-warning-foreground"
          />
          <span className="shrink-0 font-mono text-caption text-dim-foreground tabular-nums">
            {precise ? `${state.duration.toFixed(2)}s` : formatPlaybackTime(state.duration)}
          </span>
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            aria-label={state.muted ? "Unmute" : "Mute"}
            aria-pressed={state.muted}
            onClick={toggleMuted}
          >
            {state.muted ? (
              <VolumeXIcon aria-hidden className="size-3.5" />
            ) : (
              <Volume2Icon aria-hidden className="size-3.5" />
            )}
          </Button>
        </div>
      </div>
      {metadata ? <p className="text-caption text-dim-foreground">{metadata}</p> : null}
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
      {...(props.variant === "bubble" ? { shape: "bubble" as const } : {})}
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
      <ContextChipLabel className={props.variant === "bubble" ? "flex-1" : "max-w-72"}>
        {open ? (
          <InlineButton
            className="block max-w-full"
            onClick={open}
            aria-label={`${props.failed && !props.onOpen ? "Retry" : "Preview"} ${props.name}`}
          >
            <span className="block truncate text-left">
              {middleTruncateAttachmentName(props.name)}
            </span>
          </InlineButton>
        ) : (
          middleTruncateAttachmentName(props.name)
        )}
      </ContextChipLabel>
      <span dir="ltr" className="shrink-0 text-micro text-current">
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
