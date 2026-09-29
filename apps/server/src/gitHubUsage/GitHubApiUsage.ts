import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import {
  GITHUB_API_USAGE_WINDOW_MS,
  GitHubApiUsageError,
  type GitHubApiQuotaBucket,
  type GitHubApiQuotaRefreshResult,
  type GitHubApiUsageReport,
  type GitHubApiUsageReportInput,
  type GitHubApiUsageWindow,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
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
/** Aggregate grain for durable window totals: one minute. */
export const BUCKET_MS = 60_000;
const MAX_DIM_KEYS = 32;
const OVERFLOW_KEY = "~other";
const MAX_BREAKDOWN_ROWS = 200;
const MAX_LABEL_LENGTH = 64;
const MAX_HOST_LENGTH = 253;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export type GitHubApiCooldownKind = "primary" | "secondary" | "unknown";

/** [invocations, httpRequests, errors, rateLimited, cacheHits] */
type DimCounts = [number, number, number, number, number];

interface UsageBucket {
  startMs: number;
  invocations: number;
  httpRequests: number;
  unknown: number;
  cacheHits: number;
  errors: number;
  rateLimited: number;
  byFeature: Map<string, DimCounts>;
  byOperation: Map<string, DimCounts>;
  byRepo: Map<string, DimCounts>;
  byPr: Map<string, DimCounts>;
  byHost: Map<string, DimCounts>;
}

function newBucket(startMs: number): UsageBucket {
  return {
    startMs,
    invocations: 0,
    httpRequests: 0,
    unknown: 0,
    cacheHits: 0,
    errors: 0,
    rateLimited: 0,
    byFeature: new Map(),
    byOperation: new Map(),
    byRepo: new Map(),
    byPr: new Map(),
    byHost: new Map(),
  };
}

function bumpDim(map: Map<string, DimCounts>, key: string, event: GitHubApiUsageEvent): void {
  let counts = map.get(key);
  if (counts === undefined) {
    if (map.size >= MAX_DIM_KEYS) {
      counts = map.get(OVERFLOW_KEY);
      if (counts === undefined) {
        counts = [0, 0, 0, 0, 0];
        map.set(OVERFLOW_KEY, counts);
      }
    } else {
      counts = [0, 0, 0, 0, 0];
      map.set(key, counts);
    }
  }
  if (event.servedFromCache) {
    counts[4] += 1;
  } else {
    counts[0] += 1;
    if (event.outcome === "failure") counts[2] += 1;
    if (event.outcome === "rate-limited") counts[3] += 1;
  }
  if (event.httpRequests !== null) counts[1] += event.httpRequests;
}

function foldEvent(bucket: UsageBucket, event: GitHubApiUsageEvent): void {
  if (event.servedFromCache) {
    bucket.cacheHits += 1;
  } else {
    bucket.invocations += 1;
    if (event.outcome === "failure") bucket.errors += 1;
    if (event.outcome === "rate-limited") bucket.rateLimited += 1;
  }
  if (event.httpRequests === null) bucket.unknown += 1;
  else bucket.httpRequests += event.httpRequests;
  bumpDim(bucket.byFeature, event.feature, event);
  bumpDim(bucket.byOperation, event.operation, event);
  bumpDim(bucket.byHost, event.host, event);
  if (event.repository !== null) {
    bumpDim(bucket.byRepo, `${event.host}/${event.repository}`, event);
    // Batched multi-PR reads carry no prNumber and stay unattributed here —
    // never fabricated onto one pull request.
    if (event.prNumber !== null) {
      bumpDim(bucket.byPr, `${event.host}/${event.repository}#${event.prNumber}`, event);
    }
  }
}

function mergeDim(maps: Iterable<Map<string, DimCounts>>): Array<{
  readonly key: string;
  readonly invocations: number;
  readonly httpRequests: number;
  readonly errors: number;
  readonly rateLimited: number;
  readonly cacheHits: number;
}> {
  const merged = new Map<string, DimCounts>();
  for (const map of maps) {
    for (const [key, counts] of map) {
      const held = merged.get(key);
      if (held === undefined) {
        merged.set(key, [...counts]);
      } else {
        held[0] += counts[0];
        held[1] += counts[1];
        held[2] += counts[2];
        held[3] += counts[3];
        held[4] += counts[4];
      }
    }
  }
  return [...merged]
    .map(([key, counts]) => ({
      key,
      invocations: counts[0],
      httpRequests: counts[1],
      errors: counts[2],
      rateLimited: counts[3],
      cacheHits: counts[4],
    }))
    .toSorted(
      (left, right) =>
        right.httpRequests - left.httpRequests || right.invocations - left.invocations,
    )
    .slice(0, MAX_BREAKDOWN_ROWS);
}

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
  /** The trace named a secondary rate limit rather than quota exhaustion. */
  readonly secondaryRateLimit?: boolean | undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SerializedUsageBucket {
  readonly startMs: number;
  readonly invocations: number;
  readonly httpRequests: number;
  readonly unknown: number;
  readonly cacheHits: number;
  readonly errors: number;
  readonly rateLimited: number;
  readonly byFeature: ReadonlyArray<readonly [string, DimCounts]>;
  readonly byOperation: ReadonlyArray<readonly [string, DimCounts]>;
  readonly byRepo: ReadonlyArray<readonly [string, DimCounts]>;
  readonly byPr: ReadonlyArray<readonly [string, DimCounts]>;
  readonly byHost: ReadonlyArray<readonly [string, DimCounts]>;
}

export interface GitHubApiUsageSnapshot {
  readonly version: 1;
  readonly coverageStartMs: number;
  readonly savedAtMs: number;
  readonly buckets: ReadonlyArray<SerializedUsageBucket>;
  readonly quota: ReadonlyArray<{
    readonly host: string;
    readonly owner: string;
    readonly resource: string;
    readonly state: QuotaState;
  }>;
  readonly cooldowns: ReadonlyArray<{
    readonly key: string;
    readonly untilMs: number;
    readonly kind: GitHubApiCooldownKind;
  }>;
  readonly identities: ReadonlyArray<readonly [string, string]>;
  readonly refreshAttempts: ReadonlyArray<readonly [string, number]>;
}

function isNonNegativeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function restoreDimCounts(value: unknown): DimCounts | null {
  if (!Array.isArray(value) || value.length !== 5) return null;
  const [a, b, c, d, e] = value;
  const counts = [a, b, c, d, e];
  if (!counts.every(isNonNegativeCount)) return null;
  return [counts[0]!, counts[1]!, counts[2]!, counts[3]!, counts[4]!];
}

function restoreDimMap(value: unknown): Map<string, DimCounts> | null {
  if (!Array.isArray(value)) return null;
  const map = new Map<string, DimCounts>();
  for (const entry of value) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") return null;
    const counts = restoreDimCounts(entry[1]);
    if (counts === null) return null;
    // Cap cardinality on load exactly like live folding does.
    if (!map.has(entry[0]) && map.size >= MAX_DIM_KEYS && entry[0] !== OVERFLOW_KEY) continue;
    map.set(entry[0].slice(0, 512), counts);
  }
  return map;
}

