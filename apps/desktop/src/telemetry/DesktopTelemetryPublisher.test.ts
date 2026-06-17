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

function makeElectronAppLayer(
  metrics: ReadonlyArray<Electron.ProcessMetric>,
  onMetricsRead: () => void = () => undefined,
) {
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
    getAppMetrics: Effect.sync(() => {
      onMetricsRead();
      return metrics;
    }),
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
      let metricsReadCount = 0;
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
        Layer.provide(
          Layer.mergeAll(
            makeElectronAppLayer(metrics, () => {
              metricsReadCount += 1;
            }),
            powerLayer,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
        const encoded = yield* publisher.encoded.pipe(Stream.take(2), Stream.runCollect);
        const decoder = new TextDecoder();
        const messages = Array.from(encoded, (bytes) => JSON.parse(decoder.decode(bytes).trim()));

        assert.equal(messages[0]?.type, "desktopTelemetryHello");
        assert.equal(messages[0]?.electronPid, process.pid);
        assert.equal(messages[1]?.type, "desktopTelemetry");
        assert.deepEqual(messages[1]?.electronProcesses, []);
        assert.equal(messages[1]?.electronPid, process.pid);
        assert.equal(metricsReadCount, 0);

        const nextSnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* publisher.handleControl({
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: true,
        });
        const demandedSnapshot = Option.getOrThrow(yield* Fiber.join(nextSnapshotFiber));
        assert.equal(demandedSnapshot.electronProcesses[0]?.pid, 4_242);
        assert.equal(demandedSnapshot.electronProcesses[0]?.cpuPercent, 12.5);
        assert.equal(demandedSnapshot.electronProcesses[0]?.workingSetBytes, 2_048 * 1_024);
        assert.equal(metricsReadCount, 1);

        const batterySnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* Ref.set(onBattery, true);
        simpleListeners.get("on-battery")?.();
        const batterySnapshot = Option.getOrThrow(yield* Fiber.join(batterySnapshotFiber));
        assert.equal(batterySnapshot.power.onBattery, "true");

        const metricsAfterBatteryEvent = metricsReadCount;
        yield* TestClock.adjust(Duration.millis(4_999));
        assert.equal(metricsReadCount, metricsAfterBatteryEvent);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(metricsReadCount, metricsAfterBatteryEvent + 1);

        const constrainedSnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        thermalListener?.("serious");
        const constrainedSnapshot = Option.getOrThrow(yield* Fiber.join(constrainedSnapshotFiber));
        assert.equal(constrainedSnapshot.power.thermalState, "serious");

        const metricsAfterThermalEvent = metricsReadCount;
        yield* TestClock.adjust(Duration.millis(14_999));
        assert.equal(metricsReadCount, metricsAfterThermalEvent);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(metricsReadCount, metricsAfterThermalEvent + 1);

        const speedLimitSnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        speedLimitListener?.(65);
        const speedLimitSnapshot = Option.getOrThrow(yield* Fiber.join(speedLimitSnapshotFiber));
        assert.equal(Option.getOrNull(speedLimitSnapshot.speedLimitPercent), 65);

        const stoppedSnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* publisher.handleControl({
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: false,
        });
        const stoppedSnapshot = Option.getOrThrow(yield* Fiber.join(stoppedSnapshotFiber));
        assert.deepEqual(stoppedSnapshot.electronProcesses, []);
        const backgroundSequence = stoppedSnapshot.sequence;
        const metricsAfterStopping = metricsReadCount;

        yield* TestClock.adjust(Duration.seconds(29));
        assert.equal(
          (yield* publisher.latest).pipe(Option.getOrThrow).sequence,
          backgroundSequence,
        );
        assert.equal(metricsReadCount, metricsAfterStopping);
        yield* TestClock.adjust(Duration.seconds(1));
        assert.equal(
          (yield* publisher.latest).pipe(Option.getOrThrow).sequence,
          backgroundSequence + 1,
        );
        assert.equal(metricsReadCount, metricsAfterStopping);
      }).pipe(Effect.provide(layer));
    }),
  );
});
