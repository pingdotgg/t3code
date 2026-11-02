import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

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

it.effect("a call waiting on its caller never resolves through the next credential", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    yield* sessions.set(session("credential:old"));
    const pending = yield* Effect.forkChild(
      sessions.resolveNativeCaller({
        threadId,
        providerSessionId: "credential:old",
        callId: "codex-thread:native",
      }),
      { startImmediately: true },
    );
    // A resumed Codex session binds the same native thread id under its new credential.
    yield* sessions.set(session("credential:new"));
    yield* sessions.bindNativeCaller({
      threadId,
      callId: "codex-thread:native",
      callerThreadId: ThreadId.make("thread:native-child"),
    });
    assert.isUndefined(yield* Fiber.join(pending));
    assert.equal(
      yield* sessions.resolveNativeCaller({
        threadId,
        providerSessionId: "credential:new",
        callId: "codex-thread:native",
      }),
      ThreadId.make("thread:native-child"),
    );
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);
