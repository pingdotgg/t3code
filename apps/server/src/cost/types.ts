/**
 * Shared cost-tracker types. Persisted to disk verbatim under
 * `<T3CODE_HOME>/<state>/usage/*.json`. Loose interfaces + a sanitizer pass
 * — we're the only writer, so round-tripping through Effect.Schema is
 * overkill here. The sanitizer tolerates garbage and returns a fresh empty
 * bucket rather than crashing.
 */

/** Running tallies for a single (model, bucket) pair. */
export interface ModelCostEntry {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalUsd: number;
  readonly turnCount: number;
}

export const emptyModelCostEntry = (): ModelCostEntry => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalUsd: 0,
  turnCount: 0,
});

/**
 * A cost bucket — used for per-thread (session), per-month, and all-time
 * aggregates. Same shape, different persistence files.
 */
export interface CostBucket {
  readonly totalUsd: number;
  readonly turnCount: number;
  readonly byModel: Record<string, ModelCostEntry>;
  readonly updatedAt: string;
}

export const emptyCostBucket = (now: Date = new Date()): CostBucket => ({
  totalUsd: 0,
  turnCount: 0,
  byModel: {},
  updatedAt: now.toISOString(),
});

export type PersistedCostFileKind = "session" | "month" | "alltime";

/** Last cumulative usage snapshot — drives delta math when payload lacks lastXxx. */
export interface CumulativeUsageSnapshot {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

export const zeroCumulativeUsage = (): CumulativeUsageSnapshot => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
});

export interface PersistedCostFile {
  readonly version: 1;
  readonly kind: PersistedCostFileKind;
  readonly key: string;
  readonly bucket: CostBucket;
  /**
   * Session files only. Runtime payloads from Claude/Codex carry cumulative
   * totals across the whole thread; we subtract this snapshot to get the
   * just-completed turn's deltas.
   */
  readonly lastCumulative?: CumulativeUsageSnapshot;
}

export interface CostSummary {
  readonly thread: CostBucket | null;
  readonly month: CostBucket;
  readonly allTime: CostBucket;
  readonly monthKey: string;
}

export interface RecordUsageInput {
  readonly threadId: string;
  readonly model: string;
  readonly usage: UsageSnapshotLite;
  readonly provider?: string | undefined;
  readonly at?: Date;
}

/**
 * Minimal shape we need from `ThreadTokenUsageSnapshot`; accepting a plain
 * record keeps tests independent of the contracts package.
 */
export interface UsageSnapshotLite {
  readonly inputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly cacheCreationInputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly reasoningOutputTokens?: number | undefined;
  readonly lastInputTokens?: number | undefined;
  readonly lastCachedInputTokens?: number | undefined;
  readonly lastCacheCreationInputTokens?: number | undefined;
  readonly lastOutputTokens?: number | undefined;
  readonly lastReasoningOutputTokens?: number | undefined;
}

/**
 * `YYYY-MM` key for a Date in the user's local timezone. Statusline.sh-style
 * monthly bucket: rollover on the user's clock, not UTC.
 */
export function localMonthKey(date: Date = new Date()): string {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  return `${year}-${month}`;
}
