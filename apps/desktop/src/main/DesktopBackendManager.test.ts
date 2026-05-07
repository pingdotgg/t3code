import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Schema,
  Sink,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendEvents from "./DesktopBackendEvents.ts";

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
  return Schema.decodeEffect(Schema.fromJsonString(DesktopBackendBootstrap))(raw);
}

function makeManagerLayer(input: {
  readonly spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly events?: Partial<DesktopBackendEvents.DesktopBackendEventsShape>;
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
        Layer.succeed(DesktopBackendEvents.DesktopBackendEvents, {
          onStarting: Effect.void,
          onStarted: () => Effect.void,
          onReady: Effect.void,
          onReadinessFailure: () => Effect.void,
          onOutput: () => Effect.void,
          onExit: () => Effect.void,
          onRestartScheduled: () => Effect.void,
          ...input.events,
        } satisfies DesktopBackendEvents.DesktopBackendEventsShape),
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
        events: {
          onReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0))),
          onExit: () => Queue.offer(exited, void 0).pipe(Effect.asVoid),
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.isDefined(spawnedCommand);
        if (spawnedCommand?._tag === "StandardCommand") {
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
        }
        assert.deepEqual(yield* decodeBootstrap(bootstrapJson), configWithObservability);
      }).pipe(Effect.provide(managerLayer));
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
        events: {
          onReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0))),
          onExit: () => Queue.offer(exited, void 0).pipe(Effect.asVoid),
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        yield* Deferred.await(firstRequest);

        assert.equal(readyCount, 0);
        assert.deepEqual(requestUrls, ["http://127.0.0.1:3773/"]);

        yield* TestClock.adjust(Duration.millis(100));
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.deepEqual(requestUrls, ["http://127.0.0.1:3773/", "http://127.0.0.1:3773/"]);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("inherits child output when captureOutput is false", () =>
    Effect.gen(function* () {
      let spawnedCommand: ChildProcess.Command | undefined;
      const ready = yield* Deferred.make<void>();
      const exited = yield* Queue.unbounded<void>();

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            spawnedCommand = command;
            return makeProcess({
              exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        config: {
          ...baseConfig,
          captureOutput: false,
        },
        spawnerLayer,
        events: {
          onReady: Deferred.succeed(ready, void 0).pipe(Effect.asVoid),
          onExit: () => Queue.offer(exited, void 0).pipe(Effect.asVoid),
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;
        yield* Queue.take(exited);

        assert.isDefined(spawnedCommand);
        if (spawnedCommand?._tag === "StandardCommand") {
          assert.equal(spawnedCommand.options.stdout, "inherit");
          assert.equal(spawnedCommand.options.stderr, "inherit");
        }
      }).pipe(Effect.provide(managerLayer));
    }),
  );

  it.effect("starts the configured backend and closes the scoped process on stop", () =>
    Effect.gen(function* () {
      let startCount = 0;
      let closedCount = 0;
      const closed = yield* Deferred.make<void>();
      const startedPids = yield* Queue.unbounded<number>();
      const ready = yield* Deferred.make<void>();

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            startCount += 1;
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
        events: {
          onStarted: ({ pid }) => Queue.offer(startedPids, pid).pipe(Effect.asVoid),
          onReady: Deferred.succeed(ready, void 0).pipe(Effect.asVoid),
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        assert.isTrue(Option.isNone(yield* manager.currentConfig));

        yield* manager.start;
        assert.equal(yield* Queue.take(startedPids), 123);
        yield* Deferred.await(ready);
        assert.deepEqual(yield* manager.currentConfig, Option.some(baseConfig));

        const runningSnapshot = yield* manager.snapshot;
        assert.equal(runningSnapshot.ready, true);
        assert.deepEqual(runningSnapshot.activePid, Option.some(123));

        yield* manager.stop();
        assert.equal(startCount, 1);
        assert.equal(closedCount, 1);

        const stoppedSnapshot = yield* manager.snapshot;
        assert.equal(stoppedSnapshot.desiredRunning, false);
        assert.equal(stoppedSnapshot.ready, false);
        assert.equal(Option.isNone(stoppedSnapshot.activePid), true);
      }).pipe(Effect.provide(managerLayer));
    }),
  );

  it.effect("restarts an unexpectedly exited backend with the Effect clock", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      const restartDelays = yield* Queue.unbounded<number>();
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
        events: {
          onRestartScheduled: ({ delay }) =>
            Queue.offer(restartDelays, Duration.toMillis(delay)).pipe(Effect.asVoid),
        },
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager.DesktopBackendManager;
        yield* manager.start;

        assert.equal(yield* Queue.take(starts), 1);
        assert.equal(yield* Queue.take(restartDelays), 500);

        yield* TestClock.adjust(Duration.millis(500));
        assert.equal(yield* Queue.take(starts), 2);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );
});
