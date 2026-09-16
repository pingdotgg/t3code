import type { WebContents } from "electron";
import * as Schema from "effect/Schema";

const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));
const decodeSurfaceState = Schema.decodeUnknownSync(
  Schema.NullOr(
    Schema.Struct({
      viewportWidth: PositiveFinite,
      viewportHeight: PositiveFinite,
      devicePixelRatio: PositiveFinite,
      surfaceWidth: PositiveFinite,
      surfaceHeight: PositiveFinite,
      renderedWidth: PositiveFinite,
      renderedHeight: PositiveFinite,
    }),
  ),
);
const decodePositiveFinite = Schema.decodeUnknownSync(PositiveFinite);
const decodePrepared = Schema.decodeUnknownSync(Schema.Boolean);

const FITTED_SCALE_EPSILON = 0.001;
let captureSequence = 0;

export interface NativeScreenshotSurface {
  readonly restore: () => Promise<void>;
}

const findSurfaceExpression = (tabId: string, webContentsId: number): string => `(() => {
  const webview = Array.from(document.querySelectorAll("webview[data-preview-tab]"))
    .find((candidate) => candidate.dataset.previewTab === ${JSON.stringify(tabId)});
  if (!webview || webview.getWebContentsId() !== ${webContentsId}) return null;
  const rect = webview.getBoundingClientRect();
  return {
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    devicePixelRatio,
    surfaceWidth: webview.offsetWidth,
    surfaceHeight: webview.offsetHeight,
    renderedWidth: rect.width,
    renderedHeight: rect.height,
  };
})()`;

const prepareSurfaceExpression = (input: {
  readonly tabId: string;
  readonly webContentsId: number;
  readonly token: string;
  readonly coverDataUrl: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}): string => `(() => {
  const webview = Array.from(document.querySelectorAll("webview[data-preview-tab]"))
    .find((candidate) => candidate.dataset.previewTab === ${JSON.stringify(input.tabId)});
  const root = document.getElementById("root");
  if (!webview || webview.getWebContentsId() !== ${input.webContentsId} || !root) return false;

  const cover = document.createElement("img");
  cover.id = ${JSON.stringify(`t3-native-screenshot-cover-${input.token}`)};
  cover.src = ${JSON.stringify(input.coverDataUrl)};
  cover.alt = "";
  cover.draggable = false;
  cover.dataset.rootHadStyle = root.hasAttribute("style") ? "true" : "false";
  cover.dataset.rootStyle = root.getAttribute("style") ?? "";
  cover.style.cssText = [
    "position:fixed",
    "inset:0",
    "width:100vw",
    "height:100vh",
    "z-index:2147483647",
    "pointer-events:none",
    "object-fit:fill",
    "user-select:none",
  ].join(";");
  cover.setAttribute("aria-hidden", "true");

  const style = document.createElement("style");
  style.id = ${JSON.stringify(`t3-native-screenshot-style-${input.token}`)};
  style.textContent = "webview[data-preview-native-screenshot] { transform: none !important; }";

  root.style.width = ${JSON.stringify(`${input.viewportWidth}px`)};
  root.style.height = ${JSON.stringify(`${input.viewportHeight}px`)};
  webview.setAttribute("data-preview-native-screenshot", "");
  document.head.append(style);
  document.body.append(cover);
  return true;
})()`;

const restoreSurfaceExpression = (token: string): string => `(() => {
  const cover = document.getElementById(${JSON.stringify(`t3-native-screenshot-cover-${token}`)});
  const root = document.getElementById("root");
  document.querySelector("webview[data-preview-native-screenshot]")
    ?.removeAttribute("data-preview-native-screenshot");
  document.getElementById(${JSON.stringify(`t3-native-screenshot-style-${token}`)})?.remove();
  if (root && cover) {
    if (cover.dataset.rootHadStyle === "true") {
      root.setAttribute("style", cover.dataset.rootStyle ?? "");
    } else {
      root.removeAttribute("style");
    }
  }
  cover?.remove();
})()`;

const nextPaintExpression = `Promise.resolve(document.fonts?.ready).then(
  () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
)`;

