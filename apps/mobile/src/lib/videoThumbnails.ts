import type { VideoThumbnail } from "expo-video";

import type { AttachmentPreviewFile } from "./attachmentDownload";

const thumbnails = new Map<string, VideoThumbnail>();
const MAX_CACHED_THUMBNAILS = 32;
let pending: Promise<unknown> = Promise.resolve();

interface InFlightThumbnail {
  readonly promise: Promise<VideoThumbnail | null>;
  readonly readers: Set<AbortSignal>;
  readonly controller: AbortController;
}

const inFlight = new Map<string, InFlightThumbnail>();

export function cachedVideoThumbnail(key: string): VideoThumbnail | null {
  return thumbnails.get(key) ?? null;
}

async function extractFrame(uri: string, signal: AbortSignal) {
  if (signal.aborted) return null;
  const { createVideoPlayer } = await import("expo-video");
  if (signal.aborted) return null;
  const player = createVideoPlayer(null);
  let disposed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let attachedSubscription: { remove(): void } | undefined;
  let onAbort: (() => void) | undefined;
  try {
    // Never play or change audio settings: thumbnails must leave the shared audio session alone.
    player.bufferOptions = { preferredForwardBufferDuration: 1 };
    const timedOut = new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), 15_000);
    });
    const aborted = new Promise<null>((resolve) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      onAbort = () => resolve(null);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // iOS resolves replaceAsync before the main thread attaches the item, and until then
    // generateThumbnailsAsync finds no asset and returns no frames.
    const attached = new Promise<void>((resolve) => {
      attachedSubscription = player.addListener("sourceChange", ({ source }) => {
        if (source) resolve();
      });
    });
    const frame = (async () => {
      await player.replaceAsync({ uri, contentType: "progressive" });
      if (disposed || signal.aborted) return null;
      await attached;
      if (disposed || signal.aborted) return null;
      const [thumbnail] = await player.generateThumbnailsAsync([0], {
        maxWidth: 480,
        maxHeight: 480,
      });
      return thumbnail ?? null;
    })().catch(() => null);
    return await Promise.race([frame, timedOut, aborted]);
  } finally {
    disposed = true;
    clearTimeout(timeout);
    attachedSubscription?.remove();
    if (onAbort) signal.removeEventListener("abort", onAbort);
    player.release();
  }
}

function attachReader(entry: InFlightThumbnail, signal: AbortSignal) {
  entry.readers.add(signal);
  const onAbort = () => {
    entry.readers.delete(signal);
    // Defer abort by a microtask so a re-signed URL mounting for the same key in the same
    // render/tick reuses the in-flight extraction instead of restarting it.
    queueMicrotask(() => {
      if (entry.readers.size === 0) {
        entry.controller.abort();
      }
    });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  void entry.promise.finally(() => {
    entry.readers.delete(signal);
    signal.removeEventListener("abort", onAbort);
  });
}

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

  const existing = inFlight.get(key);
  if (existing && !existing.controller.signal.aborted) {
    attachReader(existing, signal);
    return existing.promise;
  }

  const controller = new AbortController();
  const readers = new Set<AbortSignal>();
  const load = pending
    .then(async () => {
      if (controller.signal.aborted) return null;
      const cached = cachedVideoThumbnail(key);
      if (cached) return cached;

      const source = await resolveSource(controller.signal);
      if (!source) return null;
      try {
        if (controller.signal.aborted) return null;
        const thumbnail = await extractFrame(source.uri, controller.signal);
        if (!thumbnail || controller.signal.aborted) return null;
        thumbnails.set(key, thumbnail);
        if (thumbnails.size > MAX_CACHED_THUMBNAILS) {
          thumbnails.delete(thumbnails.keys().next().value!);
        }
        return thumbnail;
      } finally {
        source.dispose();
      }
    })
    .catch(() => null)
    .finally(() => {
      if (inFlight.get(key) === entry) {
        inFlight.delete(key);
      }
    });
  const entry: InFlightThumbnail = { promise: load, readers, controller };
  inFlight.set(key, entry);
  attachReader(entry, signal);
  pending = load;
  return load;
}
