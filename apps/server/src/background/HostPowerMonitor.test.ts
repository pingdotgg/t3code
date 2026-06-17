import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as HostPowerMonitor from "./HostPowerMonitor.ts";

describe("HostPowerMonitor", () => {
  it.effect("publishes semantic power changes without idle-time heartbeat churn", () =>
    Effect.gen(function* () {
      const monitor = yield* HostPowerMonitor.make();
      const initial = {
        source: "electron-main",
        idle: "false",
        idleSeconds: 0,
        locked: "false",
        suspended: false,
        onBattery: "false",
        lowPowerMode: "unknown",
        thermalState: "nominal",
        stale: false,
        updatedAt: DateTime.makeUnsafe("2026-06-17T12:00:00.000Z"),
      } as const;
      yield* monitor.report(initial);

      const nextChange = yield* Stream.runHead(monitor.streamChanges).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* monitor.report({
        ...initial,
        idleSeconds: 1,
        updatedAt: DateTime.makeUnsafe("2026-06-17T12:00:01.000Z"),
      });
      yield* monitor.report({
        ...initial,
        locked: "true",
        updatedAt: DateTime.makeUnsafe("2026-06-17T12:00:02.000Z"),
      });

      expect(Option.getOrThrow(yield* Fiber.join(nextChange)).locked).toBe("true");
    }),
  );
});
