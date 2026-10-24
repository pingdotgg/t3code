import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
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

function layerElectronApp(
  metrics: ReadonlyArray<Electron.ProcessMetric>,
  onMetricsRead: () => void = () => undefined,
) {
  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
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

const layerPolicyPublisher = DesktopTelemetryPublisher.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerElectronApp([]),
      layerHistory,
      Layer.succeed(ElectronPowerMonitor.ElectronPowerMonitor, {
        isOnBatteryPower: Effect.succeed(false),
        getSystemIdleTime: Effect.succeed(0),
        getSystemIdleState: () => Effect.succeed("active"),
        getCurrentThermalState: Effect.succeed("nominal" as const),
        onSimpleEvent: () => Effect.void,
        onThermalStateChange: () => Effect.void,
        onSpeedLimitChange: () => Effect.void,
      }),
    ),
  ),
);

describe("DesktopTelemetryPublisher", () => {
  it.effect("requires matching policy ACKs from every targeted backend and targets rollback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
        const primaryMessages = yield* Queue.unbounded<Record<string, unknown>>();
        const wslMessages = yield* Queue.unbounded<Record<string, unknown>>();
        for (const [sourceId, messages] of [
          ["primary", primaryMessages],
          ["wsl:Ubuntu", wslMessages],
        ] as const) {
          yield* Stream.runForEach(publisher.encoded(sourceId), (bytes) =>
            Queue.offer(messages, JSON.parse(new TextDecoder().decode(bytes))),
          ).pipe(Effect.forkScoped);
          assert.equal((yield* Queue.take(messages)).type, "desktopTelemetryHello");
        }
        const policy = {
          version: 1,
          type: "desktopUpdateRestartPolicy",
          requestId: "install-1",
          continueRunningThreads: false,
        } as const;
        const preparing = yield* publisher
          .requestUpdateRestartPolicy(["primary", "wsl:Ubuntu"], policy)
          .pipe(Effect.forkScoped);
        for (const messages of [primaryMessages, wslMessages]) {
          const command = yield* Stream.fromQueue(messages).pipe(
            Stream.filter((message) => message.type === policy.type),
            Stream.runHead,
          );
          assert.deepEqual(Option.getOrThrow(command), policy);
        }
        const result = {
          ...policy,
          type: "desktopUpdateRestartPolicyResult",
          accepted: true,
        } as const;
        yield* publisher.handleControlForSource("unrelated", result);
        yield* publisher.handleControlForSource("primary", {
          ...result,
          continueRunningThreads: true,
        });
        assert.isUndefined(preparing.pollUnsafe());
        yield* publisher.handleControlForSource("primary", result);
        assert.isUndefined(preparing.pollUnsafe());
        yield* publisher.handleControlForSource("wsl:Ubuntu", result);
        assert.isTrue(yield* Fiber.join(preparing));
        const rollback = yield* publisher
          .requestUpdateRestartPolicy(["wsl:Ubuntu"], { ...policy, continueRunningThreads: true })
          .pipe(Effect.forkScoped);
        const rollbackMessage = yield* Stream.fromQueue(wslMessages).pipe(
          Stream.filter((message) => message.type === policy.type),
          Stream.runHead,
        );
        assert.equal(Option.getOrThrow(rollbackMessage).continueRunningThreads, true);
        yield* publisher.handleControlForSource("wsl:Ubuntu", {
          ...result,
          continueRunningThreads: true,
        });
        assert.isTrue(yield* Fiber.join(rollback));
        const pendingPrimary = yield* Queue.takeBetween(
          primaryMessages,
          0,
          Number.POSITIVE_INFINITY,
        );
        assert.isFalse(
          Array.from(pendingPrimary).some(
            (message) => message.type === policy.type && message.continueRunningThreads === true,
          ),
        );
        yield* publisher.clearUpdateRestartPolicy(policy.requestId);
      }),
    ).pipe(Effect.provide(layerPolicyPublisher)),
  );

  it.effect.each(["queued", "initial", "cleared initial"] as const)(
    "drops %s restart policies replaced while a source consumer is paused",
    (policyState) =>
      Effect.scoped(
        Effect.gen(function* () {
          const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
          const subscribe = yield* Deferred.make<void>();
          const helloRead = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const observerReady = yield* Deferred.make<void>();
          const observedPolicies = yield* Queue.unbounded<Record<string, unknown>>();
          yield* Stream.runForEach(publisher.encoded("observer"), (bytes) => {
            const message = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
            return message.type === "desktopTelemetryHello"
              ? Deferred.succeed(observerReady, undefined)
              : message.type === "desktopUpdateRestartPolicy"
                ? Queue.offer(observedPolicies, message)
                : Effect.void;
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(observerReady);
          const nextPolicy = yield* publisher.encoded("paused").pipe(
            Stream.map(
              (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>,
            ),
            Stream.tap((message) =>
              message.type === "desktopTelemetryHello"
                ? Deferred.succeed(helloRead, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                  )
                : Effect.void,
            ),
            Stream.filter((message) => message.type === "desktopUpdateRestartPolicy"),
            Stream.runHead,
            (consume) => Deferred.await(subscribe).pipe(Effect.andThen(consume)),
            Effect.forkScoped,
          );
          if (policyState === "queued") {
            yield* Deferred.succeed(subscribe, undefined);
            yield* Deferred.await(helloRead);
          }
          for (const requestId of ["install-A", "install-B"]) {
            const policy = {
              version: 1,
              type: "desktopUpdateRestartPolicy",
              requestId,
              continueRunningThreads: false,
            } as const;
            const preparing = yield* publisher
              .requestUpdateRestartPolicy(["paused", "observer"], policy)
              .pipe(Effect.forkScoped);
            assert.deepEqual(yield* Queue.take(observedPolicies), policy);
            for (const sourceId of ["paused", "observer"]) {
              yield* publisher.handleControlForSource(sourceId, {
                ...policy,
                type: "desktopUpdateRestartPolicyResult",
                accepted: true,
              });
            }
            assert.isTrue(yield* Fiber.join(preparing));
            if (requestId === "install-A" && policyState !== "queued") {
              yield* Deferred.succeed(subscribe, undefined);
              yield* Deferred.await(helloRead);
              if (policyState === "cleared initial")
                yield* publisher.clearUpdateRestartPolicy(requestId);
            }
          }
          yield* Deferred.succeed(resume, undefined);
          assert.equal(Option.getOrThrow(yield* Fiber.join(nextPolicy)).requestId, "install-B");
        }),
      ).pipe(Effect.provide(layerPolicyPublisher)),
  );

  it.effect.each(["refused", "disconnected", "missing"] as const)(
    "refuses an update when a backend policy ACK is %s",
    (failure) =>
      Effect.scoped(
        Effect.gen(function* () {
          const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
          const policy = {
            version: 1,
            type: "desktopUpdateRestartPolicy",
            requestId: "failed-1",
            continueRunningThreads: false,
          } as const;
          const pending = yield* publisher
            .requestUpdateRestartPolicy(["primary", "wsl:Ubuntu"], policy)
            .pipe(Effect.forkScoped);
          const command = yield* publisher.encoded("primary").pipe(
            Stream.map(
              (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>,
            ),
            Stream.filter((message) => message.type === policy.type),
            Stream.runHead,
          );
          assert.deepEqual(Option.getOrThrow(command), policy);
          const result = {
            ...policy,
            type: "desktopUpdateRestartPolicyResult",
            accepted: true,
          } as const;
          yield* publisher.handleControlForSource("primary", result);
          if (failure === "refused")
            yield* publisher.handleControlForSource("wsl:Ubuntu", { ...result, accepted: false });
          else if (failure === "disconnected") yield* publisher.removeControlSource("primary");
          else yield* TestClock.adjust("15 seconds");
          assert.isFalse(yield* Fiber.join(pending));
          yield* publisher.clearUpdateRestartPolicy(policy.requestId);
          const hello = Option.getOrThrow(yield* publisher.encoded("primary").pipe(Stream.runHead));
          assert.deepEqual(JSON.parse(new TextDecoder().decode(hello)), {
            version: 1,
            type: "desktopTelemetryHello",
            electronPid: process.pid,
            supportsUpdateThreadContinuationControl: true,
          });
        }),
      ).pipe(Effect.provide(layerPolicyPublisher)),
  );

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
