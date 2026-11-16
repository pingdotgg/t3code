import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  KnowledgeMessageRef,
  KnowledgeDigest,
  KnowledgeSourceUnavailableReason,
} from "./projectKnowledge.ts";

/** Derived from the thread and the exact source identities, so one range has one summary. */
export const ConversationSummaryId = Schema.String.check(
  Schema.isPattern(/^summary:[a-f0-9]{64}$/),
);
export type ConversationSummaryId = typeof ConversationSummaryId.Type;

export const CONVERSATION_SUMMARY_MAX_SOURCES = 24;
export const CONVERSATION_SUMMARY_MAX_EXPANSION_CHARS = 48_000;

/** UTF-16 offsets into the complete canonical source; end is exclusive. */
export const ConversationSummarySourceRange = Schema.Struct({
  start: NonNegativeInt,
  end: PositiveInt,
  total: PositiveInt,
});

const ConversationSummaryMessageRef = Schema.Struct({
  ...KnowledgeMessageRef.fields,
  range: Schema.optionalKey(ConversationSummarySourceRange),
});
const ConversationSummaryTurnItemRef = Schema.Struct({
  kind: Schema.Literal("turn_item"),
  threadId: ThreadId,
  itemId: TurnItemId,
  digest: KnowledgeDigest,
  range: Schema.optionalKey(ConversationSummarySourceRange),
});
/** A range of a finalized message or tool result: what a leaf summarizes. */
export type ConversationSummaryRangeRef =
  | typeof ConversationSummaryMessageRef.Type
  | typeof ConversationSummaryTurnItemRef.Type;

export const ConversationSummarySourceRef = Schema.Union([
  ConversationSummaryMessageRef,
  ConversationSummaryTurnItemRef,
  // The id is already a digest of the child's exact sources, so the ref needs no digest of its own.
  Schema.Struct({
    kind: Schema.Literal("summary"),
    threadId: ThreadId,
    summaryId: ConversationSummaryId,
  }),
]);
export type ConversationSummarySourceRef = typeof ConversationSummarySourceRef.Type;

/** Identity of the complete source, independent of which part a leaf summarizes. */
export const conversationSummarySourceIdentity = (source: ConversationSummarySourceRef): string =>
  source.kind === "message"
    ? `message:${source.messageId}`
    : source.kind === "turn_item"
      ? `turn_item:${source.itemId}`
      : source.summaryId;

/** Citation key; old whole-message citations retain their original message id. */
export const conversationSummarySourceKey = (source: ConversationSummarySourceRef): string => {
  if (source.kind === "summary") return source.summaryId;
  const id = source.kind === "message" ? source.messageId : `turn_item:${source.itemId}`;
  return source.range === undefined
    ? id
    : `range:${JSON.stringify([source.kind, id, source.range.start, source.range.end, source.range.total])}`;
};

export const ConversationSummarySourceResult = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("available"),
    source: ConversationSummarySourceRef,
    text: Schema.String,
    title: Schema.String,
    /** "summary" when the source is a child summary; its text is that summary's statements. */
    role: Schema.Literals(["user", "assistant", "tool", "summary"]),
    createdAt: IsoDateTime,
    archived: Schema.Boolean,
    /** Offset and total length within this source's recorded range. */
    textOffset: Schema.optionalKey(NonNegativeInt),
    totalChars: Schema.optionalKey(NonNegativeInt),
  }),
  Schema.Struct({ state: Schema.Literal("unavailable"), reason: KnowledgeSourceUnavailableReason }),
]);
export type ConversationSummarySourceResult = typeof ConversationSummarySourceResult.Type;

export const ConversationSummaryStatement = Schema.Struct({
  text: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(600)),
  /** conversationSummarySourceKey values from the summary's own sources. */
  citations: Schema.Array(Schema.String.check(Schema.isNonEmpty())).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
});
export type ConversationSummaryStatement = typeof ConversationSummaryStatement.Type;

/**
 * An immutable summary. A leaf summarizes consecutive finalized source ranges. A condensed summary
 * summarizes consecutive summaries of the same thread, oldest first. Its text is only served while
 * every range beneath it still matches its digest.
 */
