import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_LIFECYCLE_SCRIPT_COMMAND_MAX_LENGTH = 10_000;
const PROJECT_LIFECYCLE_ENV_MAX_PROPERTIES = 128;
const PROJECT_LIFECYCLE_ENV_VALUE_MAX_LENGTH = 8_192;

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

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH),
  ),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

const ProjectLifecycleEnvKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
).check(Schema.isMaxLength(128));
const ProjectLifecycleEnvValue = Schema.String.check(
  Schema.isMaxLength(PROJECT_LIFECYCLE_ENV_VALUE_MAX_LENGTH),
);
const ProjectLifecycleEnv = Schema.Record(
  ProjectLifecycleEnvKey,
  ProjectLifecycleEnvValue,
).check(Schema.isMaxProperties(PROJECT_LIFECYCLE_ENV_MAX_PROPERTIES));

export const ProjectRunLifecycleScriptInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_LIFECYCLE_SCRIPT_COMMAND_MAX_LENGTH),
  ),
  env: Schema.optional(ProjectLifecycleEnv),
});
export type ProjectRunLifecycleScriptInput = typeof ProjectRunLifecycleScriptInput.Type;
