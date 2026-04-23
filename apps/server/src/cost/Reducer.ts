/**
 * Pure cost-tracker reducers. No filesystem, no Effect — just math on plain
 * objects so the write-path logic is trivial to unit-test.
 */
import { computeTurnCost, type ProviderKind, type TurnTokenDeltas } from "@t3tools/shared/pricing";
import type {
  CostBucket,
  CumulativeUsageSnapshot,
  ModelCostEntry,
  PersistedCostFile,
  PersistedCostFileKind,
  RecordUsageInput,
  UsageSnapshotLite,
} from "./types.ts";
import {
  emptyCostBucket,
  emptyModelCostEntry,
  localMonthKey,
  zeroCumulativeUsage,
} from "./types.ts";

function finiteNonNeg(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Derive the deltas for this turn. Prefers the payload's `lastXxxTokens`
 * fields (Codex and post-fix Claude); falls back to subtracting against the
 * session file's `lastCumulative` snapshot (older providers / recovered
 * sessions).
 */
export function deriveTurnDeltas(
  usage: UsageSnapshotLite,
  priorCumulative: CumulativeUsageSnapshot | undefined,
): {
  readonly deltas: TurnTokenDeltas;
  readonly nextCumulative: CumulativeUsageSnapshot;
} {
  const hasExplicitLast =
    usage.lastInputTokens !== undefined ||
    usage.lastCachedInputTokens !== undefined ||
    usage.lastCacheCreationInputTokens !== undefined ||
    usage.lastOutputTokens !== undefined ||
    usage.lastReasoningOutputTokens !== undefined;

  const currentCumulative: CumulativeUsageSnapshot = {
    inputTokens: finiteNonNeg(usage.inputTokens),
    cachedInputTokens: finiteNonNeg(usage.cachedInputTokens),
    cacheCreationInputTokens: finiteNonNeg(usage.cacheCreationInputTokens),
    outputTokens: finiteNonNeg(usage.outputTokens),
    reasoningOutputTokens: finiteNonNeg(usage.reasoningOutputTokens),
  };

  if (hasExplicitLast) {
    const deltas: TurnTokenDeltas = {
      inputTokens: finiteNonNeg(usage.lastInputTokens),
      cachedInputTokens: finiteNonNeg(usage.lastCachedInputTokens),
      cacheCreationInputTokens: finiteNonNeg(usage.lastCacheCreationInputTokens),
      outputTokens: finiteNonNeg(usage.lastOutputTokens),
      reasoningOutputTokens: finiteNonNeg(usage.lastReasoningOutputTokens),
    };
    // Next cumulative tracks whatever the payload reports cumulatively. If
    // the payload gives lastXxx but not the cumulative totals, roll the
    // deltas into the prior cumulative so we still have somewhere to land.
    const nextCumulative =
      currentCumulative.inputTokens +
        currentCumulative.cachedInputTokens +
        currentCumulative.cacheCreationInputTokens +
        currentCumulative.outputTokens +
        currentCumulative.reasoningOutputTokens >
      0
        ? currentCumulative
        : addCumulative(priorCumulative ?? zeroCumulativeUsage(), deltas);
    return { deltas, nextCumulative };
  }

  const prior = priorCumulative ?? zeroCumulativeUsage();
  const deltas: TurnTokenDeltas = {
    inputTokens: Math.max(0, currentCumulative.inputTokens - prior.inputTokens),
    cachedInputTokens: Math.max(0, currentCumulative.cachedInputTokens - prior.cachedInputTokens),
    cacheCreationInputTokens: Math.max(
      0,
      currentCumulative.cacheCreationInputTokens - prior.cacheCreationInputTokens,
    ),
    outputTokens: Math.max(0, currentCumulative.outputTokens - prior.outputTokens),
    reasoningOutputTokens: Math.max(
      0,
      currentCumulative.reasoningOutputTokens - prior.reasoningOutputTokens,
    ),
  };
  return { deltas, nextCumulative: currentCumulative };
}

