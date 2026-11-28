// @effect-diagnostics globalFetch:off globalTimers:off - This browser and WebView transport runs without an Effect runtime.
import { DeviceDisplayViewport } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface FrameRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const decodeEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ viewport: Schema.NullOr(DeviceDisplayViewport) })),
);

/**
 * The viewport as seen in a frame, or null when the frame does not show the framebuffer (the hub
 * already sized it to the display). An emulator turned on its side streams its framebuffer a
 * quarter turn round; Android centres the display, so its rectangle just swaps axes.
 */
const viewportInFrame = (
  viewport: DeviceDisplayViewport | null,
  frameWidth: number,
  frameHeight: number,
): DeviceDisplayViewport | null => {
  if (!viewport || frameWidth <= 0 || frameHeight <= 0) return null;
  const frameAspect = frameWidth / frameHeight;
  const aspect = viewport.width / viewport.height;
  if (Math.abs(frameAspect - aspect) <= 0.01) return viewport;
  if (Math.abs(frameAspect - 1 / aspect) > 0.01) return null;
  const { content, width, height } = viewport;
  return {
    width: height,
    height: width,
    content: { x: content.y, y: content.x, width: content.height, height: content.width },
    // Taps on a turned frame land in its own coordinates, like a touchscreen on the panel.
    touch: {
      x: content.y / height,
      y: content.x / width,
      width: content.height / height,
      height: content.width / width,
    },
  };
};

/** The part of a streamed frame that shows the display, or null to show all of it. */
export function displayRegion(
  viewport: DeviceDisplayViewport | null,
  frameWidth: number,
  frameHeight: number,
): FrameRegion | null {
  const framed = viewportInFrame(viewport, frameWidth, frameHeight);
  if (!framed) return null;
  const scaleX = frameWidth / framed.width;
  const scaleY = frameHeight / framed.height;
  const x = Math.round(framed.content.x * scaleX);
  const y = Math.round(framed.content.y * scaleY);
  const width = Math.min(frameWidth - x, Math.round(framed.content.width * scaleX));
  const height = Math.min(frameHeight - y, Math.round(framed.content.height * scaleY));
  if (width <= 0 || height <= 0 || (width === frameWidth && height === frameHeight)) return null;
  return { x, y, width, height };
}

/** Where 0..1 coordinates on the shown display go in the hub's 0..1 touch coordinates. */
export function touchArea(
  viewport: DeviceDisplayViewport | null,
  frameWidth: number,
  frameHeight: number,
): FrameRegion | null {
  return viewportInFrame(viewport, frameWidth, frameHeight)?.touch ?? null;
}

export function touchPoint(area: FrameRegion, x: number, y: number) {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return { x: area.x + clamp(x) * area.width, y: area.y + clamp(y) * area.height };
}

const sameRegion = (a: FrameRegion, b: FrameRegion) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const sameViewport = (a: DeviceDisplayViewport | null, b: DeviceDisplayViewport | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.width === b.width &&
    a.height === b.height &&
    sameRegion(a.content, b.content) &&
    sameRegion(a.touch, b.touch));

const RECONNECT_DELAY_MS = 1_000;
// A first connection can meet a hub that is still starting; a server without the route refuses
// every attempt, and the frame stays uncropped.
const CONNECTION_ATTEMPTS = 4;

/**
 * Follows where an Android emulator draws its display inside the streamed framebuffer. The
 * server pushes it, so the stream keeps updating after a media ticket expires.
 */
export function watchDisplayViewport(options: {
  readonly url: string;
  readonly credentials: boolean;
  readonly onChange: (viewport: DeviceDisplayViewport | null) => void;
  /** A stream that had connected is refused with 401 or 403, as when its media ticket expired. */
  readonly onRefused: () => void;
}) {
  // Undefined until the first event, which always applies: a watch started for a reconnect
  // must clear a viewport left from before.
  let current: DeviceDisplayViewport | null | undefined;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let probe: AbortController | null = null;
  let connected = false;
  let failedAttempts = 0;
  const reconnect = (delay: number) => {
    retry = setTimeout(() => {
      retry = null;
      connect();
    }, delay);
  };
  const failAttempt = () => {
    failedAttempts += 1;
    if (failedAttempts < CONNECTION_ATTEMPTS)
      return reconnect(RECONNECT_DELAY_MS * 2 ** (failedAttempts - 1));
    // Out of attempts: a crop that is no longer followed could go stale.
    if (current !== null) {
      current = null;
      options.onChange(null);
    }
  };
  // EventSource reports no status code, so ask for it: only lost access may renew it, since that
  // reconnects healthy video and input too.
  const checkRefusal = (refused: EventSource) => {
    const controller = new AbortController();
    probe = controller;
    void fetch(options.url, {
      credentials: options.credentials ? "include" : "same-origin",
      signal: controller.signal,
    })
      .then((response) => response.status)
      .catch(() => 0)
      .then((status) => {
        controller.abort();
        if (source !== refused) return;
        probe = null;
        if (status === 401 || status === 403) options.onRefused();
        else failAttempt();
      });
  };
  const connect = () => {
    const next = new EventSource(options.url, { withCredentials: options.credentials });
    source = next;
    let opened = false;
    next.onopen = () => {
      opened = true;
      connected = true;
      failedAttempts = 0;
    };
    next.onerror = () => {
      if (source !== next || next.readyState !== EventSource.CLOSED) return;
      if (opened) return reconnect(RECONNECT_DELAY_MS);
      if (connected) return checkRefusal(next);
      failAttempt();
    };
    next.onmessage = (event: MessageEvent<string>) => {
      const decoded = decodeEvent(event.data);
      if (Option.isNone(decoded)) return;
      const viewport = decoded.value.viewport;
      if (current !== undefined && sameViewport(viewport, current)) return;
      current = viewport;
      options.onChange(viewport);
    };
  };
  connect();
  return {
    stop: () => {
      if (retry !== null) clearTimeout(retry);
      retry = null;
      probe?.abort();
      probe = null;
      source?.close();
      source = null;
    },
  };
}
