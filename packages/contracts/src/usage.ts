/**
 * Usage reporting contract.
 *
 * Each environment scans native session files and databases, including work
 * driven outside T3 Code. Source status describes gaps in local coverage.
 *
 * Environments return pre-aggregated `(day, hourStart?, provider, model, sourcePath?)`
 * buckets. Raw transcript records never cross the wire. A summary read with
 * `groupByThread` also splits buckets by provider account and thread, and lists
 * those threads with their projects.
 *
 * @module usage
 */
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Bump for incompatible UsageSummary changes; skipped unknown array variants need no bump. */
export const USAGE_CONTRACT_VERSION = 6 as const;

export const USAGE_MERGE_COMPATIBLE_SINCE = 4 as const;

export const UsageProviderKind = Schema.Literals([
  "claude",
  "codex",
  "grok",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "muse",
]);
export type UsageProviderKind = typeof UsageProviderKind.Type;

const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const UsageDay = TrimmedNonEmptyString.check(Schema.isPattern(USAGE_DAY_PATTERN)).pipe(
  Schema.brand("UsageDay"),
);
export type UsageDay = typeof UsageDay.Type;

export const UsageResolution = Schema.Literals(["day", "hour"]);
export type UsageResolution = typeof UsageResolution.Type;

export const UsageCostSource = Schema.Literals(["providerReported", "modelPriced", "unpriced"]);
export type UsageCostSource = typeof UsageCostSource.Type;

/** Sum uncached input, cache reads, and cache writes for input totals; reasoning is already included in output. */
export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

export const UsageCategoryCost = Schema.Struct({
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
});
export type UsageCategoryCost = typeof UsageCategoryCost.Type;

export const UsageBucket = Schema.Struct({
  day: UsageDay,
  hourStart: Schema.optional(TrimmedNonEmptyString),
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString,
  sourcePath: Schema.optional(TrimmedNonEmptyString),
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  categoryCostUsd: Schema.optional(UsageCategoryCost),
  fastCostUsd: Schema.optional(Schema.Number),
  ultrafastCostUsd: Schema.optional(Schema.Number),
  speedPremiumUsd: Schema.optional(Schema.Number),
  costSource: UsageCostSource,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  sessions: NonNegativeInt,
  /**
   * Provider instance that recorded these tokens, when it is known. Present
   * only on summaries read with `groupByThread`.
   */
  instanceId: Schema.optional(TrimmedNonEmptyString),
  /** Index into {@link UsageSummary.threads}. Present only with `groupByThread`. */
  thread: Schema.optional(NonNegativeInt),
});
export type UsageBucket = typeof UsageBucket.Type;

/**
 * A conversation that used tokens: a T3 thread, a provider session started
 * outside T3, or a provider-native sub-agent inside either.
 */
export const UsageThread = Schema.Struct({
  /**
   * Stable across summaries: the T3 thread, or the provider session and
   * sub-agent. `parent` indexes stay local to one summary.
   */
  key: TrimmedNonEmptyString,
  /** The T3 thread, when this usage belongs to one. */
  threadId: Schema.optional(ThreadId),
  title: Schema.optional(TrimmedNonEmptyString),
  /** Absent when the work ran outside every project, or the folder is unknown. */
  projectId: Schema.optional(ProjectId),
  /** Index of the thread that started this one. */
  parent: Schema.optional(NonNegativeInt),
  /** A sub-agent the provider ran inside another session, not a thread of its own. */
  subagent: Schema.optional(Schema.Boolean),
  /** Whether the working directory is known. Without it, a missing project means unknown. */
  located: Schema.optional(Schema.Boolean),
});
export type UsageThread = typeof UsageThread.Type;

export const UsageProject = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
});
export type UsageProject = typeof UsageProject.Type;

/**
 * Identifies the physical transcript directory a source read from.
 *
 * Two environments on the same machine (worktree servers, for example) resolve
 * the same provider home and would otherwise double count. The client drops
 * duplicate fingerprints before merging.
 */
export const UsageSourceFingerprint = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  provider: UsageProviderKind,
  resolvedHomePath: TrimmedNonEmptyString,
  /** Transcript directory device:inode distinguishes machines sharing a hostname and home path. */
  volumeId: Schema.String,
});
export type UsageSourceFingerprint = typeof UsageSourceFingerprint.Type;

export const UsageSourceStatus = Schema.Literals(["ok", "missing", "partial", "failed"]);
export type UsageSourceStatus = typeof UsageSourceStatus.Type;

export const UsageSource = Schema.Struct({
  fingerprint: UsageSourceFingerprint,
  status: UsageSourceStatus,
  scannedFiles: NonNegativeInt,
  skippedFiles: NonNegativeInt,
  malformedRecords: NonNegativeInt,
  /** Total this count; bucket counts double-count sessions spanning days or models. */
  distinctSessions: NonNegativeInt,
  message: Schema.NullOr(TrimmedNonEmptyString),
  action: Schema.optionalKey(Schema.Literal("enableCursorKeychain")),
  /** Cached response during refresh; repeat with awaitRefresh for fresh data. */
  refreshing: Schema.optionalKey(Schema.Literal(true)),
});
export type UsageSource = typeof UsageSource.Type;

export const UsagePricingStatus = Schema.Literals(["fresh", "cached", "unavailable"]);
export type UsagePricingStatus = typeof UsagePricingStatus.Type;

export const UsagePricing = Schema.Struct({
  status: UsagePricingStatus,
  source: TrimmedNonEmptyString,
  fetchedAt: Schema.NullOr(Schema.String),
  knownModels: NonNegativeInt,
});
export type UsagePricing = typeof UsagePricing.Type;

export const UsageSummaryInput = Schema.Struct({
  sinceDay: UsageDay,
  untilDay: UsageDay,
  /** IANA bucketing zone; offsets fail across DST boundaries. */
  timeZone: TrimmedNonEmptyString,
  resolution: Schema.optional(UsageResolution),
  sinceTime: Schema.optional(TrimmedNonEmptyString),
  untilTime: Schema.optional(TrimmedNonEmptyString),
  /** Split buckets by provider account and thread, and list the threads. */
  groupByThread: Schema.optional(Schema.Boolean),
  /**
   * Wait for slow sources to finish refreshing instead of answering from their
   * cache. Clients send it as the follow-up to a summary with a `refreshing`
   * source. Older servers ignore it and always wait.
   */
  awaitRefresh: Schema.optional(Schema.Boolean),
});
export type UsageSummaryInput = typeof UsageSummaryInput.Type;

export const UsageSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  buckets: ForwardCompatibleArray(UsageBucket),
  sources: ForwardCompatibleArray(UsageSource),
  pricing: UsagePricing,
  /**
   * Threads that buckets point at, by index. Present only with
   * `groupByThread`. A plain array: skipping an entry would shift every index.
   */
  threads: Schema.optional(Schema.Array(UsageThread)),
  /** Projects that threads point at. Present only with `groupByThread`. */
  projects: Schema.optional(ForwardCompatibleArray(UsageProject)),
  /** Wall-clock cost of the scan, surfaced in diagnostics. */
  scanDurationMs: NonNegativeInt,
});
export type UsageSummary = typeof UsageSummary.Type;

export class UsageReadError extends Schema.TaggedError<UsageReadError>()("UsageReadError", {
  reason: Schema.Literals(["scanFailed", "invalidWindow"]),
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Usage read failed (${this.reason}): ${this.detail}`;
  }
}
