import {
  NonNegativeInt,
  Project,
  ProjectCreatePayload,
  ProjectUpdatePayload,
  ProjectId,
  OrchestratorMcpFailure,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { ProjectService } from "../../../project/ProjectService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { SourceControlRepositoryService } from "../../../sourceControl/SourceControlRepositoryService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const shared = {
  success: Project,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext, ThreadManagementService, ProjectService, Crypto.Crypto],
};
export const ProjectListTool = Tool.make("t3_project_list", {
  ...shared,
  description:
    "List registered projects in this environment. Pages use the current project snapshot and may shift between calls.",
  parameters: Schema.Struct({
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    projects: Schema.Array(Project),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const ProjectReadTool = Tool.make("t3_project_read", {
  ...shared,
  description:
    "Read a registered project in this environment, including its workspace and saved scripts.",
  parameters: Schema.Struct({ projectId: ProjectId }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const ProjectCreateTool = Tool.make("t3_project_create", {
  ...shared,
  description:
    "Register a project directory through the existing project service. Set createWorkspaceRootIfMissing to create a directory. Each call creates a new request; an existing registered workspace is rejected. Clone separately with t3_project_clone when needed.",
  parameters: ProjectCreatePayload,
}).annotate(Tool.Destructive, true);
export const ProjectUpdateTool = Tool.make("t3_project_update", {
  ...shared,
  description:
    "Update a registered project's settings. Omitted fields are preserved. Uses the same project service as the app.",
  parameters: Schema.Struct({ projectId: ProjectId, ...ProjectUpdatePayload.fields }),
}).annotate(Tool.Destructive, true);
export const ProjectDeleteTool = Tool.make("t3_project_delete", {
  ...shared,
  description:
    "Delete a project using the existing project deletion lifecycle. Nonempty projects require force=true. This does not delete the repository directory or promise a deleted-thread count.",
  parameters: Schema.Struct({ projectId: ProjectId, force: Schema.optionalKey(Schema.Boolean) }),
}).annotate(Tool.Destructive, true);
export const ProjectCloneTool = Tool.make("t3_project_clone", {
  ...shared,
  description:
    "Clone a repository using the app's source-control service. This only clones; register the returned cwd with t3_project_create. An existing destination is not adopted or removed on failure.",
  parameters: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  dependencies: [...shared.dependencies, SourceControlRepositoryService],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
export const ProjectToolkit = Toolkit.make(
  ProjectListTool,
  ProjectReadTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
  ProjectCloneTool,
);
