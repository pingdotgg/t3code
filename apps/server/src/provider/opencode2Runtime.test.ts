import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  escalateOpenCode2ServerTermination,
  isOpenCode2RuntimeError,
  OpenCode2Runtime,
  layer,
  openCode2AuthorizationHeader,
  parseOpenCode2Startup,
  runOpenCode2Sdk,
} from "./opencode2Runtime.ts";
import { SpawnedProcessReaper } from "./SpawnedProcessReaper.ts";

describe("parseOpenCode2Startup", () => {
  // Exact banner emitted by @opencode-ai/cli 0.0.0-next-16339, captured by
  // live-scenarios/tests/opencode2-drive-probe.mjs.
  const banner = [
    "server listening on http://127.0.0.1:4711",
    "server password Yb4ypFttKtPUvcKlnzQ4iOEUezhRpP4A",
    "",
  ].join("\n");

  it("reads both facts out of the real banner", () => {
    assert.deepStrictEqual(parseOpenCode2Startup(banner), {
      url: "http://127.0.0.1:4711",
      password: "Yb4ypFttKtPUvcKlnzQ4iOEUezhRpP4A",
    });
  });

  it("withholds a result until the password line has also arrived", () => {
    // The two lines land in whatever chunks the pipe produces. Resolving on the
    // URL alone would build a client with no credentials, and 2.x answers every
    // unauthenticated request with 401 rather than an obvious startup failure.
    assert.isNull(parseOpenCode2Startup("server listening on http://127.0.0.1:4711\n"));
    assert.isNotNull(parseOpenCode2Startup(banner));
  });

  it("withholds a result until the url line has also arrived", () => {
    assert.isNull(parseOpenCode2Startup("server password abc123\n"));
  });

  it("does not match the 1.x banner", () => {
    // 1.x prints `opencode server listening on ...` and never prints a
    // password, so it must not satisfy the 2.x contract.
    assert.isNull(
      parseOpenCode2Startup(
        [
          "Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.",
          "opencode server listening on http://127.0.0.1:4607",
          "",
        ].join("\n"),
      ),
    );
  });

  it("tolerates surrounding log noise", () => {
    const noisy = [
      "[00:00:00.000] INFO (#1): starting",
      "server listening on http://127.0.0.1:9999",
      "some unrelated line",
      "server password s3cr3t-token_ABC",
    ].join("\n");
    assert.deepStrictEqual(parseOpenCode2Startup(noisy), {
      url: "http://127.0.0.1:9999",
      password: "s3cr3t-token_ABC",
    });
  });
});

describe("openCode2AuthorizationHeader", () => {
  it("encodes the fixed opencode username with the minted password", () => {
    assert.strictEqual(
      openCode2AuthorizationHeader("s3cr3t"),
      `Basic ${Buffer.from("opencode:s3cr3t", "utf8").toString("base64")}`,
    );
  });
});

describe("escalateOpenCode2ServerTermination", () => {
  it.effect("sends TERM, waits for the grace period, then sends KILL", () =>
    Effect.gen(function* () {
      const signals: Array<NodeJS.Signals> = [];
      const exit = yield* Deferred.make<void>();
      const termination = yield* escalateOpenCode2ServerTermination(
        (signal) =>
          Effect.sync(() => {
            signals.push(signal);
          }),
        Deferred.await(exit),
        Effect.succeed(true),
      ).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.deepStrictEqual(signals, ["SIGTERM"]);

      yield* TestClock.adjust("499 millis");
      assert.deepStrictEqual(signals, ["SIGTERM"]);

      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(termination);
      assert.deepStrictEqual(signals, ["SIGTERM", "SIGKILL"]);
    }),
  );

  it.effect("returns immediately when the direct child exits and the group is gone", () =>
    Effect.gen(function* () {
      const signals: Array<NodeJS.Signals> = [];
      const exit = yield* Deferred.make<void>();
      const termination = yield* escalateOpenCode2ServerTermination(
        (signal) =>
          Effect.sync(() => {
            signals.push(signal);
          }),
        Deferred.await(exit),
        Effect.succeed(false),
      ).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.deepStrictEqual(signals, ["SIGTERM"]);

      yield* Deferred.succeed(exit, undefined);
      yield* Fiber.join(termination);
      assert.deepStrictEqual(signals, ["SIGTERM"]);
    }),
  );

  it.effect("kills surviving descendants after the direct child exits", () =>
    Effect.gen(function* () {
      const signals: Array<NodeJS.Signals> = [];
      const exit = yield* Deferred.make<void>();
      const termination = yield* escalateOpenCode2ServerTermination(
        (signal) =>
          Effect.sync(() => {
            signals.push(signal);
          }),
        Deferred.await(exit),
        Effect.succeed(true),
      ).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* Deferred.succeed(exit, undefined);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(signals, ["SIGTERM"]);

      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(termination);
      assert.deepStrictEqual(signals, ["SIGTERM", "SIGKILL"]);
    }),
  );
});

