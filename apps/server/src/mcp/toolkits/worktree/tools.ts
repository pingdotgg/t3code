import {
  WorktreeMcpFailure,
  OrchestratorMcpFailure,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsListWorktreesResult,
  VcsPruneWorktreesInput,
  VcsPruneWorktreesResult,
  WorktreeMcpHandoffInput,
  WorktreeMcpHandoffResult,
  WorktreeMcpStatusResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";
import * as WorktreeService from "../../../vcs/WorktreeService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  WorktreeMcpService.WorktreeMcpService,
];

const WorktreeHandoffTool = Tool.make("t3_worktree_handoff", {
  description:
    "Move this agent thread into a new git worktree. To launch a separate agent already bound to a new or existing worktree, use t3_thread_launch with workspaceStrategy instead. Creates the worktree branch (optionally from origin), re-points the thread at the worktree, and by default runs the project's setup script there. Changing the workspace detaches the live provider session, so the current turn ends shortly after the handoff is recorded; call this as the last action of the turn. To keep working after the handoff, pass continuationPrompt with the remaining work: it is queued as the thread's next message and starts a new turn inside the worktree with the conversation preserved. Without it the thread stays idle until the next message. The worktree is not removed automatically when the thread is deleted. Fails if the thread is already attached to a worktree.",
  parameters: WorktreeMcpHandoffInput,
  success: WorktreeMcpHandoffResult,
  failure: WorktreeMcpFailure,
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
    "Report this agent thread's worktree binding: whether it is attached to a git worktree, the worktree path and branch, the project's main workspace root, and the server default for t3_worktree_handoff's startFromOrigin. Call this before t3_worktree_handoff to check whether a handoff is possible or has already happened.",
  // No `parameters`: Tool.make defaults to Tool.EmptyParams, which serializes
  // to a top-level `type: "object"` JSON Schema. An explicit empty
  // Schema.Struct({}) serializes to `anyOf: [object, array]`, which is not a
  // valid MCP tool input schema and makes clients reject the whole server.
  success: WorktreeMcpStatusResult,
  failure: WorktreeMcpFailure,
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
    "List branch refs and their associated checkout paths for this thread's workspace using the app's ref inventory. Detached worktrees without a branch are not included. Use t3_worktree_status for the thread binding and t3_worktree_handoff to create a new worktree.",
  parameters: Schema.Struct({
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
    GitWorkflowService.GitWorkflowService,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const worktreeInventoryDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  WorktreeService.WorktreeService,
];

const WorktreeInventoryTool = Tool.make("t3_worktree_inventory", {
  description:
    "List the app-managed git worktrees of this thread's project, including detached ones: path, branch, linked threads, changed and ignored file counts, unpushed commits, and pruneBlockers, the reasons t3_worktree_remove would keep each one. Reads local state only and does not fetch. Use t3_worktree_list for branch refs.",
  success: VcsListWorktreesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: worktreeInventoryDependencies,
})
  .annotate(Tool.Title, "List managed worktrees")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WorktreeRemoveTool = Tool.make("t3_worktree_remove", {
  description:
    "Remove managed worktree checkouts of this thread's project by path, as listed by t3_worktree_inventory. Branches, checkpoints and thread history are kept, and a linked thread's checkout is recreated from its branch on its next turn. Never forces: a worktree with a running or queued turn, a live session or terminal, an open thread, uncommitted changes or unpushed commits is skipped and returned with its reason, so this thread's own worktree cannot be removed. A worktree holding ignored files (other than node_modules) is skipped unless allowIgnoredFiles is true; set it only after the user has seen those paths and agreed to delete them. Requires a full-access/default caller.",
  parameters: Schema.Struct({
    paths: VcsPruneWorktreesInput.fields.paths,
    allowIgnoredFiles: VcsPruneWorktreesInput.fields.allowIgnoredFiles,
  }),
  success: VcsPruneWorktreesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: worktreeInventoryDependencies,
})
  .annotate(Tool.Title, "Remove managed worktrees")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const WorktreeToolkit = Toolkit.make(
  WorktreeHandoffTool,
  WorktreeStatusTool,
  WorktreeListTool,
  WorktreeInventoryTool,
  WorktreeRemoveTool,
);
