import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  RunId,
  TurnTokenUsage,
  UsageTokenTotals,
} from "@t3tools/contracts";

export type ThreadTurnTokenUsageStatus = "complete" | "partial" | "unavailable";

export type ThreadTurnTokenUsageSummary = {
  readonly usageStatus: ThreadTurnTokenUsageStatus;
  readonly inputTokens: number | null;
  /** Input that was not served from cache; `inputTokens` minus cache read/write when known. */
  readonly uncachedInputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly otherInputTokens: number | null;
  readonly otherOutputTokens: number | null;
  /** Main-agent input plus output when both sums are known. */
  readonly totalTokens: number | null;
  readonly turnCount: number;
  readonly measuredTurnCount: number;
};

export type ThreadTurnTokenUsageRow = {
  readonly runId: RunId;
  readonly ordinal: number;
  /** Label for the By turn row (a single model, Mixed models, or Unknown model). */
  readonly model: string | null;
  /**
   * Model id to price this run's totals. Null when models are mixed or unknown so we do not
   * apply one rate to another model's tokens.
   */
  readonly priceModel: string | null;
  readonly usage: ThreadTurnTokenUsageSummary;
};

function sumField(
  usages: ReadonlyArray<TurnTokenUsage>,
  field:
    | "inputTokens"
    | "cachedInputTokens"
    | "cacheCreationTokens"
    | "outputTokens"
    | "reasoningTokens",
): number | null {
  let sum = 0;
  let known = 0;
  for (const usage of usages) {
    const value = usage[field];
    if (value === undefined) continue;
    sum += value;
    known += 1;
  }
  return known === 0 ? null : sum;
}

function sumOther(
  usages: ReadonlyArray<TurnTokenUsage>,
  field: "inputTokens" | "outputTokens",
): number | null {
  let sum = 0;
  let known = 0;
  for (const usage of usages) {
    const other = usage.otherUsage;
    if (other === undefined) continue;
    sum += other[field];
    known += 1;
  }
  return known === 0 ? null : sum;
}

function usageHasCounts(usage: TurnTokenUsage | undefined): boolean {
  return (
    usage?.inputTokens !== undefined ||
    usage?.outputTokens !== undefined ||
    usage?.cachedInputTokens !== undefined ||
    usage?.cacheCreationTokens !== undefined ||
    usage?.reasoningTokens !== undefined
  );
}

/** complete only when every turn reports complete usage; partial when any turn has counts. */
function combinedStatus(
  usages: ReadonlyArray<TurnTokenUsage | undefined>,
): ThreadTurnTokenUsageStatus {
  if (usages.length > 0 && usages.every((usage) => usage?.usageStatus === "complete")) {
    return "complete";
  }
  return usages.some(usageHasCounts) ? "partial" : "unavailable";
}

function emptySummary(turnCount: number): ThreadTurnTokenUsageSummary {
  return {
    usageStatus: "unavailable",
    inputTokens: null,
    uncachedInputTokens: null,
    cachedInputTokens: null,
    cacheCreationTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    otherInputTokens: null,
    otherOutputTokens: null,
    totalTokens: null,
    turnCount,
    measuredTurnCount: 0,
  };
}

/**
 * Sums each provider turn's `turnTokenUsage` for one T3 thread.
 * Input already includes cache reads and writes on Claude and Codex; those fields are a breakdown.
 * Child-thread subagents are not included; native ledger extras appear as `other*`.
 */