function restoreBucket(raw: unknown): UsageBucket | null {
  if (!isRecord(raw)) return null;
  const numbers = [
    "startMs",
    "invocations",
    "httpRequests",
    "unknown",
    "cacheHits",
    "errors",
    "rateLimited",
  ] as const;
  for (const field of numbers) {
    if (!isNonNegativeCount(raw[field])) return null;
  }
  const byFeature = restoreDimMap(raw["byFeature"]);
  const byOperation = restoreDimMap(raw["byOperation"]);
  const byRepo = restoreDimMap(raw["byRepo"]);
  const byPr = restoreDimMap(raw["byPr"]);
  const byHost = restoreDimMap(raw["byHost"]);
  if (
    byFeature === null ||
    byOperation === null ||
    byRepo === null ||
    byPr === null ||
    byHost === null
  ) {
    return null;
  }
  return {
    startMs: raw["startMs"] as number,
    invocations: raw["invocations"] as number,
    httpRequests: raw["httpRequests"] as number,
    unknown: raw["unknown"] as number,
    cacheHits: raw["cacheHits"] as number,
    errors: raw["errors"] as number,
    rateLimited: raw["rateLimited"] as number,
    byFeature,
    byOperation,
    byRepo,
    byPr,
    byHost,
  };
}

function restoreQuotaState(raw: unknown): QuotaState | null {
  if (!isRecord(raw)) return null;
  const asCount = (field: string): number | null => {
    const value = raw[field];
    if (value === null) return null;
    return isNonNegativeCount(value) ? value : null;
  };
  // resetAtMs uses epoch-millis like the live state; finite covers both.
  const resetAtMs = raw["resetAtMs"];
  if (resetAtMs !== null && !Number.isFinite(resetAtMs)) return null;
  const lastObservedAt = raw["lastObservedAt"];
  if (!Number.isFinite(lastObservedAt)) return null;
  return {
    limit: asCount("limit"),
    remaining: asCount("remaining"),
    used: asCount("used"),
    resetAtMs: resetAtMs === null ? null : (resetAtMs as number),
    lastObservedAt: lastObservedAt as number,
  };
}

interface QuotaState {
  limit: number | null;
  remaining: number | null;
  used: number | null;
  resetAtMs: number | null;
  lastObservedAt: number;
}

