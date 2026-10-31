import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import * as TailscaleServe from "./tailscaleServe.ts";

const encoder = new TextEncoder();
const SERVE_PORT = 18443;
const LOCAL_TARGET = "http://127.0.0.1:18638";

interface FakeOptions {
  /** `serve --bg` is refused this many times (operator not granted, Tailscale still starting). */
  readonly refusedServeAttempts?: number;
  /** The attempt after the refusals never answers. */
  readonly hangs?: boolean;
  /** The daemon applies the mapping at once but the CLI exits only after this delay. */
  readonly ackDelay?: Duration.Input;
  /** The Serve root starts out proxying to this other server. */
  readonly heldBy?: string;
}

// Stands in for the tailscale CLI and keeps the Serve root like the daemon does.
const makeFakeTailscale = (options: FakeOptions) => {
  const state = {
    serveAttempts: 0,
    releases: 0,
    root: options.heldBy ?? null,
  };
  // Completes when the daemon takes the mapping, before the CLI exits.
  const mappingApplied = Deferred.makeUnsafe<void>();
  const serveStatus = () =>
    state.root === null
      ? "null\n"
      : JSON.stringify({
          TCP: { [SERVE_PORT]: { HTTPS: true } },
          Web: {
            [`desktop.tail.ts.net:${SERVE_PORT}`]: { Handlers: { "/": { Proxy: state.root } } },
          },
        });
  const handle = (
    args: ReadonlyArray<string>,
  ): { code: number; stdout?: string; stderr?: string; ackDelay?: Duration.Input } | undefined => {
    const command = args.join(" ");
    if (command === "serve status --json") {
      return { code: 0, stdout: serveStatus() };
    }
    if (args[0] === "serve" && args[1] === "--bg") {
      state.serveAttempts += 1;
      if (state.serveAttempts <= (options.refusedServeAttempts ?? 0)) {
        return { code: 1, stderr: "Access denied: serve config denied" };
      }
      if (options.hangs) {
        return undefined;
      }
      state.root = args.at(-1) ?? null;
      Deferred.doneUnsafe(mappingApplied, Effect.void);
      return { code: 0, ...(options.ackDelay === undefined ? {} : { ackDelay: options.ackDelay }) };
    }
    if (command === `serve --https=${SERVE_PORT} --set-path=/ off`) {
      state.releases += 1;
      state.root = null;
      return { code: 0 };
    }
    return { code: 1, stderr: "unexpected command" };
  };
  const spawner = ChildProcessSpawner.make((command) => {
    const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
    const result = handle(args);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode:
          result === undefined
            ? Effect.never
            : Effect.succeed(ChildProcessSpawner.ExitCode(result.code)).pipe(
                Effect.delay(result.ackDelay ?? 0),
              ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(result?.stdout ?? "")),
        stderr: Stream.make(encoder.encode(result?.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { state, spawner, mappingApplied };
};

const startTailscaleServe = Effect.fn(function* (options: FakeOptions = {}) {
  const fake = makeFakeTailscale(options);
  const parked = yield* Deferred.make<void>();
  const settled = yield* Deferred.make<void>();
  const scope = yield* Scope.make();
  yield* Layer.buildWithScope(
    TailscaleServe.layer({
      servePort: SERVE_PORT,
      parked,
      settled,
      awaitActivation: Effect.void,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
          Layer.succeed(HostProcess.Platform, "linux"),
          Layer.mock(HttpServer.HttpServer)({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 18638),
          }),
        ),
      ),
    ),
    scope,
  );
  return { state: fake.state, mappingApplied: fake.mappingApplied, scope, settled };
});

describe("TailscaleServe", () => {
  // regression: #16238 - a refused first `tailscale serve` left Serve off
  // until the server was restarted.
  it.effect("configures Serve once a later attempt succeeds, without a restart", () =>
    Effect.gen(function* () {
      const { state, settled } = yield* startTailscaleServe({ refusedServeAttempts: 1 });
      // Headless startup prints its pairing URL after the first attempt, not after every retry.
      yield* Deferred.await(settled);
      assert.equal(state.root, null);

      yield* TestClock.adjust("1 hour");

      assert.equal(state.root, LOCAL_TARGET, "Serve was never configured after the first refusal");
    }),
  );

  it.effect("keeps retrying with backoff capped at 30 seconds", () =>
    Effect.gen(function* () {
      // Attempts fall at 0, 1, 3, 7, 15 and 31 s, then every 30 s.
      const { state } = yield* startTailscaleServe({ refusedServeAttempts: 8 });
      let elapsedMs = 0;
      const attemptsAt = Effect.fn(function* (ms: number) {
        yield* TestClock.adjust(ms - elapsedMs);
        elapsedMs = ms;
        return state.serveAttempts;
      });

      assert.equal(yield* attemptsAt(999), 1, "retried before the first backoff delay");
      assert.equal(yield* attemptsAt(1_000), 2);
      assert.equal(yield* attemptsAt(30_999), 5);
      assert.equal(yield* attemptsAt(31_000), 6);
      assert.equal(yield* attemptsAt(60_999), 6, "backoff not capped at 30 seconds");
      assert.equal(yield* attemptsAt(61_000), 7);
      assert.equal(yield* attemptsAt(91_000), 8);
      assert.equal(state.root, null);
      assert.equal(yield* attemptsAt(121_000), 9);
      assert.equal(state.root, LOCAL_TARGET);
    }),
  );

  it.effect("removes its Serve root on shutdown after a later attempt succeeded", () =>
    Effect.gen(function* () {
      const { state, scope } = yield* startTailscaleServe({ refusedServeAttempts: 1 });
      yield* TestClock.adjust("1 hour");

      yield* Scope.close(scope, Exit.void);

      assert.equal(state.releases, 1);
      assert.equal(state.root, null);
    }),
  );

  it.effect("removes the Serve root on shutdown while the CLI has yet to acknowledge it", () =>
    Effect.gen(function* () {
      const { state, mappingApplied, scope } = yield* startTailscaleServe({
        ackDelay: "2 seconds",
      });
      yield* Deferred.await(mappingApplied);
      assert.equal(state.serveAttempts, 1);

      const shutdown = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(shutdown);

      assert.equal(state.releases, 1, "a mapping the daemon applied outlived shutdown");
    }),
  );

  it.effect("stops retrying on shutdown and leaves Serve alone if no attempt succeeded", () =>
    Effect.gen(function* () {
      const { state, scope } = yield* startTailscaleServe({
        refusedServeAttempts: Number.POSITIVE_INFINITY,
      });
      yield* TestClock.adjust("1 minute");
      const attemptsBeforeShutdown = state.serveAttempts;

      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust("1 hour");

      assert.isAbove(attemptsBeforeShutdown, 1);
      assert.equal(state.serveAttempts, attemptsBeforeShutdown);
      assert.equal(state.releases, 0);
    }),
  );

  it.effect("waits on shutdown no longer than the Serve command's timeout", () =>
    Effect.gen(function* () {
      const { state, scope } = yield* startTailscaleServe({ refusedServeAttempts: 1, hangs: true });
      yield* TestClock.adjust("1 second");
      assert.equal(state.serveAttempts, 2);

      const shutdown = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(shutdown);

      // No attempt succeeded, so the port is not ours to clear.
      assert.equal(state.releases, 0);
    }),
  );

  // regression: #10363 - a second server took the Serve URL from the running one.
  it.effect("leaves another server's Serve root alone and takes over once it is gone", () =>
    Effect.gen(function* () {
      const otherServer = "http://192.168.1.20:3773";
      const { state, scope } = yield* startTailscaleServe({ heldBy: otherServer });
      yield* TestClock.adjust("1 minute");
      assert.equal(state.serveAttempts, 0);
      assert.equal(state.root, otherServer);

      state.root = null;
      yield* TestClock.adjust("30 seconds");
      assert.equal(state.root, LOCAL_TARGET);

      // Another server took the port back, so shutdown must not remove its root.
      state.root = otherServer;
      yield* Scope.close(scope, Exit.void);
      assert.equal(state.releases, 0);
      assert.equal(state.root, otherServer);
    }),
  );
});
