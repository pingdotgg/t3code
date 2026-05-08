import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ServerLocalAgentInventory } from "./localAgents.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_FILE_PATH_MAX_LENGTH = 512;
export const PROJECT_TEXT_FILE_MAX_BYTES = 512 * 1024;
export const ProjectRelativePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_FILE_PATH_MAX_LENGTH),
);
export const ProjectFileVersion = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export type ProjectFileVersion = typeof ProjectFileVersion.Type;

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
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectListEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: Schema.optional(Schema.NullOr(ProjectRelativePath)),
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

export const ProjectLocalAgentInventoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectLocalAgentInventoryInput = typeof ProjectLocalAgentInventoryInput.Type;

export const ProjectLocalAgentInventoryResult = ServerLocalAgentInventory;
export type ProjectLocalAgentInventoryResult = typeof ProjectLocalAgentInventoryResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class ProjectListEntriesError extends Schema.TaggedErrorClass<ProjectListEntriesError>()(
  "ProjectListEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: ProjectRelativePath,
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: ProjectRelativePath,
  contents: Schema.String,
  version: ProjectFileVersion,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: ProjectRelativePath,
  contents: Schema.String,
  expectedVersion: Schema.optional(Schema.NullOr(ProjectFileVersion)),
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: ProjectRelativePath,
  version: ProjectFileVersion,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export const ProjectCreateDirectoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: ProjectRelativePath,
});
export type ProjectCreateDirectoryInput = typeof ProjectCreateDirectoryInput.Type;

export const ProjectCreateDirectoryResult = Schema.Struct({
  relativePath: ProjectRelativePath,
});
export type ProjectCreateDirectoryResult = typeof ProjectCreateDirectoryResult.Type;

export const ProjectRenameEntryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  fromRelativePath: ProjectRelativePath,
  toRelativePath: ProjectRelativePath,
});
export type ProjectRenameEntryInput = typeof ProjectRenameEntryInput.Type;

export const ProjectRenameEntryResult = Schema.Struct({
  fromRelativePath: ProjectRelativePath,
  toRelativePath: ProjectRelativePath,
  kind: ProjectEntryKind,
});
export type ProjectRenameEntryResult = typeof ProjectRenameEntryResult.Type;

export const ProjectDeleteEntryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: ProjectRelativePath,
  recursive: Schema.Boolean,
});
export type ProjectDeleteEntryInput = typeof ProjectDeleteEntryInput.Type;

export const ProjectDeleteEntryResult = Schema.Struct({
  relativePath: ProjectRelativePath,
  kind: ProjectEntryKind,
});
export type ProjectDeleteEntryResult = typeof ProjectDeleteEntryResult.Type;

export class ProjectFileNotFoundError extends Schema.TaggedErrorClass<ProjectFileNotFoundError>()(
  "ProjectFileNotFoundError",
  {
    message: TrimmedNonEmptyString,
    relativePath: ProjectRelativePath,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class ProjectFileBinaryError extends Schema.TaggedErrorClass<ProjectFileBinaryError>()(
  "ProjectFileBinaryError",
  {
    message: TrimmedNonEmptyString,
    relativePath: ProjectRelativePath,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class ProjectFileTooLargeError extends Schema.TaggedErrorClass<ProjectFileTooLargeError>()(
  "ProjectFileTooLargeError",
  {
    message: TrimmedNonEmptyString,
    relativePath: ProjectRelativePath,
    sizeBytes: PositiveInt,
    maxBytes: PositiveInt,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class ProjectFileVersionConflictError extends Schema.TaggedErrorClass<ProjectFileVersionConflictError>()(
  "ProjectFileVersionConflictError",
  {
    message: TrimmedNonEmptyString,
    relativePath: ProjectRelativePath,
    expectedVersion: Schema.NullOr(ProjectFileVersion),
    actualVersion: Schema.NullOr(ProjectFileVersion),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class ProjectLocalAgentInventoryError extends Schema.TaggedErrorClass<ProjectLocalAgentInventoryError>()(
  "ProjectLocalAgentInventoryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectReadFileRpcError = Schema.Union([
  ProjectFileNotFoundError,
  ProjectFileBinaryError,
  ProjectFileTooLargeError,
  ProjectReadFileError,
]);
export type ProjectReadFileRpcError = typeof ProjectReadFileRpcError.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectWriteFileRpcError = Schema.Union([
  ProjectFileVersionConflictError,
  ProjectWriteFileError,
]);
export type ProjectWriteFileRpcError = typeof ProjectWriteFileRpcError.Type;

export class ProjectCreateDirectoryError extends Schema.TaggedErrorClass<ProjectCreateDirectoryError>()(
  "ProjectCreateDirectoryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class ProjectRenameEntryError extends Schema.TaggedErrorClass<ProjectRenameEntryError>()(
  "ProjectRenameEntryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class ProjectDeleteEntryError extends Schema.TaggedErrorClass<ProjectDeleteEntryError>()(
  "ProjectDeleteEntryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
