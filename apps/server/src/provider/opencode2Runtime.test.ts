import { ClientError } from "@opencode-ai/client";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  environmentForSharedOpenCode2Server,
  escalateOpenCode2ServerTermination,
  isOpenCode2RuntimeError,
  OpenCode2Runtime,
  layer,
  openCode2AuthorizationHeader,
  openCode2SharedServerKey,
  parseOpenCode2Startup,
  readOpenCode2StatePassword,
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

  it("withholds a result until the password is available", () => {
    assert.isNull(parseOpenCode2Startup("server listening on http://127.0.0.1:4711\n"));
    assert.deepStrictEqual(parseOpenCode2Startup(banner), {
      url: "http://127.0.0.1:4711",
      password: "Yb4ypFttKtPUvcKlnzQ4iOEUezhRpP4A",
    });
  });

  it("withholds a result until the url line has also arrived", () => {
    assert.isNull(parseOpenCode2Startup("server password abc123\n"));
  });

  it("does not match the 1.x banner", () => {
    // 1.x prints `opencode server listening on ...` so it must not satisfy the
    // 2.x listen-line contract.
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

describe("readOpenCode2StatePassword", () => {
  it("reads the beta lildax state-dir password file", () => {
    const stateHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-state-"));
    NodeFS.mkdirSync(NodePath.join(stateHome, "opencode"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(stateHome, "opencode", "password"),
      "file-minted-password\n",
    );
    assert.strictEqual(
      readOpenCode2StatePassword({ XDG_STATE_HOME: stateHome }),
      "file-minted-password",
    );
  });

  it("returns null when the state-dir password is missing", () => {
    const stateHome = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "opencode2-state-missing-"),
    );
    assert.isNull(readOpenCode2StatePassword({ XDG_STATE_HOME: stateHome }));
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

  it.effect("classifies the typed client's transport wrapper as a network failure", () =>
    Effect.gen(function* () {
      const cause = new ClientError("Transport", {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
          code: "ECONNREFUSED",
        }),
      });
      const error = yield* runOpenCode2Sdk("health.get", async () => {
        throw cause;
      }).pipe(Effect.flip);

      assert.strictEqual(error.category, "network-failed");
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, "ECONNREFUSED");
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
  it.effect("falls back to a usable root and removes only the private Bun temp directory", () =>
    Effect.gen(function* () {
      const encoder = new TextEncoder();
      const bunTempRoot = NodePath.join(process.cwd(), "tmp");
      const siblingPath = NodePath.join(bunTempRoot, `.opencode2-runtime-sibling-${process.pid}`);
      NodeFS.mkdirSync(bunTempRoot, { recursive: true });
      NodeFS.writeFileSync(siblingPath, "keep");
      let bunTempDirectory: string | undefined;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          assert.isTrue(ChildProcess.isStandardCommand(command));
          if (!ChildProcess.isStandardCommand(command)) {
            throw new Error("Expected a standard command");
          }
          const commandBunTempDirectory = command.options.env?.BUN_TMPDIR;
          assert.isString(commandBunTempDirectory);
          if (commandBunTempDirectory === undefined) {
            throw new Error("Expected BUN_TMPDIR in the spawn environment");
          }
          bunTempDirectory = commandBunTempDirectory;
          assert.strictEqual(command.options.env?.OPENCODE_TEST_MARKER, "preserved");
          assert.strictEqual(NodePath.dirname(commandBunTempDirectory), bunTempRoot);
          NodeFS.writeFileSync(
            NodePath.join(commandBunTempDirectory, ".embedded-native-library.so"),
            "x",
          );
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(42),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(
              encoder.encode(
                "server listening on http://127.0.0.1:4711\nserver password test-password\n",
              ),
            ),
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          });
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCode2Runtime;
          yield* runtime.startOpenCode2ServerProcess({
            binaryPath: "opencode2",
            environment: {
              ...process.env,
              BUN_TMPDIR: NodePath.join(bunTempRoot, "missing"),
              OPENCODE_TEST_MARKER: "preserved",
              TMPDIR: bunTempRoot,
            },
            port: 4_711,
          });
          assert.isDefined(bunTempDirectory);
          assert.isTrue(NodeFS.existsSync(bunTempDirectory));
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

      assert.isDefined(bunTempDirectory);
      assert.isFalse(NodeFS.existsSync(bunTempDirectory));
      assert.isTrue(NodeFS.existsSync(siblingPath));
      NodeFS.unlinkSync(siblingPath);
    }),
  );

  it.effect("removes the private Bun temp directory when spawning fails", () =>
    Effect.gen(function* () {
      const bunTempRoot = NodePath.join(process.cwd(), "tmp");
      NodeFS.mkdirSync(bunTempRoot, { recursive: true });
      let bunTempDirectory: string | undefined;
      const spawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) {
          return Effect.die(new Error("Expected a standard command"));
        }
        bunTempDirectory = command.options.env?.BUN_TMPDIR;
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "test spawn failure",
          }),
        );
      });

      yield* Effect.gen(function* () {
        const runtime = yield* OpenCode2Runtime;
        const parentScope = yield* Scope.make();
        const exit = yield* runtime
          .startOpenCode2ServerProcess({
            binaryPath: "opencode2",
            environment: { ...process.env, BUN_TMPDIR: bunTempRoot },
            port: 4_711,
          })
          .pipe(Effect.provideService(Scope.Scope, parentScope), Effect.exit);

        assert.isTrue(Exit.isFailure(exit));
        assert.isDefined(bunTempDirectory);
        assert.isFalse(NodeFS.existsSync(bunTempDirectory));
        yield* Scope.close(parentScope, Exit.void);
      }).pipe(
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

  it.effect("waits for a late banner password after the state-file grace window", () =>
    Effect.gen(function* () {
      const stateHome = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "opencode2-grace-empty-"),
      );
      const output = yield* Queue.unbounded<Uint8Array>();
      const encoder = new TextEncoder();
      yield* Queue.offer(output, encoder.encode("server listening on http://127.0.0.1:4711\n"));
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

      const startup = Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCode2Runtime;
          return yield* runtime.startOpenCode2ServerProcess({
            binaryPath: "opencode2",
            port: 4_711,
            environment: { XDG_STATE_HOME: stateHome },
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
      const startupFiber = yield* startup.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      // Poll loop (20ms) + password grace (100ms).
      yield* TestClock.adjust("150 millis");
      assert.isUndefined(startupFiber.pollUnsafe());

      yield* Queue.offer(output, encoder.encode("server password late-password\n"));
      const credentials = yield* Fiber.join(startupFiber);

      assert.strictEqual(credentials.url, "http://127.0.0.1:4711");
      assert.strictEqual(credentials.password, "late-password");
    }),
  );

  it.effect("loads the beta state-dir password when the banner omits it", () =>
    Effect.gen(function* () {
      const stateHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-grace-file-"));
      NodeFS.mkdirSync(NodePath.join(stateHome, "opencode"), { recursive: true });
      const spawner = ChildProcessSpawner.make(() => {
        NodeFS.writeFileSync(
          NodePath.join(stateHome, "opencode", "password"),
          "state-dir-password\n",
        );
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(42),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make("server listening on http://127.0.0.1:4711\n")),
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.never,
          }),
        );
      });

      const startup = Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCode2Runtime;
          return yield* runtime.startOpenCode2ServerProcess({
            binaryPath: "opencode2",
            port: 4_711,
            environment: { XDG_STATE_HOME: stateHome },
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
      const startupFiber = yield* startup.pipe(Effect.forkChild);
      yield* TestClock.adjust("150 millis");
      const credentials = yield* Fiber.join(startupFiber);

      assert.strictEqual(credentials.url, "http://127.0.0.1:4711");
      assert.strictEqual(credentials.password, "state-dir-password");
    }),
  );

  it.effect("accepts a state-dir password rewritten after a stale predecessor", () =>
    Effect.gen(function* () {
      const stateHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-stale-file-"));
      NodeFS.mkdirSync(NodePath.join(stateHome, "opencode"), { recursive: true });
      const passwordPath = NodePath.join(stateHome, "opencode", "password");
      NodeFS.writeFileSync(passwordPath, "stale-password\n");
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(42),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make("server listening on http://127.0.0.1:4711\n")),
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
          return yield* runtime.startOpenCode2ServerProcess({
            binaryPath: "opencode2",
            port: 4_711,
            environment: { XDG_STATE_HOME: stateHome },
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
      const startupFiber = yield* startup.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      assert.isUndefined(startupFiber.pollUnsafe());

      NodeFS.writeFileSync(passwordPath, "current-password\n");
      yield* TestClock.adjust("100 millis");
      const credentials = yield* Fiber.join(startupFiber);

      assert.strictEqual(credentials.password, "current-password");
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

  it.effect("reaps a spawned server whose startup password times out", () =>
    Effect.gen(function* () {
      const stateHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode2-timeout-"));
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
            stdout: Stream.encodeText(Stream.make("server listening on http://127.0.0.1:4711\n")),
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
            environment: { XDG_STATE_HOME: stateHome },
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

describe("openCode2SharedServerKey", () => {
  it("ignores session-varying inline config", () => {
    const left = openCode2SharedServerKey({
      binaryPath: "opencode2",
      environment: {
        XDG_DATA_HOME: "/data",
        XDG_STATE_HOME: "/state",
        OPENCODE_CONFIG_CONTENT: '{"mcp":1}',
      },
    });
    const right = openCode2SharedServerKey({
      binaryPath: "opencode2",
      environment: {
        XDG_DATA_HOME: "/data",
        XDG_STATE_HOME: "/state",
        OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}',
      },
    });
    assert.strictEqual(left, right);
  });

  it("separates managed data homes", () => {
    const left = openCode2SharedServerKey({
      binaryPath: "opencode2",
      environment: { XDG_DATA_HOME: "/a" },
    });
    const right = openCode2SharedServerKey({
      binaryPath: "opencode2",
      environment: { XDG_DATA_HOME: "/b" },
    });
    assert.notStrictEqual(left, right);
  });
});

describe("environmentForSharedOpenCode2Server", () => {
  it("strips inline config and keeps instance env", () => {
    const environment = environmentForSharedOpenCode2Server({
      OPENCODE_CONFIG_CONTENT: '{"mcp":1}',
      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "1",
      XDG_DATA_HOME: "/data",
    });
    assert.deepStrictEqual(environment, {
      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "1",
      XDG_DATA_HOME: "/data",
    });
  });
});

describe("OpenCode2Runtime shared server", () => {
  const bannerSpawner = (spawnCount: { value: number }) => {
    const encoder = new TextEncoder();
    return ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        spawnCount.value += 1;
        const port = 4700 + spawnCount.value;
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(40 + spawnCount.value),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(
            encoder.encode(
              `server listening on http://127.0.0.1:${port}\nserver password shared-password\n`,
            ),
          ),
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.never,
        });
      }),
    );
  };

  it.effect("reuses one spawned process across connect calls", () =>
    Effect.gen(function* () {
      const spawnCount = { value: 0 };
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* OpenCode2Runtime;
          const connection = yield* runtime.connectToOpenCode2Server({
            binaryPath: "opencode2",
            environment: {
              XDG_DATA_HOME: "/data",
              OPENCODE_CONFIG_CONTENT: '{"mcp":1}',
            },
          });
          const again = yield* runtime.connectToOpenCode2Server({
            binaryPath: "opencode2",
            environment: {
              XDG_DATA_HOME: "/data",
              OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}',
            },
          });
          return { connection, again };
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.provideService(SpawnedProcessReaper, {
          track: () => Effect.void,
          untrack: () => Effect.void,
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, bannerSpawner(spawnCount)),
        Effect.provideService(HostProcessPlatform, "win32"),
      );

      assert.strictEqual(spawnCount.value, 1);
      assert.strictEqual(first.connection.url, first.again.url);
      assert.strictEqual(first.connection.password, "shared-password");
      assert.isFalse(first.connection.external);
    }),
  );

  it.effect("does not kill the shared process when a caller scope closes", () =>
    Effect.gen(function* () {
      const spawnCount = { value: 0 };
      const urls = yield* Effect.gen(function* () {
        const runtime = yield* OpenCode2Runtime;
        const first = yield* Effect.scoped(
          runtime.connectToOpenCode2Server({
            binaryPath: "opencode2",
            environment: { XDG_DATA_HOME: "/data" },
          }),
        );
        const second = yield* Effect.scoped(
          runtime.connectToOpenCode2Server({
            binaryPath: "opencode2",
            environment: { XDG_DATA_HOME: "/data" },
          }),
        );
        return { first: first.url, second: second.url };
      }).pipe(
        Effect.scoped,
        Effect.provide(layer),
        Effect.provideService(SpawnedProcessReaper, {
          track: () => Effect.void,
          untrack: () => Effect.void,
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, bannerSpawner(spawnCount)),
        Effect.provideService(HostProcessPlatform, "win32"),
      );

      assert.strictEqual(spawnCount.value, 1);
      assert.strictEqual(urls.first, urls.second);
    }),
  );
});
