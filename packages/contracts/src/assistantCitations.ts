import * as Schema from "effect/Schema";
import { EnvironmentId, MessageId, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";

export const ASSISTANT_CITATION_MAX_TEXT_LENGTH = 8_000;
export const ASSISTANT_CITATION_MAX_COMMENT_LENGTH = 8_000;
export const ASSISTANT_CITATION_CONTEXT_LENGTH = 32;
// Provider message IDs nest and re-encode their thread and turn IDs, so they outgrow a few hundred characters.
export const ASSISTANT_CITATION_MAX_ID_LENGTH = 4_096;

/** Positions are UTF-16 offsets, not Markdown offsets. */
export const AssistantCitation = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: EnvironmentId.check(Schema.isMaxLength(ASSISTANT_CITATION_MAX_ID_LENGTH)),
  threadId: ThreadId.check(Schema.isMaxLength(ASSISTANT_CITATION_MAX_ID_LENGTH)),
  messageId: MessageId.check(Schema.isMaxLength(ASSISTANT_CITATION_MAX_ID_LENGTH)),
  text: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(ASSISTANT_CITATION_MAX_TEXT_LENGTH),
  ),
  comment: Schema.optional(
    Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_MAX_COMMENT_LENGTH)),
  ),
  start: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  end: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  prefix: Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_CONTEXT_LENGTH)),
  suffix: Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_CONTEXT_LENGTH)),
}).check(
  Schema.makeFilter((citation) => citation.end > citation.start && citation.text.trim().length > 0),
);
export type AssistantCitation = typeof AssistantCitation.Type;

export const DOCUMENT_CITATION_MAX_PATH_LENGTH = 4_096;

/**
 * A quote of a rendered workspace file with an optional user comment. Lines are
 * 1-based source lines as of when the quote was taken. Like an assistant quote,
 * start and end are UTF-16 offsets in the rendered text, and with the prefix and
 * suffix they find the quote again after the file changes.
 */
export const DocumentCitation = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("document"),
  environmentId: EnvironmentId.check(Schema.isMaxLength(512)),
  threadId: ThreadId.check(Schema.isMaxLength(512)),
  filePath: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(DOCUMENT_CITATION_MAX_PATH_LENGTH),
  ),
  startLine: PositiveInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  endLine: PositiveInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  text: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(ASSISTANT_CITATION_MAX_TEXT_LENGTH),
  ),
  comment: Schema.optional(
    Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_MAX_COMMENT_LENGTH)),
  ),
  start: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  end: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  prefix: Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_CONTEXT_LENGTH)),
  suffix: Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_CONTEXT_LENGTH)),
}).check(
  Schema.makeFilter(
    (citation) =>
      citation.endLine >= citation.startLine &&
      citation.end > citation.start &&
      citation.text.trim().length > 0,
  ),
);
export type DocumentCitation = typeof DocumentCitation.Type;

/** Anything a user can quote into the composer; only document quotes carry `kind`. */
export type Citation = AssistantCitation | DocumentCitation;
