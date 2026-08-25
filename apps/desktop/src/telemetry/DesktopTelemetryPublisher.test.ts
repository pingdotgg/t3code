import { DesktopHostTelemetryMessage } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
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
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.sync(() => {
      onMetricsRead();
      return metrics;
    }),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);
}

describe("DesktopTelemetryPublisher", () => {
  it.effect("stops when its scope closes during an Electron telemetry sample", () =>
    Effect.gen(function* () {
      const pollStarted = yield* Deferred.make<void>();
      const blockPoll = yield* Deferred.make<void>();
      const powerLayer = Layer.succeed(
        ElectronPowerMonitor.ElectronPowerMonitor,
        ElectronPowerMonitor.ElectronPowerMonitor.of({
          isOnBatteryPower: Effect.succeed(false),
          getSystemIdleTime: Deferred.succeed(pollStarted, undefined).pipe(
            Effect.andThen(Deferred.await(blockPoll)),
            Effect.as(0),
          ),
          getSystemIdleState: () => Effect.succeed("active"),
          getCurrentThermalState: Effect.succeed("nominal"),
          onSimpleEvent: () => Effect.void,
          onThermalStateChange: () => Effect.void,
          onSpeedLimitChange: () => Effect.void,
        }),
      );
      const layer = DesktopTelemetryPublisher.layer.pipe(
        Layer.provide(Layer.mergeAll(makeElectronAppLayer([]), powerLayer)),
      );
      const scope = yield* Scope.make();

      yield* Layer.buildWithScope(layer, scope);
      yield* Deferred.await(pollStarted);

      const closeFiber = yield* Scope.close(scope, Exit.void).pipe(Effect.forkDetach);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.isDefined(closeFiber.pollUnsafe());
    }),
  );

  it.effect("publishes Electron metrics and event-driven power state over NDJSON", () =>
    Effect.gen(function* () {
      const onBattery = yield* Ref.make(false);
      const systemIdleState = yield* Ref.make<ElectronPowerMonitor.ElectronIdleState>("active");
      let beforeSystemIdleState: Effect.Effect<void> = Effect.void;
      let metricsReadCount = 0;
      const simpleListeners = new Map<string, () => void>();
      let thermalListener: ((state: ElectronPowerMonitor.ElectronThermalState) => void) | null =
        null;
      let speedLimitListener: ((limit: number) => void) | null = null;
      const metrics = [
        {
          pid: 4_242,
          type: "Browser",
          creationTime: 1_000.75,
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
          getSystemIdleState: () =>
            beforeSystemIdleState.pipe(Effect.andThen(Ref.get(systemIdleState))),
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
        const decodeMessage = Schema.decodeUnknownEffect(
          Schema.fromJsonString(DesktopHostTelemetryMessage),
        );
        const messages = yield* Effect.forEach(encoded, (bytes) =>
          decodeMessage(decoder.decode(bytes).trim()),
        );

        assert.equal(messages[0]?.type, "desktopTelemetryHello");
        assert.equal(messages[0]?.electronPid, process.pid);
        const initialSnapshot = messages[1];
        if (initialSnapshot?.type !== "desktopTelemetry") {
          return assert.fail("Expected the second telemetry message to be a snapshot.");
        }
        assert.deepEqual(initialSnapshot.electronProcesses, []);
        assert.equal(initialSnapshot.electronPid, process.pid);
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
        assert.equal(demandedSnapshot.electronProcesses[0]?.creationTimeMs, 1_001);
        assert.equal(demandedSnapshot.electronProcesses[0]?.cpuPercent, 12.5);
        assert.equal(demandedSnapshot.electronProcesses[0]?.workingSetBytes, 2_048 * 1_024);
        assert.equal(metricsReadCount, 1);
        yield* publisher.handleControlForSource("secondary-backend", {
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: true,
        });
        yield* publisher.handleControl({
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: false,
        });
        yield* publisher.handleControlForSource("old-backend", {
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: true,
        });
        yield* publisher.handleControlForSource("secondary-backend", {
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: false,
        });
        yield* Effect.all(
          [
            publisher.removeControlSource("old-backend"),
            publisher.handleControlForSource("replacement-backend", {
              version: 1,
              type: "setDiagnosticsDemand",
              enabled: true,
            }),
          ],
          { concurrency: "unbounded", discard: true },
        );

        const batterySnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        simpleListeners.get("on-battery")?.();
        const batterySnapshot = Option.getOrThrow(yield* Fiber.join(batterySnapshotFiber));
        assert.equal(batterySnapshot.power.onBattery, "true");
        yield* Ref.set(onBattery, true);

        const metricsAfterBatteryEvent = metricsReadCount;
        yield* TestClock.adjust(Duration.millis(4_999));
        assert.equal(metricsReadCount, metricsAfterBatteryEvent);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(metricsReadCount, metricsAfterBatteryEvent + 1);
        assert.equal((yield* publisher.latest).pipe(Option.getOrThrow).power.onBattery, "true");

        yield* Ref.set(onBattery, false);
        const metricsBeforePolledAc = metricsReadCount;
        yield* TestClock.adjust(Duration.seconds(5));
        assert.equal(metricsReadCount, metricsBeforePolledAc + 1);
        assert.equal((yield* publisher.latest).pipe(Option.getOrThrow).power.onBattery, "false");
        yield* TestClock.adjust(Duration.seconds(1));
        assert.equal(metricsReadCount, metricsBeforePolledAc + 2);

        const suspendedSnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        simpleListeners.get("suspend")?.();
        const suspendedSnapshot = Option.getOrThrow(yield* Fiber.join(suspendedSnapshotFiber));
        assert.isTrue(suspendedSnapshot.power.suspended);

        const constrainedSnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        thermalListener?.("serious");
        const constrainedSnapshot = Option.getOrThrow(yield* Fiber.join(constrainedSnapshotFiber));
        assert.equal(constrainedSnapshot.power.thermalState, "serious");
        assert.isTrue(constrainedSnapshot.power.suspended);

        const metricsAfterThermalEvent = metricsReadCount;
        const recoveredSnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust(Duration.millis(14_999));
        assert.equal(metricsReadCount, metricsAfterThermalEvent);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(metricsReadCount, metricsAfterThermalEvent + 1);
        const recoveredSnapshot = Option.getOrThrow(yield* Fiber.join(recoveredSnapshotFiber));
        assert.isFalse(recoveredSnapshot.power.suspended);

        const speedLimitSnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        speedLimitListener?.(65);
        const speedLimitSnapshot = Option.getOrThrow(yield* Fiber.join(speedLimitSnapshotFiber));
        assert.equal(Option.getOrNull(speedLimitSnapshot.speedLimitPercent), 65);

        const encodedSpeedLimit = yield* publisher.encoded.pipe(Stream.take(2), Stream.runCollect);
        const decodedSpeedLimit = yield* decodeMessage(decoder.decode(encodedSpeedLimit[1]).trim());
        if (decodedSpeedLimit.type !== "desktopTelemetry") {
          return assert.fail("Expected the encoded telemetry message to be a snapshot.");
        }
        assert.equal(Option.getOrNull(decodedSpeedLimit.speedLimitPercent), 65);
        assert.equal(decodedSpeedLimit.electronProcesses[0]?.pid, 4_242);
        assert.equal(decodedSpeedLimit.electronProcesses[0]?.creationTimeMs, 1_001);

        const metricsBeforeSecondaryOnlySample = metricsReadCount;
        yield* TestClock.adjust(Duration.seconds(15));
        assert.equal(metricsReadCount, metricsBeforeSecondaryOnlySample + 1);
        assert.equal(
          (yield* publisher.latest).pipe(Option.getOrThrow).electronProcesses[0]?.pid,
          4_242,
        );

        const stoppedSnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* publisher.handleControlForSource("replacement-backend", {
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: false,
        });
        const stoppedSnapshot = Option.getOrThrow(yield* Fiber.join(stoppedSnapshotFiber));
        assert.deepEqual(stoppedSnapshot.electronProcesses, []);
        const metricsAfterStopping = metricsReadCount;
        const configuredSnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* publisher.handleControl({
          version: 1,
          type: "setHostPowerIntervals",
          activeIntervalMs: 7_000,
          idleIntervalMs: 11_000,
        });
        const configuredSequence = Option.getOrThrow(
          yield* Fiber.join(configuredSnapshotFiber),
        ).sequence;

        yield* TestClock.adjust(Duration.millis(6_999));
        assert.equal(
          (yield* publisher.latest).pipe(Option.getOrThrow).sequence,
          configuredSequence,
        );
        assert.equal(metricsReadCount, metricsAfterStopping);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(
          (yield* publisher.latest).pipe(Option.getOrThrow).sequence,
          configuredSequence + 1,
        );
        assert.equal(metricsReadCount, metricsAfterStopping);

        yield* Ref.set(systemIdleState, "locked");
        yield* TestClock.adjust(Duration.seconds(7));
        const lockedSequence = (yield* publisher.latest).pipe(Option.getOrThrow).sequence;
        assert.equal((yield* publisher.latest).pipe(Option.getOrThrow).power.locked, "true");
        yield* TestClock.adjust(Duration.millis(10_999));
        assert.equal((yield* publisher.latest).pipe(Option.getOrThrow).sequence, lockedSequence);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(
          (yield* publisher.latest).pipe(Option.getOrThrow).sequence,
          lockedSequence + 1,
        );

        yield* Ref.set(systemIdleState, "active");
        yield* TestClock.adjust(Duration.seconds(11));
        const unlockedSnapshot = (yield* publisher.latest).pipe(Option.getOrThrow);
        assert.equal(unlockedSnapshot.power.locked, "false");
        assert.equal(unlockedSnapshot.power.idle, "false");

        yield* TestClock.adjust(Duration.millis(6_999));
        assert.equal(
          (yield* publisher.latest).pipe(Option.getOrThrow).sequence,
          unlockedSnapshot.sequence,
        );
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(
          (yield* publisher.latest).pipe(Option.getOrThrow).sequence,
          unlockedSnapshot.sequence + 1,
        );

        const pollStarted = yield* Deferred.make<void>();
        const releasePoll = yield* Deferred.make<void>();
        beforeSystemIdleState = Deferred.succeed(pollStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releasePoll)),
        );
        const concurrentEventSnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* publisher.handleControl({
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: true,
        });
        yield* Deferred.await(pollStarted);
        simpleListeners.get("lock-screen")?.();
        thermalListener?.("critical");
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releasePoll, undefined);

        const concurrentEventSnapshot = Option.getOrThrow(
          yield* Fiber.join(concurrentEventSnapshotFiber),
        );
        assert.equal(concurrentEventSnapshot.power.locked, "true");
        assert.equal(concurrentEventSnapshot.power.thermalState, "critical");
      }).pipe(Effect.provide(layer));
    }),
  );
});
