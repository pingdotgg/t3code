import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Sessions from "./McpProviderSessions.ts";

it.effect("requires a one-use trusted attestation for the same current provider session", () =>
  Effect.gen(function* () {
    const sessions = yield* Sessions.McpProviderSessions;
    const threadId = ThreadId.make("parent");
    const config = {
      threadId,
      environmentId: EnvironmentId.make("env"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: "session",
      endpoint: "http://localhost/mcp",
      authorizationHeader: "Bearer test",
      browserToolsAvailable: true,
    };
    yield* sessions.set(config);
    const first = (yield* sessions.beginHostInvocation("session"))!;
    expect(yield* sessions.attestHostInvocation(first, "foreign-session", false)).toBe(false);
    expect(yield* sessions.takeHostInvocation(first, "foreign-session")).toBeUndefined();
    expect(yield* sessions.takeHostInvocation(first, "session")).toBeUndefined();
    expect(yield* sessions.attestHostInvocation(first, "session", false)).toBe(false);
    const second = (yield* sessions.beginHostInvocation("session"))!;
    expect(yield* sessions.attestHostInvocation(second, "session", true)).toBe(true);
    expect(yield* sessions.attestHostInvocation(second, "session", false)).toBe(false);
    expect(yield* sessions.takeHostInvocation(second, "session")).toBe(true);
    expect(yield* sessions.takeHostInvocation(second, "session")).toBeUndefined();
    const parent = (yield* sessions.beginHostInvocation("session"))!;
    yield* sessions.attestHostInvocation(parent, "session", false);
    expect(yield* sessions.takeHostInvocation(parent, "session")).toBe(false);
    const revoked = (yield* sessions.beginHostInvocation("session"))!;
    yield* sessions.attestHostInvocation(revoked, "session", false);
    yield* sessions.clear(threadId);
    expect(yield* sessions.takeHostInvocation(revoked, "session")).toBeUndefined();
    expect(yield* sessions.beginHostInvocation("session")).toBeUndefined();
  }).pipe(Effect.provide(Sessions.layer)),
);
