import { DesktopHostTelemetryMessage } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type * as Electron from "electron";
import * as NodeEvents from "node:events";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopTelemetryPublisher from "./DesktopTelemetryPublisher.ts";
import * as DesktopRendererHistory from "./DesktopRendererHistory.ts";

const layerHistory = Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
  register: () => Effect.void,
  recordMetrics: () => Effect.void,
  shutdown: Effect.void,
});

const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopHostTelemetryMessage),
);

function layerElectronApp(
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
      const layerPower = Layer.succeed(
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
        Layer.provide(Layer.mergeAll(layerElectronApp([]), layerPower, layerHistory)),
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
      const recordedMetrics: ReadonlyArray<Electron.ProcessMetric>[] = [];
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
      const layerPower = Layer.succeed(
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
            layerElectronApp(metrics, () => {
              metricsReadCount += 1;
            }),
            layerPower,
            Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
              register: () => Effect.void,
              shutdown: Effect.void,
              recordMetrics: (sample) =>
                Effect.sync(() => {
                  recordedMetrics.push(sample);
                }),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
        const encoded = yield* publisher.encoded.pipe(Stream.take(2), Stream.runCollect);
        const decoder = new TextDecoder();
        const messages = yield* Effect.forEach(encoded, (bytes) =>
          decodeMessage(decoder.decode(bytes).trim()),
        );

        const hello = messages[0];
        if (hello?.type !== "desktopTelemetryHello") {
          return assert.fail("Expected the first telemetry message to be the hello.");
        }
        assert.equal(hello.electronPid, process.pid);
        const initialSnapshot = messages[1];
        if (initialSnapshot?.type !== "desktopTelemetry") {
          return assert.fail("Expected the second telemetry message to be a snapshot.");
        }
        assert.deepEqual(initialSnapshot.electronProcesses, []);
        assert.equal(initialSnapshot.electronPid, process.pid);
        assert.equal(metricsReadCount, 1);
        assert.deepEqual(recordedMetrics, [metrics]);

        const nextSnapshotFiber = yield* Stream.runHead(publisher.changes).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* publisher.handleControlForSource("primary-backend", {
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: true,
        });
        const demandedSnapshot = Option.getOrThrow(yield* Fiber.join(nextSnapshotFiber));
        assert.equal(demandedSnapshot.electronProcesses[0]?.pid, 4_242);
        assert.equal(demandedSnapshot.electronProcesses[0]?.creationTimeMs, 1_001);
        assert.equal(demandedSnapshot.electronProcesses[0]?.cpuPercent, 12.5);
        assert.equal(demandedSnapshot.electronProcesses[0]?.workingSetBytes, 2_048 * 1_024);
        assert.equal(metricsReadCount, 2);
        assert.deepEqual(recordedMetrics, [metrics, metrics]);
        yield* publisher.handleControlForSource("secondary-backend", {
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: true,
        });
        yield* publisher.handleControlForSource("primary-backend", {
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
        yield* publisher.handleControlForSource("primary-backend", {
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
        assert.equal(metricsReadCount, metricsAfterStopping + 1);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(
          (yield* publisher.latest).pipe(Option.getOrThrow).sequence,
          configuredSequence + 1,
        );
        assert.equal(metricsReadCount, metricsAfterStopping + 2);

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
        yield* publisher.handleControlForSource("primary-backend", {
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

  it.effect("routes requestDesktopUpdate control messages and replays update reports", () =>
    Effect.gen(function* () {
      const layerPower = Layer.succeed(
        ElectronPowerMonitor.ElectronPowerMonitor,
        ElectronPowerMonitor.ElectronPowerMonitor.of({
          isOnBatteryPower: Effect.succeed(false),
          getSystemIdleTime: Effect.succeed(0),
          getSystemIdleState: () => Effect.succeed("active"),
          getCurrentThermalState: Effect.succeed("nominal"),
          onSimpleEvent: () => Effect.void,
          onThermalStateChange: () => Effect.void,
          onSpeedLimitChange: () => Effect.void,
        }),
      );
      const layer = DesktopTelemetryPublisher.layer.pipe(
        Layer.provide(Layer.mergeAll(layerElectronApp([]), layerPower, layerHistory)),
      );

      yield* Effect.gen(function* () {
        const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;

        yield* publisher.handleControlForSource("wsl:Ubuntu", {
          version: 1,
          type: "cuaDriverRequest",
          requestId: "remote",
          enabled: true,
        });
        yield* publisher.handleControlForSource("primary", {
          version: 1,
          type: "cuaDriverRequest",
          requestId: "local",
          enabled: true,
        });
        const cuaRequest = yield* Stream.runHead(publisher.cuaRequests);
        assert.equal(Option.getOrThrow(cuaRequest).requestId, "local");
        yield* publisher.removeControlSource("wsl:Ubuntu");
        yield* publisher.removeControlSource("primary");
        const detachRequest = Option.getOrThrow(yield* Stream.runHead(publisher.cuaRequests));
        assert.equal(detachRequest.requestId, "desktop-primary-detached");
        assert.equal(detachRequest.enabled, false);

        const primaryAttached = yield* Deferred.make<void>();
        const cuaReportFiber = yield* publisher.encodedForSource("primary").pipe(
          Stream.mapEffect((bytes) => decodeMessage(new TextDecoder().decode(bytes).trim())),
          Stream.tap((message) =>
            message.type === "desktopTelemetryHello"
              ? Deferred.succeed(primaryAttached, undefined)
              : Effect.void,
          ),
          Stream.filter((message) => message.type === "cuaDriverReport"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Deferred.await(primaryAttached);
        const cuaReport = {
          version: 1,
          type: "cuaDriverReport",
          requestId: "local",
          status: "ready",
          mcp: {
            command: "/driver",
            args: ["mcp"],
            environment: [{ name: "SESSION", value: "opaque" }],
          },
        } as const;
        yield* publisher.publishCuaReport(cuaReport);
        assert.deepEqual(Option.getOrThrow(yield* Fiber.join(cuaReportFiber)), cuaReport);

        const requestFiber = yield* Stream.runHead(publisher.updateRequests).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* publisher.handleControlForSource("test", {
          version: 1,
          type: "requestDesktopUpdate",
          requestId: "req-9",
        });
        const received = yield* Fiber.join(requestFiber);
        assert.equal(Option.getOrThrow(received).requestId, "req-9");

        const report = {
          version: 1,
          type: "desktopUpdateStatus",
          outcome: "up-to-date",
          state: {
            enabled: true,
            status: "up-to-date",
            channel: "latest",
            currentVersion: "1.2.3",
            hostArch: "arm64",
            appArch: "arm64",
            runningUnderArm64Translation: false,
            availableVersion: null,
            downloadedVersion: null,
            releaseNotes: [],
            downloadPercent: null,
            checkedAt: null,
            message: null,
            errorContext: null,
            canRetry: false,
            omittedReleaseCount: 0,
          },
        } as const;
        yield* publisher.publishUpdateReport(report);

        // A subscriber that attaches after the publish (the backend spawned
        // by a relaunch) still sees the latest report replayed.
        const decoder = new TextDecoder();
        const replayed = yield* publisher.encoded.pipe(
          Stream.mapEffect((bytes) => decodeMessage(decoder.decode(bytes).trim())),
          Stream.filter((message) => message.type === "desktopUpdateStatus"),
          Stream.runHead,
        );
        const replayedReport = Option.getOrThrow(replayed);
        if (replayedReport.type !== "desktopUpdateStatus") {
          return assert.fail("Expected a desktop update status report.");
        }
        assert.equal(replayedReport.outcome, "up-to-date");
        assert.equal(replayedReport.state.currentVersion, "1.2.3");
        const wslMessages = yield* publisher.encodedForSource("wsl:Ubuntu").pipe(
          Stream.mapEffect((bytes) => decodeMessage(decoder.decode(bytes).trim())),
          Stream.takeUntil((message) => message.type === "desktopUpdateStatus"),
          Stream.runCollect,
        );
        assert.equal(
          wslMessages.some((message) => message.type === "cuaDriverReport"),
          false,
        );
      }).pipe(Effect.provide(layer));
    }),
  );
});

describe("DesktopRendererHistory", () => {
  it.effect(
    "persists surface identity and memory through renderer replacement and destruction",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-renderer-history-",
        });
        let previewPid = 7_002;
        let previewDestroyed = false;
        let urlReads = 0;
        const main = Object.assign(new NodeEvents.EventEmitter(), {
          id: 1,
          getOSProcessId: () => 7_001,
          isDestroyed: () => false,
          getURL: () => {
            urlReads += 1;
            return "https://private.invalid/main?secret=private";
          },
        });
        const preview = Object.assign(new NodeEvents.EventEmitter(), {
          id: 2,
          getOSProcessId: () => previewPid,
          isDestroyed: () => previewDestroyed,
          getURL: () => {
            urlReads += 1;
            return "https://private.invalid/preview?secret=private";
          },
        });
        const metrics = [7_001, 7_002].map(
          (pid) =>
            ({
              pid,
              type: "Tab",
              creationTime: pid * 100,
              memory: { workingSetSize: 2_048, peakWorkingSetSize: 4_096 },
              cpu: { percentCPUUsage: 0, cumulativeCPUUsage: 0, idleWakeupsPerSecond: 0 },
            }) satisfies Electron.ProcessMetric,
        );
        const recordSchema = Schema.fromJsonString(
          Schema.Struct({
            event: Schema.String,
            mainPid: Schema.Number,
            mainSessionStartedAtUnixMs: Schema.Number,
            timestampUnixMs: Schema.Number,
            webContentsId: Schema.Number,
            surface: Schema.String,
            tabId: Schema.optional(Schema.String),
            rendererPid: Schema.NullOr(Schema.Number),
            rendererPidSource: Schema.String,
            rendererCreationTimeMs: Schema.NullOr(Schema.Number),
            memory: Schema.NullOr(
              Schema.Struct({
                kind: Schema.String,
                sampledAtUnixMs: Schema.Number,
                workingSetBytes: Schema.Number,
                peakWorkingSetBytes: Schema.Number,
              }),
            ),
            reason: Schema.optional(Schema.String),
            exitCode: Schema.optional(Schema.Number),
          }),
        );
        const decodeRecord = Schema.decodeUnknownEffect(recordSchema);
        type Record = typeof recordSchema.Type;
        const persisted: Record[] = [];
        let milestone:
          | {
              readonly matches: (record: Record) => boolean;
              readonly written: Deferred.Deferred<Record>;
            }
          | undefined;
        const layerFile = Layer.succeed(FileSystem.FileSystem, {
          ...fileSystem,
          writeFile: (filePath, bytes, options) =>
            fileSystem.writeFile(filePath, bytes, options).pipe(
              Effect.tap(() =>
                decodeRecord(new TextDecoder().decode(bytes).trim()).pipe(
                  Effect.orDie,
                  Effect.flatMap((record) =>
                    Effect.sync(() => {
                      persisted.push(record);
                      if (milestone?.matches(record)) {
                        Deferred.doneUnsafe(milestone.written, Effect.succeed(record));
                      }
                    }),
                  ),
                ),
              ),
            ),
        });
        const layer = DesktopRendererHistory.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                DesktopEnvironment.DesktopEnvironment,
                DesktopEnvironment.DesktopEnvironment.of({
                  logDir: directory,
                } as DesktopEnvironment.DesktopEnvironment["Service"]),
              ),
              layerFile,
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const history = yield* DesktopRendererHistory.DesktopRendererHistory;
          yield* history.register(main as unknown as Electron.WebContents, { surface: "main" });
          yield* history.register(preview as unknown as Electron.WebContents, {
            surface: "preview",
          });
          yield* history.register(preview as unknown as Electron.WebContents, {
            surface: "preview",
            tabId: "preview-tab",
          });
          const sampled = yield* Deferred.make<Record>();
          milestone = {
            matches: (row) => row.event === "sample" && row.webContentsId === 2,
            written: sampled,
          };
          yield* TestClock.adjust(Duration.seconds(30));
          yield* history.recordMetrics(metrics);
          const sample = yield* Deferred.await(sampled);
          assert.equal(sample.rendererPid, 7_002);
          assert.equal(sample.rendererCreationTimeMs, 700_200);
          assert.equal(sample.tabId, "preview-tab");
          assert.equal(sample.mainPid, process.pid);
          assert.equal(sample.memory?.kind, "electron-process-working-set");
          assert.equal(sample.memory?.workingSetBytes, 2_048 * 1_024);
          assert.equal(sample.memory?.peakWorkingSetBytes, 4_096 * 1_024);
          assert.equal(sample.memory?.sampledAtUnixMs, sample.timestampUnixMs);
          assert.isTrue(
            persisted.some(
              (row) =>
                row.event === "created" && row.surface === "main" && row.rendererPid === 7_001,
            ),
          );
          assert.isTrue(
            persisted.some((row) => row.event === "identified" && row.tabId === "preview-tab"),
          );

          const replaced = yield* Deferred.make<Record>();
          milestone = { matches: (row) => row.event === "dom-ready", written: replaced };
          previewPid = 7_003;
          preview.emit("dom-ready");
          const replacement = yield* Deferred.await(replaced);
          assert.equal(replacement.rendererPid, 7_003);
          assert.isNull(replacement.rendererCreationTimeMs);
          assert.isNull(replacement.memory);
          metrics[1] = { ...metrics[1]!, pid: 7_003, creationTime: 700_300 };
          const replacementSampled = yield* Deferred.make<Record>();
          milestone = {
            matches: (row) => row.event === "sample" && row.webContentsId === 2,
            written: replacementSampled,
          };
          yield* TestClock.adjust(Duration.seconds(30));
          yield* history.recordMetrics(metrics);
          assert.equal((yield* Deferred.await(replacementSampled)).rendererCreationTimeMs, 700_300);

          const crashed = yield* Deferred.make<Record>();
          milestone = { matches: (row) => row.event === "render-process-gone", written: crashed };
          previewPid = 0;
          preview.emit("render-process-gone", {}, { reason: "oom", exitCode: -7 });
          const crash = yield* Deferred.await(crashed);
          assert.equal(crash.rendererPid, 7_003);
          assert.equal(crash.rendererPidSource, "last-known");
          assert.equal(crash.reason, "oom");
          assert.equal(crash.exitCode, -7);
          // A restarted renderer can reuse the same numeric PID.
          const restarted = yield* Deferred.make<Record>();
          milestone = { matches: (row) => row.event === "dom-ready", written: restarted };
          previewPid = 7_003;
          preview.emit("dom-ready");
          const restart = yield* Deferred.await(restarted);
          assert.equal(restart.rendererPid, 7_003);
          assert.equal(restart.rendererPidSource, "current");
          assert.isNull(restart.rendererCreationTimeMs);
          assert.isNull(restart.memory);
          const destroyed = yield* Deferred.make<Record>();
          milestone = { matches: (row) => row.event === "destroyed", written: destroyed };
          previewDestroyed = true;
          preview.emit("destroyed");
          const destruction = yield* Deferred.await(destroyed);
          assert.equal(destruction.rendererPid, 7_003);
          assert.isNull(destruction.rendererCreationTimeMs);
          assert.equal(destruction.tabId, "preview-tab");
          assert.equal(preview.eventNames().length, 0);
          const afterDestroy = yield* Deferred.make<Record>();
          milestone = { matches: (row) => row.event === "sample", written: afterDestroy };
          const previousCount = persisted.length;
          yield* TestClock.adjust(Duration.seconds(30));
          yield* history.recordMetrics(metrics);
          assert.equal((yield* Deferred.await(afterDestroy)).webContentsId, 1);
          assert.isFalse(persisted.slice(previousCount).some((row) => row.webContentsId === 2));
          // The app quit handshake drains before the history layer closes.
          for (let index = 0; index < 12; index++) main.emit("dom-ready");
          yield* history.shutdown;
          assert.equal(
            persisted.filter((row) => row.webContentsId === 1 && row.event === "dom-ready").length,
            12,
          );
          const afterShutdown = persisted.length;
          yield* history.register(main as unknown as Electron.WebContents, { surface: "main" });
          yield* history.recordMetrics(metrics);
          assert.equal(persisted.length, afterShutdown);
          assert.equal(main.eventNames().length, 0);
          yield* history.shutdown;
        }).pipe(Effect.provide(layer));

        assert.equal(main.eventNames().length, 0);
        assert.equal(
          persisted.filter((row) => row.webContentsId === 1 && row.event === "dom-ready").length,
          12,
        );
        assert.equal(urlReads, 0);
        const contents = yield* fileSystem.readFileString(`${directory}/renderer-history.ndjson`);
        assert.isFalse(contents.includes("private.invalid"));
        assert.isFalse(contents.includes("secret"));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rotates retained incident history within three 256 kib files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-renderer-rotation-",
      });
      const filePath = `${directory}/renderer-history.ndjson`;
      const maxBytes = 256 * 1_024;
      const encodeSeed = Schema.encodeEffect(
        Schema.fromJsonString(Schema.Struct({ seed: Schema.String })),
      );
      for (const [suffix, seed] of [
        ["", "current"],
        [".1", "previous"],
        [".2", "expired"],
        [".3", "overflow"],
      ] as const) {
        const encodedSeed = yield* encodeSeed({ seed });
        yield* fileSystem.writeFileString(
          `${filePath}${suffix}`,
          `${encodedSeed.padEnd(maxBytes - 1, " ")}\n`,
        );
      }
      const written = yield* Deferred.make<void>();
      const layerFile = Layer.succeed(FileSystem.FileSystem, {
        ...fileSystem,
        writeFile: (target, bytes, options) =>
          fileSystem
            .writeFile(target, bytes, options)
            .pipe(Effect.tap(() => Deferred.succeed(written, undefined))),
      });
      const layer = DesktopRendererHistory.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              DesktopEnvironment.DesktopEnvironment,
              DesktopEnvironment.DesktopEnvironment.of({
                logDir: directory,
              } as DesktopEnvironment.DesktopEnvironment["Service"]),
            ),
            layerFile,
          ),
        ),
      );
      const renderer = Object.assign(new NodeEvents.EventEmitter(), {
        id: 7,
        getOSProcessId: () => 9_001,
        isDestroyed: () => false,
      });
      yield* Effect.gen(function* () {
        const history = yield* DesktopRendererHistory.DesktopRendererHistory;
        yield* history.register(renderer as unknown as Electron.WebContents, {
          surface: "preview",
          tabId: "t".repeat(1_000),
        });
        yield* Deferred.await(written);
      }).pipe(Effect.provide(layer));
      assert.deepEqual((yield* fileSystem.readDirectory(directory)).sort(), [
        "renderer-history.ndjson",
        "renderer-history.ndjson.1",
        "renderer-history.ndjson.2",
      ]);
      let totalBytes = 0;
      for (const suffix of ["", ".1", ".2"]) {
        const size = Number((yield* fileSystem.stat(`${filePath}${suffix}`)).size);
        assert.isAtMost(size, maxBytes);
        totalBytes += size;
      }
      assert.isAtMost(totalBytes, 3 * maxBytes);
      assert.include(yield* fileSystem.readFileString(`${filePath}.1`), '"seed":"current"');
      assert.include(yield* fileSystem.readFileString(`${filePath}.2`), '"seed":"previous"');
      const current = yield* fileSystem.readFileString(filePath);
      assert.include(current, `"tabId":"${"t".repeat(128)}"`);
      assert.notInclude(current, "t".repeat(129));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
