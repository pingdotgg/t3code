import { Schema } from "effect";

export const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const TrimmedNonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());

export class ProjectSearchEntriesInput extends Schema.Class<ProjectSearchEntriesInput>(
  "ProjectSearchEntriesInput",
)({
  cwd: TrimmedNonEmptyString,
  query: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  limit: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT),
  ),
}) {}

export const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export class ProjectEntry extends Schema.Class<ProjectEntry>("ProjectEntry")({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
}) {}

export class ProjectSearchEntriesResult extends Schema.Class<ProjectSearchEntriesResult>(
  "ProjectSearchEntriesResult",
)({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
}) {}
