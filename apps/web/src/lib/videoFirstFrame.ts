/** Requests an initial frame without playing or replacing the video's streaming source. */
export function prepareVideoFirstFrame(
  video: Pick<
    HTMLVideoElement,
    "autoplay" | "currentTime" | "duration" | "paused" | "played" | "seeking" | "src"
  >,
): void {
  if (
    video.autoplay ||
    !video.paused ||
    video.seeking ||
    video.currentTime !== 0 ||
    video.played.length > 0 ||
    !Number.isFinite(video.duration) ||
    video.duration <= 0
  ) {
    return;
  }

  const fragment = video.src.split("#", 2)[1];
  if (fragment && new URLSearchParams(fragment).has("t")) return;

  try {
    video.currentTime = Math.min(0.1, video.duration / 2);
  } catch {
    // A rejected preview seek must leave the native Play control usable.
  }
}
