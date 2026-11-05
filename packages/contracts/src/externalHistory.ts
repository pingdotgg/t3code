import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

const Identifier = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const Cursor = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(16_384));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

export const ExternalHistorySettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  chatGptExportPaths: Schema.Array(Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)))
    .check(Schema.isMaxLength(32))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ExternalHistorySettings = typeof ExternalHistorySettings.Type;

export const ExternalHistorySourceRef = Schema.Struct({
  sourceId: Identifier,
  threadId: Identifier,
  readCursor: Cursor,
  digest: Digest,
});
export type ExternalHistorySourceRef = typeof ExternalHistorySourceRef.Type;

export const ExternalHistoryRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("sources") }),
  Schema.Struct({
    operation: Schema.Literal("search"),
    sourceId: Identifier,
    query: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
    filterCwd: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
    includeArchived: Schema.optionalKey(Schema.Boolean),
    cursor: Schema.optionalKey(Cursor),
  }),
  Schema.Struct({
    operation: Schema.Literal("read"),
    ref: ExternalHistorySourceRef,
    textOffset: Schema.optionalKey(NonNegativeInt),
    maxChars: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 48_000 })),
    ),
  }),
]);
export type ExternalHistoryRequest = typeof ExternalHistoryRequest.Type;

export const ExternalHistorySource = Schema.Struct({
  id: Identifier,
  label: Schema.String,
  kind: Schema.Literals(["codex", "chatgpt_export"]),
});
export const ExternalHistoryMatch = Schema.Struct({
  ref: ExternalHistorySourceRef,
  threadTitle: Schema.String,
  itemId: Identifier,
  role: Schema.Literals(["user", "assistant", "tool"]),
  excerpt: Schema.String,
  textOffset: NonNegativeInt,
  totalChars: NonNegativeInt,
});
export type ExternalHistoryMatch = typeof ExternalHistoryMatch.Type;

export const ExternalHistoryResponse = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("sources"),
    enabled: Schema.Boolean,
    sources: Schema.Array(ExternalHistorySource),
  }),
  Schema.Struct({
    operation: Schema.Literal("search"),
    matches: Schema.Array(ExternalHistoryMatch),
    examinedItems: NonNegativeInt,
    nextCursor: Schema.NullOr(Cursor),
  }),
  Schema.Struct({
    operation: Schema.Literal("read"),
    ref: ExternalHistorySourceRef,
    threadTitle: Schema.String,
    role: Schema.Literals(["user", "assistant", "tool"]),
    text: Schema.String,
    textOffset: NonNegativeInt,
    totalChars: NonNegativeInt,
    nextTextOffset: Schema.NullOr(NonNegativeInt),
  }),
]);
export type ExternalHistoryResponse = typeof ExternalHistoryResponse.Type;

export class ExternalHistoryError extends Schema.TaggedError<ExternalHistoryError>()(
  "ExternalHistoryError",
  {
    reason: Schema.Literals([
      "disabled",
      "unavailable",
      "unsupported",
      "missing",
      "changed",
      "invalid_cursor",
      "limit_exceeded",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "disabled":
        return "External history is disabled for this environment.";
      case "unavailable":
        return "The external history source could not be read.";
      case "unsupported":
        return "This source does not support the required history format or API.";
      case "missing":
        return "The external history source or item is no longer available.";
      case "changed":
        return "The source changed. Search again before opening this evidence.";
      case "invalid_cursor":
        return "This cursor or text offset does not belong to the requested history.";
      case "limit_exceeded":
        return "This source exceeds the bounded history reader's capacity.";
    }
  }
}
