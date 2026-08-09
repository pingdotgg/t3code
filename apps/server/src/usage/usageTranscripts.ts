/**
 * Pure parsers for the provider CLIs' on-disk session transcripts.
 *
 * Both parsers are line-at-a-time reducers so callers can stream large files
 * without materialising them. Neither touches the filesystem.
 *
 * @module usageTranscripts
 */
import type { UsageProviderKind, UsageTokenTotals } from "@t3tools/contracts";

export interface UsageRecord {
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
  /**
   * Key for cross-file de-duplication, or `null` when the record is inherently
   * unique and needs no dedup.
   */
  readonly dedupeKey: string | null;
}

const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function addTotals(a: UsageTokenTotals, b: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export function totalTokens(totals: UsageTokenTotals): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/**
 * Cheap substring gate applied before `JSON.parse`.
 *
 * Transcripts are mostly tool output; only a minority of lines carry usage. On
 * a 30-day window this skips roughly half the lines outright and is worth about
 * an order of magnitude.
 */
export function mightCarryUsage(line: string, provider: UsageProviderKind): boolean {
  return provider === "claude" ? line.includes('"usage"') : line.includes('"token_count"');
}

/* -------------------------------------------------------------------------- */
/* Claude Code                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parses one line of a Claude Code transcript.
 *
 * T3 Code writes one record per assistant *content block*, and every one of
 * those records repeats the same complete `usage` object for the parent
 * message. Summing them overcounts by roughly 2.4x on a real workload, so the
 * caller must drop repeats by `dedupeKey` and keep the first.
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  // Matches ccusage: prefer the message/request pair, fall back to whichever
  // half exists. Records with neither cannot be de-duplicated.
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: int(usageRecord["input_tokens"]),
      cachedInputTokens: int(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: int(usageRecord["cache_creation_input_tokens"]),
      outputTokens: int(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    dedupeKey,
  };
}

/* -------------------------------------------------------------------------- */
/* Codex                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rolling state for a single Codex rollout file.
 *
 * Codex `token_count` events carry no model, so the model is carried forward
 * from the most recent `turn_context`. Sessions that switch models mid-run
 * attribute correctly from the switch onward.
 */
export interface CodexScanState {
  model: string;
  sessionId: string;
  /** Last cumulative checkpoint, used to validate the next per-request increment. */
  cumulativeUsage: CodexUsageCounters | null;
  /** Counter sequences that could not be reconciled without guessing. */
  malformedRecords: number;
}

export function initialCodexScanState(): CodexScanState {
  return { model: "", sessionId: "", cumulativeUsage: null, malformedRecords: 0 };
}

type CodexUsageCounters = readonly [
  inputTokens: number,
  cachedInputTokens: number,
  cacheWriteInputTokens: number,
  outputTokens: number,
  reasoningOutputTokens: number,
  totalTokens: number,
];

function codexCounter(
  record: Record<string, unknown>,
  key: string,
  optional = false,
): number | null {
  const value = record[key];
  if (optional && value === undefined) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function codexUsageCounters(record: Record<string, unknown>): CodexUsageCounters | null {
  const inputTokens = codexCounter(record, "input_tokens");
  const cachedInputTokens = codexCounter(record, "cached_input_tokens");
  // Older Codex rollouts predate this counter; Serde defaults it to zero.
  const cacheWriteInputTokens = codexCounter(record, "cache_write_input_tokens", true);
  const outputTokens = codexCounter(record, "output_tokens");
  const reasoningOutputTokens = codexCounter(record, "reasoning_output_tokens");
  const totalTokens = codexCounter(record, "total_tokens");
  if (
    inputTokens === null ||
    cachedInputTokens === null ||
    cacheWriteInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null ||
    totalTokens === null
  ) {
    return null;
  }
  return [
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  ];
}

function sameCounters(a: CodexUsageCounters, b: CodexUsageCounters): boolean {
  return a.every((value, index) => value === b[index]);
}

function advancesBy(
  previous: CodexUsageCounters,
  current: CodexUsageCounters,
  increment: CodexUsageCounters,
): boolean {
  return current.every((value, index) => value - (previous[index] ?? 0) === increment[index]);
}

function containsAtLeast(total: CodexUsageCounters, part: CodexUsageCounters): boolean {
  return total.every((value, index) => value >= (part[index] ?? 0));
}

function hasValidSubsets(counters: CodexUsageCounters): boolean {
  const [inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningTokens] =
    counters;
  return (
    cachedInputTokens + cacheWriteInputTokens <= inputTokens && reasoningTokens <= outputTokens
  );
}

function hasValidFirstCheckpoint(total: CodexUsageCounters, last: CodexUsageCounters): boolean {
  if (!containsAtLeast(total, last)) return false;
  const impliedPrior: CodexUsageCounters = [
    total[0] - last[0],
    total[1] - last[1],
    total[2] - last[2],
    total[3] - last[3],
    total[4] - last[4],
    total[5] - last[5],
  ];
  // The first visible checkpoint may include earlier requests (including a
  // total-only context-window residue), but its measured residue must still
  // obey the same subset relationships as every other usage vector.
  return hasValidSubsets(impliedPrior);
}

function hasValidLastTotal(counters: CodexUsageCounters): boolean {
  const [
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningTokens,
    total,
  ] = counters;
  const hasMeasuredUsage =
    inputTokens + cachedInputTokens + cacheWriteInputTokens + outputTokens + reasoningTokens > 0;
  return !hasMeasuredUsage || total === inputTokens + outputTokens;
}

function isContextWindowCheckpoint(
  previous: CodexUsageCounters,
  total: CodexUsageCounters,
  last: CodexUsageCounters,
): boolean {
  return (
    total.slice(0, 5).every((value) => value === 0) &&
    last.slice(0, 5).every((value) => value === 0) &&
    last[5] === Math.max(total[5] - previous[5], 0)
  );
}

/**
 * Feeds one line of a Codex rollout into `state`, returning a record when the
 * line was a usage event.
 *
 * Codex constructs `total_token_usage` by adding each real
 * `last_token_usage` element-wise. An unchanged cumulative checkpoint is a
 * re-emission, while an advancing checkpoint must advance by exactly the last
 * usage. Ambiguous events are skipped and counted in `malformedRecords`.
 */
export function parseCodexLine(line: string, state: CodexScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;
  const payloadType = payloadRecord["type"];

  if (record["type"] === "session_meta") {
    const id = payloadRecord["id"] ?? payloadRecord["session_id"];
    if (typeof id === "string") state.sessionId = id;
    return null;
  }

  if (record["type"] === "turn_context") {
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    return null;
  }

  if (payloadType !== "token_count") return null;

  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return null;
  const infoRecord = info as Record<string, unknown>;
  const total = infoRecord["total_token_usage"];
  const last = infoRecord["last_token_usage"];
  if (typeof total !== "object" || total === null || typeof last !== "object" || last === null) {
    state.malformedRecords += 1;
    return null;
  }
  const totalRecord = total as Record<string, unknown>;
  const lastRecord = last as Record<string, unknown>;

  // Only an otherwise eligible event may advance the checkpoint. A
  // token_count before its turn_context must not hide the re-emitted copy that
  // arrives after its model is known.
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  if (state.model.length === 0) return null;

  const cumulativeUsage = codexUsageCounters(totalRecord);
  const lastUsage = codexUsageCounters(lastRecord);
  if (cumulativeUsage === null || lastUsage === null) {
    state.malformedRecords += 1;
    return null;
  }
  if (
    !hasValidSubsets(cumulativeUsage) ||
    !hasValidSubsets(lastUsage) ||
    !hasValidLastTotal(lastUsage)
  ) {
    state.malformedRecords += 1;
    return null;
  }
  if (state.cumulativeUsage !== null && sameCounters(cumulativeUsage, state.cumulativeUsage)) {
    return null;
  }
  const previousCumulativeUsage = state.cumulativeUsage;
  state.cumulativeUsage = cumulativeUsage;
  if (
    (previousCumulativeUsage === null && !hasValidFirstCheckpoint(cumulativeUsage, lastUsage)) ||
    (previousCumulativeUsage !== null &&
      !advancesBy(previousCumulativeUsage, cumulativeUsage, lastUsage))
  ) {
    // `fill_to_context_window` deliberately replaces the component totals
    // with a total-only checkpoint. It carries no billable usage but is the
    // correct baseline for the next request.
    if (
      previousCumulativeUsage !== null &&
      isContextWindowCheckpoint(previousCumulativeUsage, cumulativeUsage, lastUsage)
    ) {
      return null;
    }
    state.malformedRecords += 1;
    return null;
  }
  const [inputTokens, cachedInputTokens, cacheCreationTokens, outputTokens, reasoningTokens] =
    lastUsage;

  const totals: UsageTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    // Reported inside output_tokens, surfaced separately for the token mix.
    reasoningTokens,
  };

  if (totalTokens(totals) === 0) return null;

  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    // Codex does not report cost in the rollout.
    reportedCostUsd: null,
    // Rollout files are unique per session, so events need no global dedup.
    dedupeKey: null,
  };
}

export { EMPTY_TOTALS };
