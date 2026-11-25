// @effect-diagnostics globalFetch:off globalTimers:off globalDate:off - This browser and WebView transport runs without an Effect runtime.
import type { DeviceDisplayViewport } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface FrameRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const POLL_MS = 5_000;

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

type ReadResult = { readonly viewport: DeviceDisplayViewport | null } | "unsupported" | "failed";

// The panel and its mini player stream the same device; a read in flight serves both.
const inFlight = new Map<string, Promise<ReadResult>>();

const read = (url: string, credentials: boolean): Promise<ReadResult> => {
  const current = inFlight.get(url);
  if (current) return current;
  const pending = fetch(url, {
    cache: "no-store",
    credentials: credentials ? "include" : "same-origin",
  })
    .then(async (response): Promise<ReadResult> => {
      // A server without this route, or an expired media ticket, will not start answering.
      if ([401, 403, 404].includes(response.status)) return "unsupported";
      if (!response.ok) return "failed";
      const decoded = decodeResponse(await response.json());
      return Option.isSome(decoded) ? { viewport: decoded.value.viewport } : "failed";
    })
    .catch((): ReadResult => "failed");
  inFlight.set(url, pending);
  void pending.then(() => inFlight.delete(url));
  return pending;
};

/**
 * Follows where an Android emulator draws its display inside the streamed framebuffer. A
 * `wm size` change does not resize the stream, so the viewport is polled while it is watched.
 */
export function watchDisplayViewport(options: {
  readonly url: string;
  readonly credentials: boolean;
  readonly onChange: (viewport: DeviceDisplayViewport | null) => void;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reading = false;
  let again = false;
  let current: DeviceDisplayViewport | null = null;
  const sameRegion = (a: FrameRegion, b: FrameRegion) =>
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  const same = (a: DeviceDisplayViewport | null, b: DeviceDisplayViewport | null) =>
    a === b ||
    (a !== null &&
      b !== null &&
      a.width === b.width &&
      a.height === b.height &&
      sameRegion(a.content, b.content) &&
      sameRegion(a.touch, b.touch));
  const schedule = () => {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      refresh();
    }, POLL_MS);
  };
  const refresh = () => {
    if (stopped) return;
    if (reading) {
      again = true;
      return;
    }
    if (timer !== null) clearTimeout(timer);
    timer = null;
    reading = true;
    void read(options.url, options.credentials).then((result) => {
      reading = false;
      if (stopped) return;
      if (result === "unsupported") {
        stopped = true;
        return;
      }
      if (result !== "failed" && !same(result.viewport, current)) {
        current = result.viewport;
        options.onChange(current);
      }
      if (again) {
        again = false;
        refresh();
      } else schedule();
    });
  };
  refresh();
  return {
    refresh,
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
