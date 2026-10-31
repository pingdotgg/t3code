import {
  MaximizeIcon,
  MinimizeIcon,
  PauseIcon,
  PlayIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { cn } from "~/lib/utils";
import { ContentButton } from "../ui/button";

import { formatPlaybackTime } from "./mediaFileInfo";

export interface MediaPlaybackState {
  readonly paused: boolean;
  readonly currentTime: number;
  readonly duration: number;
  readonly muted: boolean;
}

const IDLE_PLAYBACK: MediaPlaybackState = {
  paused: true,
  currentTime: 0,
  duration: 0,
  muted: false,
};

function createMediaPlayback(element: HTMLMediaElement | null) {
  let snapshot = IDLE_PLAYBACK;
  const getSnapshot = () => {
    if (element === null) return IDLE_PLAYBACK;
    const duration = Number.isFinite(element.duration) ? element.duration : 0;
    if (
      snapshot.paused !== element.paused ||
      snapshot.currentTime !== element.currentTime ||
      snapshot.duration !== duration ||
      snapshot.muted !== element.muted
    ) {
      snapshot = {
        paused: element.paused,
        currentTime: element.currentTime,
        duration,
        muted: element.muted,
      };
    }
    return snapshot;
  };
  const subscribe = (onChange: () => void) => {
    if (element === null) return () => {};
    const events = [
      "play",
      "pause",
      "ended",
      "timeupdate",
      "seeked",
      "durationchange",
      "loadedmetadata",
      "volumechange",
      "emptied",
    ] as const;
    for (const event of events) element.addEventListener(event, onChange);
    return () => {
      for (const event of events) element.removeEventListener(event, onChange);
    };
  };

  const togglePlay = () => {
    if (element === null) return;
    if (element.paused || element.ended) void element.play().catch(() => undefined);
    else element.pause();
  };
  const seek = (seconds: number) => {
    if (element === null || !Number.isFinite(seconds)) return;
    element.currentTime = Math.max(0, Math.min(seconds, element.duration || seconds));
  };
  const toggleMuted = () => {
    if (element !== null) element.muted = !element.muted;
  };
  return { getSnapshot, subscribe, togglePlay, seek, toggleMuted };
}

/**
 * Mirrors a media element's playback into React for custom controls. It only
 * listens to the element's own events (timeupdate fires a few times a second
 * while playing), so a paused player never re-renders.
 */
export function useMediaPlayback(element: HTMLMediaElement | null) {
  const playback = createMediaPlayback(element);
  const state = useSyncExternalStore(playback.subscribe, playback.getSnapshot, () => IDLE_PLAYBACK);
  return {
    state,
    togglePlay: playback.togglePlay,
    seek: playback.seek,
    toggleMuted: playback.toggleMuted,
  };
}

/**
 * A thin progress track with an invisible native range on top, so the look is
 * the redesign's while keyboard and screen reader seeking stay native.
 */
export function MediaScrubber(props: {
  readonly state: MediaPlaybackState;
  readonly onSeek: (seconds: number) => void;
  readonly label: string;
  readonly trackClassName: string;
  readonly playedClassName: string;
}) {
  const { duration, currentTime } = props.state;
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  return (
    <span className="relative flex h-4 min-w-0 flex-1 items-center rounded-full focus-within:ring-2 focus-within:ring-inset focus-within:ring-current">
      <span
        className={cn("relative h-1 w-full overflow-hidden rounded-full", props.trackClassName)}
      >
        <span
          aria-hidden
          className={cn("absolute inset-y-0 left-0 rounded-full", props.playedClassName)}
          style={{ width: `${progress * 100}%` }}
        />
      </span>
      <input
        type="range"
        aria-label={props.label}
        aria-valuetext={`${formatPlaybackTime(currentTime)} of ${formatPlaybackTime(duration)}`}
        min={0}
        max={duration > 0 ? duration : 0}
        step="any"
        value={duration > 0 ? currentTime : 0}
        disabled={duration <= 0}
        onChange={(event) => props.onSeek(Number(event.currentTarget.value))}
        className="absolute inset-0 m-0 w-full cursor-pointer opacity-0 disabled:cursor-default"
      />
    </span>
  );
}

/**
 * The redesign's video transport: play, time, scrubber, mute and fullscreen,
 * laid over the bottom of the frame. Fullscreen targets the whole player so
 * these controls come along instead of the browser's.
 */
export function VideoTransport(props: {
  readonly video: HTMLVideoElement | null;
  readonly fullscreenTarget: HTMLElement | null;
}) {
  const { state, togglePlay, seek, toggleMuted } = useMediaPlayback(props.video);
  const [fullscreen, setFullscreen] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to the browser's fullscreen state for this player and remove the listener on cleanup.
  useEffect(() => {
    const target = props.fullscreenTarget;
    if (target === null) return;
    const sync = () => setFullscreen(document.fullscreenElement === target);
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [props.fullscreenTarget]);
  const toggleFullscreen = () => {
    const target = props.fullscreenTarget;
    if (target === null) return;
    if (document.fullscreenElement === target)
      void document.exitFullscreen().catch(() => undefined);
    else void target.requestFullscreen?.().catch(() => undefined);
  };
  const canFullscreen =
    typeof document !== "undefined" &&
    document.fullscreenEnabled &&
    props.fullscreenTarget !== null;

  return (
    <span className="absolute inset-x-0 bottom-0 flex items-center gap-2.5 bg-linear-to-b from-transparent to-black/70 px-3 py-2.5 text-white">
      <ContentButton
        variant="transport"
        type="button"
        aria-label={state.paused ? "Play" : "Pause"}
        onClick={togglePlay}
      >
        {state.paused ? (
          <PlayIcon aria-hidden className="size-3.5" />
        ) : (
          <PauseIcon aria-hidden className="size-3.5" />
        )}
      </ContentButton>
      <span className="shrink-0 font-mono text-caption tabular-nums">
        {formatPlaybackTime(state.currentTime)} / {formatPlaybackTime(state.duration)}
      </span>
      <MediaScrubber
        state={state}
        onSeek={seek}
        label="Seek video"
        trackClassName="bg-white/20"
        playedClassName="bg-white"
      />
      <ContentButton
        variant="transport"
        type="button"
        aria-label={state.muted ? "Unmute" : "Mute"}
        aria-pressed={state.muted}
        onClick={toggleMuted}
      >
        {state.muted ? (
          <VolumeXIcon aria-hidden className="size-3.5" />
        ) : (
          <Volume2Icon aria-hidden className="size-3.5" />
        )}
      </ContentButton>
      {canFullscreen ? (
        <ContentButton
          variant="transport"
          type="button"
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          onClick={toggleFullscreen}
        >
          {fullscreen ? (
            <MinimizeIcon aria-hidden className="size-3.5" />
          ) : (
            <MaximizeIcon aria-hidden className="size-3.5" />
          )}
        </ContentButton>
      ) : null}
    </span>
  );
}
