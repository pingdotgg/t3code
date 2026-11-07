import { assert, describe, it } from "@effect/vitest";
import { DESKTOP_UPDATE_IN_PROGRESS_TTL_MS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as Sink from "effect/Sink";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import type { DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

function layerPool(
  labelRef: Ref.Ref<string>,
  options: {
    readonly config?: DesktopBackendStartConfig;
    readonly fileSystem?: Partial<FileSystem.FileSystem>;
    readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly httpClient?: HttpClient.HttpClient;
    readonly onReady?: Effect.Effect<void>;
  } = {},
): Layer.Layer<DesktopBackendPool.DesktopBackendPool> {
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/src",
          homeDirectory: "/test-home",
          platform: "linux",
          processArch: "x64",
          appVersion: "1.2.3",
          appPath: "/repo",
          isPackaged: true,
          resourcesPath: "/missing/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(Path.layer, DesktopConfig.layerTest({ T3CODE_HOME: "/test-home" })),
          ),
          Layer.orDie,
        ),
        FileSystem.layerNoop(options.fileSystem ?? {}),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          options.spawner ??
            ChildProcessSpawner.make(() => Effect.die("unexpected child process spawn")),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          options.httpClient ?? HttpClient.make(() => Effect.die("unexpected HTTP request")),
        ),
        Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
          forInstance: () =>
            Effect.succeed({
              beginSession: () => Effect.void,
              writeOutputChunk: () => Effect.void,
              persistFailureSnapshot: () => Effect.void,
              persistFailure: () => Effect.void,
              discardSession: Effect.void,
            } satisfies DesktopObservability.DesktopBackendOutputLogShape),
        } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
        Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
          latest: Effect.succeedNone,
          changes: Stream.empty,
          encoded: Stream.empty,
          handleControlForSource: () => Effect.void,
          removeControlSource: () => Effect.void,
          publishUpdateReport: () => Effect.void,
          updateRequests: Stream.empty,
          updateCommits: Stream.empty,
          updateCancellations: Stream.empty,
        }),
        DesktopBrowserHost.layer,
        Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
          resolvePrimary: options.config
            ? Effect.succeed(options.config)
            : Effect.die("unexpected primary config resolve"),
          resolvePrimaryLabel: Ref.get(labelRef),
          resolveWsl: () => Effect.die("unexpected WSL config resolve"),
          currentBootstrapToken: Effect.die("unexpected bootstrap token read"),
        } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]),
        DesktopAppSettings.layerTest(),
        DesktopState.layer,
        DesktopWslEnvironment.layerTest(),
        ElectronDialog.layer,
        ElectronApp.layer,
        Layer.succeed(DesktopWindow.DesktopWindow, {
          createMain: Effect.die("unexpected window create"),
          ensureMain: Effect.die("unexpected window ensure"),
          revealOrCreateMain: Effect.die("unexpected window reveal"),
          activate: Effect.die("unexpected window activate"),
          createMainIfBackendReady: Effect.die("unexpected window create"),
          showConnectingSplash: Effect.void,
          handleBackendReady: () => options.onReady ?? Effect.void,
          handleBackendNotReady: Effect.void,
          flushMainWindowBounds: Effect.void,
          prepareCaptureReveal: Effect.void,
          dispatchMenuAction: () => Effect.die("unexpected menu action"),
          dispatchSnapShotEvent: () => Effect.void,
          zoomMain: () => Effect.die("unexpected zoom"),
          runMainContentsCommand: () => Effect.die("unexpected main contents command"),
          syncAppearance: Effect.void,
        } satisfies DesktopWindow.DesktopWindow["Service"]),
      ),
    ),
  );
}

const markerPath = "/test-home/runtime/desktop-update-in-progress";
const runtimePath = "/test-home/userdata/server-runtime.json";

