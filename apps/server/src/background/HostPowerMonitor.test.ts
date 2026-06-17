import type { DesktopHostTelemetrySnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
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

  it.effect("consumes desktop power directly without retaining diagnostics telemetry", () =>
    Effect.gen(function* () {
      const sampledAt = DateTime.makeUnsafe("2026-06-17T12:00:00.000Z");
      const desktopChanges = yield* PubSub.sliding<DesktopHostTelemetrySnapshot>(1);
      const diagnosticsDemandWrites = yield* Ref.make(0);
      const receiverLayer = DesktopTelemetryReceiver.layerTest({
        changes: Stream.fromPubSub(desktopChanges),
        setDiagnosticsDemand: () => Ref.update(diagnosticsDemandWrites, (count) => count + 1),
      });
      const layer = HostPowerMonitor.layer.pipe(Layer.provide(receiverLayer));

      yield* Effect.gen(function* () {
        const monitor = yield* HostPowerMonitor.HostPowerMonitor;
        const nextPower = yield* Stream.runHead(monitor.streamChanges).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* PubSub.publish(desktopChanges, {
          version: 1,
          type: "desktopTelemetry",
          sequence: 1,
          sampledAtUnixMs: DateTime.toEpochMillis(sampledAt),
          electronPid: 100,
          power: {
            source: "electron-main",
            idle: "false",
            idleSeconds: 0,
            locked: "false",
            suspended: false,
            onBattery: "true",
            lowPowerMode: "unknown",
            thermalState: "nominal",
            stale: false,
            updatedAt: sampledAt,
          },
          speedLimitPercent: Option.none(),
          electronProcesses: [],
        });

        expect(Option.getOrThrow(yield* Fiber.join(nextPower)).onBattery).toBe("true");
        expect(yield* Ref.get(diagnosticsDemandWrites)).toBe(0);
      }).pipe(Effect.provide(layer));
    }),
  );
});
