/**
 * Usage reporting contract.
 *
 * Each environment scans the provider CLIs' own on-disk session transcripts
 * (`~/.claude/projects/**\/*.jsonl`, `~/.codex/sessions/**\/*.jsonl`,
 * `~/.grok/sessions/**\/updates.jsonl`) rather than relying on T3 Code's own
 * orchestration projections, so usage stays complete even for turns that were
 * never driven through T3 Code. This mirrors the approach `ccusage` takes.
 *
 * Environments return pre-aggregated `(day, hourStart?, provider, model)`
 * buckets. Raw transcript records never cross the wire.
 *
 * @module usage
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bumped whenever the shape of {@link UsageSummary} changes incompatibly. The
 * client renders partial coverage when an environment reports an older version
 * rather than failing the whole page.
 */
export const USAGE_CONTRACT_VERSION = 12 as const;

/**
 * Oldest {@link UsageSummary} version a current client will still merge.
 *
 * v5 only adds `grok` to {@link UsageProviderKind}; v6 adds the optional bucket
 * `project`; v7 adds its optional stable `projectId`; v8 distinguishes outside
 * projects from unknown attribution; v9 adds the separate thread-breakdown RPC;
 * v10 adds optional cache-write costs; v11 adds optional cache-write TTL counters;
 * v12 adds server-side thread filtering before the breakdown row cap.
 * v4 Claude/Codex buckets remain valid, so mixed-version environments keep those
 * totals instead of treating every older server as stale.
 */
export const USAGE_MERGE_COMPATIBLE_SINCE = 4 as const;
/** First contract version that explicitly distinguishes outside from unknown attribution. */
export const USAGE_PROJECT_ATTRIBUTION_SINCE = 8 as const;
/** First contract version that exposes the current thread-breakdown RPC. */
export const USAGE_THREAD_BREAKDOWN_SINCE = 10 as const;
/** First contract version that applies `threadId` before the breakdown row cap. */
export const USAGE_THREAD_FILTER_SINCE = 12 as const;

export const UsageProviderKind = Schema.Literals(["claude", "codex", "grok"]);
export type UsageProviderKind = typeof UsageProviderKind.Type;

/**
 * A calendar day in the reporting time zone, formatted `YYYY-MM-DD`.
 *
 * Days are bucketed server-side so that a turn always lands on the day the user
 * experienced it, not the UTC day.
 */
const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const UsageDay = TrimmedNonEmptyString.check(Schema.isPattern(USAGE_DAY_PATTERN)).pipe(
  Schema.brand("UsageDay"),
);
export type UsageDay = typeof UsageDay.Type;

export const UsageResolution = Schema.Literals(["day", "hour"]);
export type UsageResolution = typeof UsageResolution.Type;

/**
 * Why a bucket's cost is what it is.
 *
 * - `providerReported` - the transcript carried an explicit cost figure.
 * - `modelPriced` - we used a custom price override or the LiteLLM rate table.
 * - `unpriced` - tokens are known, rates are not. Counted in totals, excluded
 *   from cost.
 */
export const UsageCostSource = Schema.Literals(["providerReported", "modelPriced", "unpriced"]);
export type UsageCostSource = typeof UsageCostSource.Type;

/**
 * Token counts for a bucket.
 *
 * `cachedInputTokens` and `cacheCreationTokens` are disjoint from
 * `uncachedInputTokens`; summing all three gives total input. `reasoningTokens`
 * is a *subset* of `outputTokens` (Codex reports it that way, and Anthropic
 * folds thinking into output), so it must never be added on top.
 */
export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  /** Anthropic five-minute cache writes, when the transcript reports the TTL. */
  cacheCreation5mTokens: Schema.optional(NonNegativeInt),
  /** Anthropic one-hour cache writes, when the transcript reports the TTL. */
  cacheCreation1hTokens: Schema.optional(NonNegativeInt),
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

/**
 * One `(day, hourStart?, project, provider, model)` cell. `hourStart` is the
 * UTC start instant of a rolling bucket and is present only for hourly
 * requests.
 *
 * `costUsd` is the raw API-equivalent cost of these tokens. It is not money
 * spent: subscription plans bill separately. `unpricedRecords` counts records
 * whose tokens are included in the token totals but which contributed nothing
 * to `costUsd`.
 */
