/** Where playback stood when a video moved between the inline player, viewer and mini player. */
export interface VideoHandoff {
  readonly startAt: number;
  readonly playing: boolean;
  readonly volume: number;
  readonly muted: boolean;
}

/** A video that never played, or has no metadata yet, starts fresh (and autoplays) in its next player. */
export function readVideoHandoff(video: HTMLVideoElement | null | undefined): VideoHandoff | null {
  if (!video || video.readyState < HTMLMediaElement.HAVE_METADATA || video.played.length === 0) {
    return null;
  }
  return {
    startAt: video.currentTime,
    playing: !video.paused && !video.ended,
    volume: video.volume,
    muted: video.muted,
  };
}
