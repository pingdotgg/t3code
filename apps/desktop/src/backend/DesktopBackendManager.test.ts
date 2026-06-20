import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const decodeDesktopBackendBootstrap = Schema.decodeEffect(
  Schema.fromJsonString(DesktopBackendBootstrap),
);
const isBackendProcessError = Schema.is(DesktopBackendManager.BackendProcessError);

const baseConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

const configWithObservability: DesktopBackendBootstrapValue = {
  ...baseConfig.bootstrap,
  tailscaleServeEnabled: true,
  otlpTracesUrl: "http://127.0.0.1:4318/v1/traces",
};

function makeProcess(options?: {
  readonly stdout?: Stream.Stream<Uint8Array>;
  readonly stderr?: Stream.Stream<Uint8Array>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly kill?: ChildProcessSpawner.ChildProcessHandle["kill"];
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: options?.stdout ?? Stream.empty,
    stderr: options?.stderr ?? Stream.empty,
    all: Stream.merge(options?.stdout ?? Stream.empty, options?.stderr ?? Stream.empty),
    exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: options?.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function responseForRequest(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(request, new Response(null, { status }));
}

function httpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

const healthyHttpClientLayer = httpClientLayer((request) =>
  Effect.succeed(responseForRequest(request, 200)),
);

function decodeBootstrap(raw: string) {
  return decodeDesktopBackendBootstrap(raw);
}

function makeManagerLayer(input: {
  readonly spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly backendOutputLog?: Partial<DesktopObservability.DesktopBackendOutputLog["Service"]>;
  readonly desktopState?: DesktopState.DesktopState["Service"];
  readonly desktopWindow?: Partial<DesktopWindow.DesktopWindow["Service"]>;
  readonly config?: DesktopBackendManager.DesktopBackendStartConfig;
}) {
  return DesktopBackendManager.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          exists: () => Effect.succeed(true),
        }),
        Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
          resolve: Effect.succeed(input.config ?? baseConfig),
        }),
        input.spawnerLayer,
        input.httpClientLayer ?? healthyHttpClientLayer,
        input.desktopState
          ? Layer.succeed(DesktopState.DesktopState, input.desktopState)
          : DesktopState.layer,
        Layer.succeed(DesktopObservability.DesktopBackendOutputLog, {
          writeSessionBoundary: () => Effect.void,
          writeOutputChunk: () => Effect.void,
          ...input.backendOutputLog,
        } satisfies DesktopObservability.DesktopBackendOutputLog["Service"]),
        Layer.succeed(DesktopWindow.DesktopWindow, {
          createMain: Effect.die("unexpected createMain"),
          ensureMain: Effect.die("unexpected ensureMain"),
          revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
          activate: Effect.void,
          createMainIfBackendReady: Effect.void,
          handleBackendReady: Effect.void,
          dispatchMenuAction: () => Effect.void,
          syncAppearance: Effect.void,
          ...input.desktopWindow,
        } satisfies DesktopWindow.DesktopWindow["Service"]),
      ),
    ),
  );
}

