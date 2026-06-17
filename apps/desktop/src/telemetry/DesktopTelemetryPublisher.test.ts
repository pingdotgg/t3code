import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopTelemetryPublisher from "./DesktopTelemetryPublisher.ts";

function makeElectronAppLayer(metrics: ReadonlyArray<Electron.ProcessMetric>) {
  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    whenReady: Effect.void,
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    getAppMetrics: Effect.succeed(metrics),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);
}

describe("DesktopTelemetryPublisher", () => {
  it.effect("publishes Electron metrics and event-driven power state over NDJSON", () =>
    Effect.gen(function* () {
      const onBattery = yield* Ref.make(false);
      const simpleListeners = new Map<string, () => void>();
      let thermalListener: ((state: ElectronPowerMonitor.ElectronThermalState) => void) | null =
        null;
      let speedLimitListener: ((limit: number) => void) | null = null;
      const metrics = [
        {
          pid: 4_242,
          type: "Browser",
          creationTime: 1_000,
          name: "electron",
          cpu: {
            percentCPUUsage: 12.5,
            cumulativeCPUUsage: 3.25,
            idleWakeupsPerSecond: 7,
          },
          memory: {
            workingSetSize: 2_048,
            peakWorkingSetSize: 4_096,
          },
        } as Electron.ProcessMetric,
      ];
      const powerLayer = Layer.succeed(
        ElectronPowerMonitor.ElectronPowerMonitor,
        ElectronPowerMonitor.ElectronPowerMonitor.of({
          isOnBatteryPower: Ref.get(onBattery),
          getSystemIdleTime: Effect.succeed(5),
          getSystemIdleState: () => Effect.succeed("active"),
          getCurrentThermalState: Effect.succeed("nominal"),
          onSimpleEvent: (eventName, listener) =>
            Effect.sync(() => {
              simpleListeners.set(eventName, listener);
            }),
          onThermalStateChange: (listener) =>
            Effect.sync(() => {
              thermalListener = listener;
            }),
          onSpeedLimitChange: (listener) =>
            Effect.sync(() => {
              speedLimitListener = listener;
            }),
        }),
      );
      const layer = DesktopTelemetryPublisher.layer.pipe(
        Layer.provide(Layer.mergeAll(makeElectronAppLayer(metrics), powerLayer)),
      );

      yield* Effect.gen(function* () {
        const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
        const encoded = yield* publisher.encoded.pipe(Stream.take(2), Stream.runCollect);
        const decoder = new TextDecoder();
        const messages = Array.from(encoded, (bytes) => JSON.parse(decoder.decode(bytes).trim()));

        assert.equal(messages[0]?.type, "desktopTelemetryHello");
        assert.equal(messages[0]?.electronPid, process.pid);
        assert.equal(messages[1]?.type, "desktopTelemetry");
        assert.equal(messages[1]?.electronProcesses[0]?.pid, 4_242);
        assert.equal(messages[1]?.electronProcesses[0]?.cpuPercent, 12.5);
        assert.equal(messages[1]?.electronProcesses[0]?.workingSetBytes, 2_048 * 1_024);

        const nextSnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Ref.set(onBattery, true);
        simpleListeners.get("lock-screen")?.();
        simpleListeners.get("suspend")?.();
        thermalListener?.("serious");
        speedLimitListener?.(65);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(1));

        const nextSnapshot = Option.getOrThrow(yield* Fiber.join(nextSnapshotFiber));
        assert.equal(nextSnapshot.power.locked, "true");
        assert.equal(nextSnapshot.power.suspended, true);
        assert.equal(nextSnapshot.power.onBattery, "true");
        assert.equal(nextSnapshot.power.thermalState, "serious");
        assert.equal(Option.getOrNull(nextSnapshot.speedLimitPercent), 65);
      }).pipe(Effect.provide(layer));
    }),
  );
});