export const UsageBucket = Schema.Struct({
  day: UsageDay,
  hourStart: Schema.optional(TrimmedNonEmptyString),
  /**
   * Title of the T3 project whose workspace root contains the session's
   * working directory, resolved per environment at scan time. Absent when the
   * session ran outside every project on that environment, or when the
   * transcript carries no working directory (Grok, and summaries from servers
   * predating this field).
   */
  project: Schema.optional(TrimmedNonEmptyString),
  /** Stable identity for `project`; absent on summaries from pre-v7 servers. */
  projectId: Schema.optional(ProjectId),
  /**
   * Whether the session ran in a project, outside every project, or carried no
   * working directory. Optional only so current clients can read older summaries.
   */
  projectAttribution: Schema.optional(Schema.Literals(["project", "outside", "unknown"])),
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString,
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  /**
   * What the cached input would have cost at full input rates minus what it
   * actually cost. Requires the rate table, so it is computed alongside cost
   * rather than derived on the client.
   */
  cacheSavingsUsd: Schema.Number,
  /**
   * Estimated cache-write cost at the model and TTL-specific rates. Cache
   * creation is a billing category, not proof of expiry. A subset of `costUsd`
   * when the bucket is model-priced. Absent from older summaries.
   */
  cacheWriteUsd: Schema.optional(Schema.Number),
  costSource: UsageCostSource,
  /** Distinct assistant responses, after de-duplication. */
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  /** Distinct transcript sessions that contributed to this cell. */
  sessions: NonNegativeInt,
});
export type UsageBucket = typeof UsageBucket.Type;

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
  /**
   * Filesystem identity of the transcript directory, as `device:inode`.
   *
   * Hostname and path alone are not enough: every Mac in a fleet resolves
   * `/Users/<user>/.claude`, so two machines that happen to share a hostname
   * would look like one source and have their usage silently dropped. The
   * device/inode pair is stable for two servers reading the same directory and
   * effectively never collides across machines. Empty when it cannot be read.
   */
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
  /** Records that parsed but carried no recognisable usage payload. */
  malformedRecords: NonNegativeInt,
  /**
   * Distinct transcript sessions seen under this directory. Buckets also carry
   * per-bucket session counts, but a session spans days and models, so summing
   * those overcounts; this is the figure clients should total.
   */
  distinctSessions: NonNegativeInt,
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type UsageSource = typeof UsageSource.Type;

export const UsagePricingStatus = Schema.Literals(["fresh", "cached", "unavailable"]);
export type UsagePricingStatus = typeof UsagePricingStatus.Type;

/**
 * Provenance for the rate table, so the UI can be honest about how good the
 * cost figures are.
 */
export const UsagePricing = Schema.Struct({
  status: UsagePricingStatus,
  source: TrimmedNonEmptyString,
  fetchedAt: Schema.NullOr(Schema.String),
  knownModels: NonNegativeInt,
});
export type UsagePricing = typeof UsagePricing.Type;

export const UsageSummaryInput = Schema.Struct({
  /** Inclusive first day of the window, in `timeZone`. */
  sinceDay: UsageDay,
  /** Inclusive last day of the window, in `timeZone`. */
  untilDay: UsageDay,
  /**
   * IANA zone the client wants days bucketed in. An offset would be wrong for
   * any window that crosses a DST boundary.
   */
  timeZone: TrimmedNonEmptyString,
  /** Defaults to daily for older clients. */
  resolution: Schema.optional(UsageResolution),
  /** Inclusive UTC instant for an hourly rolling window. */
  sinceTime: Schema.optional(TrimmedNonEmptyString),
  /** Exclusive UTC instant for an hourly rolling window. */
  untilTime: Schema.optional(TrimmedNonEmptyString),
  /**
   * Opaque identity of the source snapshots visible when the user explicitly
   * requested a refresh. A new value bypasses the short-lived source cache
   * once; repeated reads with the same value may reuse the updated snapshot.
   */
  refreshToken: Schema.optional(TrimmedNonEmptyString),
});
export type UsageSummaryInput = typeof UsageSummaryInput.Type;

export const UsageSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  buckets: Schema.Array(UsageBucket),
  sources: Schema.Array(UsageSource),
  pricing: UsagePricing,
  /** Wall-clock cost of the scan, surfaced in diagnostics. */
  scanDurationMs: NonNegativeInt,
});
export type UsageSummary = typeof UsageSummary.Type;

