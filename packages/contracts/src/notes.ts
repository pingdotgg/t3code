import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const NOTES_LIST_LIMIT = 500;
export const NOTE_MAX_BYTES = 1024 * 1024;

export const NotesListInput = Schema.Struct({
  query: Schema.optionalKey(TrimmedString.check(Schema.isMaxLength(200))),
});
export type NotesListInput = typeof NotesListInput.Type;

export const NoteSummary = Schema.Struct({
  /** Relative to the vault, with `/` separators. */
  path: TrimmedNonEmptyString,
  title: Schema.String,
  modifiedAt: NonNegativeInt,
  size: NonNegativeInt,
  /** Text around the first content match, when a query matched the body. */
  snippet: Schema.optionalKey(Schema.String),
});
export type NoteSummary = typeof NoteSummary.Type;

export const NotesListResult = Schema.Struct({
  notes: Schema.Array(NoteSummary),
  truncated: Schema.Boolean,
});
export type NotesListResult = typeof NotesListResult.Type;

export const NotesReadInput = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
});
export type NotesReadInput = typeof NotesReadInput.Type;

export const NotesReadResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: Schema.String,
  content: Schema.String,
  modifiedAt: NonNegativeInt,
});
export type NotesReadResult = typeof NotesReadResult.Type;

export const NotesWriteInput = Schema.Struct({
  /** Relative to the vault, with `/` separators; must end in `.md`. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  content: Schema.String.check(Schema.isMaxLength(NOTE_MAX_BYTES)),
  /** Fail with `already-exists` instead of overwriting. */
  createOnly: Schema.optionalKey(Schema.Boolean),
});
export type NotesWriteInput = typeof NotesWriteInput.Type;

export const NotesWriteResult = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type NotesWriteResult = typeof NotesWriteResult.Type;

export const NotesFailureReason = Schema.Literals([
  "unconfigured",
  "vault-missing",
  "outside-vault",
  "not-markdown",
  "too-large",
  "not-found",
  "read-failed",
  "already-exists",
  "write-failed",
]);
export type NotesFailureReason = typeof NotesFailureReason.Type;

const NOTES_FAILURE_MESSAGES: Record<NotesFailureReason, string> = {
  unconfigured: "Set your vault folder in Settings.",
  "vault-missing": "The vault folder does not exist. Check the path in Settings.",
  "outside-vault": "That note is outside the vault.",
  "not-markdown": "Only Markdown notes can be opened.",
  "too-large": "That note is larger than 1 MB.",
  "not-found": "That note no longer exists.",
  "read-failed": "Could not read the vault.",
  "already-exists": "A note with that name already exists.",
  "write-failed": "Could not save the note.",
};

export class NotesError extends Schema.TaggedError<NotesError>()("NotesError", {
  reason: NotesFailureReason,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return NOTES_FAILURE_MESSAGES[this.reason];
  }
}