function addCumulative(
  base: CumulativeUsageSnapshot,
  deltas: TurnTokenDeltas,
): CumulativeUsageSnapshot {
  return {
    inputTokens: base.inputTokens + deltas.inputTokens,
    cachedInputTokens: base.cachedInputTokens + deltas.cachedInputTokens,
    cacheCreationInputTokens: base.cacheCreationInputTokens + deltas.cacheCreationInputTokens,
    outputTokens: base.outputTokens + deltas.outputTokens,
    reasoningOutputTokens: base.reasoningOutputTokens + deltas.reasoningOutputTokens,
  };
}

function addEntry(
  entry: ModelCostEntry,
  deltas: TurnTokenDeltas,
  costUsd: number,
): ModelCostEntry {
  return {
    inputTokens: entry.inputTokens + deltas.inputTokens,
    cachedInputTokens: entry.cachedInputTokens + deltas.cachedInputTokens,
    cacheCreationInputTokens: entry.cacheCreationInputTokens + deltas.cacheCreationInputTokens,
    outputTokens: entry.outputTokens + deltas.outputTokens,
    reasoningOutputTokens: entry.reasoningOutputTokens + deltas.reasoningOutputTokens,
    totalUsd: entry.totalUsd + costUsd,
    turnCount: entry.turnCount + 1,
  };
}

export function addTurnToBucket(
  bucket: CostBucket,
  model: string,
  deltas: TurnTokenDeltas,
  costUsd: number,
  now: Date,
): CostBucket {
  const prev = bucket.byModel[model] ?? emptyModelCostEntry();
  return {
    totalUsd: bucket.totalUsd + costUsd,
    turnCount: bucket.turnCount + 1,
    byModel: {
      ...bucket.byModel,
      [model]: addEntry(prev, deltas, costUsd),
    },
    updatedAt: now.toISOString(),
  };
}

/** True when no billable tokens changed — tracker should no-op. */
export function isTurnNoOp(deltas: TurnTokenDeltas): boolean {
  return (
    deltas.inputTokens +
      deltas.cachedInputTokens +
      deltas.cacheCreationInputTokens +
      deltas.outputTokens +
      deltas.reasoningOutputTokens <=
    0
  );
}

export interface ProcessTurnArgs {
  readonly input: RecordUsageInput;
  readonly session: PersistedCostFile | undefined;
  readonly month: PersistedCostFile | undefined;
  readonly allTime: PersistedCostFile | undefined;
  readonly now?: Date;
}

export interface ProcessTurnResult {
  readonly session: PersistedCostFile;
  readonly month: PersistedCostFile;
  readonly allTime: PersistedCostFile;
  readonly monthKey: string;
  readonly deltas: TurnTokenDeltas;
  readonly costUsd: number;
  readonly applied: boolean;
}

/**
 * Pure reducer: given the current persisted state for the three buckets and
 * one runtime usage event, produce the three updated files. Idempotent when
 * the turn contributes zero tokens (returns inputs unchanged).
 */
export function processTurn(args: ProcessTurnArgs): ProcessTurnResult {
  const now = args.now ?? args.input.at ?? new Date();
  const monthKey = localMonthKey(now);

  const priorSessionBucket =
    args.session?.bucket ?? emptyCostBucket(now);
  const priorMonthBucket = args.month?.bucket ?? emptyCostBucket(now);
  const priorAllTimeBucket = args.allTime?.bucket ?? emptyCostBucket(now);

  const { deltas, nextCumulative } = deriveTurnDeltas(
    args.input.usage,
    args.session?.lastCumulative,
  );

  if (isTurnNoOp(deltas)) {
    return {
      session: {
        version: 1,
        kind: "session",
        key: args.input.threadId,
        bucket: priorSessionBucket,
        ...(args.session?.lastCumulative
          ? { lastCumulative: args.session.lastCumulative }
          : {}),
      },
      month: {
        version: 1,
        kind: "month",
        key: args.month?.key ?? monthKey,
        bucket: priorMonthBucket,
      },
      allTime: {
        version: 1,
        kind: "alltime",
        key: "alltime",
        bucket: priorAllTimeBucket,
      },
      monthKey,
      deltas,
      costUsd: 0,
      applied: false,
    };
  }

  const breakdown = computeTurnCost(
    args.input.model,
    deltas,
    args.input.provider as ProviderKind | undefined,
  );
  const costUsd = breakdown.totalUsd;

  const nextSession: PersistedCostFile = {
    version: 1,
    kind: "session",
    key: args.input.threadId,
    bucket: addTurnToBucket(priorSessionBucket, args.input.model, deltas, costUsd, now),
    lastCumulative: nextCumulative,
  };
  const nextMonth: PersistedCostFile = {
    version: 1,
    kind: "month",
    key: monthKey,
    bucket: addTurnToBucket(priorMonthBucket, args.input.model, deltas, costUsd, now),
  };
  const nextAllTime: PersistedCostFile = {
    version: 1,
    kind: "alltime",
    key: "alltime",
    bucket: addTurnToBucket(priorAllTimeBucket, args.input.model, deltas, costUsd, now),
  };

  return {
    session: nextSession,
    month: nextMonth,
    allTime: nextAllTime,
    monthKey,
    deltas,
    costUsd,
    applied: true,
  };
}

