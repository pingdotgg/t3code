import type { OrchestrationContextWindow } from "@t3tools/contracts";

type UnknownRecord = Record<string, unknown>;
const CODEX_CONTEXT_BASELINE_TOKENS = 12_000;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : null;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function compactRecords(
  values: ReadonlyArray<UnknownRecord | null | undefined>,
): ReadonlyArray<UnknownRecord> {
  return values.filter((value): value is UnknownRecord => value !== null && value !== undefined);
}

function pickValue(record: UnknownRecord | null, keys: ReadonlyArray<string>): unknown {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }
  return undefined;
}

function pickNumber(record: UnknownRecord | null, keys: ReadonlyArray<string>): number | undefined {
  return asNonNegativeInteger(pickValue(record, keys));
}

function pickFirstRecord(
  records: ReadonlyArray<UnknownRecord>,
  keys: ReadonlyArray<string>,
): UnknownRecord | null {
  for (const record of records) {
    const value = asRecord(pickValue(record, keys));
    if (value) {
      return value;
    }
  }
  return null;
}

function recordHasTotalTokenFields(record: UnknownRecord): boolean {
  return pickNumber(record, ["total_tokens", "totalTokens"]) !== undefined;
}

function resolveNestedUsageRecord(
  records: ReadonlyArray<UnknownRecord>,
  keys: ReadonlyArray<string>,
): UnknownRecord | null {
  const nestedRecord = pickFirstRecord(records, keys);
  if (nestedRecord) {
    return nestedRecord;
  }

  return records.find(recordHasTotalTokenFields) ?? null;
}

function resolveContextUsageRecord(records: ReadonlyArray<UnknownRecord>): UnknownRecord | null {
  return resolveNestedUsageRecord(records, ["last_token_usage", "lastTokenUsage", "last"]);
}

function resolveTotalUsageRecord(records: ReadonlyArray<UnknownRecord>): UnknownRecord | null {
  return resolveNestedUsageRecord(records, [
    "total_token_usage",
    "totalTokenUsage",
    "usage",
    "total_usage",
    "total",
  ]);
}

function pickFirstNumber(
  records: ReadonlyArray<UnknownRecord>,
  keys: ReadonlyArray<string>,
): number | undefined {
  for (const record of records) {
    const value = pickNumber(record, keys);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function computeCodexUsedPercent(usedTokens: number, contextWindow: number): number {
  if (contextWindow <= CODEX_CONTEXT_BASELINE_TOKENS) {
    return 100;
  }

  const effectiveWindow = contextWindow - CODEX_CONTEXT_BASELINE_TOKENS;
  const adjustedUsed = Math.max(0, usedTokens - CODEX_CONTEXT_BASELINE_TOKENS);
  const remaining = Math.max(0, effectiveWindow - adjustedUsed);
  const remainingPercent = clampPercent((remaining / effectiveWindow) * 100);

  return 100 - remainingPercent;
}

function computeCodexRemainingTokens(usedTokens: number, contextWindow: number): number {
  if (contextWindow <= CODEX_CONTEXT_BASELINE_TOKENS) {
    return 0;
  }

  const effectiveWindow = contextWindow - CODEX_CONTEXT_BASELINE_TOKENS;
  const adjustedUsed = Math.max(0, usedTokens - CODEX_CONTEXT_BASELINE_TOKENS);

  return Math.max(0, effectiveWindow - adjustedUsed);
}

function normalizeFromCandidates(
  candidates: ReadonlyArray<unknown>,
  updatedAt: string,
): OrchestrationContextWindow | null {
  for (const candidate of candidates) {
    const contextWindow = normalizeCodexContextWindow(candidate, updatedAt);
    if (contextWindow) {
      return contextWindow;
    }
  }
  return null;
}

export function normalizeCodexContextWindow(
  usage: unknown,
  updatedAt: string,
): OrchestrationContextWindow | null {
  const payload = asRecord(usage);
  const info = asRecord(pickValue(payload, ["info"]));
  const tokenUsage = asRecord(pickValue(payload, ["tokenUsage", "token_usage"]));
  const infoTokenUsage = asRecord(pickValue(info, ["tokenUsage", "token_usage"]));
  const records = compactRecords([payload, info, tokenUsage, infoTokenUsage]);
  const contextUsage = resolveContextUsageRecord(records);
  const totalUsage = resolveTotalUsageRecord(records);
  const usageRecord = contextUsage ?? totalUsage;
  const usedTokens = pickNumber(usageRecord, ["total_tokens", "totalTokens"]);
  const maxTokens = pickFirstNumber(records, [
    "model_context_window",
    "modelContextWindow",
    "context_window",
  ]);

  if (usedTokens === undefined || maxTokens === undefined || maxTokens <= 0) {
    return null;
  }

  const inputTokens = pickNumber(usageRecord, ["input_tokens", "inputTokens"]);
  const cachedInputTokens = pickNumber(usageRecord, ["cached_input_tokens", "cachedInputTokens"]);
  const outputTokens = pickNumber(usageRecord, ["output_tokens", "outputTokens"]);
  const reasoningOutputTokens = pickNumber(usageRecord, [
    "reasoning_output_tokens",
    "reasoningOutputTokens",
  ]);
  const remainingTokens = computeCodexRemainingTokens(usedTokens, maxTokens);
  const usedPercent = computeCodexUsedPercent(usedTokens, maxTokens);

  return {
    provider: "codex",
    usedTokens,
    maxTokens,
    remainingTokens,
    usedPercent,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    updatedAt,
  };
}

export function normalizeCodexContextWindowFromRuntimeDetail(
  detail: unknown,
  updatedAt: string,
): OrchestrationContextWindow | null {
  const detailRecord = asRecord(detail);
  const detailInfo = asRecord(pickValue(detailRecord, ["info"]));
  const detailThread = asRecord(pickValue(detailRecord, ["thread"]));

  return normalizeFromCandidates(
    [
      detail,
      pickValue(detailRecord, ["usage"]),
      pickValue(detailRecord, ["tokenUsage", "token_usage"]),
      detailInfo,
      detailThread,
      pickValue(detailInfo, ["tokenUsage", "token_usage"]),
      pickValue(detailThread, ["usage"]),
      pickValue(detailThread, ["tokenUsage", "token_usage"]),
      pickValue(detailThread, ["info"]),
    ],
    updatedAt,
  );
}
