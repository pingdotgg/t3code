import {
  ProviderReplayEntry,
  ProviderReplayNdjsonRecord,
  ProviderReplayTranscript,
  type ProviderReplayTranscriptHeader,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ProviderReplayNdjsonLineParseError extends Schema.TaggedErrorClass<ProviderReplayNdjsonLineParseError>()(
  "ProviderReplayNdjsonLineParseError",
  {
    lineNumber: Schema.Number,
    line: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to parse provider replay NDJSON line ${this.lineNumber}.`;
  }
}

export class ProviderReplayNdjsonMissingHeaderError extends Schema.TaggedErrorClass<ProviderReplayNdjsonMissingHeaderError>()(
  "ProviderReplayNdjsonMissingHeaderError",
  {},
) {
  override get message(): string {
    return "Provider replay NDJSON requires a transcript_start header or fallback transcript metadata.";
  }
}

export class ProviderReplayNdjsonEmptyError extends Schema.TaggedErrorClass<ProviderReplayNdjsonEmptyError>()(
  "ProviderReplayNdjsonEmptyError",
  {},
) {
  override get message(): string {
    return "Provider replay NDJSON did not contain any records.";
  }
}

export const ProviderReplayNdjsonParseError = Schema.Union([
  ProviderReplayNdjsonLineParseError,
  ProviderReplayNdjsonMissingHeaderError,
  ProviderReplayNdjsonEmptyError,
]);
export type ProviderReplayNdjsonParseError = typeof ProviderReplayNdjsonParseError.Type;

export type ProviderReplayTranscriptMetadata = Omit<ProviderReplayTranscript, "entries">;

export const REPLAY_TRANSCRIPT_WORKSPACE_PLACEHOLDER = "<workspace>";

function materializeWorkspacePlaceholder(value: unknown, workspace: string): unknown {
  if (value === REPLAY_TRANSCRIPT_WORKSPACE_PLACEHOLDER) {
    return workspace;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => materializeWorkspacePlaceholder(entry, workspace));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      materializeWorkspacePlaceholder(entry, workspace),
    ]),
  );
}

/**
 * Resolves portable fixture placeholders before a replay driver sees the transcript.
 * The resulting outbound frames still use exact structural equality during replay.
 */
export function materializeReplayTranscriptWorkspace(
  transcript: ProviderReplayTranscript,
  workspace: string,
): ProviderReplayTranscript {
  return {
    ...transcript,
    entries: transcript.entries.map((entry) =>
      entry.type === "expect_outbound"
        ? {
            ...entry,
            frame: materializeWorkspacePlaceholder(entry.frame, workspace),
          }
        : entry,
    ),
  };
}

const decodeReplayRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderReplayNdjsonRecord),
);
const decodeTranscript = Schema.decodeUnknownSync(ProviderReplayTranscript);

function parseReplayRecord(
  line: string,
  lineNumber: number,
): Effect.Effect<ProviderReplayNdjsonRecord, ProviderReplayNdjsonLineParseError> {
  return Effect.try({
    try: () => decodeReplayRecord(line),
    catch: (cause) =>
      new ProviderReplayNdjsonLineParseError({
        lineNumber,
        line,
        cause,
      }),
  });
}

function metadataFromHeader(
  header: ProviderReplayTranscriptHeader,
): ProviderReplayTranscriptMetadata {
  const { type: _type, ...metadata } = header;
  return metadata;
}

export function decodeProviderReplayNdjson(
  input: string,
  fallbackMetadata?: ProviderReplayTranscriptMetadata,
): Effect.Effect<ProviderReplayTranscript, ProviderReplayNdjsonParseError> {
  return Effect.gen(function* () {
    const lines = input
      .split(/\r?\n/u)
      .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
      .filter(({ line }) => line.length > 0);

    if (lines.length === 0) {
      return yield* new ProviderReplayNdjsonEmptyError();
    }

    const firstRecord = yield* parseReplayRecord(lines[0]!.line, lines[0]!.lineNumber);
    const metadata =
      firstRecord.type === "transcript_start" ? metadataFromHeader(firstRecord) : fallbackMetadata;

    if (!metadata) {
      return yield* new ProviderReplayNdjsonMissingHeaderError();
    }

    const entries: Array<ProviderReplayEntry> = [];
    if (firstRecord.type !== "transcript_start") {
      entries.push(firstRecord);
    }

    for (const { line, lineNumber } of lines.slice(1)) {
      const record = yield* parseReplayRecord(line, lineNumber);
      if (record.type === "transcript_start") {
        return yield* new ProviderReplayNdjsonLineParseError({
          lineNumber,
          line,
          cause: "transcript_start is only valid as the first replay record",
        });
      }
      entries.push(record);
    }

    return decodeTranscript({
      ...metadata,
      entries,
    });
  });
}
