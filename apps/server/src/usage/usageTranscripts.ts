/**
 * Pure parsers for the provider CLIs' on-disk session transcripts.
 *
 * Both parsers are line-at-a-time reducers so callers can stream large files
 * without materialising them. Neither touches the filesystem.
 *
 * @module usageTranscripts
 */
import type { UsageProviderKind } from "@t3tools/contracts";
import { UsageTokenTotals } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
const PROVIDER_MIGHT_CARRY_USAGE: Record<UsageProviderKind, (line: string) => boolean> = {
  claude: (line) => line.includes('"usage"'),
  devin: (line) => line.includes('"devin_usage"'),
  codex: (line) =>
    line.includes('"token_count"') ||
    line.includes('"turn_context"') ||
    line.includes('"session_meta"'),
};

export function mightCarryUsage(line: string, provider: UsageProviderKind): boolean {
  return PROVIDER_MIGHT_CARRY_USAGE[provider](line);
}

/* -------------------------------------------------------------------------- */
/* Claude Code                                                                */
/* -------------------------------------------------------------------------- */

const ClaudeUsageMessageSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  model: Schema.String,
  usage: Schema.Struct({
    input_tokens: Schema.optional(Schema.Number),
    cache_read_input_tokens: Schema.optional(Schema.Number),
    cache_creation_input_tokens: Schema.optional(Schema.Number),
    output_tokens: Schema.optional(Schema.Number),
  }),
});

const ClaudeUsageLineSchema = Schema.Struct({
  type: Schema.Literal("assistant"),
  timestamp: Schema.String,
  requestId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  message: ClaudeUsageMessageSchema,
  costUSD: Schema.optional(Schema.NullOr(Schema.Number)),
});

const decodeClaudeUsageLine = Schema.decodeUnknownOption(ClaudeUsageLineSchema);

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

  const result = decodeClaudeUsageLine(parsed);
  if (Option.isNone(result)) return null;
  const record = result.value;

  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null) return null;

  const messageId = record.message.id ?? null;
  const requestId = record.requestId ?? null;
  // Matches ccusage: prefer the message/request pair, fall back to whichever
  // half exists. Records with neither cannot be de-duplicated.
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  return {
    provider: "claude",
    timestampMs,
    model: record.message.model,
    sessionId: record.sessionId ?? "",
    totals: {
      uncachedInputTokens: int(record.message.usage.input_tokens),
      cachedInputTokens: int(record.message.usage.cache_read_input_tokens),
      cacheCreationTokens: int(record.message.usage.cache_creation_input_tokens),
      outputTokens: int(record.message.usage.output_tokens),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd:
      record.costUSD !== undefined && record.costUSD !== null && Number.isFinite(record.costUSD)
        ? record.costUSD
        : null,
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
  sawSessionMeta: boolean;
  /** While true, leading usage events are re-stamped copies of parent history. */
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    sessionId: "",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/**
 * A forked or subagent rollout opens with the parent's full history copied in,
 * every line re-stamped to the fork instant. Those copies are written in one
 * synchronous burst (observed gaps 0-40ms), while the child's first genuine
 * usage event only lands after a real model turn (observed 5s+). One second of
 * separation splits the two cleanly; `ccusage` uses the same threshold.
 */
const FORK_COPY_MAX_GAP_MS = 1000;

const CodexRecordSchema = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.String,
  payload: Schema.Unknown,
});

const decodeCodexRecord = Schema.decodeUnknownOption(CodexRecordSchema);

const CodexSessionMetaPayloadSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  forked_from_id: Schema.optional(Schema.String),
  source: Schema.optional(
    Schema.Struct({
      subagent: Schema.optional(
        Schema.Struct({
          thread_spawn: Schema.optional(
            Schema.Struct({
              parent_thread_id: Schema.optional(Schema.String),
            }),
          ),
        }),
      ),
    }),
  ),
});

type CodexSessionMetaPayload = typeof CodexSessionMetaPayloadSchema.Type;

const decodeCodexSessionMetaPayload = Schema.decodeUnknownOption(CodexSessionMetaPayloadSchema);

const CodexTurnContextPayloadSchema = Schema.Struct({
  model: Schema.optional(Schema.String),
});

const decodeCodexTurnContextPayload = Schema.decodeUnknownOption(CodexTurnContextPayloadSchema);

const CodexLastTokenUsageSchema = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  cached_input_tokens: Schema.optional(Schema.Number),
  cache_write_input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  reasoning_output_tokens: Schema.optional(Schema.Number),
});

const CodexTokenCountPayloadSchema = Schema.Struct({
  type: Schema.Literal("token_count"),
  info: Schema.Struct({
    last_token_usage: CodexLastTokenUsageSchema,
  }),
});

const decodeCodexTokenCountPayload = Schema.decodeUnknownOption(CodexTokenCountPayloadSchema);