describe("OpenCode2Runtime errors", () => {
  it.effect("keeps SDK cause text out of the stable model-ready error", () =>
    Effect.gen(function* () {
      const secret = "MODEL_STARTUP_SECRET";
      const cause = new Error(`Model unavailable: ${secret}`);
      const error = yield* runOpenCode2Sdk("session.generate", async () => {
        throw cause;
      }).pipe(Effect.flip);

      assert.isTrue(isOpenCode2RuntimeError(error));
      assert.strictEqual(error.category, "model-unavailable");
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, secret);
    }),
  );

  it.effect("normalizes authentication and network failures at the SDK boundary", () =>
    Effect.gen(function* () {
      const authentication = yield* runOpenCode2Sdk("health.get", async () => {
        throw new Error("401 Unauthorized: PRIVATE_RESPONSE");
      }).pipe(Effect.flip);
      const network = yield* runOpenCode2Sdk("health.get", async () => {
        throw new Error("fetch failed: ECONNREFUSED PRIVATE_ADDRESS");
      }).pipe(Effect.flip);

      assert.strictEqual(authentication.category, "authentication-failed");
      assert.strictEqual(network.category, "network-failed");
      assert.notInclude(authentication.message, "PRIVATE_RESPONSE");
      assert.notInclude(network.message, "PRIVATE_ADDRESS");
    }),
  );

  it.effect("does not classify an SDK 404 as a missing executable", () =>
    Effect.gen(function* () {
      const error = yield* runOpenCode2Sdk("health.get", async () => {
        throw new Error("NotFoundError: endpoint returned 404");
      }).pipe(Effect.flip);

      assert.strictEqual(error.category, "sdk-request-failed");
    }),
  );
});

