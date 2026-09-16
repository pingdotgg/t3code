const preferredMimeTypes = [
  "video/mp4;codecs=avc3",
  "video/mp4;codecs=avc3.640028",
  "video/mp4;codecs=avc3.42e01e",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

export function createBrowserMediaRecorder(stream: MediaStream): MediaRecorder {
  const mimeType = preferredMimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  const settings = stream.getVideoTracks()[0]?.getSettings();
  const videoBitsPerSecond = Math.round(
    Math.min(
      50_000_000,
      Math.max(
        2_500_000,
        (settings?.width ?? 1920) * (settings?.height ?? 1080) * (settings?.frameRate ?? 30) * 0.05,
      ),
    ),
  );
  return new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond });
}
