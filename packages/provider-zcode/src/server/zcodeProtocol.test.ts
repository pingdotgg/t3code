import { assert, describe, it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { makeZcodeConnection, ZcodeProtocolError, type ZcodeRecord } from "./zcodeProtocol.ts";

// Mirrors the private EXIT_DRAIN_GRACE and TERMINATION_GRACE in zcodeProtocol.ts.
const EXIT_DRAIN_GRACE_MS = 1_000;
const TERMINATION_GRACE_MS = 1_000;

const processGroupState = vi.hoisted(() => ({
  groupAlive: true,
  signals: [] as Array<NodeJS.Signals | 0>,
}));

vi.mock("@t3tools/provider-core/server/processGroup", () => ({
  signalProcessGroup: (pid: number, signal: NodeJS.Signals | 0) => {
    if (!processGroupState.groupAlive) {
      throw Object.assign(new Error(`kill ESRCH: no process group ${pid}`), { code: "ESRCH" });
    }
    processGroupState.signals.push(signal);
  },
}));

const setupProcessGroup = (groupAlive: boolean) => {
  processGroupState.groupAlive = groupAlive;
  processGroupState.signals = [];
};

const makeHeldOpenChild = Effect.fnUntraced(function* (scope?: Scope.Closeable) {
  const exitCode = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const stdinChunks = yield* Queue.unbounded<Uint8Array>();
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(55_000),
    exitCode: Deferred.await(exitCode),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((chunk: Uint8Array) => Queue.offer(stdinChunks, chunk).pipe(Effect.asVoid)),
    stdout: Stream.fromQueue(stdout),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
  const unscoped = makeZcodeConnection({
    command: "zcode",
    args: ["app-server", "--stdio"],
    cwd: undefined,
    env: {},
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.succeed(handle)),
    ),
    Effect.provideService(HostProcess.Platform, "linux"),
  );
  const connection = yield* scope === undefined ? unscoped : unscoped.pipe(Scope.provide(scope));
  return { connection, exitCode, stdout, stdinChunks };
});

const takeSentRecord = Effect.fnUntraced(function* (stdinChunks: Queue.Dequeue<Uint8Array>) {
  const line = new TextDecoder().decode(yield* Queue.take(stdinChunks));
  return JSON.parse(line) as ZcodeRecord;
});