describe("OpenCode2Runtime startup cleanup", () => {
  it.effect("registers process cleanup before reaper tracking can block", () =>
    Effect.gen(function* () {
      const signals: Array<NodeJS.Signals> = [];
      const trackStarted = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(42),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: (options) =>
              Effect.sync(() => {
                if (options?.killSignal !== undefined) signals.push(options.killSignal);
              }),
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.never,
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          }),
        ),
      );
      const startup = Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCode2Runtime;
          yield* runtime.startOpenCode2ServerProcess({ binaryPath: "opencode2", port: 4_711 });
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(SpawnedProcessReaper, {
          track: () => Deferred.succeed(trackStarted, undefined).pipe(Effect.andThen(Effect.never)),
          untrack: () => Effect.void,
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcessPlatform, "win32"),
      );
      const startupFiber = yield* startup.pipe(Effect.forkChild);

      yield* Deferred.await(trackStarted);
      yield* Fiber.interrupt(startupFiber);

      assert.deepStrictEqual(signals, ["SIGTERM"]);
    }),
  );

  it.effect("keeps draining stdout after startup settles", () =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array>();
      const encoder = new TextEncoder();
      const banner = [
        "server listening on http://127.0.0.1:4711",
        "server password drained-password",
        "",
      ].join("\n");
      yield* Queue.offer(output, encoder.encode(banner));
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(42),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.fromQueue(output),
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          }),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCode2Runtime;
          yield* runtime.startOpenCode2ServerProcess({
            binaryPath: "opencode2",
            port: 4_711,
          });
          yield* Queue.offer(output, encoder.encode("post-ready diagnostic\n"));
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Queue.size(output), 0);
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(SpawnedProcessReaper, {
          track: () => Effect.void,
          untrack: () => Effect.void,
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcessPlatform, "win32"),
      );
    }),
  );

  it.effect("retains startup credentials across more than the diagnostic buffer", () =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array>();
      const encoder = new TextEncoder();
      yield* Queue.offer(
        output,
        encoder.encode(`server listening on http://127.0.0.1:4711\n${"x".repeat(17_000)}\n`),
      );
      yield* Queue.offer(output, encoder.encode("server password retained-password\n"));
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(42),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.fromQueue(output),
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          }),
        ),
      );

      const credentials = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCode2Runtime;
          return yield* runtime.startOpenCode2ServerProcess({
            binaryPath: "opencode2",
            port: 4_711,
          });
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(SpawnedProcessReaper, {
          track: () => Effect.void,
          untrack: () => Effect.void,
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcessPlatform, "win32"),
      );

      assert.strictEqual(credentials.url, "http://127.0.0.1:4711");
      assert.strictEqual(credentials.password, "retained-password");
    }),
  );

  it.effect("rejects a ready banner from a process that already exited", () =>
    Effect.gen(function* () {
      const banner = [
        "server listening on http://127.0.0.1:4711",
        "server password expired-password",
        "",
      ].join("\n");
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(42),
            exitCode: Effect.never,
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(banner)),
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          }),
        ),
      );

      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCode2Runtime;
          return yield* runtime
            .startOpenCode2ServerProcess({ binaryPath: "opencode2", port: 4_711 })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(SpawnedProcessReaper, {
          track: () => Effect.void,
          untrack: () => Effect.void,
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcessPlatform, "win32"),
      );

      assert.strictEqual(error.category, "startup-exited");
      assert.notInclude(error.message, "expired-password");
    }),
  );

  it.effect("does not expose a startup password when the server exits before ready", () =>
    Effect.gen(function* () {
      const password = "MINTED_STARTUP_PASSWORD";
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(42),
            exitCode: Deferred.await(exit),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(`server password ${password}\n`)),
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          }),
        ),
      );
      const startup = Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCode2Runtime;
          return yield* runtime
            .startOpenCode2ServerProcess({
              binaryPath: "opencode2",
              port: 4_711,
            })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(SpawnedProcessReaper, {
          track: () => Effect.void,
          untrack: () => Effect.void,
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcessPlatform, "win32"),
      );
      const startupFiber = yield* startup.pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(1));
      const error = yield* Fiber.join(startupFiber);

      assert.isTrue(isOpenCode2RuntimeError(error));
      assert.strictEqual(error.category, "startup-exited");
      assert.strictEqual(error.exitCode, 1);
      assert.isUndefined(error.cause);
      assert.notInclude(error.message, password);
    }),
  );

  it.effect("recognizes the package placeholder without retaining its output", () =>
    Effect.gen(function* () {
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const output = yield* Deferred.make<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(42),
            exitCode: Deferred.await(exit),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.fromEffect(Deferred.await(output)),
            stderr: Stream.empty,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          }),
        ),
      );
      const startup = Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCode2Runtime;
          return yield* runtime
            .startOpenCode2ServerProcess({ binaryPath: "opencode2", port: 4_711 })
            .pipe(Effect.flip);
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(SpawnedProcessReaper, {
          track: () => Effect.void,
          untrack: () => Effect.void,
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcessPlatform, "win32"),
      );
      const startupFiber = yield* startup.pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(1));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(
        output,
        new TextEncoder().encode("Error: @opencode-ai/cli's postinstall script was not run.\n"),
      );
      const error = yield* Fiber.join(startupFiber);

      assert.isTrue(isOpenCode2RuntimeError(error));
      assert.strictEqual(error.category, "placeholder-binary");
      assert.notInclude(error.message, "postinstall script was not run");
    }),
  );

  it.effect("reaps a spawned server whose startup banner times out", () =>
    Effect.gen(function* () {
      const signals: Array<NodeJS.Signals> = [];
      const killOptions: Array<unknown> = [];
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(42),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: (options) =>
              Effect.sync(() => {
                killOptions.push(options);
                if (options?.killSignal !== undefined) {
                  signals.push(options.killSignal);
                }
              }),
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.never,
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          }),
        ),
      );
      const startup = Effect.gen(function* () {
        const runtime = yield* OpenCode2Runtime;
        const runtimeScope = yield* Scope.make();
        const startupFiber = yield* runtime
          .startOpenCode2ServerProcess({
            binaryPath: "opencode2",
            port: 4_711,
            timeoutMs: 100,
          })
          .pipe(Effect.provideService(Scope.Scope, runtimeScope), Effect.flip, Effect.forkChild);

        yield* Effect.yieldNow;
        yield* TestClock.adjust("100 millis");
        const error = yield* Fiber.join(startupFiber);
        assert.strictEqual(error.category, "startup-timeout");
        assert.deepStrictEqual(signals, ["SIGTERM"]);

        yield* Scope.close(runtimeScope, Exit.void);
        assert.deepStrictEqual(signals, ["SIGTERM"]);
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(SpawnedProcessReaper, {
          track: () => Effect.void,
          untrack: () => Effect.void,
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcessPlatform, "win32"),
      );
      yield* startup;
      assert.deepStrictEqual(signals, ["SIGTERM"]);
      assert.deepStrictEqual(killOptions, [
        { killSignal: "SIGTERM", forceKillAfter: "500 millis" },
      ]);
    }),
  );
});
