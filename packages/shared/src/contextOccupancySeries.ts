import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2RunAttempt,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type ContextOccupancyPointKind = "turn" | "compaction-before" | "compaction-after";

export type ContextOccupancyPoint = {
  readonly atMs: number;
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly kind: ContextOccupancyPointKind;
  readonly runId: RunId | null;
};

export type ContextOccupancySeries = {
  readonly points: readonly ContextOccupancyPoint[];
  /** Highest maxTokens seen, for the chart ceiling. */
  readonly maxTokens: number | null;
  readonly peakUsedTokens: number;
};

type OccupancyTurnItem = {
  readonly type: string;
  readonly runId: RunId | null;
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
  readonly updatedAt?: DateTime.Utc | null;
  readonly beforeTokenCount?: number | undefined;
  readonly afterTokenCount?: number | undefined;
};

function toEpochMs(value: DateTime.Utc | null | undefined): number | null {
  if (value == null) return null;
  const ms = DateTime.toEpochMillis(value);
  return Number.isFinite(ms) ? ms : null;
}

function isoToEpochMs(value: string | null | undefined): number | null {
  if (value == null || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Build a chronological context-window fill series from per-turn occupancy
 * snapshots and compaction before/after counts. Projection keeps only the
 * latest tokenUsage per turn, so this is turn-level plus compaction dips.
 */
export function deriveContextOccupancySeries(input: {
  readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "tokenUsage" | "startedAt" | "completedAt">
  >;
  readonly turnItems: ReadonlyArray<OccupancyTurnItem>;
}): ContextOccupancySeries {
  const runIdByAttempt = new Map<string, RunId>();
  for (const attempt of input.attempts) {
    runIdByAttempt.set(attempt.id, attempt.runId);
  }

  const points: ContextOccupancyPoint[] = [];
  let maxTokens: number | null = null;
  let peakUsedTokens = 0;

  const noteMax = (value: number | null | undefined) => {
    if (value == null || value <= 0) return;
    maxTokens = maxTokens === null ? value : Math.max(maxTokens, value);
  };

  for (const turn of input.providerTurns) {
    const usage = turn.tokenUsage;
    if (usage === undefined) continue;
    const atMs =
      isoToEpochMs(usage.updatedAt) ?? toEpochMs(turn.completedAt) ?? toEpochMs(turn.startedAt);
    if (atMs === null) continue;
    const runId =
      turn.runAttemptId === null ? null : (runIdByAttempt.get(turn.runAttemptId) ?? null);
    const pointMax = usage.maxTokens ?? null;
    noteMax(pointMax);
    peakUsedTokens = Math.max(peakUsedTokens, usage.usedTokens);
    points.push({
      atMs,
      usedTokens: usage.usedTokens,
      maxTokens: pointMax,
      kind: "turn",
      runId,
    });
  }

  for (const item of input.turnItems) {
    if (item.type !== "compaction") continue;
    const before = item.beforeTokenCount;
    const after = item.afterTokenCount;
    if (before === undefined && after === undefined) continue;
    const beforeAt =
      toEpochMs(item.startedAt) ?? toEpochMs(item.updatedAt) ?? toEpochMs(item.completedAt);
    const afterAt =
      toEpochMs(item.completedAt) ?? toEpochMs(item.updatedAt) ?? toEpochMs(item.startedAt);
    if (before !== undefined && beforeAt !== null) {
      peakUsedTokens = Math.max(peakUsedTokens, before);
      points.push({
        atMs: beforeAt,
        usedTokens: before,
        maxTokens: null,
        kind: "compaction-before",
        runId: item.runId,
      });
    }
    if (after !== undefined && afterAt !== null) {
      // Keep the drop visible when before/after share a timestamp.
      const atMs =
        before !== undefined && beforeAt !== null && afterAt <= beforeAt ? beforeAt + 1 : afterAt;
      peakUsedTokens = Math.max(peakUsedTokens, after);
      points.push({
        atMs,
        usedTokens: after,
        maxTokens: null,
        kind: "compaction-after",
        runId: item.runId,
      });
    }
  }

  points.sort(
    (left, right) => left.atMs - right.atMs || kindOrder(left.kind) - kindOrder(right.kind),
  );
  return { points, maxTokens, peakUsedTokens };
}

function kindOrder(kind: ContextOccupancyPointKind): number {
  if (kind === "compaction-before") return 0;
  if (kind === "turn") return 1;
  return 2;
}
