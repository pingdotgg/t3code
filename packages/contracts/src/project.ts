import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RepositoryIdentity } from "./environment.ts";
import { ModelSelection, ProjectScript } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { SourceControlProviderInfo, SourceControlProviderKind } from "./sourceControl.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;

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
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectListEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

export const ProjectEntriesFailure = Schema.Literals([
  "workspace_root_not_found",
  "workspace_root_create_failed",
  "workspace_root_stat_failed",
  "workspace_root_not_directory",
  "search_index_create_failed",
  "search_index_scan_timed_out",
  "search_index_search_failed",
]);
export type ProjectEntriesFailure = typeof ProjectEntriesFailure.Type;

type ProjectEntriesFailureContext = {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
  readonly cause?: unknown;
};

function decodedProjectErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // The structured fields are optional on the wire so newer peers can decode legacy message-only
  // failures. New application code must provide them through this constructor.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectListEntriesError extends Schema.TaggedErrorClass<ProjectListEntriesError>()(
  "ProjectListEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectEntriesFailureContext & { readonly cwd: string }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ?? `Failed to list workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectFileFailure = Schema.Literals([
  "workspace_path_outside_root",
  "resolved_path_outside_root",
  "path_not_file",
  "binary_file",
  "operation_failed",
]);
export type ProjectFileFailure = typeof ProjectFileFailure.Type;

export const ProjectFileOperation = Schema.Literals([
  "realpath-workspace-root",
  "realpath-target",
  "open",
  "stat",
  "read",
  "close",
  "make-directory",
  "write-file",
]);
export type ProjectFileOperation = typeof ProjectFileOperation.Type;

type ProjectFileFailureContext = {
  readonly cwd: string;
  readonly relativePath: string;
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
  readonly cause?: unknown;
};

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to read workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}

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
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to write workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}

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
const ProjectAutomaticGitFetchIntervalMs = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const ProjectActionEnvironment = Schema.Record(
  ProjectActionEnvironmentKey,
  ProjectActionEnvironmentValue,
).check(Schema.isMaxProperties(128));
export type ProjectActionEnvironment = typeof ProjectActionEnvironment.Type;

export const ProjectSettings = Schema.Struct({
  remoteOverride: Schema.NullOr(ProjectRemoteOverride).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  automaticGitFetchInterval: Schema.NullOr(ProjectAutomaticGitFetchIntervalMs).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  actionEnvironment: ProjectActionEnvironment.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  disabledProviderInstanceIds: Schema.Array(ProviderInstanceId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ProjectSettings = typeof ProjectSettings.Type;

export const ProjectSettingsPatch = Schema.Struct({
  remoteOverride: Schema.optionalKey(Schema.NullOr(ProjectRemoteOverride)),
  automaticGitFetchInterval: Schema.optionalKey(Schema.NullOr(ProjectAutomaticGitFetchIntervalMs)),
  actionEnvironment: Schema.optionalKey(ProjectActionEnvironment),
  disabledProviderInstanceIds: Schema.optionalKey(Schema.Array(ProviderInstanceId)),
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
    cause: Schema.optional(Schema.Defect()),
  },
) {}
