import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  GITHUB_API_USAGE_WINDOW_MS,
  type GitHubApiQuotaBucket,
  type GitHubApiQuotaRefreshResult,
  type GitHubApiUsageReport,
  type GitHubApiUsageReportInput,
  type GitHubApiUsageWindow,
} from "@t3tools/contracts";

import { GitHubCli } from "../git/Services/GitHubCli.ts";
import {
  aggregateUsage,
  parseGhDebugTelemetry,
  type GitHubApiRateLimitObservation,
  type GitHubApiUsageEvent,
  type GitHubApiUsageOutcome,
} from "./ghDebugTelemetry.ts";

/**
 * Rolling GitHub API usage telemetry. One shared seam: every application-owned
 * `gh` invocation flows through `GitHubCli.execute`, which records here.
 *
 * What this is not: account-wide attribution. Agent-issued `gh` commands, MCP
 * requests, and other environments on the same account bypass this server, so
 * attributed counts explain only the traffic this process made. Quota itself
 * is account-wide and shared — the report says so next to the numbers.
 */
export const MAX_RETAINED_EVENTS = 1_000;
export const RETENTION_MS = 24 * 60 * 60_000;
export const RETENTION_HOURS = 24;
/** An explicit quota refresh costs a request itself: at most one per host here. */
export const QUOTA_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
const MAX_LABEL_LENGTH = 64;
const MAX_HOST_LENGTH = 253;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export interface RecordUsageInput {
  readonly operation: string;
  readonly feature: string;
  readonly host: string;
  readonly repository?: string | null | undefined;
  readonly prNumber?: number | null | undefined;
  readonly httpRequests: number | null;
  readonly outcome: GitHubApiUsageOutcome;
  readonly latencyMs: number;
  readonly servedFromCache?: boolean | undefined;
  readonly rateLimits?: ReadonlyArray<GitHubApiRateLimitObservation> | undefined;
  readonly login?: string | null | undefined;
  /** Retry/cdn cooldown instant observed on a rate-limited call (epoch ms). */
  readonly retryAfterAtMs?: number | null | undefined;
}

function boundLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= MAX_LABEL_LENGTH ? trimmed : `${trimmed.slice(0, MAX_LABEL_LENGTH)}…`;
}

function boundHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.length <= MAX_HOST_LENGTH ? trimmed : trimmed.slice(0, MAX_HOST_LENGTH);
}

function boundRepository(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return REPOSITORY_PATTERN.test(trimmed) ? trimmed : null;
}

function boundPrNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function toIsoDateTime(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

interface QuotaState {
  limit: number | null;
  remaining: number | null;
  used: number | null;
  resetAtMs: number | null;
  lastObservedAt: number;
  login: string | null;
}

/** Plain store so counting, retention, and quota semantics stay unit-testable. */
export class GitHubApiUsageStore {
  private events: Array<GitHubApiUsageEvent> = [];
  private readonly quota = new Map<string, Map<string, QuotaState>>();
  private readonly cooldowns = new Map<string, number>();
  private readonly identities = new Map<string, string>();
  private lastRefreshAt = new Map<string, number>();

  get retainedEvents(): number {
    return this.events.length;
  }

  record(input: RecordUsageInput, nowMs: number): void {
    const at = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
    const host = boundHost(input.host.length > 0 ? input.host : "unknown");
    if (input.login !== null && input.login !== undefined && input.login.trim().length > 0) {
      this.identities.set(host, input.login.trim().slice(0, MAX_LABEL_LENGTH));
    }
    this.events.push({
      at,
      operation: boundLabel(input.operation.length > 0 ? input.operation : "gh"),
      feature: boundLabel(input.feature.length > 0 ? input.feature : "unknown"),
      host,
      repository: boundRepository(input.repository),
      prNumber: boundPrNumber(input.prNumber),
      httpRequests:
        input.httpRequests === null ||
        !Number.isSafeInteger(input.httpRequests) ||
        input.httpRequests < 0
          ? null
          : input.httpRequests,
      outcome: input.outcome,
      latencyMs:
        !Number.isFinite(input.latencyMs) || input.latencyMs < 0
          ? 0
          : Math.min(Math.floor(input.latencyMs), 3_600_000),
      servedFromCache: input.servedFromCache === true,
    });
    for (const observation of input.rateLimits ?? []) {
      this.observeRateLimit(host, observation, at);
    }
    if (input.outcome === "rate-limited" && typeof input.retryAfterAtMs === "number") {
      this.observeCooldown(host, input.retryAfterAtMs);
    }
    if (this.events.length > MAX_RETAINED_EVENTS || this.events.length % 64 === 0) {
      this.prune(at);
    }
  }

  recordCacheHit(
    input: {
      readonly feature: string;
      readonly host: string;
      readonly repository?: string | null | undefined;
      readonly prNumber?: number | null | undefined;
    },
    nowMs: number,
  ): void {
    this.record(
      {
        operation: `${boundLabel(input.feature)} cache`,
        feature: input.feature,
        host: input.host,
        repository: input.repository,
        prNumber: input.prNumber,
        httpRequests: 0,
        outcome: "success",
        latencyMs: 0,
        servedFromCache: true,
      },
      nowMs,
    );
  }

  observeRateLimit(host: string, observation: GitHubApiRateLimitObservation, nowMs: number): void {
    const normalizedHost = boundHost(host);
    let byResource = this.quota.get(normalizedHost);
    if (byResource === undefined) {
      byResource = new Map();
      this.quota.set(normalizedHost, byResource);
    }
    const previous = byResource.get(observation.resource);
    byResource.set(observation.resource, {
      limit: observation.limit,
      remaining: observation.remaining,
      used: observation.used,
      resetAtMs: observation.resetAtMs,
      lastObservedAt: nowMs,
      login: previous?.login ?? this.identities.get(normalizedHost) ?? null,
    });
  }

  observeCooldown(host: string, untilMs: number): void {
    if (!Number.isFinite(untilMs)) return;
    const normalizedHost = boundHost(host);
    this.cooldowns.set(normalizedHost, Math.max(this.cooldowns.get(normalizedHost) ?? 0, untilMs));
  }

  setIdentity(host: string, login: string): void {
    const normalizedHost = boundHost(host);
    const trimmed = login.trim().slice(0, MAX_LABEL_LENGTH);
    if (trimmed.length === 0) return;
    this.identities.set(normalizedHost, trimmed);
    for (const state of this.quota.get(normalizedHost)?.values() ?? []) {
      state.login = trimmed;
    }
  }

  /** Pure throttle decision: explicit refreshes are modest and coalesced. */
  shouldRefresh(host: string, nowMs: number): boolean {
    const last = this.lastRefreshAt.get(boundHost(host)) ?? Number.NEGATIVE_INFINITY;
    return nowMs - last >= QUOTA_REFRESH_MIN_INTERVAL_MS;
  }

  markRefreshed(host: string, nowMs: number): void {
    this.lastRefreshAt.set(boundHost(host), nowMs);
  }

  prune(nowMs: number): void {
    const cutoff = nowMs - RETENTION_MS;
    this.events = this.events.filter((event) => event.at > cutoff).slice(-MAX_RETAINED_EVENTS);
    for (const [host, until] of this.cooldowns) {
      if (until <= nowMs) this.cooldowns.delete(host);
    }
  }

  quotaSnapshot(nowMs: number): Array<GitHubApiQuotaBucket> {
    // Core budgets first: these are the ones pull-request reads spend. The
    // rest of the rate_limit payload follows alphabetically.
    const resourceOrder = (resource: string): number =>
      resource === "core" ? 0 : resource === "graphql" ? 1 : resource === "search" ? 2 : 3;
    const buckets: Array<GitHubApiQuotaBucket> = [];
    for (const [host, byResource] of [...this.quota].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      for (const [resource, state] of [...byResource].toSorted(
        ([left], [right]) =>
          resourceOrder(left) - resourceOrder(right) || left.localeCompare(right),
      )) {
        const coolingDownUntil = this.cooldowns.get(host) ?? null;
        buckets.push({
          host,
          resource,
          login: state.login ?? this.identities.get(host) ?? null,
          limit: state.limit,
          remaining: state.remaining,
          used: state.used,
          resetAt: toIsoDateTime(state.resetAtMs),
          lastObservedAt: new Date(state.lastObservedAt).toISOString(),
          coolingDownUntil:
            coolingDownUntil !== null && coolingDownUntil > nowMs
              ? new Date(coolingDownUntil).toISOString()
              : null,
        });
      }
    }
    return buckets;
  }

  report(input: GitHubApiUsageReportInput, nowMs: number): GitHubApiUsageReport {
    const window: GitHubApiUsageWindow = input.window ?? "1h";
    const host = input.host?.trim().toLowerCase() ?? null;
    const feature = input.feature?.trim() ?? null;
    const query = input.query?.trim().toLowerCase() ?? null;
    const filtered = this.events.filter((event) => {
      if (host !== null && event.host !== host) return false;
      if (feature !== null && event.feature !== feature) return false;
      if (
        query !== null &&
        !event.operation.toLowerCase().includes(query) &&
        !(event.repository ?? "").toLowerCase().includes(query)
      ) {
        return false;
      }
      return true;
    });
    const aggregated = aggregateUsage(filtered, {
      nowMs,
      windowMs: GITHUB_API_USAGE_WINDOW_MS[window],
    });
    const hostsWithEvents = new Set(filtered.map((event) => event.host));
    const quota = this.quotaSnapshot(nowMs);
    // A host with traffic but no header observations yet is unknown — never zero.
    // Hosts seen only through cache hits have no quota relationship at all and
    // stay out of the quota section rather than gaining an empty card.
    const outboundHosts = new Set(
      filtered.filter((event) => !event.servedFromCache).map((event) => event.host),
    );
    for (const eventHost of [...hostsWithEvents].toSorted()) {
      if (!quota.some((bucket) => bucket.host === eventHost) && outboundHosts.has(eventHost)) {
        const coolingDownUntil = this.cooldowns.get(eventHost) ?? null;
        quota.push({
          host: eventHost,
          resource: "unknown",
          login: this.identities.get(eventHost) ?? null,
          limit: null,
          remaining: null,
          used: null,
          resetAt: null,
          lastObservedAt: new Date(nowMs).toISOString(),
          coolingDownUntil:
            coolingDownUntil !== null && coolingDownUntil > nowMs
              ? new Date(coolingDownUntil).toISOString()
              : null,
        });
      }
    }
    return {
      window,
      generatedAt: new Date(nowMs).toISOString(),
      retainedEvents: this.events.length,
      retentionHours: RETENTION_HOURS,
      totals: aggregated.totals,
      byFeature: aggregated.byFeature,
      byOperation: aggregated.byOperation,
      byRepository: aggregated.byRepository,
      byHost: aggregated.byHost,
      trend: aggregated.trend.map((bucket) => ({
        at: new Date(bucket.at).toISOString(),
        invocations: bucket.invocations,
        httpRequests: bucket.httpRequests,
      })),
      recent: aggregated.recent.map((event) => ({
        at: new Date(event.at).toISOString(),
        operation: event.operation,
        feature: event.feature,
        host: event.host,
        repository: event.repository,
        prNumber: event.prNumber,
        httpRequests: event.httpRequests,
        outcome: event.outcome,
        latencyMs: event.latencyMs,
        servedFromCache: event.servedFromCache,
      })),
      quota,
    };
  }
}

export class GitHubApiUsage extends Context.Service<
  GitHubApiUsage,
  {
    readonly record: (input: RecordUsageInput) => Effect.Effect<void>;
    readonly recordCacheHit: (input: {
      readonly feature: string;
      readonly host: string;
      readonly repository?: string | null | undefined;
      readonly prNumber?: number | null | undefined;
    }) => Effect.Effect<void>;
    readonly setIdentity: (host: string, login: string) => Effect.Effect<void>;
    readonly report: (input: GitHubApiUsageReportInput) => Effect.Effect<GitHubApiUsageReport>;
    readonly refreshQuota: (host: string) => Effect.Effect<GitHubApiQuotaRefreshResult>;
  }
>()("t3/gitHubUsage/GitHubApiUsage") {}

/**
 * Parse `rate_limit`'s own answer into header-style observations. Only the
 * `resources` object is read; everything else in the payload is ignored.
 */
export function parseRateLimitPayload(
  raw: string,
  nowMs: number,
): ReadonlyArray<GitHubApiRateLimitObservation> {
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (typeof body !== "object" || body === null || !("resources" in body)) return [];
  const resources = (body as { resources: unknown }).resources;
  if (typeof resources !== "object" || resources === null) return [];
  void nowMs;
  const observations: Array<GitHubApiRateLimitObservation> = [];
  for (const [resource, value] of Object.entries(resources as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const asInt = (field: string): number | null => {
      const candidate = entry[field];
      return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
        ? candidate
        : null;
    };
    const reset = asInt("reset");
    observations.push({
      resource: resource.toLowerCase(),
      limit: asInt("limit"),
      remaining: asInt("remaining"),
      used: asInt("used"),
      resetAtMs: reset === null ? null : reset * 1_000,
    });
  }
  return observations.toSorted((left, right) => left.resource.localeCompare(right.resource));
}

const make = Effect.sync(() => {
  const store = new GitHubApiUsageStore();
  // Single-flight explicit refreshes per host: concurrent callers share one.
  const inFlight = new Map<string, Deferred.Deferred<GitHubApiQuotaRefreshResult>>();

  const runRefresh = (normalizedHost: string): Effect.Effect<GitHubApiQuotaRefreshResult> =>
    Effect.gen(function* () {
      const github = yield* Effect.serviceOption(GitHubCli);
      if (github._tag === "None") {
        const at = Date.now();
        return {
          host: normalizedHost,
          refreshed: false,
          quota: store.quotaSnapshot(at),
        };
      }
      const result = yield* github.value
        .execute({
          cwd: process.cwd(),
          args: ["api", "--hostname", normalizedHost, "rate_limit"],
          usage: { feature: "quota-refresh", host: normalizedHost },
        })
        .pipe(Effect.option);
      const at = Date.now();
      if (result._tag === "None") {
        return {
          host: normalizedHost,
          refreshed: false,
          quota: store.quotaSnapshot(at),
        };
      }
      store.markRefreshed(normalizedHost, at);
      for (const observation of parseRateLimitPayload(result.value.stdout, at)) {
        store.observeRateLimit(normalizedHost, observation, at);
      }
      return {
        host: normalizedHost,
        refreshed: true,
        quota: store.quotaSnapshot(at),
      };
    });

  const refreshQuota = (host: string): Effect.Effect<GitHubApiQuotaRefreshResult> =>
    Effect.gen(function* () {
      const normalizedHost = boundHost(host);
      const existing = inFlight.get(normalizedHost);
      if (existing !== undefined) return yield* Deferred.await(existing);
      const nowMs = Date.now();
      if (!store.shouldRefresh(normalizedHost, nowMs)) {
        return {
          host: normalizedHost,
          refreshed: false,
          quota: store.quotaSnapshot(nowMs),
        };
      }
      const gate = yield* Deferred.make<GitHubApiQuotaRefreshResult>();
      inFlight.set(normalizedHost, gate);
      // Exited, never failed: waiters must always be released with an answer.
      const outcome = yield* Effect.exit(runRefresh(normalizedHost));
      inFlight.delete(normalizedHost);
      const result = Exit.isSuccess(outcome)
        ? outcome.value
        : {
            host: normalizedHost,
            refreshed: false,
            quota: store.quotaSnapshot(Date.now()),
          };
      yield* Deferred.succeed(gate, result);
      return result;
    });

  return GitHubApiUsage.of({
    // Recording never fails the caller: the store is synchronous and bounded,
    // and any defect is contained and logged rather than propagated.
    record: (input) =>
      Effect.sync(() => store.record(input, Date.now())).pipe(
        Effect.catchCause((cause) => Effect.logWarning("GitHub API usage record failed", cause)),
      ),
    recordCacheHit: (input) =>
      Effect.sync(() => store.recordCacheHit(input, Date.now())).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("GitHub API cache-hit record failed", cause),
        ),
      ),
    setIdentity: (host, login) => Effect.sync(() => store.setIdentity(host, login)),
    report: (input) => Effect.sync(() => store.report(input, Date.now())),
    refreshQuota,
  });
});

export const GitHubApiUsageLive = Layer.effect(GitHubApiUsage, make);

export { parseGhDebugTelemetry };