describe("makeZcodeConnection", () => {
  it.effect("fails the transport once the exit grace elapses with stdout still open", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Group modeled empty, so the scope-close termination below is a no-op.
        setupProcessGroup(false);
        const { connection, exitCode, stdout } = yield* makeHeldOpenChild();

        yield* Deferred.succeed(exitCode, ChildProcessSpawner.ExitCode(0));
        assert.equal(yield* connection.exited, 0);

        // Records buffered when zcode died still drain while the grace runs.
        yield* Queue.offer(stdout, new TextEncoder().encode('{"event":"turn.completed"}\n'));
        const drained = yield* Queue.take(connection.events);
        assert.equal(drained["event"], "turn.completed");

        const down = yield* Deferred.make<ZcodeProtocolError>();
        yield* Queue.take(connection.events).pipe(
          Effect.catch((error) => Deferred.succeed(down, error)),
          Effect.forkScoped,
        );
        yield* TestClock.adjust(Duration.millis(EXIT_DRAIN_GRACE_MS - 1));
        assert.isTrue(Option.isNone(yield* Deferred.poll(down)));
        yield* TestClock.adjust(Duration.millis(1));
        const error = yield* Deferred.await(down);
        assert.instanceOf(error, ZcodeProtocolError);
        assert.equal(error.operation, "read");
        assert.equal(error.detail, "zcode app-server exited with code 0, but stdout never closed");
      }),
    ),
  );

  it.effect("stdout closing after exit still reports the exit code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Group modeled empty, so the scope-close termination below is a no-op.
        setupProcessGroup(false);
        const { connection, exitCode, stdout } = yield* makeHeldOpenChild();
        const down = yield* Deferred.make<ZcodeProtocolError>();
        yield* Queue.take(connection.events).pipe(
          Effect.catch((error) => Deferred.succeed(down, error)),
          Effect.forkScoped,
        );

        yield* Deferred.succeed(exitCode, ChildProcessSpawner.ExitCode(7));
        assert.equal(yield* connection.exited, 7);
        yield* Queue.end(stdout);

        const error = yield* Deferred.await(down);
        assert.equal(error.operation, "read");
        assert.equal(error.detail, "zcode app-server exited with code 7");
      }),
    ),
  );

  it.effect("escalates to SIGKILL after the leader exits while tools keep the group alive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        setupProcessGroup(true);
        const scope = yield* Scope.make();
        const { connection, exitCode } = yield* makeHeldOpenChild(scope);

        yield* Deferred.succeed(exitCode, ChildProcessSpawner.ExitCode(0));
        assert.equal(yield* connection.exited, 0);

        // Detached tools keep the pgid alive after the leader is reaped; termination must
        // still SIGTERM the group and, after the grace, SIGKILL the survivors.
        const closed = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
        yield* TestClock.adjust(Duration.millis(TERMINATION_GRACE_MS));
        yield* Fiber.join(closed);

        // hasExited probes interleave signal 0; assert on the delivered signals only.
        const sent = processGroupState.signals.filter((signal) => signal !== 0);
        expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
      }),
    ),
  );

  it.effect("skips group signalling once the leader exited and the group is empty", () =>
    Effect.scoped(
      Effect.gen(function* () {
        setupProcessGroup(false);
        const scope = yield* Scope.make();
        const { connection, exitCode } = yield* makeHeldOpenChild(scope);

        yield* Deferred.succeed(exitCode, ChildProcessSpawner.ExitCode(0));
        assert.equal(yield* connection.exited, 0);

        // No survivors: termination returns without waiting the grace or signalling.
        yield* Scope.close(scope, Exit.void);

        expect(processGroupState.signals).toEqual([]);
      }),
    ),
  );

  it.effect("a rejected request reports the real method with bounded detail", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Group modeled empty, so the scope-close termination below is a no-op.
        setupProcessGroup(false);
        const { connection, stdout, stdinChunks } = yield* makeHeldOpenChild();

        const pending = yield* connection
          .request("provider/updateAccountConfig", { accountId: "acct_1" })
          .pipe(
            Effect.catch((error) => Effect.succeed(error)),
            Effect.forkScoped,
          );

        const sent = yield* takeSentRecord(stdinChunks);
        assert.equal(sent["method"], "provider/updateAccountConfig");

        const payload = "SECRET_ZCODE_SERVER_PAYLOAD";
        const serverError = { code: "accountConfigRejected", message: payload };
        yield* Queue.offer(
          stdout,
          new TextEncoder().encode(`${JSON.stringify({ id: sent["id"], error: serverError })}\n`),
        );

        const error = yield* Fiber.join(pending);
        assert.instanceOf(error, ZcodeProtocolError);
        // Raw payload stays in cause only; message and detail carry bounded metadata.
        assert.isFalse(`${error.detail}`.includes(payload));
        assert.isFalse(error.message.includes(payload));
        assert.equal(
          error.detail,
          `code accountConfigRejected, ${JSON.stringify(serverError).length}-char payload`,
        );
        assert.include(JSON.stringify(error.cause), payload);
        // The failure names the method that failed, not the generic "request".
        assert.equal(error.operation, "provider/updateAccountConfig");
      }),
    ),
  );

  it.effect("a string error payload also stays confined to cause", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Group modeled empty, so the scope-close termination below is a no-op.
        setupProcessGroup(false);
        const { connection, stdout, stdinChunks } = yield* makeHeldOpenChild();

        const pending = yield* connection
          .request("session/subscribe", { sessionId: "sess_1" })
          .pipe(
            Effect.catch((error) => Effect.succeed(error)),
            Effect.forkScoped,
          );

        const sent = yield* takeSentRecord(stdinChunks);

        const payload = "SECRET_BARE_ZCODE_PAYLOAD";
        yield* Queue.offer(
          stdout,
          new TextEncoder().encode(`${JSON.stringify({ id: sent["id"], error: payload })}\n`),
        );

        const error = yield* Fiber.join(pending);
        assert.instanceOf(error, ZcodeProtocolError);
        assert.isFalse(`${error.detail}`.includes(payload));
        assert.isFalse(error.message.includes(payload));
        assert.equal(error.detail, `${JSON.stringify(payload).length}-char payload`);
        assert.include(JSON.stringify(error.cause), payload);
        assert.equal(error.operation, "session/subscribe");
      }),
    ),
  );
});
