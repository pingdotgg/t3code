import type { VideoThumbnail } from "expo-video";

import type { AttachmentPreviewFile } from "./attachmentDownload";

const thumbnails = new Map<string, VideoThumbnail>();
const MAX_CACHED_THUMBNAILS = 32;
let pending: Promise<unknown> = Promise.resolve();

export function cachedVideoThumbnail(key: string): VideoThumbnail | null {
  return thumbnails.get(key) ?? null;
}

async function extractFrame(uri: string, signal: AbortSignal) {
  const { createVideoPlayer } = await import("expo-video");
  if (signal.aborted) return null;
  const player = createVideoPlayer(null);
  let disposed = false;
  let cancel = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Never play or change audio settings: thumbnails must leave the shared audio session alone.
    player.bufferOptions = { preferredForwardBufferDuration: 1 };
    const canceled = new Promise<null>((resolve) => {
      cancel = () => resolve(null);
    });
    signal.addEventListener("abort", cancel, { once: true });
    // An unreachable environment must not hold up thumbnails for other environments.
    timeout = setTimeout(cancel, 15_000);
    const frame = (async () => {
      await player.replaceAsync({ uri, contentType: "progressive" });
      if (disposed || signal.aborted) return null;
      const [thumbnail] = await player.generateThumbnailsAsync([0], {
        maxWidth: 480,
        maxHeight: 480,
      });
      return thumbnail ?? null;
    })();
    return await Promise.race([frame, canceled]);
  } finally {
    disposed = true;
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    player.release();
  }
}

/** Serializes frame extraction and releases each temporary player and local-file lease. */
export function loadVideoThumbnail(
  key: string,
  resolveSource: (
    signal: AbortSignal,
  ) => Promise<Pick<AttachmentPreviewFile, "uri" | "dispose"> | null>,
  signal: AbortSignal,
): Promise<VideoThumbnail | null> {
  if (signal.aborted) return Promise.resolve(null);
  const cached = cachedVideoThumbnail(key);
  if (cached) return Promise.resolve(cached);
  const load = pending
    .then(async () => {
      if (signal.aborted) return null;
      const cached = cachedVideoThumbnail(key);
      if (cached) return cached;

      const source = await resolveSource(signal);
      if (!source) return null;
      try {
        const thumbnail = await extractFrame(source.uri, signal);
        if (!thumbnail || signal.aborted) return null;
        thumbnails.set(key, thumbnail);
        if (thumbnails.size > MAX_CACHED_THUMBNAILS) {
          thumbnails.delete(thumbnails.keys().next().value!);
        }
        return thumbnail;
      } finally {
        source.dispose();
      }
    })
    .catch(() => null);
  pending = load;
  return load;
}
