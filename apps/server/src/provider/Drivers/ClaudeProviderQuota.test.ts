import * as NodeAssert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderDriverKind, ProviderInstanceId, ProviderQuotaSnapshot } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { makeClaudeProviderQuota, type ClaudeRateLimitEvent } from "./ClaudeProviderQuota.ts";

const instanceId = ProviderInstanceId.make("claude-work");
const initialTimeMs = 1_700_000_000_000;
const initialTimeIso = "2023-11-14T22:13:20.000Z";
const decodeProviderQuotaSnapshot = Schema.decodeUnknownSync(ProviderQuotaSnapshot);

const rateLimitEvent = (
  rateLimitInfo: ClaudeRateLimitEvent["rate_limit_info"],
): Extract<SDKMessage, { readonly type: "rate_limit_event" }> => ({
  type: "rate_limit_event",
  rate_limit_info: rateLimitInfo,
  uuid: "00000000-0000-4000-8000-000000000001",
  session_id: "claude-session-1",
});

it.effect("returns honest unknown quota before Claude reports a rate-limit event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(initialTimeMs);
    const tracker = yield* makeClaudeProviderQuota(instanceId);

    NodeAssert.deepStrictEqual(yield* tracker.quota.read, {
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      status: "unknown",
      source: "claude-agent-sdk",
      readAt: initialTimeIso,
      lastSuccessfulReadAt: null,
      headlineMetricKey: null,
      metrics: [],
      credits: null,
      bankedResets: null,
      detail: {},
      message: "Quota information is unavailable for this provider.",
    });
    NodeAssert.equal(yield* tracker.quota.revision, 0);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("normalizes Claude utilization ratios, reset time, and safe SDK metadata", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(initialTimeMs);
    const tracker = yield* makeClaudeProviderQuota(instanceId);

    yield* tracker.recordRateLimitEvent(
      rateLimitEvent({
        status: "allowed_warning",
        utilization: 0.82,
        resetsAt: 1_700_003_600,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits",
      }),
    );

    NodeAssert.deepStrictEqual(yield* tracker.quota.read, {
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      status: "current",
      source: "claude-agent-sdk",
      readAt: initialTimeIso,
      lastSuccessfulReadAt: initialTimeIso,
      headlineMetricKey: "claude",
      metrics: [
        {
          key: "claude",
          label: "Claude usage",
          remainingPercent: 18,
          usedPercent: 82,
          resetsAt: "2023-11-14T23:13:20.000Z",
          windowMinutes: null,
          blocking: true,
        },
      ],
      credits: null,
      bankedResets: null,
      detail: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits",
      },
      message: null,
    });
    NodeAssert.equal(yield* tracker.quota.revision, 1);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("truncates provider-derived Claude detail before contract encoding", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(initialTimeMs);
    const tracker = yield* makeClaudeProviderQuota(instanceId);
    yield* tracker.recordRateLimitEvent(
      rateLimitEvent({
        status: "allowed",
        utilization: 0.5,
        overageDisabledReason: "x".repeat(700),
      } as ClaudeRateLimitEvent["rate_limit_info"]),
    );

    const snapshot = yield* tracker.quota.read;
    NodeAssert.doesNotThrow(() => decodeProviderQuotaSnapshot(snapshot));
    NodeAssert.equal(snapshot.detail.overageDisabledReason?.length, 512);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("normalizes the valid Claude utilization ratio boundaries", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(initialTimeMs);

    for (const [utilization, usedPercent, remainingPercent] of [
      [0, 0, 100],
      [1, 100, 0],
    ] as const) {
      const tracker = yield* makeClaudeProviderQuota(instanceId);
      yield* tracker.recordRateLimitEvent(rateLimitEvent({ status: "allowed", utilization }));

      const metric = (yield* tracker.quota.read).metrics[0];
      NodeAssert.equal(metric?.usedPercent, usedPercent);
      NodeAssert.equal(metric?.remainingPercent, remainingPercent);
    }
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("omits quota headlines for absent, non-finite, or out-of-range utilization", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(initialTimeMs);

    for (const utilization of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01]) {
      const tracker = yield* makeClaudeProviderQuota(instanceId);
      yield* tracker.recordRateLimitEvent(
        rateLimitEvent({
          status: "rejected",
          ...(utilization === undefined ? {} : { utilization }),
          resetsAt: Number.NaN,
        }),
      );

      const snapshot = yield* tracker.quota.read;
      NodeAssert.equal(snapshot.status, "current");
      NodeAssert.equal(snapshot.headlineMetricKey, null);
      NodeAssert.deepStrictEqual(snapshot.metrics, []);
      NodeAssert.deepStrictEqual(snapshot.detail, { status: "rejected" });
    }
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("marks Claude quota stale at the 30-minute observation boundary", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(initialTimeMs);
    const tracker = yield* makeClaudeProviderQuota(instanceId);
    yield* tracker.recordRateLimitEvent(
      rateLimitEvent({
        status: "allowed",
        utilization: 0.25,
        resetsAt: 1_700_007_200,
      }),
    );

    yield* TestClock.adjust("29 minutes");
    NodeAssert.equal((yield* tracker.quota.read).status, "current");

    yield* TestClock.adjust("1 minute");
    const stale = yield* tracker.quota.read;
    NodeAssert.equal(stale.status, "stale");
    NodeAssert.equal(stale.readAt, "2023-11-14T22:43:20.000Z");
    NodeAssert.equal(stale.lastSuccessfulReadAt, initialTimeIso);
    NodeAssert.equal(stale.headlineMetricKey, null);
    NodeAssert.equal(stale.metrics[0]?.remainingPercent, null);
    NodeAssert.equal(stale.metrics[0]?.usedPercent, 25);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("marks Claude quota stale at an earlier SDK reset boundary", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(initialTimeMs);
    const tracker = yield* makeClaudeProviderQuota(instanceId);
    yield* tracker.recordRateLimitEvent(
      rateLimitEvent({
        status: "allowed",
        utilization: 0.1,
        resetsAt: 1_700_000_600,
      }),
    );

    yield* TestClock.adjust("10 minutes");
    const stale = yield* tracker.quota.read;
    NodeAssert.equal(stale.status, "stale");
    NodeAssert.equal(stale.headlineMetricKey, null);
    NodeAssert.equal(stale.metrics[0]?.remainingPercent, null);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("keeps Claude quota state and revisions isolated per provider instance", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(initialTimeMs);
    const first = yield* makeClaudeProviderQuota(ProviderInstanceId.make("claude-first"));
    const second = yield* makeClaudeProviderQuota(ProviderInstanceId.make("claude-second"));

    yield* first.recordRateLimitEvent(rateLimitEvent({ status: "allowed", utilization: 0.4 }));
    yield* first.recordRateLimitEvent(
      rateLimitEvent({ status: "allowed_warning", utilization: 0.5 }),
    );

    NodeAssert.equal(yield* first.quota.revision, 2);
    NodeAssert.equal((yield* first.quota.read).metrics[0]?.remainingPercent, 50);
    NodeAssert.equal(yield* second.quota.revision, 0);
    NodeAssert.equal((yield* second.quota.read).status, "unknown");
  }).pipe(Effect.provide(TestClock.layer())),
);