export const ConversationSummary = Schema.Struct({
  id: ConversationSummaryId,
  projectId: ProjectId,
  threadId: ThreadId,
  sources: Schema.Array(ConversationSummarySourceRef).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CONVERSATION_SUMMARY_MAX_SOURCES),
    Schema.makeFilter(
      (sources) =>
        sources.every((source) => source.kind === "summary") ||
        sources.every((source) => source.kind !== "summary"),
      { expected: "sources that are all summaries or all ranges" },
    ),
  ),
  statements: Schema.Array(ConversationSummaryStatement).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
  modelSelection: ModelSelection,
  createdAt: IsoDateTime,
  /** Once derived text is scrubbed, a source reverting does not restore that text. */
  scrubbed: Schema.optionalKey(Schema.Boolean),
});
export type ConversationSummary = typeof ConversationSummary.Type;

export const ConversationSummaryRead = Schema.Union([
  Schema.Struct({ state: Schema.Literal("available"), summary: ConversationSummary }),
  // A source changed or went away: the generated text is withheld.
  Schema.Struct({
    state: Schema.Literal("stale"),
    id: ConversationSummaryId,
    sourceCount: NonNegativeInt,
    createdAt: IsoDateTime,
    reason: KnowledgeSourceUnavailableReason,
  }),
]);
export type ConversationSummaryRead = typeof ConversationSummaryRead.Type;

/** What the latest background pass for a thread did. */
export const ConversationSummaryPass = Schema.Struct({
  runId: RunId,
  result: Schema.Literals(["ran", "skipped", "failed"]),
  reason: Schema.NullOr(Schema.String),
  generated: NonNegativeInt,
  /** Settled messages still waiting for a summary after this pass. */
  waitingMessages: NonNegativeInt,
  at: IsoDateTime,
});
export type ConversationSummaryPass = typeof ConversationSummaryPass.Type;

const Scope = { projectId: ProjectId, threadId: ThreadId };

export const ConversationSummaryListInput = Schema.Struct({
  ...Scope,
  cursor: Schema.optionalKey(ConversationSummaryId),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  /** Case-insensitive literal substring search over generated statements. */
  query: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(256))),
});
export type ConversationSummaryListInput = typeof ConversationSummaryListInput.Type;

export const ConversationSummaryList = Schema.Struct({
  enabled: Schema.Boolean,
  lastPass: Schema.NullOr(ConversationSummaryPass),
  summaries: Schema.Array(ConversationSummaryRead),
  nextCursor: Schema.NullOr(ConversationSummaryId),
});
export type ConversationSummaryList = typeof ConversationSummaryList.Type;

export const ConversationSummaryDescribeInput = Schema.Struct({
  ...Scope,
  summaryId: ConversationSummaryId,
});
export type ConversationSummaryDescribeInput = typeof ConversationSummaryDescribeInput.Type;

export const ConversationSummaryExpandInput = Schema.Struct({
  ...ConversationSummaryDescribeInput.fields,
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CONVERSATION_SUMMARY_MAX_SOURCES })),
  ),
  textOffset: Schema.optionalKey(NonNegativeInt),
  /** Maximum returned source text across the page, measured in UTF-16 code units. */
  maxChars: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 2, maximum: CONVERSATION_SUMMARY_MAX_EXPANSION_CHARS }),
    ),
  ),
});
export type ConversationSummaryExpandInput = typeof ConversationSummaryExpandInput.Type;

export const ConversationSummaryExpansion = Schema.Struct({
  summary: ConversationSummaryRead,
  /** Canonical source ranges as they are now, or why unavailable; never stored text. */
  sources: Schema.Array(
    Schema.Struct({ ref: ConversationSummarySourceRef, result: ConversationSummarySourceResult }),
  ),
  nextOffset: Schema.NullOr(NonNegativeInt),
  /** Continue at nextOffset and nextTextOffset together, including within one source. */
  nextTextOffset: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
});
export type ConversationSummaryExpansion = typeof ConversationSummaryExpansion.Type;

export class ConversationSummaryError extends Schema.TaggedError<ConversationSummaryError>()(
  "ConversationSummaryError",
  {
    reason: Schema.Literals(["storage", "missing_project", "missing_summary", "invalid_cursor"]),
    projectId: ProjectId,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "missing_project":
        return `Project ${this.projectId} was not found.`;
      case "missing_summary":
        return "No conversation summary with that id exists for this project and thread.";
      case "invalid_cursor":
        return "The cursor or offset does not belong to this listing.";
      case "storage":
        return "Conversation summaries could not be read.";
    }
  }
}
