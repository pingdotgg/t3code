import * as NodeAssert from "node:assert/strict";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderQuotaSnapshot,
  CodexSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as CodexClient from "effect-codex-app-server/client";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { makeCodexProviderQuota, normalizeCodexProviderQuota } from "./CodexProviderQuota.ts";

const instanceId = ProviderInstanceId.make("codex-work");
const readAt = "2026-08-11T10:00:00.000Z";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeProviderQuotaSnapshot = Schema.decodeUnknownSync(ProviderQuotaSnapshot);

const richResponse = {
  rateLimits: {
    credits: { balance: "12.345678901234567890", hasCredits: true, unlimited: false },
    individualLimit: {
      limit: "250.00",
      remainingPercent: 35,
      resetsAt: 1_700_007_200,
      used: "162.50",
    },
    limitId: "codex",
    limitName: "Codex",
    planType: "plus",
    primary: { resetsAt: 1_700_000_000, usedPercent: 20, windowDurationMins: 300 },
    rateLimitReachedType: "rate_limit_reached",
    secondary: { resetsAt: 1_700_003_600, usedPercent: 75, windowDurationMins: 10_080 },
    spendControlReached: false,
  },
  rateLimitsByLimitId: {
    gpt: {
      individualLimit: {
        limit: "50.00",
        remainingPercent: 5,
        resetsAt: 1_700_018_000,
        used: "45.00",
      },
      limitId: "gpt",
      limitName: "GPT models",
      planType: "plus",
      primary: { resetsAt: 1_700_010_800, usedPercent: 60, windowDurationMins: 60 },
      secondary: { resetsAt: 1_700_014_400, usedPercent: 90, windowDurationMins: 1_440 },
    },
  },
  rateLimitResetCredits: {
    availableCount: 2,
    credits: [
      {
        id: "credit-1",
        title: "One reset",
        description: "Restore the coding limit",
        grantedAt: 1_700_000_000,
        expiresAt: 1_700_086_400,
        resetType: "codexRateLimits",
        status: "available",
      },
    ],
  },
} satisfies CodexSchema.V2GetAccountRateLimitsResponse;

it("normalizes every blocking Codex window, credits, metadata, and capped reset details", () => {
  const snapshot = normalizeCodexProviderQuota(richResponse, instanceId, readAt);

  NodeAssert.deepStrictEqual(snapshot, {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    status: "current",
    source: "codex-app-server",
    readAt,
    lastSuccessfulReadAt: readAt,
    headlineMetricKey: "limit:gpt:individual",
    metrics: [
      {
        key: "primary",
        label: "Primary (300 min)",
        remainingPercent: 80,
        usedPercent: 20,
        resetsAt: "2023-11-14T22:13:20.000Z",
        windowMinutes: 300,
        blocking: true,
      },
      {
        key: "secondary",
        label: "Secondary (10080 min)",
        remainingPercent: 25,
        usedPercent: 75,
        resetsAt: "2023-11-14T23:13:20.000Z",
        windowMinutes: 10_080,
        blocking: true,
      },
      {
        key: "individualLimit",
        label: "Individual limit",
        remainingPercent: 35,
        usedPercent: null,
        resetsAt: "2023-11-15T00:13:20.000Z",
        windowMinutes: null,
        blocking: true,
      },
      {
        key: "limit:gpt:primary",
        label: "GPT models primary (60 min)",
        remainingPercent: 40,
        usedPercent: 60,
        resetsAt: "2023-11-15T01:13:20.000Z",
        windowMinutes: 60,
        blocking: true,
      },
      {
        key: "limit:gpt:secondary",
        label: "GPT models secondary (1440 min)",
        remainingPercent: 10,
        usedPercent: 90,
        resetsAt: "2023-11-15T02:13:20.000Z",
        windowMinutes: 1_440,
        blocking: true,
      },
      {
        key: "limit:gpt:individual",
        label: "GPT models individual limit",
        remainingPercent: 5,
        usedPercent: null,
        resetsAt: "2023-11-15T03:13:20.000Z",
        windowMinutes: null,
        blocking: true,
      },
    ],
    credits: {
      balance: "12.345678901234567890",
      hasCredits: true,
      unlimited: false,
    },
    bankedResets: {
      availableCount: 2,
      resets: [
        {
          id: "credit-1",
          title: "One reset",
          description: "Restore the coding limit",
          grantedAt: "2023-11-14T22:13:20.000Z",
          expiresAt: "2023-11-15T22:13:20.000Z",
          resetType: "codexRateLimits",
          status: "available",
        },
      ],
      detailsComplete: false,
    },
    detail: {
      limitId: "codex",
      limitName: "Codex",
      planType: "plus",
      rateLimitReachedType: "rate_limit_reached",
      spendControlReached: "false",
    },
    message: null,
  } satisfies ProviderQuotaSnapshot);
});

