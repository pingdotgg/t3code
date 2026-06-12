import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_LIST_DIRECTORY_ENTRIES_MAX_LIMIT = 500;
const PROJECT_LIST_DIRECTORY_PATH_MAX_LENGTH = 512;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_DELETE_ENTRY_PATH_MAX_LENGTH = 512;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
  ignored: Schema.optional(Schema.Boolean),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectListDirectoryEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  directoryPath: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_LIST_DIRECTORY_PATH_MAX_LENGTH)),
  ),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_LIST_DIRECTORY_ENTRIES_MAX_LIMIT)),
});
export type ProjectListDirectoryEntriesInput = typeof ProjectListDirectoryEntriesInput.Type;

export const ProjectListDirectoryEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectListDirectoryEntriesResult = typeof ProjectListDirectoryEntriesResult.Type;

export class ProjectListDirectoryEntriesError extends Schema.TaggedErrorClass<ProjectListDirectoryEntriesError>()(
  "ProjectListDirectoryEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  truncated: Schema.Boolean,
  sizeBytes: NonNegativeInt,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectDeleteEntryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_DELETE_ENTRY_PATH_MAX_LENGTH),
  ),
});
export type ProjectDeleteEntryInput = typeof ProjectDeleteEntryInput.Type;

export const ProjectDeleteEntryResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectDeleteEntryResult = typeof ProjectDeleteEntryResult.Type;

export class ProjectDeleteEntryError extends Schema.TaggedErrorClass<ProjectDeleteEntryError>()(
  "ProjectDeleteEntryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
