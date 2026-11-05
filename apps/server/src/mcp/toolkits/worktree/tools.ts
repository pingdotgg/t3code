import {
  WorktreeMcpFailure,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  VcsListRefsInput,
  VcsListRefsResult,
  WorktreeMcpHandoffInput,
  WorktreeMcpHandoffResult,
  WorktreeMcpRepoDetachInput,
  WorktreeMcpRepoDetachResult,
  WorktreeMcpRepoEnsureInput,
  WorktreeMcpRepoEnsureResult,
  WorktreeMcpRepoSetSubmoduleInput,
  WorktreeMcpRepoSetSubmoduleResult,
  WorktreeMcpStatusResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  WorktreeMcpService.WorktreeMcpService,
];

const WorktreeToolFailure = Schema.Union([WorktreeMcpFailure, OrchestratorMcpFailure]);

const WorktreeHandoffTool = Tool.make("t3_worktree_handoff", {
  description:
    "Move THIS thread into a new git worktree on a new branch. Runs the setup script by default. A separate agent in a worktree: `t3_thread_launch` with `workspaceStrategy`. Call last in your turn. The move ends the live session. `continuationPrompt` resumes work there next turn. Without it, the thread waits. The worktree stays after the thread is deleted. Fails if this thread has a worktree.",
  parameters: WorktreeMcpHandoffInput,
  success: WorktreeMcpHandoffResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Hand off thread to a git worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WorktreeStatusTool = Tool.make("t3_worktree_status", {
  description:
    "Report this thread's worktree: attached or not, path, branch, project root, and the `startFromOrigin` default. Check before `t3_worktree_handoff`.",
  // No `parameters`: Tool.make defaults to Tool.EmptyParams, which serializes
  // to a top-level `type: "object"` JSON Schema. An explicit empty
  // Schema.Struct({}) serializes to `anyOf: [object, array]`, which is not a
  // valid MCP tool input schema and makes clients reject the whole server.
  success: WorktreeMcpStatusResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get thread worktree status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WorktreeListTool = Tool.make("t3_worktree_list", {
  description:
    "List branch refs and checkout paths for a thread's workspace. Omit `threadId` for this thread. Detached worktrees with no branch are left out.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    query: VcsListRefsInput.fields.query,
    cursor: VcsListRefsInput.fields.cursor,
    limit: VcsListRefsInput.fields.limit,
    refKind: VcsListRefsInput.fields.refKind,
    includeMatchingRemoteRefs: VcsListRefsInput.fields.includeMatchingRemoteRefs,
  }),
  success: VcsListRefsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    WorktreeMcpService.WorktreeMcpService,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const RepoWorktreeEnsureTool = Tool.make("t3_repo_worktree_ensure", {
  description:
    "Needs an agent running inside a T3 thread, in a project with Multi-Repository Project Folder turned on (see t3_worktree_status). Gets a worktree for one Git repository inside the project folder and attaches it to this thread, which stays in the folder: no handoff or restart. Call it before editing a repository, and again for each further repository the work needs. Reuses the worktree that already has this repository and exact branch checked out, keeping its uncommitted edits; never stash, reset, or clean them. Otherwise creates one in the worktree location. A new branch needs baseRef. A branch that exists without a worktree needs useExistingBranch:true. For a submodule you edit, ensure a worktree for the submodule's path too (for example 'service/framework'), commit there, then use t3_repo_worktree_set_submodule. Do all edits, builds, and commits in the returned worktreePath. T3 snapshots the worktree before this returns and with every turn after, for the user's diffs and rollback.",
  parameters: WorktreeMcpRepoEnsureInput,
  success: WorktreeMcpRepoEnsureResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create or reuse a repository worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const RepoWorktreeDetachTool = Tool.make("t3_repo_worktree_detach", {
  description:
    "Needs an agent running inside a T3 thread. Detaches a repository worktree from this thread. The folder, branch, and edits stay; it only stops being listed and protected as this thread's work.",
  parameters: WorktreeMcpRepoDetachInput,
  success: WorktreeMcpRepoDetachResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Detach a repository worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RepoWorktreeSetSubmoduleTool = Tool.make("t3_repo_worktree_set_submodule", {
  description:
    "Needs an agent running inside a T3 thread, in a project with Multi-Repository Project Folder turned on. Points a submodule inside a parent repository worktree at a commit from the submodule repository's own worktree; both must be attached to this thread. Copies the commit into the parent worktree's submodule with a local fetch when it is missing (no push, no remote or URL change), checks it out on a detached HEAD, and stages the gitlink. Refuses a submodule with uncommitted changes. Call it again after each new submodule commit, then commit the parent with ordinary git.",
  parameters: WorktreeMcpRepoSetSubmoduleInput,
  success: WorktreeMcpRepoSetSubmoduleResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Pin a submodule to a worktree commit")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const WorktreeToolkit = Toolkit.make(
  WorktreeHandoffTool,
  WorktreeStatusTool,
  WorktreeListTool,
  RepoWorktreeEnsureTool,
  RepoWorktreeDetachTool,
  RepoWorktreeSetSubmoduleTool,
);
