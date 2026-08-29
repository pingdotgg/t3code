import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadEnvMode } from "./environment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { Project, ProjectScript } from "./project.ts";
import { SourceControlCloneProtocol, SourceControlProviderKind } from "./sourceControl.ts";

const ProjectMcpClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
  description: "Stable idempotency key to reuse when retrying this operation.",
});

export const ProjectMcpProject = Schema.Struct({
  ...Project.fields,
  projectFileDefaultThreadEnvMode: Schema.NullOr(ThreadEnvMode),
  globalDefaultThreadEnvMode: ThreadEnvMode,
  effectiveDefaultThreadEnvMode: ThreadEnvMode,
});
export type ProjectMcpProject = typeof ProjectMcpProject.Type;

export const ProjectMcpProjectSummary = Schema.Struct({
  id: Project.fields.id,
  title: Project.fields.title,
  workspaceRoot: Project.fields.workspaceRoot,
  repositoryIdentity: Project.fields.repositoryIdentity,
  faviconPath: Project.fields.faviconPath,
  defaultModelSelection: Project.fields.defaultModelSelection,
  defaultThreadEnvMode: Project.fields.defaultThreadEnvMode,
  projectFileDefaultThreadEnvMode: Schema.NullOr(ThreadEnvMode),
  globalDefaultThreadEnvMode: ThreadEnvMode,
  effectiveDefaultThreadEnvMode: ThreadEnvMode,
  createdAt: Project.fields.createdAt,
  updatedAt: Project.fields.updatedAt,
});
export type ProjectMcpProjectSummary = typeof ProjectMcpProjectSummary.Type;

export const ProjectMcpListInput = Schema.Struct({
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type ProjectMcpListInput = typeof ProjectMcpListInput.Type;

export const ProjectMcpListResult = Schema.Struct({
  projects: Schema.Array(ProjectMcpProjectSummary),
  nextCursor: Schema.NullOr(NonNegativeInt),
  totalCount: NonNegativeInt,
});
export type ProjectMcpListResult = typeof ProjectMcpListResult.Type;

export const ProjectMcpReadInput = Schema.Struct({ projectId: ProjectId });
export type ProjectMcpReadInput = typeof ProjectMcpReadInput.Type;

export const ProjectMcpExistingDirectorySource = Schema.Struct({
  type: Schema.Literal("existing_directory"),
  workspaceRoot: TrimmedNonEmptyString,
  createIfMissing: Schema.optional(
    Schema.Boolean.annotate({
      description: "Create workspaceRoot as a directory when it does not exist. Defaults to false.",
    }),
  ),
});

export const ProjectMcpCloneSource = Schema.Struct({
  type: Schema.Literal("clone"),
  destinationPath: TrimmedNonEmptyString,
  provider: Schema.optional(SourceControlProviderKind),
  repository: Schema.optional(TrimmedNonEmptyString),
  remoteUrl: Schema.optional(TrimmedNonEmptyString),
  protocol: Schema.optional(SourceControlCloneProtocol),
}).check(
  Schema.makeFilter((input) => {
    const hasRemoteUrl = input.remoteUrl !== undefined;
    const hasProviderRepository = input.provider !== undefined && input.repository !== undefined;
    const hasPartialProviderRepository =
      (input.provider === undefined) !== (input.repository === undefined);
    return (
      (!hasPartialProviderRepository && hasRemoteUrl !== hasProviderRepository) ||
      "Provide exactly one clone source: remoteUrl, or both provider and repository."
    );
  }),
);

export const ProjectMcpCreateSource = Schema.Union([
  ProjectMcpExistingDirectorySource,
  ProjectMcpCloneSource,
]);
export type ProjectMcpCreateSource = typeof ProjectMcpCreateSource.Type;

export const ProjectMcpCreateInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  source: ProjectMcpCreateSource,
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  clientRequestId: Schema.optional(ProjectMcpClientRequestId),
});
export type ProjectMcpCreateInput = typeof ProjectMcpCreateInput.Type;

export const ProjectMcpUpdateInput = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  clientRequestId: Schema.optional(ProjectMcpClientRequestId),
});
export type ProjectMcpUpdateInput = typeof ProjectMcpUpdateInput.Type;

export const ProjectMcpDeleteInput = Schema.Struct({
  projectId: ProjectId,
  cascadeThreads: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Delete the project's thread records before removing the project. Required when the project is not empty.",
    }),
  ),
  clientRequestId: Schema.optional(ProjectMcpClientRequestId),
});
export type ProjectMcpDeleteInput = typeof ProjectMcpDeleteInput.Type;

export const ProjectMcpDeleteResult = Schema.Struct({
  projectId: ProjectId,
  deleted: Schema.Boolean,
  alreadyDeleted: Schema.Boolean,
  deletedThreadCount: NonNegativeInt,
  workspaceRoot: TrimmedNonEmptyString,
  workspaceFilesDeleted: Schema.Literal(false),
});
export type ProjectMcpDeleteResult = typeof ProjectMcpDeleteResult.Type;

export class ProjectMcpFailure extends Schema.TaggedErrorClass<ProjectMcpFailure>()(
  "ProjectMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "project_not_found",
      "project_deleted",
      "project_not_empty",
      "invalid_request",
      "operation_failed",
    ]),
    message: Schema.String,
  },
) {}