const makeUpdateMarkerFixture = (backendMode: "native" | "WSL") =>
  Effect.gen(function* () {
    const probeStarted = yield* Deferred.make<void>();
    const allowReady = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    const runtimeChecked = yield* Deferred.make<void>();
    const markerRemoved = yield* Deferred.make<void>();
    const readyRuns = yield* Queue.unbounded<void>();
    let nextPid = 123;
    const files = new Map([[markerPath, JSON.stringify({ startedAt: 0, expiresAt: 60_000 })]]);
    const removed: string[] = [];
    const config: DesktopBackendStartConfig = {
      executablePath: "/electron",
      args: [],
      entryPath: "/server/bin.mjs",
      cwd: "/server",
      env: {},
      bootstrap: {
        mode: "desktop",
        noBrowser: true,
        port: 3774,
        ...(backendMode === "native" ? { t3Home: "/test-home" } : {}),
        host: "127.0.0.1",
        desktopBootstrapToken: "token",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      bootstrapDelivery: "fd3",
      extendEnv: true,
      httpBaseUrl: new URL("http://127.0.0.1:3774"),
      captureOutput: false,
      preflightFailure: Option.none(),
    };
    const layer = layerPool(Ref.makeUnsafe("Local"), {
      config,
      fileSystem: {
        exists: (path) => Effect.succeed(files.has(path) || path === config.entryPath),
        readFileString: (path) =>
          (path === runtimePath ? Deferred.succeed(runtimeChecked, undefined) : Effect.void).pipe(
            Effect.andThen(Effect.sync(() => files.get(path) ?? "")),
          ),
        remove: (path) =>
          Effect.sync(() => {
            removed.push(path);
            files.delete(path);
          }).pipe(
            Effect.andThen(
              path === markerPath ? Deferred.succeed(markerRemoved, undefined) : Effect.void,
            ),
            Effect.asVoid,
          ),
      },
      spawner: ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const exit = Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(
            Effect.asVoid,
          );
          // Like the real spawner, closing the run's scope ends the process.
          yield* Effect.addFinalizer(() => exit);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(nextPid++),
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Deferred.await(exited),
            isRunning: Effect.succeed(true),
            kill: () => exit,
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          });
        }),
      ),
      httpClient: HttpClient.make((request) =>
        Deferred.succeed(probeStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowReady)),
          Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
        ),
      ),
      onReady: Deferred.succeed(ready, undefined).pipe(
        Effect.andThen(Queue.offer(readyRuns, undefined)),
        Effect.asVoid,
      ),
    });
    const publishRuntime = (pid: number) =>
      files.set(
        runtimePath,
        JSON.stringify({
          version: 1,
          pid,
          port: 3774,
          origin: "http://127.0.0.1:3774",
          startedAt: "2026-10-27T00:00:00.000Z",
        }),
      );
    return {
      layer,
      files,
      removed,
      probeStarted,
      allowReady,
      ready,
      readyRuns,
      runtimeChecked,
      markerRemoved,
      publishRuntime,
    };
  });