/** Plain store so counting, retention, and quota semantics stay unit-testable. */
export class GitHubApiUsageStore {
  private events: Array<GitHubApiUsageEvent> = [];
  private buckets = new Map<number, UsageBucket>();
  private coverageStartMs: number;
  private readonly quota = new Map<string, Map<string, Map<string, QuotaState>>>();
  private readonly cooldowns = new Map<string, { untilMs: number; kind: GitHubApiCooldownKind }>();
  private readonly identities = new Map<string, string>();
  private readonly lastRefreshAttempt = new Map<string, number>();
  private dirty = false;

  constructor(coverageStartMs?: number) {
    this.coverageStartMs = coverageStartMs ?? Date.now();
  }

  get retainedEvents(): number {
    return this.events.length;
  }

  /** True once any write happened since the last snapshot; drives the saver. */
  consumeDirty(): boolean {
    const was = this.dirty;
    this.dirty = false;
    return was;
  }

  identityOf(host: string): string | null {
    return this.identities.get(boundHost(host)) ?? null;
  }

  private ownerKey(host: string, owner: string): string {
    return `${host}\n${owner}`;
  }

  private resolveOwner(host: string, login?: string | null): string {
    const trimmed = login?.trim() ?? "";
    if (trimmed.length > 0) return this.applyIdentity(host, trimmed);
    return this.identities.get(host) ?? "";
  }

  /**
   * Records the account behind a host. Unattributed traffic is owned by ""
   * (never stored as an identity, so the sentinel can never masquerade as an
   * account). The first known identity claims unattributed ("") history;
   * later switches partition — earlier observations keep their owner's label
   * and never merge into the new one.
   */
  private applyIdentity(host: string, login: string): string {
    const trimmed = login.trim().slice(0, MAX_LABEL_LENGTH);
    if (trimmed.length === 0) return this.identities.get(host) ?? "";
    const current = this.identities.get(host);
    if (current === trimmed) return current;
    if (current === undefined) {
      const byOwner = this.quota.get(host);
      const unattributed = byOwner?.get("");
      if (byOwner !== undefined && unattributed !== undefined && unattributed.size > 0) {
        const hasKnown = [...byOwner.keys()].some((owner) => owner !== "");
        if (!hasKnown) {
          byOwner.delete("");
          byOwner.set(trimmed, unattributed);
        }
      }
    }
    this.identities.set(host, trimmed);
    this.dirty = true;
    return trimmed;
  }

  record(input: RecordUsageInput, nowMs: number): void {
    const at = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
    const host = boundHost(input.host.length > 0 ? input.host : "unknown");
    const owner = this.applyIdentity(host, input.login ?? "");
    const event: GitHubApiUsageEvent = {
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
    };
    this.events.push(event);
    const startMs = Math.floor(at / BUCKET_MS) * BUCKET_MS;
    let bucket = this.buckets.get(startMs);
    if (bucket === undefined) {
      bucket = newBucket(startMs);
      this.buckets.set(startMs, bucket);
    }
    foldEvent(bucket, event);
    for (const observation of input.rateLimits ?? []) {
      this.observeRateLimit(host, observation, at, owner);
    }
    if (input.outcome === "rate-limited" && typeof input.retryAfterAtMs === "number") {
      const kind: GitHubApiCooldownKind = input.secondaryRateLimit
        ? "secondary"
        : (input.rateLimits ?? []).some((observation) => observation.remaining === 0)
          ? "primary"
          : "unknown";
      const resources = [...new Set((input.rateLimits ?? []).map((o) => o.resource))];
      for (const resource of resources.length > 0 ? resources : [""]) {
        this.observeCooldown(host, input.retryAfterAtMs, { kind, resource, owner });
      }
    }
    if (this.events.length > MAX_RETAINED_EVENTS || this.events.length % 64 === 0) {
      this.prune(at);
    }
    this.dirty = true;
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

  observeRateLimit(
    host: string,
    observation: GitHubApiRateLimitObservation,
    nowMs: number,
    login?: string | null,
  ): void {
    const normalizedHost = boundHost(host);
    const owner = this.resolveOwner(normalizedHost, login);
    let byOwner = this.quota.get(normalizedHost);
    if (byOwner === undefined) {
      byOwner = new Map();
      this.quota.set(normalizedHost, byOwner);
    }
    let byResource = byOwner.get(owner);
    if (byResource === undefined) {
      byResource = new Map();
      byOwner.set(owner, byResource);
    }
    byResource.set(observation.resource, {
      limit: observation.limit,
      remaining: observation.remaining,
      used: observation.used,
      resetAtMs: observation.resetAtMs,
      lastObservedAt: nowMs,
    });
    this.dirty = true;
  }

