import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";
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
  /** An explicitly playable public source to try once if the signed source fails. */
  readonly fallbackSrc?: string | null | undefined;
  readonly revision?: string | null | undefined;
  readonly preload?: "visible" | "metadata" | undefined;
  readonly autoPlay?: boolean | undefined;
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
  fallbackSrc,
  revision = null,
  preload = "visible",
  autoPlay = false,
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
  const [fallbackFor, setFallbackFor] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [preloadedSrc, setPreloadedSrc] = useState<string | null>(null);
  const usingFallback = fallbackSrc != null && fallbackFor !== null && fallbackFor === latestSrc;
  const src = playbackSource?.src ?? (usingFallback ? fallbackSrc : latestSrc);
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
      setFallbackFor(null);
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
      className={cn("relative inline-block align-middle", className)}
      style={style}
      data-markdown-copy={copyMarkdown}
    >
      {failed ? (
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
      ) : src !== null ? (
        <video
          key={loadAttempt}
          ref={videoRef}
          src={src}
          aria-label={label || "Video preview"}
          autoPlay={autoPlay}
          controls
          playsInline
          preload={preload === "metadata" || preloadedSrc === src ? "metadata" : "none"}
          className={cn("aspect-video max-h-full w-full bg-black object-contain", videoClassName)}
          style={style}
          onLoadedMetadata={(event) => prepareVideoFirstFrame(event.currentTarget)}
          onPlay={() => setPlaybackSource({ src, revision: sourceRevision })}
          onPause={refreshPausedRevision}
          onEnded={refreshPausedRevision}
          onError={() => {
            if (src === fallbackSrc) setFailedSrc(src);
            else if (latestSrc !== null && src !== latestSrc) setPlaybackSource(null);
            else if (fallbackSrc && fallbackSrc !== src) {
              setPlaybackSource(null);
              setFallbackFor(latestSrc);
            } else setFailedSrc(src);
          }}
        />
      ) : (
        <span
          role="status"
          aria-label="Loading video"
          className={cn("block aspect-video w-full rounded-lg bg-muted/60", stateClassName)}
          style={style}
        />
      )}
    </span>
  );
  let activeActionsSource = actionsSource;
  if (actionsSource && src === fallbackSrc) {
    const { asset: _asset, ...directSource } = actionsSource;
    activeActionsSource = { ...directSource, src };
  }
  return activeActionsSource ? (
    <MediaActions source={activeActionsSource}>{player}</MediaActions>
  ) : (
    player
  );
}