describe("DesktopBackendPool", () => {
  it.effect.each(["native", "WSL"] as const)(
    "%s primary retains the update marker through an eight-second boot gap and clears it once ready and published",
    (backendMode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeUpdateMarkerFixture(backendMode);
          yield* Effect.gen(function* () {
            const pool = yield* DesktopBackendPool.DesktopBackendPool;
            const primary = yield* pool.primary;
            yield* primary.start;
            yield* Deferred.await(fixture.probeStarted);
            yield* TestClock.adjust(Duration.seconds(8));
            assert.isTrue(fixture.files.has(markerPath), "starting a replacement is not readiness");
            assert.deepEqual(fixture.removed, []);
            fixture.publishRuntime(123);
            yield* Deferred.succeed(fixture.allowReady, undefined);
            yield* Deferred.await(fixture.ready);
            assert.isTrue(yield* primary.waitForReady(Duration.seconds(1)));
            yield* Deferred.await(fixture.markerRemoved);
            assert.isFalse(
              fixture.files.has(markerPath),
              "readiness must clear the handoff marker",
            );
            assert.deepEqual(fixture.removed, [markerPath]);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect(
    "keeps the update marker after HTTP readiness until the backend publishes its runtime",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeUpdateMarkerFixture("native");
          yield* Effect.gen(function* () {
            const pool = yield* DesktopBackendPool.DesktopBackendPool;
            const primary = yield* pool.primary;
            yield* primary.start;
            yield* Deferred.succeed(fixture.allowReady, undefined);
            yield* Deferred.await(fixture.ready);
            assert.isTrue(
              fixture.files.has(markerPath),
              "a launcher could neither wait nor adopt between readiness and publication",
            );
            yield* Deferred.await(fixture.runtimeChecked);
            yield* TestClock.adjust(Duration.seconds(5));
            assert.isTrue(fixture.files.has(markerPath));
            fixture.publishRuntime(456);
            yield* TestClock.adjust(Duration.seconds(1));
            assert.isTrue(
              fixture.files.has(markerPath),
              "another process's runtime is not the replacement",
            );
            fixture.publishRuntime(123);
            yield* TestClock.adjust(Duration.seconds(1));
            yield* Deferred.await(fixture.markerRemoved);
            assert.deepEqual(fixture.removed, [markerPath]);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("clears the update marker after its lifetime when no runtime is published", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeUpdateMarkerFixture("native");
        yield* Effect.gen(function* () {
          const pool = yield* DesktopBackendPool.DesktopBackendPool;
          const primary = yield* pool.primary;
          yield* primary.start;
          yield* Deferred.succeed(fixture.allowReady, undefined);
          yield* Deferred.await(fixture.ready);
          assert.isTrue(fixture.files.has(markerPath));
          yield* Deferred.await(fixture.runtimeChecked);
          yield* TestClock.adjust(Duration.millis(DESKTOP_UPDATE_IN_PROGRESS_TTL_MS - 1_000));
          assert.isTrue(fixture.files.has(markerPath));
          yield* TestClock.adjust(Duration.seconds(1));
          yield* Deferred.await(fixture.markerRemoved);
          assert.deepEqual(fixture.removed, [markerPath]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("leaves a replacement update marker written while an earlier wait is pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeUpdateMarkerFixture("native");
        yield* Effect.gen(function* () {
          const pool = yield* DesktopBackendPool.DesktopBackendPool;
          const primary = yield* pool.primary;
          yield* primary.start;
          yield* Deferred.succeed(fixture.allowReady, undefined);
          yield* Deferred.await(fixture.ready);
          yield* Deferred.await(fixture.runtimeChecked);
          yield* TestClock.adjust(Duration.millis(DESKTOP_UPDATE_IN_PROGRESS_TTL_MS - 1_000));
          const replacement = JSON.stringify({ startedAt: 59_000, expiresAt: 119_000 });
          fixture.files.set(markerPath, replacement);
          yield* TestClock.adjust(Duration.millis(DESKTOP_UPDATE_IN_PROGRESS_TTL_MS));
          assert.equal(fixture.files.get(markerPath), replacement);
          assert.deepEqual(fixture.removed, []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("a later backend run's readiness supersedes the earlier run's marker wait", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeUpdateMarkerFixture("native");
        yield* Effect.gen(function* () {
          const pool = yield* DesktopBackendPool.DesktopBackendPool;
          const primary = yield* pool.primary;
          yield* primary.start;
          yield* Deferred.succeed(fixture.allowReady, undefined);
          yield* Queue.take(fixture.readyRuns);
          yield* Deferred.await(fixture.runtimeChecked);
          yield* TestClock.adjust(Duration.seconds(30));
          yield* primary.stop();
          yield* primary.start;
          yield* Queue.take(fixture.readyRuns);
          yield* TestClock.adjust(Duration.seconds(31));
          assert.isTrue(
            fixture.files.has(markerPath),
            "the earlier run's wait must not end the later run's handoff",
          );
          assert.deepEqual(fixture.removed, []);
          fixture.publishRuntime(124);
          yield* TestClock.adjust(Duration.millis(100));
          yield* Deferred.await(fixture.markerRemoved);
          assert.deepEqual(fixture.removed, [markerPath]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("unregister stops the registered instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const id = DesktopBackendPool.BackendInstanceId("wsl:Ubuntu");
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        const instance = yield* pool.register({
          id,
          label: Effect.succeed("WSL (Ubuntu)"),
          configResolve: Effect.succeed({
            executablePath: "/electron",
            args: [],
            entryPath: "/server/bin.mjs",
            cwd: "/server",
            env: {},
            bootstrap: {
              mode: "desktop",
              noBrowser: true,
              port: 3774,
              t3Home: "/tmp/t3",
              host: "127.0.0.1",
              desktopBootstrapToken: "token",
              tailscaleServeEnabled: false,
              tailscaleServePort: 443,
            },
            bootstrapDelivery: "fd3",
            extendEnv: true,
            httpBaseUrl: new URL("http://127.0.0.1:3774"),
            captureOutput: false,
            preflightFailure: Option.some({ reason: "WSL starting", fatal: false }),
          } satisfies DesktopBackendStartConfig),
        });
        yield* instance.start;
        assert.equal((yield* instance.snapshot).restartScheduled, true);

        yield* pool.unregister(id);

        const stopped = yield* instance.snapshot;
        assert.equal(stopped.desiredRunning, false);
        assert.equal(stopped.restartScheduled, false);
        assert.equal(Option.isNone(yield* pool.get(id)), true);
      }).pipe(Effect.provide(layerPool(Ref.makeUnsafe("Windows")))),
    ),
  );
});