// ── Sanitization ────────────────────────────────────────────────────────

function sanitizeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function sanitizeModelEntry(raw: unknown): ModelCostEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    inputTokens: sanitizeNumber(r.inputTokens),
    cachedInputTokens: sanitizeNumber(r.cachedInputTokens),
    cacheCreationInputTokens: sanitizeNumber(r.cacheCreationInputTokens),
    outputTokens: sanitizeNumber(r.outputTokens),
    reasoningOutputTokens: sanitizeNumber(r.reasoningOutputTokens),
    totalUsd: sanitizeNumber(r.totalUsd),
    turnCount: sanitizeNumber(r.turnCount),
  };
}

function sanitizeBucket(raw: unknown, now: Date): CostBucket {
  if (!raw || typeof raw !== "object") return emptyCostBucket(now);
  const r = raw as Record<string, unknown>;
  const byModelRaw = (r.byModel ?? {}) as Record<string, unknown>;
  const byModel: Record<string, ModelCostEntry> = {};
  for (const [model, entry] of Object.entries(byModelRaw)) {
    if (!model) continue;
    const cleaned = sanitizeModelEntry(entry);
    if (cleaned) byModel[model] = cleaned;
  }
  return {
    totalUsd: sanitizeNumber(r.totalUsd),
    turnCount: sanitizeNumber(r.turnCount),
    byModel,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : now.toISOString(),
  };
}

function sanitizeLastCumulative(raw: unknown): CumulativeUsageSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    inputTokens: sanitizeNumber(r.inputTokens),
    cachedInputTokens: sanitizeNumber(r.cachedInputTokens),
    cacheCreationInputTokens: sanitizeNumber(r.cacheCreationInputTokens),
    outputTokens: sanitizeNumber(r.outputTokens),
    reasoningOutputTokens: sanitizeNumber(r.reasoningOutputTokens),
  };
}

/** Parse a JSON blob into a `PersistedCostFile`, swallowing malformed data. */
export function sanitizePersistedFile(
  raw: unknown,
  expectedKind: PersistedCostFileKind,
  expectedKey: string,
  now: Date = new Date(),
): PersistedCostFile {
  if (!raw || typeof raw !== "object") {
    return {
      version: 1,
      kind: expectedKind,
      key: expectedKey,
      bucket: emptyCostBucket(now),
    };
  }
  const r = raw as Record<string, unknown>;
  // version and kind are forced to the expected values — any drift from
  // what the caller asked for is treated as malformed and silently
  // sanitized (the surrounding contract only supports version 1 and the
  // requested kind).
  const key = typeof r.key === "string" && r.key.length > 0 ? r.key : expectedKey;
  const bucket = sanitizeBucket(r.bucket, now);
  const lastCumulative = sanitizeLastCumulative(r.lastCumulative);
  return {
    version: 1,
    kind: expectedKind,
    key,
    bucket,
    ...(lastCumulative && expectedKind === "session" ? { lastCumulative } : {}),
  };
}