  observeCooldown(
    host: string,
    untilMs: number,
    options?: {
      readonly kind?: GitHubApiCooldownKind | undefined;
      readonly resource?: string | undefined;
      readonly owner?: string | null | undefined;
    },
  ): void {
    if (!Number.isFinite(untilMs)) return;
    const normalizedHost = boundHost(host);
    const owner = this.resolveOwner(normalizedHost, options?.owner);
    const key = `${this.ownerKey(normalizedHost, owner)}\n${options?.resource ?? ""}`;
    const previous = this.cooldowns.get(key);
    const kind = options?.kind ?? "unknown";
    if (previous === undefined || untilMs >= previous.untilMs) {
      // Later evidence wins outright; an earlier instant never shortens a
      // longer cooldown another response already established.
      this.cooldowns.set(key, { untilMs, kind });
    } else if (previous.kind === "unknown" && kind !== "unknown") {
      this.cooldowns.set(key, { untilMs: previous.untilMs, kind });
    }
    this.dirty = true;
  }

  setIdentity(host: string, login: string): void {
    this.applyIdentity(boundHost(host), login);
  }

  /** Pure throttle decision: refresh attempts — not just successes — are modest. */
  shouldRefresh(host: string, nowMs: number, login?: string | null): boolean {
    const normalizedHost = boundHost(host);
    const owner = this.resolveOwnerNoWrite(normalizedHost, login);
    const last = this.lastRefreshAttempt.get(this.ownerKey(normalizedHost, owner));
    if (last === undefined) return true;
    // Clock skew must never wedge refreshes permanently.
    if (nowMs < last) return true;
    return nowMs - last >= QUOTA_REFRESH_MIN_INTERVAL_MS;
  }

  markRefreshAttempt(host: string, nowMs: number, login?: string | null): void {
    const normalizedHost = boundHost(host);
    this.lastRefreshAttempt.set(
      this.ownerKey(normalizedHost, this.resolveOwnerNoWrite(normalizedHost, login)),
      nowMs,
    );
    this.dirty = true;
  }

  private resolveOwnerNoWrite(host: string, login?: string | null): string {
    const trimmed = login?.trim() ?? "";
    if (trimmed.length > 0) return trimmed.slice(0, MAX_LABEL_LENGTH);
    return this.identities.get(host) ?? "";
  }

  prune(nowMs: number): void {
    const cutoff = nowMs - RETENTION_MS;
    const retainedEvents = this.events.filter((event) => event.at > cutoff);
    if (retainedEvents.length !== this.events.length) {
      this.events = retainedEvents.slice(-MAX_RETAINED_EVENTS);
      this.dirty = true;
    } else if (this.events.length > MAX_RETAINED_EVENTS) {
      this.events = this.events.slice(-MAX_RETAINED_EVENTS);
      this.dirty = true;
    }
    let droppedBuckets = false;
    for (const [startMs] of this.buckets) {
      if (startMs + BUCKET_MS <= cutoff) {
        this.buckets.delete(startMs);
        droppedBuckets = true;
      }
    }
    if (droppedBuckets) {
      this.coverageStartMs = Math.max(this.coverageStartMs, cutoff);
      this.dirty = true;
    }
    for (const [key, cooldown] of this.cooldowns) {
      if (cooldown.untilMs <= nowMs) this.cooldowns.delete(key);
    }
  }

  quotaSnapshot(nowMs: number): Array<GitHubApiQuotaBucket> {
    // Core budgets first: these are the ones pull-request reads spend. The
    // rest of the rate_limit payload follows alphabetically.
    const resourceOrder = (resource: string): number =>
      resource === "core" ? 0 : resource === "graphql" ? 1 : resource === "search" ? 2 : 3;
    const buckets: Array<GitHubApiQuotaBucket> = [];
    for (const [host, byOwner] of [...this.quota].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      for (const [owner, byResource] of [...byOwner].toSorted(([left], [right]) =>
        left.localeCompare(right),
      )) {
        for (const [resource, state] of [...byResource].toSorted(
          ([left], [right]) =>
            resourceOrder(left) - resourceOrder(right) || left.localeCompare(right),
        )) {
          // A cooldown observed for this resource wins; a host-wide one is
          // the fallback for calls that carried no resource context.
          const cooldown =
            this.cooldowns.get(`${this.ownerKey(host, owner)}\n${resource}`) ??
            this.cooldowns.get(`${this.ownerKey(host, owner)}\n`);
          const active = cooldown !== undefined && cooldown.untilMs > nowMs ? cooldown : undefined;
          buckets.push({
            host,
            resource,
            login: owner === "" ? (this.identities.get(host) ?? null) : owner,
            limit: state.limit,
            remaining: state.remaining,
            used: state.used,
            resetAt: toIsoDateTime(state.resetAtMs),
            lastObservedAt: new Date(state.lastObservedAt).toISOString(),
            coolingDownUntil: active !== undefined ? new Date(active.untilMs).toISOString() : null,
            coolingDownKind: active !== undefined && active.kind !== "unknown" ? active.kind : null,
          });
        }
      }
    }
    return buckets;
  }

