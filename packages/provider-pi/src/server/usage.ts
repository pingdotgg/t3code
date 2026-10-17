import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { PiSettings } from "../settings.ts";

const PiScanState = Schema.Struct({
  sessionId: Schema.mutableKey(Schema.String),
  /**
   * Whether the session's current model is faux. Always written; optional only
   * so states saved before faux was skipped still decode.
   */
  faux: Schema.mutableKey(Schema.optionalKey(Schema.Boolean)),
});
/** pi-ai's in-memory test provider. Its usage is scripted, never billed. */
const FAUX_PROVIDER = "faux";
/** Records Pi attributes to no model: tool calls and session summaries. */
const UNATTRIBUTED_MODEL = "Tools/summaries";
const Usage = Schema.Struct({
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  cacheRead: Schema.optional(Schema.Unknown),
  cacheWrite: Schema.optional(Schema.Unknown),
  reasoning: Schema.optional(Schema.Unknown),
  cost: Schema.optional(Schema.Struct({ total: Schema.Unknown })),
});
const Identity = { id: Schema.NonEmptyString, timestamp: Schema.String };
const Model = { provider: Schema.NonEmptyString, model: Schema.NonEmptyString };
const Entry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.NonEmptyString }),
  Schema.Struct({ type: Schema.Literal("model_change"), provider: Schema.NonEmptyString }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literal("message"),
    message: Schema.Union([
      Schema.Struct({
        ...Model,
        role: Schema.Literal("assistant"),
        responseModel: Schema.optional(Schema.NonEmptyString),
        usage: Usage,
      }),
      Schema.Struct({ role: Schema.Literal("toolResult"), usage: Usage }),
    ]),
  }),
  Schema.Struct({ ...Identity, ...Model, type: Schema.Literal("usage"), usage: Usage }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literals(["compaction", "branch_summary"]),
    usage: Usage,
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(parsed: unknown, state: typeof PiScanState.Type): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.type === "session") {
    state.sessionId = entry.id;
    state.faux = false;
    return [];
  }
  // A selected model runs the summaries that follow, even before it answers.
  if (entry.type === "model_change") {
    state.faux = entry.provider === FAUX_PROVIDER;
    return [];
  }
  const source = entry.type === "message" ? entry.message : entry;
  if ("role" in source && source.role === "assistant") {
    state.faux = source.provider === FAUX_PROVIDER;
  }
  if ("provider" in source && source.provider === FAUX_PROVIDER) return [];
  // Summaries carry no provider but run on the session's model, so a faux
  // session's are just as synthetic. Tool usage may come from any model.
  if ((entry.type === "compaction" || entry.type === "branch_summary") && state.faux === true) {
    return [];
  }
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const usage = source.usage;
  // Pi's auxiliary tool and summary records carry no model attribution. Match
  // Pi's own breakdown rather than assigning them to the conversation model.
  const rateModel =
    "model" in source
      ? "responseModel" in source
        ? (source.responseModel ?? source.model)
        : source.model
      : undefined;
  const model = "provider" in source ? `${source.provider}/${rateModel}` : UNATTRIBUTED_MODEL;
  const outputTokens = tokenCount(usage.output);
  const totals = {
    // Pi's input/cache counters are already disjoint.
    uncachedInputTokens: tokenCount(usage.input),
    cachedInputTokens: tokenCount(usage.cacheRead),
    cacheCreationTokens: tokenCount(usage.cacheWrite),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoning)),
  };
  const cost = usage.cost?.total;
  // Pi defaults omitted catalog rates to zero. Let shared pricing estimate
  // API-equivalent cost when the transcript has no positive cost estimate.
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  return [
    {
      provider: "pi",
      timestampMs,
      model,
      ...(rateModel === undefined ? {} : { rateModel }),
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      // Forks copy entries verbatim, including ID/timestamp. Entry IDs are only
      // eight random hex digits, so retain timestamp/model to avoid collisions
      // across unrelated sessions.
      dedupeKey: JSON.stringify(["pi", entry.id, entry.timestamp, model]),
    },
  ];
}

export const piUsageFormat: TranscriptUsageFormat<typeof PiScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    provider: true,
    model: true,
    usage: true,
    message: { role: true, provider: true, model: true, responseModel: true, usage: true },
  },
  usageMarkers: ['"usage"', '"session"', '"model_change"'],
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
  state: { initial: () => ({ sessionId: "", faux: false }), schema: PiScanState },
  // States without `faux` were saved before faux usage was skipped. Their faux
  // turns go, and so do unattributed rows, which a faux model may have written
  // without leaving a faux turn. A live file re-parses and recovers real ones.
  upgradeCachedRecords: ({ records, state }) =>
    typeof state === "object" && state !== null && "faux" in state
      ? undefined
      : records.filter(
          (record) =>
            !record.model.startsWith(`${FAUX_PROVIDER}/`) && record.model !== UNATTRIBUTED_MODEL,
        ),
};

export const piUsageReader: ProviderUsageReader<PiSettings, Path.Path> = {
  kind: "transcripts",
  provider: "pi",
  format: piUsageFormat,
  directories: Effect.fn("piUsageReader.directories")(function* ({ environment }) {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const sessionDir = environment.PI_CODING_AGENT_SESSION_DIR?.trim();
    if (sessionDir) return [{ dir: path.resolve(expandHomePath(sessionDir, home)) }];
    const agentDir = environment.PI_CODING_AGENT_DIR?.trim();
    return [
      {
        dir: path.resolve(
          agentDir ? expandHomePath(agentDir, home) : path.join(home, ".pi", "agent"),
          "sessions",
        ),
      },
    ];
  }),
};
