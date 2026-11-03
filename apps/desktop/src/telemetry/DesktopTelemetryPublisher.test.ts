import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";

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

describe("DesktopTelemetryPublisher", () => {
  it.effect(
    "forwards shell discovery while a telemetry sample is pending and stops on scope close",
    () =>
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
          Layer.provide(
            Layer.mergeAll(
              layerElectronApp([]),
              layerPower,
              layerHistory,
              Layer.succeed(DesktopShellEnvironment.DesktopShellEnvironment, {
                installIntoProcess: Effect.succeed(true),
                awaitDiscovery: Effect.succeed(true),
                updates: Stream.make({
                  version: 1,
                  type: "shellEnvironment",
                  discovered: true,
                  platform: "darwin",
                  environment: { PATH: "/discovered/bin" },
                }),
              }),
            ),
          ),
        );
        const scope = yield* Scope.make();

        const context = yield* Layer.buildWithScope(layer, scope);
        const publisher = Context.get(context, DesktopTelemetryPublisher.DesktopTelemetryPublisher);
        const update = yield* publisher.encoded.pipe(
          Stream.filter((bytes) => new TextDecoder().decode(bytes).includes("shellEnvironment")),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(update));
        if (Option.isSome(update))
          assert.include(new TextDecoder().decode(update.value), "/discovered/bin");
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
