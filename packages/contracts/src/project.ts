import { Schema } from "effect";

export const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const TrimmedNonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  limit: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT),
  ),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

export const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;
