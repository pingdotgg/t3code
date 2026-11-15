interface Size {
  readonly width: number;
  readonly height: number;
}

/** Largest frame with the video's aspect ratio that fits the bounds and the inline width cap. */
export function fitVideoFrame(video: Size, bounds: Size, maxWidth: number): Size | null {
  if (video.width <= 0 || video.height <= 0 || bounds.width <= 0 || bounds.height <= 0) {
    return null;
  }
  const ratio = video.width / video.height;
  const width = Math.min(bounds.width, maxWidth, bounds.height * ratio);
  return { width, height: width / ratio };
}

/** Inline frame for a video of known shape: full width up to `maxSide` on its longer edge. */
export function inlineVideoFrame(video: Size | null | undefined, maxSide: number) {
  if (!video || video.width <= 0 || video.height <= 0) return null;
  const ratio = video.width / video.height;
  return {
    width: "100%",
    maxWidth: Math.min(maxSide, maxSide * ratio),
    aspectRatio: ratio,
  } as const;
}
