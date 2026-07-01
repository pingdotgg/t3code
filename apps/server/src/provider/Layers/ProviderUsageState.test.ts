import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ProviderDriverKind, ProviderInstanceId, type ThreadId } from "@t3tools/contracts";

import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderUsageState } from "../Services/ProviderUsageState.ts";
import { makeProviderUsageStateTestHarness } from "./ProviderUsageState.testHarness.ts";

describe("ProviderUsageStateLive", () => {
  it("sets, gets, and clears usage by provider", async () => {
    const harness = makeProviderUsageStateTestHarness();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* usageState.set(
          ProviderDriverKind.make("codex"),
          undefined,
          "thread-probe" as ThreadId,
          {
            source: "codexAppServer",
            available: true,
            checkedAt: "2026-04-18T00:00:00.000Z",
            windows: [{ kind: "session", label: "Session", usedPercent: 25 }],
          },
        );
        const first = yield* usageState.get(ProviderDriverKind.make("codex"));
        yield* usageState.clear(ProviderDriverKind.make("codex"));
        const second = yield* usageState.get(ProviderDriverKind.make("codex"));

        return { first, second };
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(result.first?.windows).toEqual([{ kind: "session", label: "Session", usedPercent: 25 }]);
    expect(result.second).toBeUndefined();
  });

  it("ignores Grok token usage events because subscription usage is unavailable", async () => {
    const harness = makeProviderUsageStateTestHarness();
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* Effect.sleep("10 millis");
        yield* PubSub.publish(harness.pubsub, {
          type: "thread.token-usage.updated",
          eventId: "evt-grok-1" as never,
          provider: ProviderDriverKind.make("grok"),
          threadId: "thread-grok-1" as never,
          createdAt: "2026-06-20T00:00:00.000Z",
          payload: {
            usage: {
              usedTokens: 25,
              maxTokens: 200_000,
            },
          },
        });

        yield* Effect.sleep("10 millis");

        return yield* usageState.get(ProviderDriverKind.make("grok"));
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(state).toBeUndefined();
  });

  it("ignores Cursor token usage events because subscription usage is unavailable", async () => {
    const harness = makeProviderUsageStateTestHarness();
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* Effect.sleep("10 millis");
        yield* PubSub.publish(harness.pubsub, {
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
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(state.cursor).toBeUndefined();
    expect(state.opencode).toBeUndefined();
  });

  it("returns the most recently updated Codex rate limit usage", async () => {
    const harness = makeProviderUsageStateTestHarness();
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* Effect.sleep("10 millis");
        yield* PubSub.publish(harness.pubsub, {
          type: "account.rate-limits.updated",
          eventId: "evt-1" as never,
          provider: ProviderDriverKind.make("codex"),
          threadId: "thread-a" as never,
          createdAt: "2026-04-18T00:00:00.000Z",
          payload: {
            rateLimits: {
              primary: { usedPercent: 10, windowDurationMins: 300 },
              secondary: { usedPercent: 15, windowDurationMins: 10080 },
            },
          },
        });
        yield* PubSub.publish(harness.pubsub, {
          type: "account.rate-limits.updated",
          eventId: "evt-2" as never,
          provider: ProviderDriverKind.make("codex"),
          threadId: "thread-b" as never,
          createdAt: "2026-04-18T00:01:00.000Z",
          payload: {
            rateLimits: {
              primary: { usedPercent: 20, windowDurationMins: 300 },
            },
          },
        });
        yield* PubSub.publish(harness.pubsub, {
          type: "account.rate-limits.updated",
          eventId: "evt-3" as never,
          provider: ProviderDriverKind.make("codex"),
          threadId: "thread-a" as never,
          createdAt: "2026-04-18T00:02:00.000Z",
          payload: {
            rateLimits: {
              primary: { usedPercent: 60, windowDurationMins: 300 },
            },
          },
        });

        yield* Effect.sleep("10 millis");
        return yield* usageState.get(ProviderDriverKind.make("codex"));
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(state?.windows).toEqual([
      { kind: "session", label: "Session", usedPercent: 60, windowDurationMins: 300 },
      { kind: "weekly", label: "Weekly", usedPercent: 15, windowDurationMins: 10080 },
    ]);
  });

  it("ingests Claude runtime rate limit telemetry when utilization is present", async () => {
    const harness = makeProviderUsageStateTestHarness();
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* Effect.sleep("10 millis");
        yield* PubSub.publish(harness.pubsub, {
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
      }).pipe(Effect.provide(harness.layer)),
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

  it("ingests Codex runtime rate limit telemetry when windows are present", async () => {
    const harness = makeProviderUsageStateTestHarness();
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* Effect.sleep("10 millis");
        yield* PubSub.publish(harness.pubsub, {
          type: "account.rate-limits.updated",
          eventId: "evt-codex-1" as never,
          provider: ProviderDriverKind.make("codex"),
          threadId: "thread-codex-1" as never,
          createdAt: "2026-04-18T00:00:00.000Z",
          payload: {
            rateLimits: {
              primary: { usedPercent: 25, windowDurationMins: 300 },
              secondary: { usedPercent: 50, windowDurationMins: 10080 },
            },
          },
        });

        yield* Effect.sleep("10 millis");
        return yield* usageState.get(ProviderDriverKind.make("codex"));
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(state?.source).toBe("codexAppServer");
    expect(state?.windows).toEqual([
      {
        kind: "session",
        label: "Session",
        usedPercent: 25,
        windowDurationMins: 300,
      },
      {
        kind: "weekly",
        label: "Weekly",
        usedPercent: 50,
        windowDurationMins: 10080,
      },
    ]);
  });

  it("ignores Codex runtime rate limit telemetry when no usable windows are present", async () => {
    const harness = makeProviderUsageStateTestHarness();
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* Effect.sleep("10 millis");
        yield* PubSub.publish(harness.pubsub, {
          type: "account.rate-limits.updated",
          eventId: "evt-codex-2" as never,
          provider: ProviderDriverKind.make("codex"),
          threadId: "thread-codex-2" as never,
          createdAt: "2026-04-18T00:00:00.000Z",
          payload: {
            // Missing `usedPercent` on both windows — no usable signal.
            rateLimits: {
              primary: { windowDurationMins: 300 },
            },
          },
        });

        yield* Effect.sleep("10 millis");
        return yield* usageState.get(ProviderDriverKind.make("codex"));
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(state).toBeUndefined();
  });

  it("does not patch provider registry when unavailable token usage arrives", async () => {
    const patches: Array<{
      readonly instanceId: ProviderInstanceId;
      readonly usage: { readonly source?: string; readonly available?: boolean };
    }> = [];
    const registryLayer = Layer.succeed(ProviderRegistry, {
      getProviders: Effect.succeed([]),
      refresh: () => Effect.succeed([]),
      refreshInstance: () => Effect.succeed([]),
      getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
      setProviderMaintenanceActionState: () => Effect.succeed([]),
      patchProviderUsageLimits: (instanceId, usageLimits) =>
        Effect.sync(() => {
          patches.push({ instanceId, usage: usageLimits });
        }),
      streamChanges: Stream.empty,
    });
    const harness = makeProviderUsageStateTestHarness();

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.sleep("10 millis");
        yield* PubSub.publish(harness.pubsub, {
          type: "thread.token-usage.updated",
          eventId: "evt-grok-patch" as never,
          provider: ProviderDriverKind.make("grok"),
          providerInstanceId: ProviderInstanceId.make("grok"),
          threadId: "thread-grok-1" as never,
          createdAt: "2026-06-20T00:00:00.000Z",
          payload: {
            usage: {
              usedTokens: 25,
              maxTokens: 200_000,
            },
          },
        });
        yield* PubSub.publish(harness.pubsub, {
          type: "thread.token-usage.updated",
          eventId: "evt-cursor-patch" as never,
          provider: ProviderDriverKind.make("cursor"),
          providerInstanceId: ProviderInstanceId.make("cursor"),
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
      }).pipe(Effect.provide(harness.layer.pipe(Layer.provide(registryLayer)))),
    );

    expect(patches).toHaveLength(0);
  });

  it("patches provider registry with sparse runtime updates only", async () => {
    const patches: Array<{
      readonly instanceId: ProviderInstanceId;
      readonly usage: { readonly windows: ReadonlyArray<{ readonly kind: string }> };
    }> = [];
    const registryLayer = Layer.succeed(ProviderRegistry, {
      getProviders: Effect.succeed([]),
      refresh: () => Effect.succeed([]),
      refreshInstance: () => Effect.succeed([]),
      getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
      setProviderMaintenanceActionState: () => Effect.succeed([]),
      patchProviderUsageLimits: (instanceId, usageLimits) =>
        Effect.sync(() => {
          patches.push({ instanceId, usage: usageLimits });
        }),
      streamChanges: Stream.empty,
    });
    const harness = makeProviderUsageStateTestHarness();
    const instanceId = ProviderInstanceId.make("codex");

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.sleep("10 millis");
        yield* PubSub.publish(harness.pubsub, {
          type: "account.rate-limits.updated",
          eventId: "evt-1" as never,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: "thread-a" as never,
          createdAt: "2026-04-18T00:00:00.000Z",
          payload: {
            rateLimits: {
              primary: { usedPercent: 10, windowDurationMins: 300 },
              secondary: { usedPercent: 15, windowDurationMins: 10080 },
            },
          },
        });
        yield* PubSub.publish(harness.pubsub, {
          type: "account.rate-limits.updated",
          eventId: "evt-2" as never,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: "thread-b" as never,
          createdAt: "2026-04-18T00:01:00.000Z",
          payload: {
            rateLimits: {
              primary: { usedPercent: 60, windowDurationMins: 300 },
            },
          },
        });
        yield* Effect.sleep("10 millis");
      }).pipe(Effect.provide(harness.layer.pipe(Layer.provide(registryLayer)))),
    );

    expect(patches).toHaveLength(2);
    expect(patches[1]?.usage.windows.map((window) => window.kind)).toEqual(["session"]);
  });

  it("ignores Claude runtime rate limit telemetry when utilization is absent", async () => {
    const harness = makeProviderUsageStateTestHarness();
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const usageState = yield* ProviderUsageState;

        yield* Effect.sleep("10 millis");
        yield* PubSub.publish(harness.pubsub, {
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
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(state).toBeUndefined();
  });
});
