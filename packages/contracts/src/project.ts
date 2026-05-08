import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RepositoryIdentity } from "./environment.ts";
import { ModelSelection, ProjectScript } from "./orchestration.ts";
import { SourceControlProviderInfo, SourceControlProviderKind } from "./sourceControl.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;

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

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
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

export const ProjectRemoteOverride = Schema.Struct({
  provider: SourceControlProviderKind,
  remoteName: Schema.optional(TrimmedNonEmptyString),
  remoteUrl: TrimmedNonEmptyString,
  webUrl: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectRemoteOverride = typeof ProjectRemoteOverride.Type;

const ProjectActionEnvironmentKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
)
  .check(Schema.isMaxLength(128))
  .check(
    Schema.makeFilter((key) =>
      key.startsWith("T3CODE_") ? "T3CODE_* environment variables are reserved." : true,
    ),
  );
const ProjectActionEnvironmentValue = Schema.String.check(Schema.isMaxLength(8_192));

export const ProjectActionEnvironment = Schema.Record(
  ProjectActionEnvironmentKey,
  ProjectActionEnvironmentValue,
).check(Schema.isMaxProperties(128));
export type ProjectActionEnvironment = typeof ProjectActionEnvironment.Type;

export const ProjectSettings = Schema.Struct({
  remoteOverride: Schema.NullOr(ProjectRemoteOverride).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  actionEnvironment: ProjectActionEnvironment.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type ProjectSettings = typeof ProjectSettings.Type;

export const ProjectSettingsPatch = Schema.Struct({
  remoteOverride: Schema.optionalKey(Schema.NullOr(ProjectRemoteOverride)),
  actionEnvironment: Schema.optionalKey(ProjectActionEnvironment),
});
export type ProjectSettingsPatch = typeof ProjectSettingsPatch.Type;

export const ProjectDetailsInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectDetailsInput = typeof ProjectDetailsInput.Type;

export const ProjectUpdateSettingsInput = Schema.Struct({
  projectId: ProjectId,
  patch: ProjectSettingsPatch,
});
export type ProjectUpdateSettingsInput = typeof ProjectUpdateSettingsInput.Type;

export const ProjectDetectedRemote = Schema.Struct({
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  pushUrl: Schema.optional(TrimmedNonEmptyString),
  provider: Schema.NullOr(SourceControlProviderInfo),
});
export type ProjectDetectedRemote = typeof ProjectDetectedRemote.Type;

export const ProjectEffectiveRemote = Schema.Struct({
  source: Schema.Literals(["override", "detected"]),
  provider: SourceControlProviderKind,
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  webUrl: Schema.optional(TrimmedNonEmptyString),
  providerInfo: Schema.NullOr(SourceControlProviderInfo),
});
export type ProjectEffectiveRemote = typeof ProjectEffectiveRemote.Type;

export const ProjectDetails = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.NullOr(RepositoryIdentity),
  defaultModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  scripts: Schema.Array(ProjectScript).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  settings: ProjectSettings,
  detected: Schema.Struct({
    gitRoot: Schema.NullOr(TrimmedNonEmptyString),
    branch: Schema.NullOr(TrimmedNonEmptyString),
    remotes: Schema.Array(ProjectDetectedRemote),
    primaryRemote: Schema.NullOr(ProjectDetectedRemote),
  }),
  effective: Schema.Struct({
    title: TrimmedNonEmptyString,
    remote: Schema.NullOr(ProjectEffectiveRemote),
  }),
});
export type ProjectDetails = typeof ProjectDetails.Type;

export class ProjectDetailsError extends Schema.TaggedErrorClass<ProjectDetailsError>()(
  "ProjectDetailsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
