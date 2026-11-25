// @effect-diagnostics globalTimers:off - This browser and WebView transport runs without an Effect runtime.
import type { DeviceDisplayViewport } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface FrameRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const size = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const unit = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const decodeResponse = Schema.decodeUnknownOption(
  Schema.Struct({
    viewport: Schema.NullOr(
      Schema.Struct({
        width: size,
        height: size,
        content: Schema.Struct({ x: offset, y: offset, width: size, height: size }),
        touch: Schema.Struct({ x: unit, y: unit, width: unit, height: unit }),
      }),
    ),
  }),
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

// EventSource reports no status code, so a refusal is only treated as lost access when a fresh
// connection is refused too: a one-off proxy error must not tear down healthy video.
const RECONNECT_DELAY_MS = 1_000;

/**
 * Follows where an Android emulator draws its display inside the streamed framebuffer. The
 * server pushes it, so the stream keeps updating after a media ticket expires.
 */
export function watchDisplayViewport(options: {
  readonly url: string;
  readonly credentials: boolean;
  readonly onChange: (viewport: DeviceDisplayViewport | null) => void;
  /** A stream that had connected is refused twice in a row, as when its media ticket expired. */
  readonly onRefused: () => void;
}) {
  // Undefined until the first event, which always applies: a watch started for a reconnect
  // must clear a viewport left from before.
  let current: DeviceDisplayViewport | null | undefined;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const connect = (retrying: boolean) => {
    const next = new EventSource(options.url, { withCredentials: options.credentials });
    source = next;
    let opened = false;
    next.onopen = () => {
      opened = true;
    };
    next.onerror = () => {
      if (source !== next || next.readyState !== EventSource.CLOSED) return;
      if (opened) {
        retry = setTimeout(() => {
          retry = null;
          connect(true);
        }, RECONNECT_DELAY_MS);
      } else if (retrying) {
        options.onRefused();
      }
      // A first connection refused (a server without the route) leaves the frame uncropped.
    };
    next.onmessage = (event: MessageEvent<string>) => {
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      const decoded = decodeResponse(payload);
      if (Option.isNone(decoded)) return;
      const viewport = decoded.value.viewport;
      if (current !== undefined && sameViewport(viewport, current)) return;
      current = viewport;
      options.onChange(viewport);
    };
  };
  connect(false);
  return {
    stop: () => {
      if (retry !== null) clearTimeout(retry);
      retry = null;
      source?.close();
      source = null;
    },
  };
}
