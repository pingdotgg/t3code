import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  type PreviewStreamClient,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import type { EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { readPreviewStreamAccess } from "~/state/previewStream";

/**
 * System picture in picture for a server tab, so a phone keeps watching the
 * agent's browser over other apps. The tab streams into a detached canvas,
 * which plays as a muted video the browser floats. It is view-only and owns
 * its own socket, so it outlives the panel and floating player that opened it.
 * One at a time, like the browser's own picture in picture.
 */

/** Frames cap for the floating window, in device px. */
const STREAM_CAP_PX = 1280;
const PLACEHOLDER = { width: 640, height: 400 };
// Refused upgrades retry with backoff; past the limit the window closes.
const UNAUTHORIZED_RETRY_BASE_MS = 1_000;
const UNAUTHORIZED_RETRY_LIMIT = 5;

interface WebKitVideo {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
}

interface ActivePictureInPicture {
  readonly key: string;
  readonly video: HTMLVideoElement;
  readonly stop: () => void;
}

let active: ActivePictureInPicture | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const serverPictureInPictureKey = (threadId: string, tabId: string) =>
  JSON.stringify([threadId, tabId]);

/** Chromium and Safari float a canvas-captured video; Firefox has no API for it. */
export function supportsServerPictureInPicture(): boolean {
  if (typeof document === "undefined") return false;
  if (typeof HTMLCanvasElement.prototype.captureStream !== "function") return false;
  const video = HTMLVideoElement.prototype as HTMLVideoElement & WebKitVideo;
  return (
    (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === "function") ||
    typeof video.webkitSetPresentationMode === "function"
  );
}

/** The key of the floating server tab, or null. */
export function useServerPictureInPictureKey(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => active?.key ?? null,
    () => null,
  );
}

export function closeServerPictureInPicture(): void {
  const current = active;
  active = null;
  current?.stop();
  emit();
}

/**
 * Must run inside the click that asked for it: browsers only float a video
 * during user activation. `seed` is the tab's visible canvas, copied so the
 * window opens on the current frame instead of a blank one.
 */
export async function openServerPictureInPicture(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly tabId: string;
  readonly seed: HTMLCanvasElement | null;
}): Promise<void> {
  closeServerPictureInPicture();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const seed = input.seed && input.seed.width > 0 && input.seed.height > 0 ? input.seed : null;
  canvas.width = seed?.width ?? PLACEHOLDER.width;
  canvas.height = seed?.height ?? PLACEHOLDER.height;
  // The capture emits a frame per draw, so the seed is drawn after it starts.
  const stream = canvas.captureStream();
  if (seed) context?.drawImage(seed, 0, 0);
  else context?.fillRect(0, 0, canvas.width, canvas.height);
  const video = document.createElement("video") as HTMLVideoElement & WebKitVideo;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  // Safari only floats a video that is in the document.
  Object.assign(video.style, {
    position: "fixed",
    right: "0",
    bottom: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.append(video);

  const painter = createPreviewFramePainter(canvas);
  let client: PreviewStreamClient | null = null;
  let stopped = false;
  let refusals = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const connect = async (refresh: boolean) => {
    const access = await readPreviewStreamAccess(input.environmentId, refresh);
    if (stopped) return;
    if (!access) {
      closeServerPictureInPicture();
      return;
    }
    client = createPreviewStreamClient(
      {
        access,
        threadId: input.threadId,
        tabId: input.tabId,
        maxWidth: STREAM_CAP_PX,
        maxHeight: STREAM_CAP_PX,
      },
      {
        onFrame: (jpeg) => {
          refusals = 0;
          painter.paint(jpeg);
        },
        onViewport: () => undefined,
        onConnectedChange: () => undefined,
        onUnauthorized: () => {
          if (stopped) return;
          if (refusals >= UNAUTHORIZED_RETRY_LIMIT) {
            if (active?.video === video) closeServerPictureInPicture();
            return;
          }
          const delay = UNAUTHORIZED_RETRY_BASE_MS * 2 ** refusals;
          refusals += 1;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void connect(true);
          }, delay);
        },
        onGone: () => {
          if (active?.video === video) closeServerPictureInPicture();
        },
      },
    );
  };

  const onLeave = () => {
    if (active?.video === video) closeServerPictureInPicture();
  };
  const onPresentationMode = () => {
    if (video.webkitPresentationMode !== "picture-in-picture") onLeave();
  };
  const current: ActivePictureInPicture = {
    key: serverPictureInPictureKey(input.threadId, input.tabId),
    video,
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      client?.stop();
      painter.stop();
      video.removeEventListener("leavepictureinpicture", onLeave);
      video.removeEventListener("webkitpresentationmodechanged", onPresentationMode);
      if (document.pictureInPictureElement === video) {
        void document.exitPictureInPicture().catch(() => undefined);
      } else if (video.webkitPresentationMode === "picture-in-picture") {
        video.webkitSetPresentationMode?.("inline");
      }
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
      video.remove();
    },
  };
  active = current;
  emit();

  try {
    await video.play();
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise((resolve) =>
        video.addEventListener("loadedmetadata", resolve, { once: true }),
      );
    }
    if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === "function") {
      video.addEventListener("leavepictureinpicture", onLeave);
      await video.requestPictureInPicture();
    } else {
      video.addEventListener("webkitpresentationmodechanged", onPresentationMode);
      video.webkitSetPresentationMode?.("picture-in-picture");
    }
  } catch (error) {
    if (active === current) closeServerPictureInPicture();
    throw error;
  }
  if (active === current) void connect(false);
}
