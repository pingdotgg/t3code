import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { MuseSettings } from "../settings.ts";
import { makeMuseEnvironment } from "./sdk.ts";
import * as MuseUsageHome from "./MuseUsageHome.ts";

const Entry = Schema.Struct({
  schema_version: Schema.Literal(1),
  record_type: Schema.Literal("event"),
  payload_type: Schema.Literal("runtime.session"),
  // Native automated review completions use session payload version 3.
  payload_schema_version: Schema.Literals([1, 3]),
  id: Schema.NonEmptyString,
  recorded_at: Schema.Number,
  stream: Schema.Struct({ kind: Schema.Literal("session"), id: Schema.NonEmptyString }),
  payload: Schema.Struct({
    source_run_record_id: Schema.optional(Schema.NonEmptyString),
    event: Schema.Struct({
      kind: Schema.Literals(["model_completed", "automated_review_completed"]),
      model: Schema.Union([
        Schema.NonEmptyString,
        Schema.Struct({ model_id: Schema.NonEmptyString }),
      ]),
      usage: Schema.Struct({
        input_tokens: Schema.optional(Schema.Unknown),
        output_tokens: Schema.optional(Schema.Unknown),
        cached_tokens: Schema.optional(Schema.Unknown),
        cached_input_tokens: Schema.optional(Schema.Unknown),
        cache_read_tokens: Schema.optional(Schema.Unknown),
        cache_write_tokens: Schema.optional(Schema.Unknown),
        reasoning_tokens: Schema.optional(Schema.Unknown),
      }),
    }),
  }),
});
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(parsed: unknown): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (!Number.isSafeInteger(entry.recorded_at) || entry.recorded_at < 0) return [];
  const { event } = entry.payload;
  const { usage } = event;
  const input = tokenCount(usage.input_tokens);
  const cachedInputTokens = Math.min(
    input,
    tokenCount(usage.cache_read_tokens ?? usage.cached_input_tokens ?? usage.cached_tokens),
  );
  const cacheCreationTokens = Math.min(
    input - cachedInputTokens,
    tokenCount(usage.cache_write_tokens),
  );
  const outputTokens = tokenCount(usage.output_tokens);
  const totals = {
    // Muse's cache counters are subsets of input; reasoning is a subset of output.
    uncachedInputTokens: input - cachedInputTokens - cacheCreationTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoning_tokens)),
  };
  if (totalTokens(totals) === 0) return [];
  return [
    {
      provider: "muse",
      timestampMs: Math.trunc(entry.recorded_at / 1_000),
      model: typeof event.model === "string" ? event.model : event.model.model_id,
      sessionId: entry.stream.id,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      // Runtime envelopes can be copied into another session. The source record
      // identifies the inference even when the enclosing envelope has a new ID.
      dedupeKey: JSON.stringify(["muse", entry.payload.source_run_record_id ?? entry.id]),
    },
  ];
}

export const museUsageFormat: TranscriptUsageFormat<unknown> = {
  selectFields: {
    schema_version: true,
    record_type: true,
    payload_type: true,
    payload_schema_version: true,
    id: true,
    recorded_at: true,
    stream: { kind: true, id: true },
    payload: { source_run_record_id: true, event: { kind: true, model: true, usage: true } },
  },
  usageMarkers: ['"model_completed"', '"automated_review_completed"'],
  parseLine: (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed);
  },
  parseProjected: parseRecord,
};

export const museUsageReader: ProviderUsageReader<
  MuseSettings,
  Path.Path | MuseUsageHome.MuseUsageHome
> = {
  kind: "transcripts",
  provider: "muse",
  format: museUsageFormat,
  directories: Effect.fn("museUsageReader.directories")(function* ({ config, environment }) {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const usageHome = yield* MuseUsageHome.MuseUsageHome;
    const processEnvironment = yield* mergeProviderInstanceEnvironment(
      Object.entries(environment).flatMap(([name, value]) =>
        value === undefined ? [] : [{ name, value, sensitive: false }],
      ),
      yield* HostProcess.Environment,
    );
    const museHome = yield* usageHome.resolve({
      binaryPath: expandHomePath(config?.binaryPath ?? "muse", home),
      environment: makeMuseEnvironment(processEnvironment),
    });
    return museHome ? [{ dir: path.join(museHome, "sessions"), fileName: "session.jsonl" }] : [];
  }),
};
