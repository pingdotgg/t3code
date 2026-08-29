import {
  ProjectMcpCreateInput,
  ProjectMcpDeleteInput,
  ProjectMcpDeleteResult,
  ProjectMcpFailure,
  ProjectMcpListInput,
  ProjectMcpListResult,
  ProjectMcpProject,
  ProjectMcpReadInput,
  ProjectMcpUpdateInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectMcpService } from "../../ProjectMcpService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, ProjectMcpService];

export const ProjectListTool = Tool.make("t3_project_list", {
  description:
    "List a bounded page of active project summaries in this T3 environment. Use t3_project_read for configured scripts and full project detail.",
  parameters: ProjectMcpListInput,
  success: ProjectMcpListResult,
  failure: ProjectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List T3 projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ProjectReadTool = Tool.make("t3_project_read", {
  description:
    "Read one active project in this T3 environment by projectId, including its root, defaults, configured scripts, and effective workspace mode.",
  parameters: ProjectMcpReadInput,
  success: ProjectMcpProject,
  failure: ProjectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a T3 project")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ProjectCreateTool = Tool.make("t3_project_create", {
  description:
    "Create a T3 project from an existing directory, optionally creating that directory when missing, or clone a repository into a destination and register the clone. Cloning accepts either remoteUrl or provider plus repository. This tool never publishes a local repository to a host.",
  parameters: ProjectMcpCreateInput,
  success: ProjectMcpProject,
  failure: ProjectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create a T3 project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ProjectUpdateTool = Tool.make("t3_project_update", {
  description:
    "Update a T3 project. Omitted fields remain unchanged. Explicit null clears the model, workspace-mode, or icon override. Replacing scripts updates configuration only and does not run them.",
  parameters: ProjectMcpUpdateInput,
  success: ProjectMcpProject,
  failure: ProjectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a T3 project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ProjectDeleteTool = Tool.make("t3_project_delete", {
  description:
    "Remove a T3 project record. A project with threads requires cascadeThreads=true, which deletes the thread records first. deletedThreadCount reports this attempt; alreadyDeleted distinguishes an idempotent replay. This tool never deletes the project directory, repository, worktrees, or any workspace files.",
  parameters: ProjectMcpDeleteInput,
  success: ProjectMcpDeleteResult,
  failure: ProjectMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delete a T3 project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ProjectToolkit = Toolkit.make(
  ProjectListTool,
  ProjectReadTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
);
