/**
 * Cost summary queries.
 *
 * Reads from the server's `/api/cost/summary` endpoint. Server owns the
 * ledger (see apps/server/src/cost/*) so the client is a read-only
 * consumer — localStorage is no longer involved.
 *
 * React Query caches the summary per (environment, thread). The composer
 * invalidates this query whenever the active thread receives a new
 * `context-window.updated` activity so the ring updates in near-realtime.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { resolveEnvironmentHttpUrl } from "../environments/runtime";

// Re-export the shared USD formatter so `~/lib/costQuery` stays the single
// import surface for cost UI consumers (see CostMeter.tsx) while the
// actual implementation lives in @t3tools/shared/pricing alongside
// computeTurnCost.
export { formatUsd } from "@t3tools/shared/pricing";

const COST_SUMMARY_STALE_TIME_MS = 5_000;

/** Bucket shape mirrors apps/server/src/cost/types.ts. Kept duplicated so
 * the client doesn't import server-only modules. */
export interface ModelCostEntry {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalUsd: number;
  readonly turnCount: number;
}

export interface CostBucket {
  readonly totalUsd: number;
  readonly turnCount: number;
  readonly byModel: Record<string, ModelCostEntry>;
  readonly updatedAt: string;
}

export interface CostSummary {
  readonly monthKey: string;
  readonly thread: CostBucket | null;
  readonly month: CostBucket;
  readonly allTime: CostBucket;
}

export const emptyBucket = (): CostBucket => ({
  totalUsd: 0,
  turnCount: 0,
  byModel: {},
  updatedAt: "",
});

const monthKeyNow = () => {
  const now = new Date();
  return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}`;
};

export const EMPTY_COST_SUMMARY: CostSummary = {
  monthKey: monthKeyNow(),
  thread: null,
  month: emptyBucket(),
  allTime: emptyBucket(),
};

export const costQueryKeys = {
  all: ["cost"] as const,
  summary: (environmentId: EnvironmentId | null, threadId: ThreadId | null) =>
    ["cost", "summary", environmentId ?? null, threadId ?? null] as const,
};

async function fetchCostSummary(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly signal?: AbortSignal;
}): Promise<CostSummary> {
  const url = resolveEnvironmentHttpUrl({
    environmentId: input.environmentId,
    pathname: "/api/cost/summary",
    searchParams: input.threadId ? { threadId: String(input.threadId) } : {},
  });
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Failed to load cost summary: HTTP ${response.status}`);
  }
  const raw = (await response.json()) as unknown;
  return sanitizeSummary(raw);
}

function sanitizeSummary(raw: unknown): CostSummary {
  if (!raw || typeof raw !== "object") return EMPTY_COST_SUMMARY;
  const r = raw as Record<string, unknown>;
  return {
    monthKey: typeof r.monthKey === "string" ? r.monthKey : monthKeyNow(),
    thread: sanitizeBucketOrNull(r.thread),
    month: sanitizeBucket(r.month),
    allTime: sanitizeBucket(r.allTime),
  };
}

function sanitizeBucket(raw: unknown): CostBucket {
  if (!raw || typeof raw !== "object") return emptyBucket();
  const r = raw as Record<string, unknown>;
  const byModelRaw = (r.byModel ?? {}) as Record<string, unknown>;
  const byModel: Record<string, ModelCostEntry> = {};
  for (const [model, entry] of Object.entries(byModelRaw)) {
    if (!model || !entry || typeof entry !== "object") continue;
    byModel[model] = sanitizeEntry(entry);
  }
  return {
    totalUsd: toNonNeg(r.totalUsd),
    turnCount: toNonNeg(r.turnCount),
    byModel,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
  };
}

function sanitizeBucketOrNull(raw: unknown): CostBucket | null {
  if (!raw || typeof raw !== "object") return null;
  return sanitizeBucket(raw);
}

function sanitizeEntry(raw: unknown): ModelCostEntry {
  const r = raw as Record<string, unknown>;
  return {
    inputTokens: toNonNeg(r.inputTokens),
    cachedInputTokens: toNonNeg(r.cachedInputTokens),
    cacheCreationInputTokens: toNonNeg(r.cacheCreationInputTokens),
    outputTokens: toNonNeg(r.outputTokens),
    reasoningOutputTokens: toNonNeg(r.reasoningOutputTokens),
    totalUsd: toNonNeg(r.totalUsd),
    turnCount: toNonNeg(r.turnCount),
  };
}

function toNonNeg(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function costSummaryQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}) {
  return queryOptions({
    queryKey: costQueryKeys.summary(input.environmentId, input.threadId),
    queryFn: ({ signal }) => {
      if (!input.environmentId) {
        return Promise.resolve(EMPTY_COST_SUMMARY);
      }
      return fetchCostSummary({
        environmentId: input.environmentId,
        threadId: input.threadId,
        signal,
      });
    },
    enabled: input.environmentId !== null,
    staleTime: COST_SUMMARY_STALE_TIME_MS,
    placeholderData: EMPTY_COST_SUMMARY,
  });
}

/** Invalidate the cost query for a specific thread (or all threads if omitted). */
export function invalidateCostSummary(
  queryClient: QueryClient,
  input?: {
    readonly environmentId?: EnvironmentId | null;
    readonly threadId?: ThreadId | null;
  },
) {
  if (input?.environmentId !== undefined || input?.threadId !== undefined) {
    return queryClient.invalidateQueries({
      queryKey: costQueryKeys.summary(input.environmentId ?? null, input.threadId ?? null),
    });
  }
  return queryClient.invalidateQueries({ queryKey: costQueryKeys.all });
}