describe("DesktopBackendManager", () => {
  it.effect("spawns the backend with fd3 bootstrap JSON and reports HTTP readiness", () =>
    Effect.gen(function* () {
      let spawnedCommand: ChildProcess.Command | undefined;
      let bootstrapJson = "";
      let readyCount = 0;
      const ready = yield* Deferred.make<void>();
      const exited = yield* Queue.unbounded<void>();

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            spawnedCommand = command;
            if (command._tag === "StandardCommand") {
              const fd3 = command.options.additionalFds?.fd3;
              if (fd3?.type === "input" && fd3.stream) {
                bootstrapJson = yield* fd3.stream.pipe(Stream.decodeText(), Stream.mkString);
              }
            }

            return makeProcess({
              exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        config: {
          ...baseConfig,
          bootstrap: configWithObservability,
        },
        spawnerLayer,
        desktopWindow: {
          handleBackendReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0))),
        },
        backendOutputLog: {
          writeSessionBoundary: ({ phase }) =>
            phase === "END" ? Queue.offer(exited, void 0).pipe(Effect.asVoid) : Effect.void,
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.isDefined(spawnedCommand);
        if (spawnedCommand._tag !== "StandardCommand") {
          throw new Error("Expected backend to spawn a standard command.");
        }

        assert.equal(spawnedCommand.command, "/electron");
        assert.deepEqual(spawnedCommand.args, ["/server/bin.mjs", "--bootstrap-fd", "3"]);
        assert.equal(spawnedCommand.options.cwd, "/server");
        assert.equal(spawnedCommand.options.extendEnv, true);
        assert.equal(spawnedCommand.options.stdout, "pipe");
        assert.equal(spawnedCommand.options.stderr, "pipe");
        assert.equal(spawnedCommand.options.killSignal, "SIGTERM");
        assert.isDefined(spawnedCommand.options.forceKillAfter);
        assert.equal(
          Duration.toMillis(Duration.fromInputUnsafe(spawnedCommand.options.forceKillAfter)),
          2_000,
        );

        assert.deepEqual(yield* decodeBootstrap(bootstrapJson), configWithObservability);
      }).pipe(Effect.provide(managerLayer));
    }),
  );

  it.effect("preserves the readiness timeout cause and process context", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<HttpClientRequest.HttpClientRequest>();
      const layer = Layer.merge(
        TestClock.layer(),
        httpClientLayer((request) =>
          Deferred.succeed(requested, request).pipe(Effect.andThen(Effect.never)),
        ),
      );

      yield* Effect.gen(function* () {
        const readiness = yield* DesktopBackendManager.waitForHttpReady({
          executablePath: baseConfig.executablePath,
          entryPath: baseConfig.entryPath,
          cwd: baseConfig.cwd,
          httpBaseUrl: baseConfig.httpBaseUrl,
          timeout: Duration.millis(50),
        }).pipe(Effect.flip, Effect.forkChild);

        const request = yield* Deferred.await(requested);
        assert.equal(request.url, "http://127.0.0.1:3773/.well-known/t3/environment");

        yield* TestClock.adjust(Duration.millis(50));
        const error = yield* Fiber.join(readiness);

        assert.instanceOf(error, DesktopBackendManager.BackendReadinessTimeoutError);
        assert.equal(error.executablePath, "/electron");
        assert.equal(error.entryPath, "/server/bin.mjs");
        assert.equal(error.cwd, "/server");
        assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
        assert.equal(error.readinessUrl.href, "http://127.0.0.1:3773/.well-known/t3/environment");
        assert.equal(error.timeoutMs, 50);
        assert.isTrue(Cause.isTimeoutError(error.cause));
        assert.equal(
          error.message,
          "Timed out after 50ms waiting for desktop backend readiness at http://127.0.0.1:3773/.well-known/t3/environment.",
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reports bootstrap encoding failures with stable process context", () =>
    Effect.gen(function* () {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
      );
      const error = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        bootstrap: {
          ...baseConfig.bootstrap,
          port: 0,
        },
      }).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
      );

      if (error._tag !== "BackendProcessBootstrapEncodeError") {
        return assert.fail(`Expected bootstrap encode error, received ${error._tag}`);
      }
      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.isDefined(error.cause);
      assert.equal(
        error.message,
        "Failed to encode the desktop backend bootstrap payload for /server/bin.mjs.",
      );
      assert.isTrue(isBackendProcessError(error));
    }),
  );

  it.effect("preserves spawn failures without deriving their message from the cause", () =>
    Effect.gen(function* () {
      const spawnCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcessSpawner",
        method: "spawn",
        pathOrDescriptor: baseConfig.executablePath,
        description: "low-level detail that must not become the public message",
      });
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.fail(spawnCause)),
      );
      const error = yield* DesktopBackendManager.runBackendProcess(baseConfig).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
      );

      if (error._tag !== "BackendProcessSpawnError") {
        return assert.fail(`Expected backend spawn error, received ${error._tag}`);
      }
      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.strictEqual(error.cause, spawnCause);
      assert.equal(
        error.message,
        "Failed to spawn desktop backend entry /server/bin.mjs with /electron.",
      );
      assert.notInclude(error.message, spawnCause.message);
      assert.isTrue(isBackendProcessError(error));
    }),
  );

  it.effect("retries HTTP readiness before reporting the backend ready", () =>
    Effect.gen(function* () {
      const requestUrls: Array<string> = [];
      const statuses = [503, 200];
      let readyCount = 0;
      const firstRequest = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const exited = yield* Queue.unbounded<void>();

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({
              exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            }),
          ),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer((request) =>
          Effect.gen(function* () {
            const status = statuses.shift();
            assert.isDefined(status);
            requestUrls.push(request.url);
            yield* Deferred.succeed(firstRequest, void 0);
            return responseForRequest(request, status);
          }),
        ),
        desktopWindow: {
          handleBackendReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0))),
        },
        backendOutputLog: {
          writeSessionBoundary: ({ phase }) =>
            phase === "END" ? Queue.offer(exited, void 0).pipe(Effect.asVoid) : Effect.void,
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        yield* Deferred.await(firstRequest);

        assert.equal(readyCount, 0);
        assert.deepEqual(requestUrls, ["http://127.0.0.1:3773/.well-known/t3/environment"]);

        yield* TestClock.adjust(Duration.millis(100));
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.deepEqual(requestUrls, [
          "http://127.0.0.1:3773/.well-known/t3/environment",
          "http://127.0.0.1:3773/.well-known/t3/environment",
        ]);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("starts the configured backend and closes the scoped process on stop", () =>
    Effect.gen(function* () {
      let startCount = 0;
      let closedCount = 0;
      const closed = yield* Deferred.make<void>();
      const startedPids = yield* Queue.unbounded<number>();
      const ready = yield* Deferred.make<void>();
      const backendReady = yield* Ref.make(false);
      const quitting = yield* Ref.make(false);

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            startCount += 1;
            yield* Queue.offer(startedPids, 123);
            const close = Effect.sync(() => {
              closedCount += 1;
            }).pipe(Effect.andThen(Deferred.succeed(closed, void 0)), Effect.asVoid);

            yield* Scope.addFinalizer(scope, close);

            return makeProcess({
              exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              kill: () => close,
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        desktopState: {
          backendReady,
          quitting,
        },
        desktopWindow: {
          handleBackendReady: Deferred.succeed(ready, void 0).pipe(Effect.asVoid),
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        assert.isTrue(Option.isNone(yield* manager.currentConfig));

        yield* manager.start;
        assert.equal(yield* Queue.take(startedPids), 123);
        yield* Deferred.await(ready);
        assert.isTrue(yield* Ref.get(backendReady));
        assert.deepEqual(yield* manager.currentConfig, Option.some(baseConfig));

        const runningSnapshot = yield* manager.snapshot;
        assert.equal(runningSnapshot.ready, true);
        assert.deepEqual(runningSnapshot.activePid, Option.some(123));

        yield* manager.stop();
        assert.equal(startCount, 1);
        assert.equal(closedCount, 1);

        const stoppedSnapshot = yield* manager.snapshot;
        assert.isFalse(yield* Ref.get(backendReady));
        assert.equal(stoppedSnapshot.desiredRunning, false);
        assert.equal(stoppedSnapshot.ready, false);
        assert.equal(Option.isNone(stoppedSnapshot.activePid), true);
      }).pipe(Effect.provide(managerLayer));
    }),
  );

  it.effect("restarts an unexpectedly exited backend with the Effect clock", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      let startCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            startCount += 1;
            return makeProcess({
              exitCode: Queue.offer(starts, startCount).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(1)),
              ),
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer(() => Effect.never),
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;

        assert.equal(yield* Queue.take(starts), 1);

        yield* TestClock.adjust(Duration.millis(499));
        assert.equal(yield* Queue.size(starts), 0);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(starts), 2);

        yield* TestClock.adjust(Duration.millis(999));
        assert.equal(yield* Queue.size(starts), 0);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(starts), 3);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("cancels a scheduled restart when start is requested manually", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      const secondClosed = yield* Deferred.make<void>();
      let startCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            startCount += 1;
            yield* Queue.offer(starts, startCount);

            if (startCount === 1) {
              return makeProcess({
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              });
            }

            const scope = yield* Scope.Scope;
            const close = Deferred.succeed(secondClosed, void 0).pipe(Effect.asVoid);
            yield* Scope.addFinalizer(scope, close);
            return makeProcess({
              exitCode: Deferred.await(secondClosed).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
              kill: () => close,
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer(() => Effect.never),
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;

        assert.equal(yield* Queue.take(starts), 1);

        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 2);

        yield* manager.stop();
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.size(starts), 0);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("does not restart after stop cancels a scheduled restart", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      let startCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            startCount += 1;
            return makeProcess({
              exitCode: Queue.offer(starts, startCount).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(1)),
              ),
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        httpClientLayer: httpClientLayer(() => Effect.never),
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 1);

        let restartScheduled = false;
        while (!restartScheduled) {
          restartScheduled = (yield* manager.snapshot).restartScheduled;
          if (!restartScheduled) {
            yield* Effect.yieldNow;
          }
        }

        yield* manager.stop();
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.size(starts), 0);
        assert.equal((yield* manager.snapshot).desiredRunning, false);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );
});
