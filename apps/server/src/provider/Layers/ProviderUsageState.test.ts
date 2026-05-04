import { describe, expect, it } from "vitest";
import { Effect, Layer, PubSub, Stream } from "effect";
import { ProviderDriverKind, type ProviderRuntimeEvent, type ThreadId } from "@t3tools/contracts";

import { ProviderUsageState } from "../Services/ProviderUsageState.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderUsageStateLive } from "./ProviderUsageState.ts";

function makeProviderServiceStub() {
  const pubsub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  return {
    pubsub,
    layer: Layer.succeed(ProviderService, {
      startSession: () => Effect.die("unused"),
      sendTurn: () => Effect.die("unused"),
      interruptTurn: () => Effect.die("unused"),
      respondToRequest: () => Effect.die("unused"),
      respondToUserInput: () => Effect.die("unused"),
      stopSession: () => Effect.die("unused"),
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.die("unused"),
      rollbackConversation: () => Effect.die("unused"),
      getInstanceInfo: () => Effect.die("unused"),
      streamEvents: Stream.fromPubSub(pubsub),
    }),
  };
}

describe("ProviderUsageStateLive", () => {
  it("sets, gets, and clears usage by provider", async () => {
    const stub = makeProviderServiceStub();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* usageState.set(ProviderDriverKind.make("cursor"), "thread-probe" as ThreadId, {
          source: "cursorAcp",
          available: true,
          checkedAt: "2026-04-18T00:00:00.000Z",
          windows: [{ kind: "session", label: "Context window", usedPercent: 25 }],
        });
        const first = yield* usageState.get(ProviderDriverKind.make("cursor"));
        yield* usageState.clear(ProviderDriverKind.make("cursor"));
        const second = yield* usageState.get(ProviderDriverKind.make("cursor"));

        return { first, second };
      }).pipe(Effect.provide(ProviderUsageStateLive.pipe(Layer.provide(stub.layer)))),
    );

    expect(result.first?.windows).toEqual([
      { kind: "session", label: "Context window", usedPercent: 25 },
    ]);
    expect(result.second).toBeUndefined();
  });

  it("ingests real Cursor token usage events and isolates providers", async () => {
    const stub = makeProviderServiceStub();
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* Effect.sleep("10 millis");
        yield* PubSub.publish(stub.pubsub, {
          type: "thread.token-usage.updated",
          eventId: "evt-1" as never,
          provider: ProviderDriverKind.make("cursor"),
          threadId: "thread-1" as never,
          createdAt: "2026-04-18T00:00:00.000Z",
          payload: {
            usage: {
              usedTokens: 50,
              maxTokens: 100,
            },
          },
        });

        yield* Effect.sleep("10 millis");

        return {
          cursor: yield* usageState.get(ProviderDriverKind.make("cursor")),
          opencode: yield* usageState.get(ProviderDriverKind.make("opencode")),
        };
      }).pipe(Effect.provide(ProviderUsageStateLive.pipe(Layer.provide(stub.layer)))),
    );

    expect(state.cursor?.windows).toEqual([
      { kind: "session", label: "Context window", usedPercent: 50 },
    ]);
    expect(state.opencode).toBeUndefined();
  });

  it("returns the most recently updated thread usage", async () => {
    const stub = makeProviderServiceStub();
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* Effect.sleep("10 millis");
        yield* PubSub.publish(stub.pubsub, {
          type: "thread.token-usage.updated",
          eventId: "evt-1" as never,
          provider: ProviderDriverKind.make("cursor"),
          threadId: "thread-a" as never,
          createdAt: "2026-04-18T00:00:00.000Z",
          payload: {
            usage: {
              usedTokens: 10,
              maxTokens: 100,
            },
          },
        });
        yield* PubSub.publish(stub.pubsub, {
          type: "thread.token-usage.updated",
          eventId: "evt-2" as never,
          provider: ProviderDriverKind.make("cursor"),
          threadId: "thread-b" as never,
          createdAt: "2026-04-18T00:01:00.000Z",
          payload: {
            usage: {
              usedTokens: 20,
              maxTokens: 100,
            },
          },
        });
        yield* PubSub.publish(stub.pubsub, {
          type: "thread.token-usage.updated",
          eventId: "evt-3" as never,
          provider: ProviderDriverKind.make("cursor"),
          threadId: "thread-a" as never,
          createdAt: "2026-04-18T00:02:00.000Z",
          payload: {
            usage: {
              usedTokens: 60,
              maxTokens: 100,
            },
          },
        });

        yield* Effect.sleep("10 millis");
        return yield* usageState.get(ProviderDriverKind.make("cursor"));
      }).pipe(Effect.provide(ProviderUsageStateLive.pipe(Layer.provide(stub.layer)))),
    );

    expect(state?.windows).toEqual([{ kind: "session", label: "Context window", usedPercent: 60 }]);
  });

  it("ingests Claude runtime rate limit telemetry when utilization is present", async () => {
    const stub = makeProviderServiceStub();
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* Effect.sleep("10 millis");
        yield* PubSub.publish(stub.pubsub, {
          type: "account.rate-limits.updated",
          eventId: "evt-claude-1" as never,
          provider: ProviderDriverKind.make("claudeAgent"),
          threadId: "thread-claude-1" as never,
          createdAt: "2026-04-18T00:00:00.000Z",
          payload: {
            rateLimits: {
              type: "rate_limit_event",
              rate_limit_info: {
                status: "allowed",
                rateLimitType: "seven_day_opus",
                utilization: 64,
                resetsAt: 1776448800,
              },
            },
          },
        });

        yield* Effect.sleep("10 millis");
        return yield* usageState.get(ProviderDriverKind.make("claudeAgent"));
      }).pipe(Effect.provide(ProviderUsageStateLive.pipe(Layer.provide(stub.layer)))),
    );

    expect(state?.windows).toEqual([
      {
        kind: "weekly",
        label: "Weekly",
        usedPercent: 64,
        windowDurationMins: 10080,
        resetsAt: "2026-04-17T18:00:00.000Z",
      },
    ]);
  });

  it("ignores Claude runtime rate limit telemetry when utilization is absent", async () => {
    const stub = makeProviderServiceStub();
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* Effect.sleep("10 millis");
        yield* PubSub.publish(stub.pubsub, {
          type: "account.rate-limits.updated",
          eventId: "evt-claude-2" as never,
          provider: ProviderDriverKind.make("claudeAgent"),
          threadId: "thread-claude-2" as never,
          createdAt: "2026-04-18T00:00:00.000Z",
          payload: {
            rateLimits: {
              type: "rate_limit_event",
              rate_limit_info: {
                status: "allowed",
                rateLimitType: "five_hour",
                resetsAt: 1776448800,
              },
            },
          },
        });

        yield* Effect.sleep("10 millis");
        return yield* usageState.get(ProviderDriverKind.make("claudeAgent"));
      }).pipe(Effect.provide(ProviderUsageStateLive.pipe(Layer.provide(stub.layer)))),
    );

    expect(state).toBeUndefined();
  });
});