it("preserves a banked reset count when detail rows are unavailable", () => {
  const snapshot = normalizeCodexProviderQuota(
    {
      rateLimits: {},
      rateLimitResetCredits: { availableCount: 3, credits: null },
    },
    instanceId,
    readAt,
  );

  NodeAssert.deepStrictEqual(snapshot.bankedResets, {
    availableCount: 3,
    resets: [],
    detailsComplete: false,
  });
});

it("clamps derived remaining capacity for out-of-range provider usage", () => {
  const snapshot = normalizeCodexProviderQuota(
    {
      rateLimits: {
        primary: { usedPercent: -20 },
        secondary: { usedPercent: 140 },
      },
    },
    instanceId,
    readAt,
  );

  NodeAssert.deepStrictEqual(
    snapshot.metrics.map(({ key, remainingPercent, usedPercent }) => ({
      key,
      remainingPercent,
      usedPercent,
    })),
    [
      { key: "primary", remainingPercent: 100, usedPercent: -20 },
      { key: "secondary", remainingPercent: 0, usedPercent: 140 },
    ],
  );
  NodeAssert.equal(snapshot.headlineMetricKey, "secondary");
});

it("bounds provider-derived display strings and opaque identities before contract encoding", () => {
  const longIdentifier = "i".repeat(200);
  const longLabel = "l".repeat(400);
  const longDescription = "d".repeat(700);
  const snapshot = normalizeCodexProviderQuota(
    {
      rateLimits: {
        credits: { balance: "b".repeat(400), hasCredits: true, unlimited: false },
        limitId: longIdentifier,
        limitName: longLabel,
      },
      rateLimitsByLimitId: {
        [longIdentifier]: {
          limitName: longLabel,
          primary: { usedPercent: 25, windowDurationMins: 300 },
        },
      },
      rateLimitResetCredits: {
        availableCount: 1,
        credits: [
          {
            id: longIdentifier,
            title: longLabel,
            description: longDescription,
            grantedAt: 1_700_000_000,
            resetType: "codexRateLimits",
            status: "available",
          },
        ],
      },
    },
    instanceId,
    readAt,
  );

  NodeAssert.doesNotThrow(() => decodeProviderQuotaSnapshot(snapshot));
  NodeAssert.ok((snapshot.metrics[0]?.key.length ?? Infinity) <= 128);
  NodeAssert.equal(snapshot.metrics[0]?.label.length, 256);
  NodeAssert.equal(snapshot.credits?.balance?.length, 256);
  const resetId = snapshot.bankedResets?.resets[0]?.id;
  NodeAssert.ok(resetId);
  NodeAssert.ok(resetId.length <= 128);
  NodeAssert.match(resetId, /^t3q_reset_[0-9a-f]{64}$/u);
  NodeAssert.notEqual(resetId, longIdentifier);
  NodeAssert.equal(snapshot.bankedResets?.resets[0]?.title?.length, 256);
  NodeAssert.equal(snapshot.bankedResets?.resets[0]?.description?.length, 512);
  NodeAssert.equal(snapshot.detail.limitId?.length, 160);
  NodeAssert.equal(snapshot.detail.limitName?.length, 160);
});

it("keeps same-prefix overlong multi-limit keys distinct and maps the headline to the limiting metric", () => {
  const sharedPrefix = "limit-" + "x".repeat(180);
  const firstLimitId = `${sharedPrefix}-first`;
  const secondLimitId = `${sharedPrefix}-second`;
  const snapshot = normalizeCodexProviderQuota(
    {
      rateLimits: {},
      rateLimitsByLimitId: {
        [firstLimitId]: { primary: { usedPercent: 40 } },
        [secondLimitId]: { primary: { usedPercent: 95 } },
      },
    },
    instanceId,
    readAt,
  );

  const [first, second] = snapshot.metrics;
  NodeAssert.ok(first);
  NodeAssert.ok(second);
  NodeAssert.notEqual(first.key, second.key);
  NodeAssert.ok(first.key.length <= 128);
  NodeAssert.ok(second.key.length <= 128);
  NodeAssert.equal(snapshot.headlineMetricKey, second.key);
  NodeAssert.equal(
    snapshot.metrics.find((metric) => metric.key === snapshot.headlineMetricKey)?.remainingPercent,
    5,
  );
});

