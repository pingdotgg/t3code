import { assert, it } from "@effect/vitest";
import type { TerminalEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { TerminalManager } from "../../terminal/Manager.ts";
import { ScriptCommandRunner } from "../Services/ScriptCommandRunner.ts";
import { ScriptCommandRunnerLive } from "./ScriptCommandRunner.ts";

const snapshot = (input: {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd: string;
}): TerminalSessionSnapshot => ({
  threadId: input.threadId,
  terminalId: input.terminalId,
  cwd: input.cwd,
  worktreePath: null,
  status: "running",
  pid: 123,
  history: "",
  exitCode: null,
  exitSignal: null,
  label: "script",
  updatedAt: "2026-06-07T00:00:00.000Z",
});

const layerWithTerminal = (manager: TerminalManager["Service"]) =>
  ScriptCommandRunnerLive.pipe(Layer.provideMerge(Layer.succeed(TerminalManager, manager)));

it.effect(
  "subscribes before writing, wraps the command, and filters exit events by thread and terminal",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
      const layer = layerWithTerminal({
        open: (input) =>
          Effect.sync(() => {
            calls.push(`open:${input.threadId}:${input.terminalId}:${input.cwd}`);
            return snapshot(input);
          }),
        attachStream: () => Effect.succeed(() => undefined),
        attachHistoryStream: () => Effect.succeed(() => undefined),
        write: (input) =>
          Effect.gen(function* () {
            calls.push(`write:${input.data}`);
            if (listener === null) {
              assert.fail("terminal listener was not installed before write");
            }
            yield* listener({
              type: "exited",
              threadId: "other-thread",
              terminalId: input.terminalId,
              exitCode: 99,
              exitSignal: null,
            });
            yield* listener({
              type: "exited",
              threadId: input.threadId,
              terminalId: "other-terminal",
              exitCode: 98,
              exitSignal: null,
            });
            yield* listener({
              type: "exited",
              threadId: input.threadId,
              terminalId: input.terminalId,
              exitCode: 7,
              exitSignal: 15,
            });
          }),
        resize: () => Effect.void,
        clear: () => Effect.void,
        restart: (input) => Effect.succeed(snapshot(input)),
        close: (input) =>
          Effect.sync(() => {
            calls.push(`close:${input.threadId}:${input.terminalId ?? "*"}`);
          }),
        subscribe: (next) =>
          Effect.sync(() => {
            calls.push("subscribe");
            listener = next;
            return () => {
              calls.push("unsubscribe");
            };
          }),
        getSnapshot: () => Effect.succeed(null),
        subscribeMetadata: () => Effect.succeed(() => undefined),
      });

      const result = yield* Effect.gen(function* () {
        const runner = yield* ScriptCommandRunner;
        return yield* runner.run({
          scriptThreadId: "script-thread" as never,
          terminalId: "script-terminal",
          cwd: "/tmp/worktree",
          run: "exit 7",
          timeout: Duration.seconds(1),
        });
      }).pipe(Effect.provide(layer));

      assert.deepEqual(result, { outcome: "exited", exitCode: 7, signal: 15 });
      assert.deepEqual(calls, [
        "subscribe",
        "open:script-thread:script-terminal:/tmp/worktree",
        "write:exit 7\nexit $?\r",
        "unsubscribe",
      ]);
    }),
);

it.effect("closes the terminal and resolves timeout when no terminal event arrives", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = layerWithTerminal({
      open: (input) => Effect.succeed(snapshot(input)),
      attachStream: () => Effect.succeed(() => undefined),
      attachHistoryStream: () => Effect.succeed(() => undefined),
      write: () => Effect.void,
      resize: () => Effect.void,
      clear: () => Effect.void,
      restart: (input) => Effect.succeed(snapshot(input)),
      close: (input) =>
        Effect.sync(() => {
          calls.push(`close:${input.threadId}:${input.terminalId ?? "*"}`);
        }),
      getSnapshot: () => Effect.succeed(null),
      subscribe: () => Effect.succeed(() => undefined),
      subscribeMetadata: () => Effect.succeed(() => undefined),
    });

    const result = yield* Effect.gen(function* () {
      const runner = yield* ScriptCommandRunner;
      const fiber = yield* Effect.forkChild(
        runner.run({
          scriptThreadId: "timeout-thread" as never,
          terminalId: "timeout-terminal",
          cwd: "/tmp/worktree",
          run: "sleep 10",
          timeout: Duration.millis(10),
        }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(10));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer())));

    assert.deepEqual(result, { outcome: "timeout", exitCode: null, signal: null });
    assert.deepEqual(calls, ["close:timeout-thread:timeout-terminal"]);
  }),
);

