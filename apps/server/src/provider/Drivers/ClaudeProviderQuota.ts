import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderQuotaMetric,
  type ProviderQuotaSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ProviderQuotaPublicMessage, type ProviderQuotaCapability } from "../ProviderQuota.ts";

const DRIVER = ProviderDriverKind.make("claudeAgent");
const SOURCE = "claude-agent-sdk";
const MAX_EVENT_AGE_MS = 30 * 60 * 1_000;

export type ClaudeRateLimitEvent = Extract<SDKMessage, { readonly type: "rate_limit_event" }>;

interface RecordedClaudeQuota {
  readonly observedAt: string;
  readonly expiresAtMs: number;
  readonly metrics: ReadonlyArray<ProviderQuotaMetric>;
  readonly headlineMetricKey: string | null;
  readonly detail: Readonly<Record<string, string>>;
}

const unixSecondsToDateTime = (value: number | undefined): Option.Option<DateTime.Utc> =>
  value !== undefined && Number.isFinite(value) ? DateTime.make(value * 1_000) : Option.none();

const normalizeDetail = (
  info: ClaudeRateLimitEvent["rate_limit_info"],
): Readonly<Record<string, string>> => ({
  status: info.status,
  ...(info.rateLimitType ? { rateLimitType: info.rateLimitType } : {}),
  ...(info.overageStatus ? { overageStatus: info.overageStatus } : {}),
  ...(info.overageDisabledReason ? { overageDisabledReason: info.overageDisabledReason } : {}),
});

const normalizeEvent = (
  event: ClaudeRateLimitEvent,
  observedAt: DateTime.Utc,
): RecordedClaudeQuota => {
  const info = event.rate_limit_info;
  const reset = unixSecondsToDateTime(info.resetsAt);
  const utilization =
    info.utilization !== undefined && Number.isFinite(info.utilization) ? info.utilization : null;
  const metrics: ReadonlyArray<ProviderQuotaMetric> =
    utilization === null
      ? []
      : [
          {
            key: "claude",
            label: "Claude usage",
            remainingPercent: 100 - utilization,
            usedPercent: utilization,
            resetsAt: Option.match(reset, {
              onNone: () => null,
              onSome: DateTime.formatIso,
            }),
            windowMinutes: null,
            blocking: true,
          },
        ];
  const observedAtMs = DateTime.toEpochMillis(observedAt);
  const expiresAtMs = Math.min(
    observedAtMs + MAX_EVENT_AGE_MS,
    Option.match(reset, {
      onNone: () => Number.POSITIVE_INFINITY,
      onSome: DateTime.toEpochMillis,
    }),
  );

  return {
    observedAt: DateTime.formatIso(observedAt),
    expiresAtMs,
    metrics,
    headlineMetricKey: metrics.length > 0 ? "claude" : null,
    detail: normalizeDetail(info),
  };
};

export const makeClaudeProviderQuota = Effect.fn("makeClaudeProviderQuota")(function* (
  instanceId: ProviderInstanceId,
) {
  const eventRef = yield* Ref.make<RecordedClaudeQuota | null>(null);
  const revisionRef = yield* Ref.make(0);

  const read: ProviderQuotaCapability["read"] = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const readAt = DateTime.formatIso(now);
    const recorded = yield* Ref.get(eventRef);

    if (recorded === null) {
      return {
        instanceId,
        driver: DRIVER,
        status: "unknown",
        source: SOURCE,
        readAt,
        lastSuccessfulReadAt: null,
        headlineMetricKey: null,
        metrics: [],
        credits: null,
        bankedResets: null,
        detail: {},
        message: ProviderQuotaPublicMessage.unavailable,
      } satisfies ProviderQuotaSnapshot;
    }

    const stale = DateTime.toEpochMillis(now) >= recorded.expiresAtMs;
    return {
      instanceId,
      driver: DRIVER,
      status: stale ? "stale" : "current",
      source: SOURCE,
      readAt,
      lastSuccessfulReadAt: recorded.observedAt,
      headlineMetricKey: stale ? null : recorded.headlineMetricKey,
      metrics: stale
        ? recorded.metrics.map((metric) => ({ ...metric, remainingPercent: null }))
        : recorded.metrics,
      credits: null,
      bankedResets: null,
      detail: recorded.detail,
      message: null,
    } satisfies ProviderQuotaSnapshot;
  });

  const recordRateLimitEvent = Effect.fn("ClaudeProviderQuota.recordRateLimitEvent")(function* (
    event: ClaudeRateLimitEvent,
  ) {
    const observedAt = yield* DateTime.now;
    yield* Ref.set(eventRef, normalizeEvent(event, observedAt));
    yield* Ref.update(revisionRef, (revision) => revision + 1);
  });

  return {
    quota: {
      read,
      revision: Ref.get(revisionRef),
    } satisfies ProviderQuotaCapability,
    recordRateLimitEvent,
  };
});