it.effect("round-trips an overlong reset token to the original provider credit ID", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const rawCreditId = `credit-${"x".repeat(180)}`;
    let consumedCreditId: string | null | undefined;
    const request = ((method: string, payload: unknown) => {
      switch (method) {
        case "account/read":
          return Effect.succeed({
            account: { type: "chatgpt", email: null, planType: "plus" },
            requiresOpenaiAuth: false,
          });
        case "account/rateLimits/read":
          return Effect.succeed({
            rateLimits: {},
            rateLimitResetCredits: {
              availableCount: 1,
              credits: [
                {
                  id: rawCreditId,
                  grantedAt: 1_700_000_000,
                  resetType: "codexRateLimits",
                  status: "available",
                },
              ],
            },
          });
        case "account/rateLimitResetCredit/consume":
          consumedCreditId = (payload as { readonly creditId: string | null }).creditId;
          return Effect.succeed({ outcome: "reset" });
        default:
          return Effect.die(`Unexpected method ${method}`);
      }
    }) as CodexClient.CodexAppServerClient["Service"]["request"];
    const quota = yield* makeCodexProviderQuota(decodeCodexSettings({}), {}, instanceId, spawner, {
      openClient: Effect.succeed({ request }),
    });
    NodeAssert.ok(quota.consumeBankedReset);

    const token = (yield* quota.read).bankedResets?.resets[0]?.id;
    NodeAssert.ok(token);
    NodeAssert.ok(token.length <= 128);
    NodeAssert.notEqual(token, rawCreditId);
    yield* quota.consumeBankedReset({ creditId: token, idempotencyKey: "attempt-long" });

    NodeAssert.equal(consumedCreditId, rawCreditId);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer))),
);

it.effect("keeps same-prefix overlong reset IDs distinct and actionable", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const sharedPrefix = "credit-" + "x".repeat(180);
    const rawCreditIds = [`${sharedPrefix}-first`, `${sharedPrefix}-second`] as const;
    const consumedCreditIds: Array<string | null> = [];
    const request = ((method: string, payload: unknown) => {
      switch (method) {
        case "account/read":
          return Effect.succeed({
            account: { type: "chatgpt", email: null, planType: "plus" },
            requiresOpenaiAuth: false,
          });
        case "account/rateLimits/read":
          return Effect.succeed({
            rateLimits: {},
            rateLimitResetCredits: {
              availableCount: 2,
              credits: rawCreditIds.map((id) => ({
                id,
                grantedAt: 1_700_000_000,
                resetType: "codexRateLimits" as const,
                status: "available" as const,
              })),
            },
          });
        case "account/rateLimitResetCredit/consume":
          consumedCreditIds.push((payload as { readonly creditId: string | null }).creditId);
          return Effect.succeed({ outcome: "reset" });
        default:
          return Effect.die(`Unexpected method ${method}`);
      }
    }) as CodexClient.CodexAppServerClient["Service"]["request"];
    const quota = yield* makeCodexProviderQuota(decodeCodexSettings({}), {}, instanceId, spawner, {
      openClient: Effect.succeed({ request }),
    });
    const consumeBankedReset = quota.consumeBankedReset;
    NodeAssert.ok(consumeBankedReset);

    const tokens = (yield* quota.read).bankedResets?.resets.map((reset) => reset.id) ?? [];
    NodeAssert.equal(tokens.length, 2);
    NodeAssert.notEqual(tokens[0], tokens[1]);
    yield* Effect.forEach(tokens, (creditId, index) =>
      consumeBankedReset({ creditId, idempotencyKey: `attempt-${index}` }),
    );

    NodeAssert.deepStrictEqual(consumedCreditIds, rawCreditIds);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer))),
);

it.effect("rejects an unknown reset token without forwarding it to Codex", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let consumeCalls = 0;
    const request = ((method: string) => {
      if (method === "account/read") {
        return Effect.succeed({
          account: { type: "chatgpt", email: null, planType: "plus" },
          requiresOpenaiAuth: false,
        });
      }
      if (method === "account/rateLimitResetCredit/consume") consumeCalls += 1;
      return Effect.succeed({ outcome: "reset" });
    }) as CodexClient.CodexAppServerClient["Service"]["request"];
    const quota = yield* makeCodexProviderQuota(decodeCodexSettings({}), {}, instanceId, spawner, {
      openClient: Effect.succeed({ request }),
    });
    NodeAssert.ok(quota.consumeBankedReset);

    const error = yield* quota
      .consumeBankedReset({
        creditId: `t3q_reset_${"0".repeat(64)}`,
        idempotencyKey: "attempt-unknown",
      })
      .pipe(Effect.flip);

    NodeAssert.equal(error.reason, "providerFailed");
    NodeAssert.equal(consumeCalls, 0);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer))),
);