it.effect("treats a closed terminal event as cooperative cancellation", () =>
  Effect.gen(function* () {
    let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
    const layer = layerWithTerminal({
      open: (input) => Effect.succeed(snapshot(input)),
      attachStream: () => Effect.succeed(() => undefined),
      attachHistoryStream: () => Effect.succeed(() => undefined),
      write: (input) =>
        Effect.gen(function* () {
          if (listener === null) {
            assert.fail("terminal listener was not installed before write");
          }
          yield* listener({
            type: "closed",
            threadId: input.threadId,
            terminalId: input.terminalId,
          });
        }),
      resize: () => Effect.void,
      clear: () => Effect.void,
      restart: (input) => Effect.succeed(snapshot(input)),
      close: () => Effect.void,
      getSnapshot: () => Effect.succeed(null),
      subscribe: (next) =>
        Effect.sync(() => {
          listener = next;
          return () => undefined;
        }),
      subscribeMetadata: () => Effect.succeed(() => undefined),
    });

    const result = yield* Effect.gen(function* () {
      const runner = yield* ScriptCommandRunner;
      return yield* runner.run({
        scriptThreadId: "cancel-thread" as never,
        terminalId: "cancel-terminal",
        cwd: "/tmp/worktree",
        run: "sleep 10",
        timeout: Duration.seconds(1),
      });
    }).pipe(Effect.provide(layer));

    assert.deepEqual(result, { outcome: "cancelled", exitCode: null, signal: null });
  }),
);

it.effect("fails fast with the terminal error message instead of stalling on timeout", () =>
  Effect.gen(function* () {
    let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
    const layer = layerWithTerminal({
      open: (input) => Effect.succeed(snapshot(input)),
      attachStream: () => Effect.succeed(() => undefined),
      attachHistoryStream: () => Effect.succeed(() => undefined),
      write: (input) =>
        Effect.gen(function* () {
          if (listener === null) {
            assert.fail("terminal listener was not installed before write");
          }
          // An errored terminal emits `error` with NO following exited/closed.
          yield* listener({
            type: "error",
            threadId: input.threadId,
            terminalId: input.terminalId,
            message: "pty spawn failed",
          });
        }),
      resize: () => Effect.void,
      clear: () => Effect.void,
      restart: (input) => Effect.succeed(snapshot(input)),
      close: () => Effect.void,
      getSnapshot: () => Effect.succeed(null),
      subscribe: (next) =>
        Effect.sync(() => {
          listener = next;
          return () => undefined;
        }),
      subscribeMetadata: () => Effect.succeed(() => undefined),
    });

    const error = yield* Effect.gen(function* () {
      const runner = yield* ScriptCommandRunner;
      return yield* runner.run({
        scriptThreadId: "error-thread" as never,
        terminalId: "error-terminal",
        cwd: "/tmp/worktree",
        run: "boom",
        // A long timeout: the test would hang for it without the error handling.
        timeout: Duration.minutes(10),
      });
    }).pipe(Effect.flip, Effect.provide(layer));

    assert.include(error.message, "pty spawn failed");
  }),
);

it.effect("closes the terminal when the runner fiber is interrupted", () =>
  Effect.gen(function* () {
    const written = yield* Deferred.make<void>();
    const calls: string[] = [];
    const layer = layerWithTerminal({
      open: (input) => Effect.succeed(snapshot(input)),
      attachStream: () => Effect.succeed(() => undefined),
      attachHistoryStream: () => Effect.succeed(() => undefined),
      write: () => Deferred.succeed(written, undefined).pipe(Effect.asVoid),
      resize: () => Effect.void,
      clear: () => Effect.void,
      restart: (input) => Effect.succeed(snapshot(input)),
      close: (input) =>
        Effect.sync(() => {
          calls.push(`close:${input.threadId}:${input.terminalId ?? "*"}`);
        }),
      getSnapshot: () => Effect.succeed(null),
      subscribe: () => Effect.succeed(() => undefined),
      subscribeMetadata: () => Effect.succeed(() => undefined),
    });

    const fiber = yield* Effect.forkChild(
      Effect.gen(function* () {
        const runner = yield* ScriptCommandRunner;
        return yield* runner.run({
          scriptThreadId: "interrupt-thread" as never,
          terminalId: "interrupt-terminal",
          cwd: "/tmp/worktree",
          run: "sleep 10",
          timeout: Duration.seconds(10),
        });
      }).pipe(Effect.provide(layer)),
    );
    yield* Deferred.await(written);

    yield* Fiber.interrupt(fiber);

    assert.deepEqual(calls, ["close:interrupt-thread:interrupt-terminal"]);
  }),
);
