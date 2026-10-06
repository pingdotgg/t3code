import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  type PreviewStreamClient,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import type { EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { readPreviewStreamAccess } from "~/state/previewStream";

interface WebKitVideo {
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
}

interface ActivePictureInPicture {
  readonly key: string;
  readonly stop: () => void;
}

// Owns its stream outside React so the floating window survives panel unmounts.
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

/** Open during user activation, seeding the video with the currently visible frame. */
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
  canvas.width = seed?.width ?? 640;
  canvas.height = seed?.height ?? 400;
  // The capture emits a frame per draw, so the seed is drawn after it starts.
  const stream = canvas.captureStream();
  if (seed) context?.drawImage(seed, 0, 0);
  else context?.fillRect(0, 0, canvas.width, canvas.height);
  const video = document.createElement("video") as HTMLVideoElement & WebKitVideo;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  // Safari only floats a video that is in the document.
  video.style.cssText =
    "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(video);

  const painter = createPreviewFramePainter(canvas);
  let client: PreviewStreamClient | null = null;
  let stopped = false;
  let refusals = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const onLeave = () => {
    if (active === current) closeServerPictureInPicture();
  };
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
        maxWidth: 1280,
        maxHeight: 1280,
        interactive: false,
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
          if (refusals >= 5) {
            onLeave();
            return;
          }
          retryTimer = setTimeout(() => void connect(true), 1_000 * 2 ** refusals++);
        },
        onGone: onLeave,
      },
    );
  };

  const onPresentationMode = () => {
    if (video.webkitPresentationMode !== "picture-in-picture") onLeave();
  };
  const current: ActivePictureInPicture = {
    key: serverPictureInPictureKey(input.threadId, input.tabId),
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
    onLeave();
    throw error;
  }
  if (active === current) void connect(false);
}
