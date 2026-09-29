import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Rolling GitHub API usage report. Schema-only: every field here is safe to
 * show, store, and send — no argv, query bodies, tokens, or subprocess output.
 *
 * Counting semantics (mirrored in the report's own copy):
 * - `httpRequests` are genuinely measured HTTP requests, observed through
 *   `GH_DEBUG=api` on each `gh` invocation. One invocation usually makes one
 *   request; pagination, retries, and multi-page reads make more.
 * - `httpRequests: null` on a recent event means that invocation's count is
 *   unknown — the report never invents exactness. Totals carry
 *   `httpRequestsUnknown` when any event in the window is unknown.
 * - GraphQL cost points are not request counts and are never reported as such.
 * - `servedFromCache` counts reads answered without leaving the process
 *   (read caches, coalesced refreshes) — useful load, zero outbound traffic.
 */

/** Rolling windows the report can cover. */
export const GitHubApiUsageWindow = Schema.Literals(["5m", "1h", "24h"]);
export type GitHubApiUsageWindow = typeof GitHubApiUsageWindow.Type;

export const GITHUB_API_USAGE_WINDOW_MS: Record<GitHubApiUsageWindow, number> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};

export const GitHubApiUsageOutcome = Schema.Literals(["success", "failure", "rate-limited"]);
export type GitHubApiUsageOutcome = typeof GitHubApiUsageOutcome.Type;

export const GitHubApiUsageReportInput = Schema.Struct({
  window: Schema.optional(GitHubApiUsageWindow),
  /** Narrow to one host (`github.com`, a GHE hostname). Absent means all hosts. */
  host: Schema.optional(TrimmedNonEmptyString),
  /** Narrow to one caller (`monitor`, `list`, `detail`, `diff`, …). */
  feature: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  /** Free-text match against `operation` or `repository`, bounded for transport. */
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  /** Narrow to one pull request number; combine with `query` for the repository. */
  prNumber: Schema.optional(PositiveInt),
});
export type GitHubApiUsageReportInput = typeof GitHubApiUsageReportInput.Type;

export const GitHubApiUsageBreakdown = Schema.Struct({
  key: TrimmedNonEmptyString,
  /** Outbound `gh` invocations; cache-served reads are counted separately below. */
  invocations: NonNegativeInt,
  httpRequests: NonNegativeInt,
  errors: NonNegativeInt,
  rateLimited: NonNegativeInt,
  /** Reads answered without leaving the process; never counted as invocations. */
  cacheHits: NonNegativeInt,
});
export type GitHubApiUsageBreakdown = typeof GitHubApiUsageBreakdown.Type;

export const GitHubApiUsageTrendBucket = Schema.Struct({
  at: IsoDateTime,
  invocations: NonNegativeInt,
  httpRequests: NonNegativeInt,
});
export type GitHubApiUsageTrendBucket = typeof GitHubApiUsageTrendBucket.Type;

export const GitHubApiUsageRecentEvent = Schema.Struct({
  at: IsoDateTime,
  operation: TrimmedNonEmptyString,
  feature: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  repository: Schema.NullOr(TrimmedNonEmptyString),
  prNumber: Schema.NullOr(PositiveInt),
  /** Null where that invocation's request count is unknown — never invented. */
  httpRequests: Schema.NullOr(NonNegativeInt),
  outcome: GitHubApiUsageOutcome,
  latencyMs: NonNegativeInt,
  servedFromCache: Schema.Boolean,
});
export type GitHubApiUsageRecentEvent = typeof GitHubApiUsageRecentEvent.Type;

/**
 * One resource bucket's quota from the last passive response-header
 * observation. All fields nullable: a bucket never observed is unknown, not
 * zero. Quota is account-wide and shared — T3's attributed counts explain
 * only the traffic this server made, never the whole account.
 */
export const GitHubApiQuotaBucket = Schema.Struct({
  host: TrimmedNonEmptyString,
  resource: TrimmedNonEmptyString,
  login: Schema.NullOr(TrimmedNonEmptyString),
  limit: Schema.NullOr(NonNegativeInt),
  remaining: Schema.NullOr(NonNegativeInt),
  used: Schema.NullOr(NonNegativeInt),
  resetAt: Schema.NullOr(IsoDateTime),
  lastObservedAt: IsoDateTime,
  /** A rate-limit refusal was observed and its cooldown has not elapsed. */
  coolingDownUntil: Schema.NullOr(IsoDateTime),
  /**
   * Primary quota exhaustion vs a secondary (abuse/nuisance) limit, where the
   * trace gave evidence. Null where the kind is unknown.
   */
  coolingDownKind: Schema.NullOr(Schema.Literals(["primary", "secondary"])),
});
export type GitHubApiQuotaBucket = typeof GitHubApiQuotaBucket.Type;

export const GitHubApiUsageTotals = Schema.Struct({
  /** Outbound `gh` invocations; cache-served reads are counted separately below. */
  invocations: NonNegativeInt,
  httpRequests: NonNegativeInt,
  httpRequestsUnknown: Schema.Boolean,
  servedFromCache: NonNegativeInt,
  errors: NonNegativeInt,
  rateLimited: NonNegativeInt,
});
export type GitHubApiUsageTotals = typeof GitHubApiUsageTotals.Type;

/**
 * Whether the report covers its whole window. Unfiltered headline aggregates
 * come from durable time buckets and stay exact across restarts and ring
 * eviction; filtered drilldowns read the bounded recent-event ring and are
 * complete only back to `startAt`.
 */
export const GitHubApiUsageCoverage = Schema.Struct({
  complete: Schema.Boolean,
  startAt: IsoDateTime,
});
export type GitHubApiUsageCoverage = typeof GitHubApiUsageCoverage.Type;

export const GitHubApiUsageReport = Schema.Struct({
  window: GitHubApiUsageWindow,
  generatedAt: IsoDateTime,
  /** Bounded server-side history behind the report (events, retention hours). */
  retainedEvents: NonNegativeInt,
  retentionHours: NonNegativeInt,
  totals: GitHubApiUsageTotals,
  coverage: GitHubApiUsageCoverage,
  byFeature: Schema.Array(GitHubApiUsageBreakdown),
  byOperation: Schema.Array(GitHubApiUsageBreakdown),
  byRepository: Schema.Array(GitHubApiUsageBreakdown),
  byPullRequest: Schema.Array(GitHubApiUsageBreakdown),
  byHost: Schema.Array(GitHubApiUsageBreakdown),
  trend: Schema.Array(GitHubApiUsageTrendBucket),
  recent: Schema.Array(GitHubApiUsageRecentEvent),
  quota: Schema.Array(GitHubApiQuotaBucket),
});
export type GitHubApiUsageReport = typeof GitHubApiUsageReport.Type;

export const GitHubApiQuotaRefreshInput = Schema.Struct({
  host: TrimmedNonEmptyString,
});
export type GitHubApiQuotaRefreshInput = typeof GitHubApiQuotaRefreshInput.Type;

export const GitHubApiQuotaRefreshResult = Schema.Struct({
  host: TrimmedNonEmptyString,
  /** False when the refresh was served from the throttle window, not the host. */
  refreshed: Schema.Boolean,
  quota: Schema.Array(GitHubApiQuotaBucket),
});
export type GitHubApiQuotaRefreshResult = typeof GitHubApiQuotaRefreshResult.Type;

/** The usage seam is unavailable in this environment (never a quota problem). */
export class GitHubApiUsageError extends Schema.TaggedErrorClass<GitHubApiUsageError>()(
  "GitHubApiUsageError",
  {
    message: TrimmedNonEmptyString,
  },
) {}
