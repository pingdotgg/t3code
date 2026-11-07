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
  /** Native model id when a turn reported one; otherwise the run's selected model. */
  readonly model: string | null;
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

/** complete only when every turn reports complete usage; partial when any turn has counts. */
function combinedStatus(
  usages: ReadonlyArray<TurnTokenUsage | undefined>,
): ThreadTurnTokenUsageStatus {
  if (usages.length > 0 && usages.every((usage) => usage?.usageStatus === "complete")) {
    return "complete";
  }
  return usages.some(
    (usage) => usage?.inputTokens !== undefined || usage?.outputTokens !== undefined,
  )
    ? "partial"
    : "unavailable";
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
  return {
    usageStatus,
    inputTokens,
    uncachedInputTokens:
      inputTokens === null
        ? null
        : Math.max(0, inputTokens - (cachedInputTokens ?? 0) - (cacheCreationTokens ?? 0)),
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

function reportedModels(
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "turnTokenUsage">>,
): string | null {
  for (const turn of turns) {
    const model = turn.turnTokenUsage?.models?.find((entry) => entry.trim().length > 0);
    if (model !== undefined) return model.trim();
  }
  return null;
}

/**
 * One row per user run, summing provider turns on non-superseded attempts.
 * Retries that actually ran still count; superseded attempts do not.
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
    const attempts = (attemptsByRun.get(run.id) ?? []).filter(
      (attempt) => attempt.status !== "superseded",
    );
    const turns = attempts.flatMap((attempt) => turnsByAttempt.get(attempt.id) ?? []);
    rows.push({
      runId: run.id,
      ordinal: run.ordinal,
      model: reportedModels(turns) ?? (run.modelSelection.model.trim() || null),
      usage: summarizeThreadTurnTokenUsage(turns),
    });
  }
  return rows;
}
