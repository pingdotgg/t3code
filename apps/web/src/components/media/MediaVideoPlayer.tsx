import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { PlayIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type CSSProperties } from "react";

import { observeIntersection } from "../../lib/observeIntersection";
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
  readonly onOpen?: (() => void) | undefined;
  readonly className?: string | undefined;
  readonly videoClassName?: string | undefined;
  readonly stateClassName?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly copyMarkdown?: string | undefined;
  readonly onRetry?: (() => Promise<unknown>) | undefined;
  readonly actionsSource?: MediaActionSource | undefined;
}

export function MediaVideoPlayer({
  src: latestSrc,
  label,
  sourceFailed = false,
  originalUrl,
  revision = null,
  preload = "visible",
  autoPlay = false,
  onOpen,
  className,
  videoClassName,
  stateClassName,
  style,
  copyMarkdown,
  onRetry,
  actionsSource,
}: MediaVideoPlayerProps) {
  const [playbackSource, setPlaybackSource] = useState<{
    src: string;
    revision: string | null;
  } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [preloadedSrc, setPreloadedSrc] = useState<string | null>(null);
  const src = playbackSource?.src ?? latestSrc;
  const sourceRevision = playbackSource === null ? revision : playbackSource.revision;
  const failed = src !== null ? failedSrc === src : sourceFailed;
  const preloaded = preloadedSrc === src || typeof IntersectionObserver === "undefined";

  // Re-signing must not reload a loaded source. Changed files load once playback pauses.
  if (
    playbackSource !== null &&
    playbackSource.revision !== revision &&
    (latestSrc !== null || sourceFailed) &&
    !playing
  ) {
    setPlaybackSource(
      revision !== null && latestSrc !== null ? { src: latestSrc, revision } : null,
    );
  }

  // Retry and failure remount the element, so its listeners live and die with it.
  const attachVideo = (video: HTMLVideoElement) => {
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
      // A detached element's pause event never reaches onPause.
      setPlaying(false);
    };
  };

  // On the wrapper, not the video: re-running the video's ref callback would pause playback.
  const observePreload = (player: HTMLSpanElement) => {
    if (src === null || failed || preload === "metadata" || preloaded) return;
    return observeIntersection(
      player,
      (entry) => {
        if (entry.isIntersecting) setPreloadedSrc(src);
      },
      { rootMargin: "200px" },
    );
  };

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    const result = await settlePromise(async () => {
      await onRetry?.();
    });
    if (AsyncResult.isSuccess(result)) {
      setPlaybackSource(null);
      setFailedSrc(null);
      setLoadAttempt((current) => current + 1);
    } else {
      setFailedSrc(src);
    }
    setRetrying(false);
  };

  const player = (
    <span
      ref={observePreload}
      className={cn("relative inline-block align-middle", className)}
      style={style}
      data-markdown-copy={copyMarkdown}
    >
      {failed && !onOpen ? (
        <span
          role="alert"
          className={cn(
            "flex aspect-video max-h-full w-full flex-col items-center justify-center gap-3 rounded-lg border border-border/40 bg-muted/40 p-4 text-center text-sm text-muted-foreground",
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
          ref={attachVideo}
          src={src}
          aria-label={label || "Video preview"}
          aria-hidden={onOpen ? true : undefined}
          autoPlay={onOpen ? false : autoPlay}
          controls={!onOpen}
          muted={onOpen ? true : undefined}
          playsInline
          preload={preload === "metadata" || preloaded ? "metadata" : "none"}
          className={cn(
            "aspect-video max-h-full w-full bg-black object-contain",
            onOpen && "pointer-events-none",
            videoClassName,
          )}
          style={style}
          onLoadedMetadata={(event) => {
            prepareVideoFirstFrame(event.currentTarget);
            if (sourceRevision !== null) setPlaybackSource({ src, revision: sourceRevision });
          }}
          onPlay={() => {
            setPlaying(true);
            setPlaybackSource({ src, revision: sourceRevision });
          }}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => {
            setPlaying(false);
            setPlaybackSource(null);
            if (latestSrc === null || src === latestSrc) setFailedSrc(src);
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
          className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-black/50 text-white">
            <PlayIcon aria-hidden className="size-4 fill-current" />
          </span>
        </button>
      ) : null}
    </span>
  );
  return actionsSource ? <MediaActions source={actionsSource}>{player}</MediaActions> : player;
}
