import {
  Maximize2Icon,
  PictureInPicture2Icon,
  PlayIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { cn } from "../../lib/utils";
import { prepareVideoFirstFrame } from "../../lib/videoFirstFrame";
import { Button } from "../ui/button";
import { OpenMediaLink } from "./OpenMediaLink";
import { MediaActions, type MediaActionSource } from "./MediaActions";

interface MediaVideoPlayerProps {
  readonly src: string | null;
  readonly label: string;
  readonly sourceFailed?: boolean | undefined;
  readonly originalUrl?: string | undefined;
  readonly revision?: string | null | undefined;
  readonly preload?: "visible" | "metadata" | undefined;
  readonly autoPlay?: boolean | undefined;
  /** Playhead in seconds to resume from, so moving a video between surfaces keeps its place. */
  readonly startAt?: number | undefined;
  /** Presents a still thumbnail whose full surface opens the video in a viewer. */
  readonly onOpen?: (() => void) | undefined;
  /** Offers moving an inline video into the viewer or the mini player; the inline copy pauses. */
  readonly onPopOut?: ((video: HTMLVideoElement, mode: "viewer" | "mini") => void) | undefined;
  /** Receives the playing element, e.g. so a gallery can find this video among a message's media. */
  readonly onVideoElement?: ((video: HTMLVideoElement | null) => void) | undefined;
  readonly className?: string | undefined;
  readonly videoClassName?: string | undefined;
  /** Styles the loading and failure panels, which otherwise assume an inline light surface. */
  readonly stateClassName?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly copyMarkdown?: string | undefined;
  readonly onRetry?: (() => Promise<unknown>) | undefined;
  readonly actionsSource?: MediaActionSource | undefined;
}

/** Keeps native range streaming and playback state consistent across inline and file previews. */
export function MediaVideoPlayer({
  src: latestSrc,
  label,
  sourceFailed = false,
  originalUrl,
  revision = null,
  preload = "visible",
  autoPlay = false,
  startAt = 0,
  onOpen,
  onPopOut,
  onVideoElement,
  className,
  videoClassName,
  stateClassName,
  style,
  copyMarkdown,
  onRetry,
  actionsSource,
}: MediaVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playbackSource, setPlaybackSource] = useState<{
    src: string;
    revision: string | null;
  } | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [preloadedSrc, setPreloadedSrc] = useState<string | null>(null);
  const src = playbackSource?.src ?? latestSrc;
  const sourceRevision = playbackSource === null ? revision : playbackSource.revision;
  const failed = src !== null ? failedSrc === src : sourceFailed;

  // Re-signing must not reset the playhead. Changed files refresh once playback pauses.
  const refreshPausedRevision = useCallback(() => {
    const video = videoRef.current;
    if (video === null || video.paused || video.ended) {
      setPlaybackSource((current) =>
        current !== null && current.revision !== revision ? null : current,
      );
    }
  }, [revision]);
  useEffect(refreshPausedRevision, [refreshPausedRevision]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || preload === "metadata" || preloadedSrc === src) return;
    if (typeof IntersectionObserver === "undefined") {
      setPreloadedSrc(src);
      return;
    }
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active || !entries.some((entry) => entry.isIntersecting)) return;
        setPreloadedSrc(src);
        observer.disconnect();
      },
      { rootMargin: "200px" },
    );
    observer.observe(video);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [src, preload, preloadedSrc, failed, loadAttempt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const pauseWhenHidden = () => {
      // Native fullscreen can hide the inline page while this video is still visible.
      const fullscreen =
        document.fullscreenElement?.contains(video) ||
        ("webkitDisplayingFullscreen" in video && video.webkitDisplayingFullscreen === true);
      if (document.hidden && !fullscreen) video.pause();
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    document.addEventListener("fullscreenchange", pauseWhenHidden);
    video.addEventListener("webkitendfullscreen", pauseWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", pauseWhenHidden);
      document.removeEventListener("fullscreenchange", pauseWhenHidden);
      video.removeEventListener("webkitendfullscreen", pauseWhenHidden);
      video.pause();
    };
  }, [src, failed, loadAttempt]);

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry?.();
      setPlaybackSource(null);
      setFailedSrc(null);
      setLoadAttempt((current) => current + 1);
    } catch {
      setFailedSrc(src);
    } finally {
      setRetrying(false);
    }
  };

  const player = (
    <span
      className={cn("group/video relative inline-block align-middle", className)}
      style={style}
      data-markdown-copy={copyMarkdown}
    >
      {failed && !onOpen ? (
        <span
          role="alert"
          className={cn(
            // Same 16:9 slot as the loading and playing states, so a failed or
            // retried video does not move the rows below it.
            "flex aspect-video max-h-full min-h-28 w-full flex-col items-center justify-center gap-3 rounded-lg border border-border/40 bg-muted/40 p-4 text-center text-sm text-muted-foreground",
            stateClassName,
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
            Video unavailable{label ? ` · ${label}` : ""}
          </span>
          <span className="flex flex-wrap items-center justify-center gap-2">
            {latestSrc !== null || onRetry ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={retrying}
                onClick={() => void retry()}
              >
                <RotateCwIcon />
                {retrying ? "Retrying…" : "Retry video"}
              </Button>
            ) : null}
            <OpenMediaLink originalUrl={originalUrl} src={latestSrc ?? src} fileName={label} />
          </span>
        </span>
      ) : src !== null && !failed ? (
        <video
          key={loadAttempt}
          ref={(video) => {
            videoRef.current = video;
            onVideoElement?.(video);
          }}
          src={src}
          aria-label={label || "Video preview"}
          aria-hidden={onOpen ? true : undefined}
          autoPlay={onOpen ? false : autoPlay}
          controls={!onOpen}
          muted={onOpen ? true : undefined}
          playsInline
          preload={preload === "metadata" || preloadedSrc === src ? "metadata" : "none"}
          className={cn(
            "aspect-video max-h-full w-full bg-black object-contain",
            onOpen && "pointer-events-none",
            videoClassName,
          )}
          style={style}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (startAt <= 0) {
              prepareVideoFirstFrame(video);
              return;
            }
            video.currentTime = startAt;
            // An early pause() (such as an effect replay) cancels the autoplay attribute.
            if (autoPlay) void video.play().catch(() => {});
          }}
          onPlay={() => setPlaybackSource({ src, revision: sourceRevision })}
          onPause={refreshPausedRevision}
          onEnded={refreshPausedRevision}
          onError={() => {
            if (latestSrc !== null && src !== latestSrc) setPlaybackSource(null);
            else setFailedSrc(src);
          }}
        />
      ) : (
        <span
          role="status"
          aria-label={failed ? "Video preview unavailable" : "Loading video"}
          className={cn("block aspect-video w-full rounded-lg bg-muted/60", stateClassName)}
          style={style}
        />
      )}
      {onOpen ? (
        <button
          type="button"
          aria-label={label ? `Play ${label}` : "Play video"}
          onClick={onOpen}
          className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-black/50 text-white">
            <PlayIcon aria-hidden className="size-4 fill-current" />
          </span>
        </button>
      ) : null}
      {onPopOut && !onOpen && src !== null && !failed ? (
        <span className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover/video:opacity-100 group-focus-within/video:opacity-100 pointer-coarse:opacity-100">
          {(
            [
              ["viewer", "Open in viewer", Maximize2Icon],
              ["mini", "Open in mini player", PictureInPicture2Icon],
            ] as const
          ).map(([mode, label, Icon]) => (
            <Button
              key={mode}
              size="icon-xs"
              variant="media-close"
              aria-label={label}
              onClick={() => {
                const video = videoRef.current;
                if (!video) return;
                onPopOut(video, mode);
                video.pause();
              }}
            >
              <Icon />
            </Button>
          ))}
        </span>
      ) : null}
    </span>
  );
  return actionsSource ? <MediaActions source={actionsSource}>{player}</MediaActions> : player;
}