/** Whether a `session_meta` payload marks the rollout as a fork or subagent. */
function isForkedSessionMeta(payload: CodexSessionMetaPayload): boolean {
  if (payload.forked_from_id !== undefined && payload.forked_from_id.length > 0) {
    return true;
  }
  return payload.source?.subagent?.thread_spawn?.parent_thread_id !== undefined;
}

/**
 * Feeds one line of a Codex rollout into `state`, returning a record when the
 * line was a usage event.
 *
 * Deltas come from `last_token_usage`. Summing those across a session
 * reconciles with the session's final `total_token_usage`, provided
 * consecutive duplicate events are dropped, which this does.
 */
export function parseCodexLine(line: string, state?: CodexScanState): UsageRecord | null {
  if (!state) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const recordResult = decodeCodexRecord(parsed);
  if (Option.isNone(recordResult)) return null;
  const record = recordResult.value;

  if (record.type === "session_meta") {
    const payloadResult = decodeCodexSessionMetaPayload(record.payload);
    if (Option.isNone(payloadResult)) return null;
    const payload = payloadResult.value;

    // Only the first meta describes this file's own session. A forked rollout
    // repeats the ancestors' metas right after it; letting those through would
    // reassign every subsequent record to an ancestor session.
    if (state.sawSessionMeta) return null;
    state.sawSessionMeta = true;
    const id = payload.id ?? payload.session_id;
    if (id !== undefined) state.sessionId = id;
    const metaTimestampMs = parseTimestampMs(record.timestamp);
    if (metaTimestampMs !== null && isForkedSessionMeta(payload)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return null;
  }

  if (record.type === "turn_context") {
    const payloadResult = decodeCodexTurnContextPayload(record.payload);
    if (Option.isNone(payloadResult)) return null;
    const payload = payloadResult.value;
    if (payload.model !== undefined) state.model = payload.model;
    return null;
  }

  const tokenPayloadResult = decodeCodexTokenCountPayload(record.payload);
  if (Option.isNone(tokenPayloadResult)) return null;
  const tokenPayload = tokenPayloadResult.value;

  // token_count
  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null) return null;
  if (state.model.length === 0) return null;

  const last = tokenPayload.info.last_token_usage;

  // Codex re-emits an unchanged token_count on some stream boundaries. Summing
  // those would double count, so identical consecutive payloads are skipped.
  const signature = JSON.stringify(last);
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  // In a forked rollout the copied parent history was already counted from the
  // parent's own file. Drop the leading burst; the first usage event separated
  // from its predecessor by a real turn's worth of time ends it for good.
  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      return null;
    }
    state.suppressingForkCopies = false;
  }

  const inputTokens = int(last.input_tokens);
  const cachedInputTokens = int(last.cached_input_tokens);
  const cacheCreationTokens = int(last.cache_write_input_tokens);
  const outputTokens = int(last.output_tokens);

  const totals: UsageTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    // Reported inside output_tokens, surfaced separately for the token mix.
    reasoningTokens: Math.min(outputTokens, int(last.reasoning_output_tokens)),
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
    // Events surviving the fork-copy suppression above are unique to this
    // rollout, so they need no global dedup.
    dedupeKey: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Devin                                                                      */
/* -------------------------------------------------------------------------- */

const DevinUsageLineSchema = Schema.Struct({
  type: Schema.Literal("devin_usage"),
  timestamp: Schema.String,
  sessionId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  model: Schema.String,
  totals: UsageTokenTotals,
  reportedCostUsd: Schema.optional(Schema.NullOr(Schema.Number)),
});

const decodeDevinUsageLine = Schema.decodeUnknownOption(DevinUsageLineSchema);

/**
 * Devin advertises family slugs with dots (e.g. `swe-1.7`), but the ACP
 * `model_uid` values and the T3 Code usage transcript write dashes
 * (`swe-1-7`). The Usage page shows the dotted, human-readable version, so
 * rehydrate version dots from the dashed slug at parse time.
 */
function displayDevinModelSlug(slug: string): string {
  return slug.replace(/(\d+)-(\d+)/g, "$1.$2");
}

/**
 * Parses one line from a Devin usage transcript written by T3 Code.
 *
 * Each line is an independent, delta-normalized record keyed by
 * `sessionId:turnId` so the aggregator can de-duplicate retries.
 */
export function parseDevinLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const result = decodeDevinUsageLine(parsed);
  if (Option.isNone(result)) return null;
  const record = result.value;

  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null) return null;

  const sessionId = record.sessionId?.trim() ?? "";
  const turnId = record.turnId?.trim() ?? "";

  return {
    provider: "devin",
    timestampMs,
    model: displayDevinModelSlug(record.model),
    sessionId,
    totals: record.totals,
    reportedCostUsd:
      record.reportedCostUsd !== undefined &&
      record.reportedCostUsd !== null &&
      Number.isFinite(record.reportedCostUsd)
        ? record.reportedCostUsd
        : null,
    dedupeKey: sessionId.length > 0 && turnId.length > 0 ? `${sessionId}:${turnId}` : null,
  };
}

export { EMPTY_TOTALS };
