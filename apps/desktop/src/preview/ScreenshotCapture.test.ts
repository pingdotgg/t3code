import { describe, expect, it } from "@effect/vitest";
import { DESKTOP_PREVIEW_SCREENSHOT_ACTIVITY } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";

import { captureFreshScreenshot } from "./ScreenshotCapture.ts";

const makeHarness = () => {
  const reply = Promise.withResolvers<unknown>();
  const copying = Promise.withResolvers<void>();
  const copy = Promise.withResolvers<Electron.NativeImage>();
  const activity: unknown[][] = [];
  const image = { isEmpty: () => false } as Electron.NativeImage;
  const globals = {
    [DESKTOP_PREVIEW_SCREENSHOT_ACTIVITY]: (...args: unknown[]) => {
      activity.push(args);
      return true;
    },
  };
  const sendCommand = vi.fn(() => reply.promise);
  const capturePage = vi.fn(() => {
    copying.resolve();
    return copy.promise;
  });
  const contents = {
    hostWebContents: {
      isDestroyed: () => false,
      executeJavaScript: async (script: string) =>
        new Function("globalThis", `return ${script}`)(globals),
    },
    capturePage,
  } as unknown as Electron.WebContents;
  const debuggerSession = { sendCommand } as unknown as Electron.Debugger;
  const capture = (params: Record<string, unknown> = {}) =>
    captureFreshScreenshot(contents, debuggerSession, params, "runtime-tab", "capture-token");
  return { reply, copying, copy, image, activity, sendCommand, capturePage, capture };
};

describe("captureFreshScreenshot", () => {
  it.effect("drives an occluded capture without replacing the CDP image or its parameters", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      const params = {
        format: "jpeg",
        quality: 65,
        clip: { x: 2, y: 3, width: 40, height: 50, scale: 0.5 },
      };
      const fiber = yield* h.capture(params).pipe(Effect.forkChild);
      yield* Effect.promise(() => h.copying.promise);
      expect(h.capturePage).toHaveBeenCalledWith(undefined, { stayHidden: true });
      h.reply.resolve({ data: "fresh-cdp-image" });
      expect(yield* Fiber.join(fiber)).toEqual({ data: "fresh-cdp-image" });
      h.copy.resolve(h.image);
      expect(h.sendCommand).toHaveBeenCalledExactlyOnceWith("Page.captureScreenshot", params);
      expect(h.activity.map((args) => args[2])).toEqual([true, false]);
      expect(h.activity[0]?.slice(0, 2)).toEqual(h.activity[1]?.slice(0, 2));
      expect(h.capturePage).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("retries a cold guest copy while preserving the pending CDP capture", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      const firstCopy = Promise.withResolvers<void>();
      h.capturePage.mockImplementationOnce(() => {
        firstCopy.resolve();
        return Promise.reject(new Error("UnknownVizError"));
      });
      const fiber = yield* h.capture().pipe(Effect.forkChild);
      yield* Effect.promise(() => firstCopy.promise);
      yield* TestClock.adjust("120 millis");
      yield* Effect.promise(() => h.copying.promise);
      h.reply.resolve({ data: "fresh-after-cold-start" });
      expect(yield* Fiber.join(fiber)).toEqual({ data: "fresh-after-cold-start" });
      h.copy.resolve(h.image);
      expect(h.capturePage).toHaveBeenCalledTimes(2);
      expect(h.sendCommand).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("bounds a stalled native copy and releases renderer activity", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      const fiber = yield* h.capture().pipe(Effect.forkChild);
      yield* Effect.promise(() => h.copying.promise);
      yield* TestClock.adjust("3 seconds");
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
      expect(h.activity.map((args) => args[2])).toEqual([true, false]);
      h.copy.resolve(h.image);
      expect(h.capturePage).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("releases activity when its relay is interrupted while a copy is pending", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      const fiber = yield* h.capture().pipe(Effect.forkChild);
      yield* Effect.promise(() => h.copying.promise);
      yield* Fiber.interrupt(fiber);
      h.copy.resolve(h.image);
      expect(h.activity.map((args) => args[2])).toEqual([true, false]);
      expect(h.capturePage).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("stops on an unavailable native surface instead of repeatedly copying it", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      h.copy.resolve({ isEmpty: () => true } as Electron.NativeImage);
      const result = yield* h.capture().pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.pretty(result.cause)).toContain("surface is unavailable");
      expect(h.activity.map((args) => args[2])).toEqual([true, false]);
      expect(h.capturePage).toHaveBeenCalledTimes(1);
    }),
  );
});
