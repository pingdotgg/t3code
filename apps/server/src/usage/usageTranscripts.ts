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
  lastUsageSignature: string | null;
  hasCanonicalSessionMeta: boolean;
  fork: {
    readonly childSessionId: string;
    readonly childSessionStartedAtMs: number | null;
    readonly childHistoryStartOrdinal: number | null;
    readonly isUserFork: boolean;
    readonly taskStartedTurnIds: Set<string>;
    waitingForOwnTurn: boolean;
  } | null;
}

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    sessionId: "",
    lastUsageSignature: null,
    hasCanonicalSessionMeta: false,
    fork: null,
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function codexForkParentId(payload: Record<string, unknown>): string | null {
  const direct = nonEmptyString(payload["forked_from_id"] ?? payload["parent_thread_id"]);
  if (direct !== null) return direct;

  const source = payload["source"];
  if (typeof source !== "object" || source === null) return null;
  const subagent = (source as Record<string, unknown>)["subagent"];
  if (typeof subagent !== "object" || subagent === null) return null;
  const threadSpawn = (subagent as Record<string, unknown>)["thread_spawn"];
  if (typeof threadSpawn !== "object" || threadSpawn === null) return null;
  return nonEmptyString((threadSpawn as Record<string, unknown>)["parent_thread_id"]);
}

/** UUID-v7's first 48 bits are its Unix millisecond timestamp. */
function codexUuidV7Timestamp(id: string): string | null {
  const parts = id.split("-");
  if (
    parts.length !== 5 ||
    parts[0]?.length !== 8 ||
    parts[1]?.length !== 4 ||
    parts[2]?.length !== 4 ||
    parts[3]?.length !== 4 ||
    parts[4]?.length !== 12 ||
    !parts[2].startsWith("7") ||
    !parts.every((part) => /^[0-9a-f]+$/i.test(part))
  ) {
    return null;
  }
  return `${parts[0]}${parts[1]}`.toLowerCase();
}

function taskStartsAtOrAfterFork(
  state: NonNullable<CodexScanState["fork"]>,
  turnId: string,
  startedAt: unknown,
): boolean {
  const childTimestamp = codexUuidV7Timestamp(state.childSessionId);
  const turnTimestamp = codexUuidV7Timestamp(turnId);
  if (childTimestamp !== null && turnTimestamp !== null) {
    return turnTimestamp >= childTimestamp;
  }

  const childStartedAtMs =
    childTimestamp === null ? state.childSessionStartedAtMs : Number.parseInt(childTimestamp, 16);
  if (childStartedAtMs === null) return false;
  if (turnTimestamp !== null) return Number.parseInt(turnTimestamp, 16) >= childStartedAtMs;

  const startedAtSeconds = nonNegativeInteger(startedAt);
  // Whole-second equality cannot prove the task started after the child's
  // sub-second session timestamp, so keep treating it as inherited history.
  return startedAtSeconds !== null && startedAtSeconds > Math.floor(childStartedAtMs / 1000);
}

function turnStartsForkedSession(
  state: NonNullable<CodexScanState["fork"]>,
  turnId: string | null,
): boolean {
  if (turnId === null) return false;

  const childTimestamp = codexUuidV7Timestamp(state.childSessionId);
  if (childTimestamp === null) return state.taskStartedTurnIds.has(turnId);
  const turnTimestamp = codexUuidV7Timestamp(turnId);
  if (turnTimestamp === null) return state.taskStartedTurnIds.has(turnId);
  if (turnTimestamp > childTimestamp) return true;
  if (turnTimestamp < childTimestamp) return false;
  // The remaining UUID bits are random. Subagents identify a same-millisecond
  // child turn with task_started; human forks do not emit that event.
  return state.isUserFork || state.taskStartedTurnIds.has(turnId);
}

function rememberIgnoredUsageSignature(
  state: CodexScanState,
  payload: Record<string, unknown>,
): void {
  // Codex may echo the parent's final count after the child boundary. Remember
  // the final suppressed signature so that handoff echo remains suppressed.
  if (payload["type"] !== "token_count") return;
  const info = payload["info"];
  if (typeof info !== "object" || info === null) return;
  const last = (info as Record<string, unknown>)["last_token_usage"];
  if (typeof last !== "object" || last === null) return;
  state.lastUsageSignature = JSON.stringify(last);
}