export const UsageThreadBreakdownInput = Schema.Struct({
  /** Inclusive first day of the window, in `timeZone`. */
  sinceDay: UsageDay,
  /** Inclusive last day of the window, in `timeZone`. */
  untilDay: UsageDay,
  timeZone: TrimmedNonEmptyString,
  /** Inclusive UTC instant for a rolling window such as Past 24h. */
  sinceTime: Schema.optional(TrimmedNonEmptyString),
  /** Exclusive UTC instant for a rolling window such as Past 24h. */
  untilTime: Schema.optional(TrimmedNonEmptyString),
  /**
   * Restrict to one project's records: a namespaced stable key selects that
   * project, `null` selects records outside every project, absent applies no
   * filter.
   */
  projectKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /** Providers this environment owns after physical-source de-duplication. */
  providers: Schema.optional(Schema.Array(UsageProviderKind)),
  /** Return only rows attributed to this T3 thread. */
  threadId: Schema.optional(ThreadId),
});
export type UsageThreadBreakdownInput = typeof UsageThreadBreakdownInput.Type;

/** One Claude subagent's slice of its parent thread. */
export const UsageAgentRow = Schema.Struct({
  agentId: TrimmedNonEmptyString,
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  /** `null` when cache-creation tokens lack a model-priced estimate. */
  cacheWriteUsd: Schema.NullOr(Schema.Number),
});
export type UsageAgentRow = typeof UsageAgentRow.Type;

/**
 * One day of a thread's model-priced cost split by component. Days the thread
 * was idle are omitted. Unpriced records contribute tokens to the row totals
 * but nothing here. Provider-reported totals also stay out because an
 * estimated split could disagree with the provider's authoritative total.
 */
export const UsageThreadDayCost = Schema.Struct({
  day: UsageDay,
  cacheWriteUsd: Schema.Number,
  cacheReadUsd: Schema.Number,
  /** Fresh input plus output. */
  freshUsd: Schema.Number,
});
export type UsageThreadDayCost = typeof UsageThreadDayCost.Type;

/**
 * One thread's (or unattributed session group's) slice of the window.
 *
 * `threadId` is present when the sessions map to a T3 Code thread on this
 * environment, via the thread's resume cursor or its dedicated worktree.
 * Sessions that never ran through T3 Code stay session-granular with a title
 * taken from the transcript.
 */
export const UsageThreadRow = Schema.Struct({
  /** Stable within one environment; opaque to clients. */
  key: TrimmedNonEmptyString,
  threadId: Schema.NullOr(ThreadId),
  title: TrimmedNonEmptyString,
  provider: UsageProviderKind,
  projectId: Schema.optional(ProjectId),
  project: Schema.optional(TrimmedNonEmptyString),
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  /** `null` when cache-creation tokens lack a model-priced estimate. */
  cacheWriteUsd: Schema.NullOr(Schema.Number),
  /** Distinct transcript sessions folded into this row. */
  sessions: NonNegativeInt,
  /** Lower-cost thread rows represented by this grouped remainder row. */
  groupedRows: Schema.optional(NonNegativeInt),
  agents: Schema.Array(UsageAgentRow),
  daily: Schema.Array(UsageThreadDayCost),
});
export type UsageThreadRow = typeof UsageThreadRow.Type;

/**
 * On-demand drill-down behind the usage summary. Named rows are capped
 * server-side because a window can hold thousands of sessions. Lower-cost
 * rows fold into provider/project-specific remainder rows so totals reconcile
 * without sending every transcript session over the WebSocket.
 */
export const UsageThreadBreakdown = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  rows: Schema.Array(UsageThreadRow),
  /** Underlying rows folded into the returned remainder rows. */
  truncatedRows: NonNegativeInt,
  scanDurationMs: NonNegativeInt,
});
export type UsageThreadBreakdown = typeof UsageThreadBreakdown.Type;

export class UsageReadError extends Schema.TaggedErrorClass<UsageReadError>()("UsageReadError", {
  reason: Schema.Literals(["scanFailed", "invalidWindow"]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Usage read failed (${this.reason}): ${this.detail}`;
  }
}