it.effect("classifies a signed-out Codex account as authentication required", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const request = ((method: string) =>
      method === "account/read"
        ? Effect.succeed({ account: null, requiresOpenaiAuth: true })
        : Effect.succeed({
            rateLimits: {},
          })) as CodexClient.CodexAppServerClient["Service"]["request"];
    const quota = yield* makeCodexProviderQuota(decodeCodexSettings({}), {}, instanceId, spawner, {
      openClient: Effect.succeed({ request }),
    });

    const error = yield* quota.read.pipe(Effect.flip);
    NodeAssert.equal(error.reason, "authRequired");
    NodeAssert.equal(error.detail, "Sign in to Codex to view quota information.");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer))),
);

it.effect("classifies an older app-server without quota methods as unsupported", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const request = ((method: string) =>
      method === "account/read"
        ? Effect.succeed({
            account: { type: "chatgpt", email: null, planType: "plus" },
            requiresOpenaiAuth: false,
          })
        : Effect.fail(
            CodexAppServerRequestError.methodNotFound(method),
          )) as CodexClient.CodexAppServerClient["Service"]["request"];
    const quota = yield* makeCodexProviderQuota(decodeCodexSettings({}), {}, instanceId, spawner, {
      openClient: Effect.succeed({ request }),
    });

    const error = yield* quota.read.pipe(Effect.flip);
    NodeAssert.equal(error.reason, "unsupported");
    NodeAssert.equal(error.detail, "This Codex version does not expose provider quota.");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer))),
);

it.effect(
  "forwards one typed consume request per caller key and returns all generated outcomes",
  () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const outcomes = ["reset", "nothingToReset", "noCredit", "alreadyRedeemed"] as const;
      const calls: Array<{ readonly creditId: string | null; readonly idempotencyKey: string }> =
        [];
      let outcomeIndex = 0;
      const request = ((method: string, payload: unknown) => {
        if (method === "account/read") {
          return Effect.succeed({
            account: { type: "chatgpt", email: null, planType: "plus" },
            requiresOpenaiAuth: false,
          });
        }
        NodeAssert.equal(method, "account/rateLimitResetCredit/consume");
        calls.push(
          payload as { readonly creditId: string | null; readonly idempotencyKey: string },
        );
        return Effect.succeed({ outcome: outcomes[outcomeIndex++]! });
      }) as CodexClient.CodexAppServerClient["Service"]["request"];
      const quota = yield* makeCodexProviderQuota(
        decodeCodexSettings({}),
        {},
        instanceId,
        spawner,
        { openClient: Effect.succeed({ request }) },
      );
      NodeAssert.ok(quota.consumeBankedReset);

      const actual = yield* Effect.forEach(
        [
          { creditId: "credit-1", idempotencyKey: "attempt-1" },
          { creditId: null, idempotencyKey: "attempt-2" },
          { creditId: "credit-3", idempotencyKey: "attempt-3" },
          { creditId: "credit-4", idempotencyKey: "attempt-4" },
        ] as const,
        quota.consumeBankedReset,
      );

      NodeAssert.deepStrictEqual(actual, outcomes);
      NodeAssert.deepStrictEqual(calls, [
        { creditId: "credit-1", idempotencyKey: "attempt-1" },
        { creditId: null, idempotencyKey: "attempt-2" },
        { creditId: "credit-3", idempotencyKey: "attempt-3" },
        { creditId: "credit-4", idempotencyKey: "attempt-4" },
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer))),
);

it.effect("caches full reads until a sparse update invalidates and bumps the revision", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let reads = 0;
    const request = ((method: string) => {
      if (method === "account/read") {
        return Effect.succeed({
          account: { type: "chatgpt", email: null, planType: "plus" },
          requiresOpenaiAuth: false,
        });
      }
      NodeAssert.equal(method, "account/rateLimits/read");
      reads += 1;
      return Effect.succeed({ rateLimits: { primary: { usedPercent: reads * 10 } } });
    }) as CodexClient.CodexAppServerClient["Service"]["request"];
    const quota = yield* makeCodexProviderQuota(decodeCodexSettings({}), {}, instanceId, spawner, {
      openClient: Effect.succeed({ request }),
    });

    const first = yield* quota.read;
    const cached = yield* quota.read;
    NodeAssert.equal(first.metrics[0]?.usedPercent, 10);
    NodeAssert.equal(cached.metrics[0]?.usedPercent, 10);
    NodeAssert.equal(reads, 1);
    NodeAssert.equal(yield* quota.revision, 0);

    yield* quota.onRateLimitsUpdated({ rateLimits: { primary: { usedPercent: 99 } } });

    NodeAssert.equal(yield* quota.revision, 1);
    const refreshed = yield* quota.read;
    NodeAssert.equal(refreshed.metrics[0]?.usedPercent, 20);
    NodeAssert.equal(reads, 2);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer))),
);