export function summarizeThreadTurnTokenUsage(
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "turnTokenUsage">>,
): ThreadTurnTokenUsageSummary {
  const usages = turns.map((turn) => turn.turnTokenUsage);
  const measured = usages.filter((usage) => usage !== undefined);
  const usageStatus = combinedStatus(usages);
  if (measured.length === 0) return emptySummary(turns.length);

  const inputTokens = sumField(measured, "inputTokens");
  const cachedInputTokens = sumField(measured, "cachedInputTokens");
  const cacheCreationTokens = sumField(measured, "cacheCreationTokens");
  const outputTokens = sumField(measured, "outputTokens");
  // Per-turn uncached: cache-only turns must not reduce uncached from turns that reported input.
  let uncachedInputTokens: number | null = null;
  for (const usage of measured) {
    if (usage.inputTokens === undefined) continue;
    const contribution = Math.max(
      0,
      usage.inputTokens - (usage.cachedInputTokens ?? 0) - (usage.cacheCreationTokens ?? 0),
    );
    uncachedInputTokens = (uncachedInputTokens ?? 0) + contribution;
  }
  return {
    usageStatus,
    inputTokens,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: sumField(measured, "reasoningTokens"),
    otherInputTokens: sumOther(measured, "inputTokens"),
    otherOutputTokens: sumOther(measured, "outputTokens"),
    totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
    turnCount: turns.length,
    measuredTurnCount: measured.length,
  };
}

/** Shape used by Usage pricing; missing counts become zero so unpriced models stay unpriced. */
export function threadTurnTokenUsageTotals(
  usage: Pick<
    ThreadTurnTokenUsageSummary,
    | "uncachedInputTokens"
    | "cachedInputTokens"
    | "cacheCreationTokens"
    | "outputTokens"
    | "reasoningTokens"
  >,
): UsageTokenTotals | null {
  const uncachedInputTokens = usage.uncachedInputTokens ?? 0;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const reasoningTokens = usage.reasoningTokens ?? 0;
  if (
    uncachedInputTokens === 0 &&
    cachedInputTokens === 0 &&
    cacheCreationTokens === 0 &&
    outputTokens === 0
  ) {
    return null;
  }
  return {
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
  };
}

function resolveRunModels(
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "turnTokenUsage">>,
  fallbackModel: string,
): { readonly label: string | null; readonly priceModel: string | null } {
  const reported = new Set<string>();
  for (const turn of turns) {
    for (const entry of turn.turnTokenUsage?.models ?? []) {
      const model = entry.trim();
      if (model.length > 0) reported.add(model);
    }
  }
  if (reported.size > 1) return { label: "Mixed models", priceModel: null };
  if (reported.size === 1) {
    const model = [...reported][0]!;
    return { label: model, priceModel: model };
  }
  const fallback = fallbackModel.trim();
  if (fallback.length > 0) return { label: fallback, priceModel: fallback };
  return { label: null, priceModel: null };
}

/**
 * One row per user run, summing provider turns across every attempt that ran.
 * Superseded attempts still count when they burned tokens before a restart.
 */
export function listThreadTurnTokenUsageByRun(input: {
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "ordinal" | "modelSelection" | "activeAttemptId">
  >;
  readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId" | "status">>;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "turnTokenUsage">
  >;
}): readonly ThreadTurnTokenUsageRow[] {
  const attemptsByRun = new Map<RunId, Array<(typeof input.attempts)[number]>>();
  for (const attempt of input.attempts) {
    const list = attemptsByRun.get(attempt.runId);
    if (list === undefined) attemptsByRun.set(attempt.runId, [attempt]);
    else list.push(attempt);
  }

  const turnsByAttempt = new Map<
    string,
    Array<Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "turnTokenUsage">>
  >();
  for (const turn of input.providerTurns) {
    if (turn.runAttemptId === null) continue;
    const list = turnsByAttempt.get(turn.runAttemptId);
    if (list === undefined) turnsByAttempt.set(turn.runAttemptId, [turn]);
    else list.push(turn);
  }

  const rows: ThreadTurnTokenUsageRow[] = [];
  for (const run of [...input.runs].sort((a, b) => a.ordinal - b.ordinal)) {
    const attempts = attemptsByRun.get(run.id) ?? [];
    const turns = attempts.flatMap((attempt) => turnsByAttempt.get(attempt.id) ?? []);
    const models = resolveRunModels(turns, run.modelSelection.model);
    rows.push({
      runId: run.id,
      ordinal: run.ordinal,
      model: models.label,
      priceModel: models.priceModel,
      usage: summarizeThreadTurnTokenUsage(turns),
    });
  }
  return rows;
}
