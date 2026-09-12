import * as Electron from "electron";
import * as Effect from "effect/Effect";

const OVERLAY_SIZE = 16;
const OVERLAY_SCALE_FACTOR = 4;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

const overlayByDataUrl = new Map<string, Electron.NativeImage>();

function getUnreadCompletionOverlay(dataUrl: string): Electron.NativeImage | null {
  const cached = overlayByDataUrl.get(dataUrl);
  if (cached !== undefined) {
    return cached;
  }

  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    return null;
  }

  const overlay = Electron.nativeImage.createFromBuffer(
    Buffer.from(dataUrl.slice(PNG_DATA_URL_PREFIX.length), "base64"),
    {
      width: OVERLAY_SIZE * OVERLAY_SCALE_FACTOR,
      height: OVERLAY_SIZE * OVERLAY_SCALE_FACTOR,
      scaleFactor: OVERLAY_SCALE_FACTOR,
    },
  );
  if (overlay.isEmpty()) {
    return null;
  }

  overlayByDataUrl.set(dataUrl, overlay);
  return overlay;
}

export function setDesktopUnreadBadge(input: {
  readonly platform: NodeJS.Platform;
  readonly window: Pick<Electron.BrowserWindow, "isDestroyed" | "setOverlayIcon"> | null;
  readonly count: number;
  readonly badgeDataUrl: string | null;
}): boolean {
  try {
    if (input.platform === "darwin") {
      return Electron.app.setBadgeCount(input.count);
    }

    if (input.platform !== "win32" || input.window === null || input.window.isDestroyed()) {
      return false;
    }

    if (input.count === 0) {
      input.window.setOverlayIcon(null, "");
      return true;
    }

    const overlay =
      input.badgeDataUrl === null ? null : getUnreadCompletionOverlay(input.badgeDataUrl);
    if (overlay === null) {
      input.window.setOverlayIcon(null, "");
      return false;
    }

    input.window.setOverlayIcon(
      overlay,
      `${input.count} completed ${input.count === 1 ? "thread" : "threads"} awaiting review`,
    );
    return true;
  } catch (error) {
    Effect.runSync(Effect.logWarning("Failed to update desktop unread badge", error));
    return false;
  }
}
