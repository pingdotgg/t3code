import { DESKTOP_PREVIEW_SCREENSHOT_ACTIVITY } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";

export class ScreenshotCaptureError extends Schema.TaggedError<ScreenshotCaptureError>()(
  "ScreenshotCaptureError",
  { message: Schema.String },
) {}

export const captureFreshScreenshot = Effect.fn("Preview.captureFreshScreenshot")(function* (
  contents: Electron.WebContents,
  debuggee: Electron.Debugger,
  params: Record<string, unknown>,
  runtimeTabId: string,
  token: string,
) {
  const host = contents.hostWebContents;
  if (!host || host.isDestroyed()) {
    return yield* Effect.fail(
      new ScreenshotCaptureError({ message: "The desktop preview host window is unavailable." }),
    );
  }
  const expression = (active: boolean) =>
    `globalThis[${JSON.stringify(DESKTOP_PREVIEW_SCREENSHOT_ACTIVITY)}]?.(${JSON.stringify(runtimeTabId)},${JSON.stringify(token)},${active}) === true`;
  const screenshot = Effect.tryPromise(() =>
    debuggee.sendCommand("Page.captureScreenshot", params),
  );
  // CDP requests a redraw, but an occluded guest needs page copies to present it.
  // Discard those copies: only the CDP reply carries the requested clip and scale.
  const copies = Effect.forever(
    Effect.tryPromise(() => contents.capturePage(undefined, { stayHidden: true })).pipe(
      // A cold guest can reject its first copy with Chromium's UnknownVizError.
      Effect.retry({ times: 2, schedule: Schedule.spaced("120 millis") }),
      Effect.filterOrFail(
        (image) => !image.isEmpty(),
        () =>
          new ScreenshotCaptureError({
            message: "The desktop preview capture surface is unavailable.",
          }),
      ),
      Effect.andThen(Effect.sleep("16 millis")),
    ),
  );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      // Register cleanup before preparation: a late renderer reply must not leave
      // an activity lease behind after the caller's deadline or disconnect.
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise(() => host.executeJavaScript(expression(false))).pipe(
          Effect.timeout("1 second"),
          Effect.ignore,
        ),
      );
      yield* Effect.tryPromise(() => host.executeJavaScript(expression(true))).pipe(
        Effect.filterOrFail(
          (prepared) => prepared === true,
          () =>
            new ScreenshotCaptureError({
              message: "The desktop preview rendering surface is unavailable.",
            }),
        ),
      );
      return yield* screenshot.pipe(Effect.raceFirst(copies));
    }),
  ).pipe(Effect.timeout("3 seconds"));
});
