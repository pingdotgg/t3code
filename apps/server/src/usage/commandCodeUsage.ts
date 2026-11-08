import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";

const ScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
const Message = Schema.Struct({
  type: Schema.Literal("message"),
  id: Schema.NonEmptyString,
  timestamp: Schema.String,
  model: Schema.NonEmptyString,
  usage: Schema.Struct({
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
    cacheReadTokens: Schema.optional(Schema.Number),
    cacheWriteTokens: Schema.optional(Schema.Number),
    costUsd: Schema.optional(Schema.Number),
  }),
});
const Session = Schema.Struct({
  type: Schema.Literal("session"),
  id: Schema.NonEmptyString,
});
const decodeSession = Schema.decodeUnknownOption(Session);
const decodeMessage = Schema.decodeUnknownOption(Message);

function parseRecord(value: unknown, state: typeof ScanState.Type): readonly UsageRecord[] {
  const session = decodeSession(value);
  if (Option.isSome(session)) {
    state.sessionId = session.value.id;
    return [];
  }
  const decoded = decodeMessage(value);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const cacheRead = tokenCount(entry.usage.cacheReadTokens);
  const cacheWrite = tokenCount(entry.usage.cacheWriteTokens);
  const input = tokenCount(entry.usage.inputTokens);
  const outputTokens = tokenCount(entry.usage.outputTokens);
  // The CLI includes cached tokens in inputTokens. Malformed records must
  // not inflate the total by reporting more cached tokens than input tokens.
  if (cacheRead + cacheWrite > input) return [];
  const totals = {
    // Command Code's inputTokens includes cached tokens.
    uncachedInputTokens: Math.max(0, input - cacheRead - cacheWrite),
    cachedInputTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    outputTokens,
    reasoningTokens: 0,
  };
  const reportedCostUsd =
    entry.usage.costUsd !== undefined &&
    Number.isFinite(entry.usage.costUsd) &&
    entry.usage.costUsd >= 0
      ? entry.usage.costUsd
      : null;
  // Command Code may persist a placeholder with no usage; genuine free calls still have tokens.
  if (totalTokens(totals) === 0 && (reportedCostUsd === null || reportedCostUsd === 0)) return [];
  return [
    {
      provider: "command-code",
      timestampMs,
      model: entry.model,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      // /fork copies message IDs and timestamps into a new session, but independent
      // messages can reuse an ID. Normalize timestamps and retain model to distinguish them.
      dedupeKey: JSON.stringify(["command-code", entry.id, timestampMs, entry.model]),
    },
  ];
}

export const commandCodeUsageFormat: TranscriptUsageFormat<typeof ScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    model: true,
    usage: {
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      costUsd: true,
    },
  },
  usageMarkers: ['"usage"', '"session"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: () => ({ sessionId: "" }), schema: ScanState },
};