/**
 * Temporarily presents a fitted guest at its native raster scale. A still cover
 * keeps the desktop UI fixed while host emulation gives the unscaled guest room
 * to paint. Detaching the temporary host debugger also clears its emulation if
 * Chromium rejects the explicit cleanup command.
 */
export async function prepareNativeScreenshotSurface(
  tabId: string,
  guest: WebContents,
  signal?: AbortSignal,
): Promise<NativeScreenshotSurface | null> {
  const host = guest.hostWebContents;
  if (!host || host.isDestroyed()) return null;

  let state;
  try {
    state = decodeSurfaceState(
      await host.executeJavaScript(findSurfaceExpression(tabId, guest.id), true),
    );
  } catch {
    return null;
  }
  if (!state) return null;

  const scale = Math.min(
    state.renderedWidth / state.surfaceWidth,
    state.renderedHeight / state.surfaceHeight,
  );
  if (scale >= 1 - FITTED_SCALE_EPSILON) return null;
  if (host.isDevToolsOpened() || host.debugger.isAttached()) return null;

  signal?.throwIfAborted();
  const cover = await host.capturePage();
  signal?.throwIfAborted();
  if (cover.isEmpty()) return null;

  const guestDevicePixelRatio = decodePositiveFinite(
    await guest.executeJavaScript("devicePixelRatio", true),
  );
  const hostZoomFactor = decodePositiveFinite(host.getZoomFactor());
  const guestZoomFactor = decodePositiveFinite(guest.getZoomFactor());
  const hostDeviceScaleFactor = state.devicePixelRatio / hostZoomFactor;
  const guestDeviceScaleFactor = guestDevicePixelRatio / guestZoomFactor;
  const hostWidth = Math.ceil((state.viewportWidth * hostZoomFactor) / scale);
  const hostHeight = Math.ceil((state.viewportHeight * hostZoomFactor) / scale);
  const token = `${guest.id}-${++captureSequence}`;

  let hostDebuggerAttached = false;
  let hostMetricsOverridden = false;
  let guestMetricsOverridden = false;
  let surfacePrepared = false;
  let restored = false;

  const restore = async () => {
    if (restored) return;
    restored = true;
    if (guestMetricsOverridden && !guest.isDestroyed()) {
      await guest.debugger
        .sendCommand("Emulation.clearDeviceMetricsOverride")
        .catch(() => undefined);
    }
    if (hostMetricsOverridden && !host.isDestroyed()) {
      await host.debugger
        .sendCommand("Emulation.clearDeviceMetricsOverride")
        .catch(() => undefined);
    }
    if (hostDebuggerAttached && host.debugger.isAttached()) {
      try {
        host.debugger.detach();
      } catch {
        // The host may close while capture cleanup is in progress.
      }
    }
    if (surfacePrepared && !host.isDestroyed()) {
      await host.executeJavaScript(restoreSurfaceExpression(token), true).catch(() => undefined);
      host.invalidate();
    }
  };

  try {
    host.debugger.attach("1.3");
    hostDebuggerAttached = true;
    surfacePrepared = decodePrepared(
      await host.executeJavaScript(
        prepareSurfaceExpression({
          tabId,
          webContentsId: guest.id,
          token,
          coverDataUrl: cover.toDataURL(),
          viewportWidth: state.viewportWidth,
          viewportHeight: state.viewportHeight,
        }),
        true,
      ),
    );
    if (!surfacePrepared) {
      await restore();
      return null;
    }

    signal?.throwIfAborted();
    await host.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: hostWidth,
      height: hostHeight,
      screenWidth: hostWidth,
      screenHeight: hostHeight,
      deviceScaleFactor: hostDeviceScaleFactor,
      mobile: false,
      scale,
    });
    hostMetricsOverridden = true;
    await guest.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: state.surfaceWidth,
      height: state.surfaceHeight,
      deviceScaleFactor: guestDeviceScaleFactor,
      mobile: false,
    });
    guestMetricsOverridden = true;

    host.invalidate();
    guest.invalidate();
    await Promise.all([
      host.executeJavaScript(nextPaintExpression, true),
      guest.executeJavaScript(nextPaintExpression, true),
    ]);
    signal?.throwIfAborted();
    return { restore };
  } catch (error) {
    await restore();
    throw error;
  }
}
