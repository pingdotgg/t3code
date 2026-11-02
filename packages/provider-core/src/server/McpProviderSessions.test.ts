import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as McpProviderSessions from "./McpProviderSessions.ts";

const threadId = ThreadId.make("thread:mcp-sessions");
const session = (providerSessionId: string) => ({
  environmentId: EnvironmentId.make("environment:mcp-sessions"),
  threadId,
  providerSessionId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  endpoint: "http://127.0.0.1/mcp",
  authorizationHeader: "Bearer token",
  browserToolsAvailable: false,
});

it.effect.each(["codex-thread:native", "claude-tool:native"])(
  "a call waiting on its caller never resolves through the next credential: %s",
  (callId) =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set(session("credential:old"));
      const pending = yield* Effect.forkChild(
        sessions.resolveNativeCaller({
          threadId,
          providerSessionId: "credential:old",
          callId,
        }),
        { startImmediately: true },
      );
      yield* sessions.set(session("credential:new"));
      yield* sessions.bindNativeCaller({
        threadId,
        callId,
        callerThreadId: ThreadId.make("thread:native-child"),
      });
      assert.isUndefined(yield* Fiber.join(pending));
      assert.equal(
        yield* sessions.resolveNativeCaller({
          threadId,
          providerSessionId: "credential:new",
          callId,
        }),
        ThreadId.make("thread:native-child"),
      );
      for (const reset of ["replace", "clear"] as const) {
        if (reset === "clear") yield* sessions.clear(threadId);
        yield* sessions.set(session(`credential:${reset}`));
        const missing = yield* Effect.forkChild(
          sessions.resolveNativeCaller({
            threadId,
            providerSessionId: `credential:${reset}`,
            callId,
          }),
          { startImmediately: true },
        );
        yield* TestClock.adjust("5 seconds");
        assert.isUndefined(yield* Fiber.join(missing));
        yield* sessions.bindNativeCaller({
          threadId,
          callId,
          callerThreadId: ThreadId.make("thread:native-child"),
        });
      }
    }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect.each(["codex-thread:", "claude-tool:"])(
  "keeps active Codex callers after many %s bindings",
  (prefix) =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set(session("credential:current"));
      const callerThreadId = ThreadId.make("thread:native-child");
      yield* sessions.bindNativeCaller({
        threadId,
        callId: "codex-thread:root",
        callerThreadId: threadId,
      });
      yield* sessions.bindNativeCaller({ threadId, callId: "codex-thread:active", callerThreadId });
      for (let index = 0; index < 1_025; index += 1) {
        yield* sessions.bindNativeCaller({ threadId, callId: `${prefix}${index}`, callerThreadId });
      }
      for (const [callId, expected] of [
        ["codex-thread:root", threadId],
        ["codex-thread:active", callerThreadId],
      ] as const) {
        const resolved = yield* Effect.forkChild(
          sessions.resolveNativeCaller({
            threadId,
            providerSessionId: "credential:current",
            callId,
          }),
          { startImmediately: true },
        );
        yield* TestClock.adjust("5 seconds");
        assert.equal(yield* Fiber.join(resolved), expected);
      }
      if (prefix === "claude-tool:") {
        const expired = yield* Effect.forkChild(
          sessions.resolveNativeCaller({
            threadId,
            providerSessionId: "credential:current",
            callId: "claude-tool:0",
          }),
          { startImmediately: true },
        );
        yield* TestClock.adjust("5 seconds");
        assert.isUndefined(yield* Fiber.join(expired));
      }
    }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect.each(["interrupted", "timed out"] as const)(
  "keeps a shared caller waiter after another resolver is %s",
  (settlement) =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set(session("credential:current"));
      const input = {
        threadId,
        providerSessionId: "credential:current",
        callId: "codex-thread:native",
      };
      const first = yield* Effect.forkChild(sessions.resolveNativeCaller(input), {
        startImmediately: true,
      });
      yield* TestClock.adjust("1 second");
      const second = yield* Effect.forkChild(sessions.resolveNativeCaller(input), {
        startImmediately: true,
      });
      if (settlement === "interrupted") {
        yield* Fiber.interrupt(first);
      } else {
        yield* TestClock.adjust("4 seconds");
        assert.isUndefined(yield* Fiber.join(first));
      }
      const callerThreadId = ThreadId.make("thread:native-child");
      yield* sessions.bindNativeCaller({ ...input, callerThreadId });
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* Fiber.join(second), callerThreadId);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
);