  report(input: GitHubApiUsageReportInput, nowMs: number): GitHubApiUsageReport {
    const window: GitHubApiUsageWindow = input.window ?? "1h";
    const windowMs = GITHUB_API_USAGE_WINDOW_MS[window];
    const windowStart = nowMs - windowMs;
    const host = input.host?.trim().toLowerCase() ?? null;
    const feature = input.feature?.trim() ?? null;
    const query = input.query?.trim().toLowerCase() ?? null;
    const prNumber = input.prNumber ?? null;
    const isFiltered = host !== null || feature !== null || query !== null || prNumber !== null;
    const matches = (event: GitHubApiUsageEvent): boolean => {
      if (host !== null && event.host !== host) return false;
      if (feature !== null && event.feature !== feature) return false;
      if (prNumber !== null && event.prNumber !== prNumber) return false;
      if (
        query !== null &&
        !event.operation.toLowerCase().includes(query) &&
        !(event.repository ?? "").toLowerCase().includes(query)
      ) {
        return false;
      }
      return true;
    };

    const quota = this.quotaSnapshot(nowMs);
    const bucketsInWindow = [...this.buckets.values()]
      .filter((bucket) => bucket.startMs + BUCKET_MS > windowStart && bucket.startMs <= nowMs)
      .toSorted((left, right) => left.startMs - right.startMs);
    const hasBucketData = bucketsInWindow.length > 0;
    // Coverage starts when continuous observation began: anything in-window
    // before that instant predates this process (or its snapshot) and was
    // never recorded.
    const baseComplete = !hasBucketData || this.coverageStartMs <= windowStart;

    if (!isFiltered) {
      // Headline aggregates read durable buckets: exact across restarts and
      // recent-ring eviction. Only the bounded recent list reads the ring.
      let invocations = 0;
      let httpRequests = 0;
      let unknown = false;
      let cacheHits = 0;
      let errors = 0;
      let rateLimited = 0;
      const trendBuckets = 12;
      const trendMs = windowMs / trendBuckets;
      const trend = Array.from({ length: trendBuckets }, (_, index) => ({
        at: new Date(windowStart + Math.floor((index + 1) * trendMs)).toISOString(),
        invocations: 0,
        httpRequests: 0,
      }));
      for (const bucket of bucketsInWindow) {
        invocations += bucket.invocations;
        httpRequests += bucket.httpRequests;
        unknown = unknown || bucket.unknown > 0;
        cacheHits += bucket.cacheHits;
        errors += bucket.errors;
        rateLimited += bucket.rateLimited;
        const trendIndex = Math.min(
          trendBuckets - 1,
          Math.max(0, Math.floor((bucket.startMs - windowStart) / trendMs)),
        );
        trend[trendIndex]!.invocations += bucket.invocations;
        trend[trendIndex]!.httpRequests += bucket.httpRequests;
      }
      const recent = [...this.events]
        .filter((event) => event.at <= nowMs && event.at > windowStart)
        .toSorted((left, right) => right.at - left.at)
        .slice(0, 50)
        .map((event) => ({ ...event, at: new Date(event.at).toISOString() }));
      return {
        window,
        generatedAt: new Date(nowMs).toISOString(),
        retainedEvents: this.events.length,
        retentionHours: RETENTION_HOURS,
        totals: {
          invocations,
          httpRequests,
          httpRequestsUnknown: unknown,
          servedFromCache: cacheHits,
          errors,
          rateLimited,
        },
        coverage: {
          complete: baseComplete,
          startAt: new Date(this.coverageStartMs).toISOString(),
        },
        byFeature: mergeDim(bucketsInWindow.map((bucket) => bucket.byFeature)),
        byOperation: mergeDim(bucketsInWindow.map((bucket) => bucket.byOperation)),
        byRepository: mergeDim(bucketsInWindow.map((bucket) => bucket.byRepo)),
        byPullRequest: mergeDim(bucketsInWindow.map((bucket) => bucket.byPr)),
        byHost: mergeDim(bucketsInWindow.map((bucket) => bucket.byHost)),
        trend,
        recent: recent.map((event) => ({
          at: event.at,
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
        quota: this.withUnknownQuotaPlaceholders(quota, nowMs),
      };
    }

    // Filtered drilldowns read the bounded recent-event ring: exact while the
    // ring covers the window, flagged otherwise.
    const matching = this.events.filter(matches);
    const aggregated = aggregateUsage(matching, { nowMs, windowMs });
    const ringOldest = matching.reduce<number | null>(
      (oldest, event) =>
        event.at <= nowMs && event.at > windowStart
          ? oldest === null
            ? event.at
            : Math.min(oldest, event.at)
          : oldest,
      null,
    );
    const ringHasData = matching.some((event) => event.at <= nowMs && event.at > windowStart);
    return {
      window,
      generatedAt: new Date(nowMs).toISOString(),
      retainedEvents: this.events.length,
      retentionHours: RETENTION_HOURS,
      totals: aggregated.totals,
      coverage: {
        complete:
          baseComplete && (!ringHasData || (ringOldest !== null && ringOldest <= windowStart)),
        startAt: new Date(this.coverageStartMs).toISOString(),
      },
      byFeature: aggregated.byFeature,
      byOperation: aggregated.byOperation,
      byRepository: aggregated.byRepository,
      byPullRequest: aggregated.byPullRequest,
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
      quota: this.withUnknownQuotaPlaceholders(quota, nowMs, matching),
    };
  }

  /**
   * A host with outbound traffic but no header observations yet is unknown —
   * never zero. Hosts seen only through cache hits have no quota relationship
   * at all and stay out of the quota section rather than gaining an empty card.
   */
  private withUnknownQuotaPlaceholders(
    quota: Array<GitHubApiQuotaBucket>,
    nowMs: number,
    scope?: ReadonlyArray<GitHubApiUsageEvent>,
  ): Array<GitHubApiQuotaBucket> {
    const events = scope ?? this.events;
    const outboundHosts = new Set(
      events.filter((event) => !event.servedFromCache).map((event) => event.host),
    );
    const hostsWithEvents = new Set(events.map((event) => event.host));
    for (const eventHost of [...hostsWithEvents].toSorted()) {
      if (!quota.some((bucket) => bucket.host === eventHost) && outboundHosts.has(eventHost)) {
        const identity = this.identities.get(eventHost) ?? null;
        const cooldown = this.cooldowns.get(`${eventHost}\n${identity ?? ""}\n`) ?? null;
        quota.push({
          host: eventHost,
          resource: "unknown",
          login: identity,
          limit: null,
          remaining: null,
          used: null,
          resetAt: null,
          lastObservedAt: new Date(nowMs).toISOString(),
          coolingDownUntil:
            cooldown !== null && cooldown.untilMs > nowMs
              ? new Date(cooldown.untilMs).toISOString()
              : null,
          coolingDownKind:
            cooldown !== null && cooldown.untilMs > nowMs && cooldown.kind !== "unknown"
              ? cooldown.kind
              : null,
        });
      }
    }
    return quota;
  }

  snapshot(): GitHubApiUsageSnapshot {
    const serializeBucket = (bucket: UsageBucket): SerializedUsageBucket => ({
      startMs: bucket.startMs,
      invocations: bucket.invocations,
      httpRequests: bucket.httpRequests,
      unknown: bucket.unknown,
      cacheHits: bucket.cacheHits,
      errors: bucket.errors,
      rateLimited: bucket.rateLimited,
      byFeature: [...bucket.byFeature],
      byOperation: [...bucket.byOperation],
      byRepo: [...bucket.byRepo],
      byPr: [...bucket.byPr],
      byHost: [...bucket.byHost],
    });
    return {
      version: 1,
      coverageStartMs: this.coverageStartMs,
      savedAtMs: Date.now(),
      buckets: [...this.buckets.values()]
        .toSorted((left, right) => left.startMs - right.startMs)
        .map(serializeBucket),
      quota: [...this.quota].flatMap(([host, byOwner]) =>
        [...byOwner].flatMap(([owner, byResource]) =>
          [...byResource].map(([resource, state]) => ({
            host,
            owner,
            resource,
            state: { ...state },
          })),
        ),
      ),
      cooldowns: [...this.cooldowns].map(([key, cooldown]) => ({ key, ...cooldown })),
      identities: [...this.identities],
      refreshAttempts: [...this.lastRefreshAttempt],
    };
  }

  /**
   * Loads a snapshot, defensively: structurally invalid snapshots are refused
   * wholesale, while individually corrupt entries are skipped. Returns whether
   * anything was loaded.
   */
  restore(snapshot: unknown, nowMs: number): boolean {
    if (!isRecord(snapshot) || snapshot["version"] !== 1) return false;
    if (!Number.isFinite(snapshot["coverageStartMs"])) return false;
    if (!Array.isArray(snapshot["buckets"])) return false;
    const buckets = new Map<number, UsageBucket>();
    for (const raw of snapshot["buckets"]) {
      const bucket = restoreBucket(raw);
      if (bucket !== null) buckets.set(bucket.startMs, bucket);
    }
    this.buckets = buckets;
    this.coverageStartMs = snapshot["coverageStartMs"] as number;
    this.quota.clear();
    if (Array.isArray(snapshot["quota"])) {
      for (const raw of snapshot["quota"]) {
        if (!isRecord(raw)) continue;
        const host = typeof raw["host"] === "string" ? boundHost(raw["host"]) : null;
        const owner =
          typeof raw["owner"] === "string" ? raw["owner"].slice(0, MAX_LABEL_LENGTH) : null;
        const resource =
          typeof raw["resource"] === "string" ? raw["resource"].slice(0, MAX_LABEL_LENGTH) : null;
        const state = restoreQuotaState(raw["state"]);
        if (
          host === null ||
          host.length === 0 ||
          owner === null ||
          resource === null ||
          state === null
        ) {
          continue;
        }
        let byOwner = this.quota.get(host);
        if (byOwner === undefined) {
          byOwner = new Map();
          this.quota.set(host, byOwner);
        }
        let byResource = byOwner.get(owner);
        if (byResource === undefined) {
          byResource = new Map();
          byOwner.set(owner, byResource);
        }
        byResource.set(resource, state);
      }
    }
    this.cooldowns.clear();
    if (Array.isArray(snapshot["cooldowns"])) {
      for (const raw of snapshot["cooldowns"]) {
        if (!isRecord(raw)) continue;
        const key = typeof raw["key"] === "string" ? raw["key"].slice(0, 512) : null;
        const untilMs = raw["untilMs"];
        const kind = raw["kind"];
        if (
          key === null ||
          !Number.isFinite(untilMs) ||
          (kind !== "primary" && kind !== "secondary" && kind !== "unknown")
        ) {
          continue;
        }
        this.cooldowns.set(key, { untilMs: untilMs as number, kind });
      }
    }
    this.identities.clear();
    if (Array.isArray(snapshot["identities"])) {
      for (const raw of snapshot["identities"]) {
        if (
          Array.isArray(raw) &&
          typeof raw[0] === "string" &&
          typeof raw[1] === "string" &&
          raw[1].trim().length > 0
        ) {
          this.identities.set(boundHost(raw[0]), raw[1].trim().slice(0, MAX_LABEL_LENGTH));
        }
      }
    }
    this.lastRefreshAttempt.clear();
    if (Array.isArray(snapshot["refreshAttempts"])) {
      for (const raw of snapshot["refreshAttempts"]) {
        if (Array.isArray(raw) && typeof raw[0] === "string" && Number.isFinite(raw[1])) {
          this.lastRefreshAttempt.set(raw[0].slice(0, 512), raw[1] as number);
        }
      }
    }
    this.prune(nowMs);
    this.dirty = true;
    return true;
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
    readonly refreshQuota: (
      host: string,
    ) => Effect.Effect<GitHubApiQuotaRefreshResult, GitHubApiUsageError>;
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
  return buildService(store);
});

function buildService(store: GitHubApiUsageStore): GitHubApiUsage["Service"] {
  // Single-flight explicit refreshes per host: concurrent callers share one.
  const inFlight = new Map<
    string,
    Deferred.Deferred<GitHubApiQuotaRefreshResult, GitHubApiUsageError>
  >();

  const runRefresh = (
    normalizedHost: string,
  ): Effect.Effect<GitHubApiQuotaRefreshResult, GitHubApiUsageError> =>
    Effect.gen(function* () {
      const github = yield* Effect.serviceOption(GitHubCli);
      if (github._tag === "None") {
        return yield* new GitHubApiUsageError({
          message: `GitHub CLI is unavailable in this environment, so quota for ${normalizedHost} cannot be refreshed.`,
        });
      }
      const result = yield* github.value
        .execute({
          cwd: process.cwd(),
          args: ["api", "--hostname", normalizedHost, "rate_limit"],
          usage: { feature: "quota-refresh", host: normalizedHost },
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new GitHubApiUsageError({
                message: `GitHub quota refresh for ${normalizedHost} failed: ${error.detail}`,
              }),
          ),
        );
      const at = Date.now();
      const observations = parseRateLimitPayload(result.stdout, at);
      if (observations.length === 0) {
        return yield* new GitHubApiUsageError({
          message: `GitHub quota refresh for ${normalizedHost} returned no usable quota observations.`,
        });
      }
      for (const observation of observations) {
        store.observeRateLimit(normalizedHost, observation, at);
      }
      return {
        host: normalizedHost,
        refreshed: true,
        quota: store.quotaSnapshot(at),
      };
    });

  const refreshQuota: GitHubApiUsage["Service"]["refreshQuota"] = (host) =>
    Effect.gen(function* () {
      const normalizedHost = boundHost(host);
      const existing = inFlight.get(normalizedHost);
      if (existing !== undefined) return yield* Deferred.await(existing);
      const nowMs = Date.now();
      const login = store.identityOf(normalizedHost) ?? undefined;
      if (!store.shouldRefresh(normalizedHost, nowMs, login)) {
        return {
          host: normalizedHost,
          refreshed: false,
          quota: store.quotaSnapshot(nowMs),
        };
      }
      const gate = yield* Deferred.make<GitHubApiQuotaRefreshResult, GitHubApiUsageError>();
      inFlight.set(normalizedHost, gate);
      // Attempts throttle even when they fail, so a broken probe cannot poll.
      store.markRefreshAttempt(normalizedHost, Date.now(), login);
      const outcome = yield* Effect.exit(runRefresh(normalizedHost));
      // Uninterruptible release: waiters must always be answered and the map
      // must never retain a settled gate, however this fiber ends.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          inFlight.delete(normalizedHost);
          if (Exit.isSuccess(outcome)) {
            yield* Deferred.succeed(gate, outcome.value);
          } else {
            yield* Deferred.failCause(gate, outcome.cause);
          }
        }),
      );
      return yield* Deferred.await(gate);
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
}

export const GitHubApiUsageLive = Layer.effect(GitHubApiUsage, make);

export const USAGE_SNAPSHOT_KEY = "github-usage-snapshot-v1";
const SNAPSHOT_SAVE_INTERVAL = Duration.seconds(30);

/** Total save: failures are logged, never thrown — callers must not break on I/O. */
export function saveUsageSnapshot(
  store: GitHubApiUsageStore,
): Effect.Effect<void, never, KeyValueStore.KeyValueStore> {
  return Effect.flatMap(
    Effect.sync(() => JSON.stringify(store.snapshot())),
    (json) =>
      Effect.asVoid(
        KeyValueStore.KeyValueStore.pipe(
          Effect.flatMap((kvs) => kvs.set(USAGE_SNAPSHOT_KEY, json)),
        ),
      ),
  ).pipe(
    Effect.catchCause((cause) => Effect.logWarning("GitHub usage snapshot save failed", cause)),
  );
}

function saveIfDirty(
  store: GitHubApiUsageStore,
): Effect.Effect<void, never, KeyValueStore.KeyValueStore> {
  return Effect.flatMap(
    Effect.sync(() => store.consumeDirty()),
    (dirty) => (dirty ? saveUsageSnapshot(store) : Effect.void),
  );
}

/** Total load: a missing or invalid snapshot starts fresh with a warning. */
export function loadUsageSnapshot(
  store: GitHubApiUsageStore,
  nowMs: number,
): Effect.Effect<void, never, KeyValueStore.KeyValueStore> {
  return Effect.gen(function* () {
    const kvs = yield* KeyValueStore.KeyValueStore;
    const raw = yield* kvs
      .get(USAGE_SNAPSHOT_KEY)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("GitHub usage snapshot read failed; starting fresh", cause).pipe(
            Effect.as(undefined),
          ),
        ),
      );
    if (raw === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      yield* Effect.logWarning("GitHub usage snapshot is not valid JSON; starting fresh");
      return;
    }
    if (!store.restore(parsed, nowMs)) {
      yield* Effect.logWarning("GitHub usage snapshot failed validation; starting fresh");
    }
  });
}

/**
 * File-backed usage history: loads the snapshot at startup, saves dirty
 * state every 30 seconds, and flushes on shutdown. Falls back to memory-only
 * history when the snapshot directory is unavailable.
 */
export const GitHubApiUsagePersistentLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const backing = KeyValueStore.layerFileSystem(
      path.join(config.providerStatusCacheDir, "github-usage"),
    ).pipe(
      Layer.catch(() =>
        Layer.effectDiscard(
          Effect.logWarning(
            "GitHub usage snapshot directory unavailable; usage history will not survive restarts",
          ),
        ).pipe(Layer.provideMerge(KeyValueStore.layerMemory)),
      ),
    );
    return Layer.effect(
      GitHubApiUsage,
      Effect.gen(function* () {
        const store = new GitHubApiUsageStore(Date.now());
        yield* loadUsageSnapshot(store, Date.now());
        yield* Effect.forkScoped(
          Effect.forever(Effect.andThen(Effect.sleep(SNAPSHOT_SAVE_INTERVAL), saveIfDirty(store))),
        );
        yield* Effect.addFinalizer(() => saveIfDirty(store));
        return buildService(store);
      }),
    ).pipe(Layer.provide(backing));
  }),
);

export { parseGhDebugTelemetry };
