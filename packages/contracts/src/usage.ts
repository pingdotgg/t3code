import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

// ---------------------------------------------------------------------------
// Usage facts
//
// A usage fact is an immutable accounting record: interval token counters (never
// cumulative) attributed to a provider-native session so that concurrent or
// resumed provider sessions on one T3 thread can never be conflated. Facts are
// persisted as `thread.usage-recorded` orchestration events and projected into
// `projection_usage_facts` / `projection_usage_daily` by a registered projector.
// ---------------------------------------------------------------------------

export const UsageFactId = TrimmedNonEmptyString.pipe(Schema.brand("UsageFactId"));
export type UsageFactId = typeof UsageFactId.Type;

/** Interval (delta) token counters. Adapters convert cumulative provider
 * counters into deltas before a fact is emitted; a fact never carries a
 * running total. `cachedInputTokens` are cache reads; `cacheCreationTokens`
 * are cache writes — they are priced differently and never summed silently. */
export const UsageTokenCounters = Schema.Struct({
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningOutputTokens: NonNegativeInt,
});
export type UsageTokenCounters = typeof UsageTokenCounters.Type;

/** `final` — per-model settlement derived from a provider's terminal report
 * (Claude modelUsage deltas). `interval` — an accumulated slice of a turn
 * flushed before settlement (Codex per-update deltas); intervals and finals
 * both sum linearly. `turn-total` — the provider's own turn-level cost figure
 * kept only to reconcile against per-model facts, never added to them. */
export const UsageFactKind = Schema.Literals(["final", "interval", "turn-total"]);
export type UsageFactKind = typeof UsageFactKind.Type;

export const UsageFact = Schema.Struct({
  factId: UsageFactId,
  kind: UsageFactKind,
  provider: ProviderDriverKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  /** Provider-native session identity (Claude session_id, Codex thread id).
   * Falls back to the T3 thread id when a driver exposes nothing better. */
  providerSessionId: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  /** Model id exactly as the provider reported it (e.g. with `[1m]` suffix). */
  modelRaw: TrimmedNonEmptyString,
  reasoningEffort: Schema.optional(TrimmedNonEmptyString),
  tokens: UsageTokenCounters,
  /** Exact provider-reported cost in integer micro-USD. Absent when the
   * provider does not meter (Codex); estimates are computed at query time and
   * never stored. */
  costMicroUsd: Schema.optional(NonNegativeInt),
  /** True when the originating runtime event was rejected by the turn
   * lifecycle guard (stale completion); recorded rather than dropped. */
  stale: Schema.optional(Schema.Boolean),
  observedAt: IsoDateTime,
});
export type UsageFact = typeof UsageFact.Type;

// ---------------------------------------------------------------------------
// Claude SDK modelUsage — typed replacement for the UnknownRecord that rides
// on `turn.completed`. Keys of the map are raw model ids.
// ---------------------------------------------------------------------------

export const ClaudeModelUsageEntry = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadInputTokens: NonNegativeInt,
  cacheCreationInputTokens: NonNegativeInt,
  costUSD: Schema.optional(Schema.Number),
});
export type ClaudeModelUsageEntry = typeof ClaudeModelUsageEntry.Type;

export const ClaudeModelUsageMap = Schema.Record(Schema.String, ClaudeModelUsageEntry);
export type ClaudeModelUsageMap = typeof ClaudeModelUsageMap.Type;

// ---------------------------------------------------------------------------
// usage.summary RPC — one dashboard-shaped request so the Usage page renders
// from a single round trip. All aggregates are integers (tokens) or integer
// micro-USD; grouping happens in the requested IANA timezone.
// ---------------------------------------------------------------------------

export const UsageSummaryRequest = Schema.Struct({
  /** Inclusive ISO date-time lower bound; omit for all time. */
  since: Schema.optional(IsoDateTime),
  /** Exclusive ISO date-time upper bound; omit for now. */
  until: Schema.optional(IsoDateTime),
  /** IANA timezone used for calendar bucketing (daily, hour-of-week). */
  timeZone: TrimmedNonEmptyString,
});
export type UsageSummaryRequest = typeof UsageSummaryRequest.Type;

export const UsageCostSource = Schema.Literals(["exact", "estimated", "none"]);
export type UsageCostSource = typeof UsageCostSource.Type;

const UsageAggregate = Schema.Struct({
  ...UsageTokenCounters.fields,
  totalTokens: NonNegativeInt,
  turns: NonNegativeInt,
  exactCostMicroUsd: NonNegativeInt,
  estimatedCostMicroUsd: NonNegativeInt,
});
export type UsageAggregate = typeof UsageAggregate.Type;

export const UsageModelBucket = Schema.Struct({
  ...UsageAggregate.fields,
  provider: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  costSource: UsageCostSource,
});
export type UsageModelBucket = typeof UsageModelBucket.Type;

export const UsageDailyBucket = Schema.Struct({
  ...UsageAggregate.fields,
  /** Local calendar date (YYYY-MM-DD) in the request timezone. */
  day: TrimmedNonEmptyString,
  provider: ProviderDriverKind,
  model: TrimmedNonEmptyString,
});
export type UsageDailyBucket = typeof UsageDailyBucket.Type;

export const UsageHourOfWeekBucket = Schema.Struct({
  /** 0 = Sunday, per JS Date#getDay in the request timezone. */
  dayOfWeek: NonNegativeInt,
  hour: NonNegativeInt,
  turns: NonNegativeInt,
  totalTokens: NonNegativeInt,
});
export type UsageHourOfWeekBucket = typeof UsageHourOfWeekBucket.Type;

export const UsageProjectBucket = Schema.Struct({
  ...UsageAggregate.fields,
  projectId: Schema.NullOr(ProjectId),
  projectTitle: Schema.NullOr(TrimmedNonEmptyString),
});
export type UsageProjectBucket = typeof UsageProjectBucket.Type;

export const UsageSummaryResponse = Schema.Struct({
  totals: UsageAggregate,
  byModel: Schema.Array(UsageModelBucket),
  daily: Schema.Array(UsageDailyBucket),
  hourOfWeek: Schema.Array(UsageHourOfWeekBucket),
  byProject: Schema.Array(UsageProjectBucket),
  /** Models with token volume but no pricing entry — surfaced, never $0. */
  unpricedModels: Schema.Array(TrimmedNonEmptyString),
  pricingVersion: TrimmedNonEmptyString,
  /** Earliest fact in the ledger, for "history starts here" honesty. */
  earliestFactAt: Schema.NullOr(IsoDateTime),
});
export type UsageSummaryResponse = typeof UsageSummaryResponse.Type;
