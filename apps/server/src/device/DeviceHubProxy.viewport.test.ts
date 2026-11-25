import { expect, it } from "@effect/vitest";
import { DeviceOperationError, type DeviceDisplayViewport } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { displayViewportUpdates } from "./DeviceHubProxy.ts";

const letterboxed: DeviceDisplayViewport = {
  width: 1080,
  height: 2400,
  content: { x: 72, y: 0, width: 936, height: 2400 },
  touch: { x: 0, y: 0, width: 904 / 1080, height: 2316 / 2400 },
};

it.effect("skips failed viewport reads and repeated viewports", () =>
  Effect.gen(function* () {
    const narrower = { ...letterboxed, content: { x: 120, y: 0, width: 840, height: 2400 } };
    const reads: ReadonlyArray<DeviceDisplayViewport | "fail"> = [
      letterboxed,
      "fail",
      letterboxed,
      narrower,
    ];
    let index = 0;
    const read = Effect.suspend(() => {
      const next = reads[index++];
      return next === "fail"
        ? Effect.fail(
            new DeviceOperationError({
              operation: "display viewport",
              reason: "command_failed",
              cause: "adb: device offline",
            }),
          )
        : Effect.succeed(next ?? null);
    });
    const updates = yield* displayViewportUpdates(read, []).pipe(
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* TestClock.adjust("20 seconds");
    expect(yield* Fiber.join(updates)).toEqual([letterboxed, narrower]);
    expect(index).toBe(4);
  }),
);

it.effect(
  "starts from the read that let the stream open and reads again only after the interval",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const read = Effect.sync(() => {
        reads += 1;
        return null;
      });
      const updates = yield* displayViewportUpdates(read, [letterboxed]).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* TestClock.adjust("4 seconds");
      expect(reads).toBe(0);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(updates)).toEqual([letterboxed, null]);
      expect(reads).toBe(1);
    }),
);