/**
 * Feeds one line of a Codex rollout into `state`, returning a record when the
 * line was a usage event.
 *
 * Deltas come from `last_token_usage`. Summing those across a session
 * reconciles with the session's final `total_token_usage`, provided
 * consecutive duplicate events are dropped, which this does.
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
    const id = nonEmptyString(payloadRecord["id"] ?? payloadRecord["session_id"]);
    // The first session_meta belongs to this rollout. Forks may copy later
    // session_meta records from their parent history.
    if (!state.hasCanonicalSessionMeta && id !== null) {
      state.hasCanonicalSessionMeta = true;
      state.sessionId = id;
      const parentId = codexForkParentId(payloadRecord);
      if (parentId !== null && parentId !== id) {
        state.fork = {
          childSessionId: id,
          childSessionStartedAtMs: parseTimestampMs(record["timestamp"]),
          childHistoryStartOrdinal: nonNegativeInteger(
            payloadRecord["subagent_history_start_ordinal"],
          ),
          isUserFork: payloadRecord["thread_source"] === "user",
          taskStartedTurnIds: new Set(),
          waitingForOwnTurn: true,
        };
      }
    }
    return null;
  }

  const fork = state.fork;
  if (fork?.waitingForOwnTurn) {
    const ordinal = nonNegativeInteger(record["ordinal"]);
    if (fork.childHistoryStartOrdinal !== null) {
      if (ordinal === null || ordinal < fork.childHistoryStartOrdinal) {
        rememberIgnoredUsageSignature(state, payloadRecord);
        return null;
      }
      fork.waitingForOwnTurn = false;
      fork.taskStartedTurnIds.clear();
    } else {
      if (record["type"] === "event_msg" && payloadType === "task_started") {
        const turnId = nonEmptyString(payloadRecord["turn_id"]);
        if (turnId !== null && taskStartsAtOrAfterFork(fork, turnId, payloadRecord["started_at"])) {
          fork.taskStartedTurnIds.add(turnId);
        }
        return null;
      }

      if (record["type"] !== "turn_context") {
        rememberIgnoredUsageSignature(state, payloadRecord);
        return null;
      }
      if (!turnStartsForkedSession(fork, nonEmptyString(payloadRecord["turn_id"]))) return null;

      fork.waitingForOwnTurn = false;
      fork.taskStartedTurnIds.clear();
    }
  }

  if (record["type"] === "turn_context") {
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    return null;
  }

  if (payloadType !== "token_count") return null;

  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return null;
  const last = (info as Record<string, unknown>)["last_token_usage"];
  if (typeof last !== "object" || last === null) return null;
  const lastRecord = last as Record<string, unknown>;

  // Outside fork-history suppression, only an event that is otherwise eligible
  // may consume the duplicate signature. A token_count arriving before its
  // turn_context (no model yet) must not poison it, or the re-emitted copy after
  // the model is known would be skipped as a duplicate and never counted.
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  if (state.model.length === 0) return null;

  // Codex re-emits an unchanged token_count on some stream boundaries. Summing
  // those would double count, so identical consecutive payloads are skipped.
  const signature = JSON.stringify(lastRecord);
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  const inputTokens = int(lastRecord["input_tokens"]);
  const cachedInputTokens = int(lastRecord["cached_input_tokens"]);
  const cacheCreationTokens = int(lastRecord["cache_write_input_tokens"]);
  const outputTokens = int(lastRecord["output_tokens"]);

  const totals: UsageTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    // Reported inside output_tokens, surfaced separately for the token mix.
    reasoningTokens: Math.min(outputTokens, int(lastRecord["reasoning_output_tokens"])),
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
    // Fork replay is filtered before records are emitted; the surviving
    // per-session events need no global deduplication.
    dedupeKey: null,
  };
}

export { EMPTY_TOTALS };
