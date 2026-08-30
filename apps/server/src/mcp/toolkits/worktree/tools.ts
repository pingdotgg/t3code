import {
  WorktreeMcpFailure,
  WorktreeMcpCheckoutInput,
  WorktreeMcpCheckoutResult,
  WorktreeMcpHandoffInput,
  WorktreeMcpHandoffResult,
  WorktreeMcpListInput,
  WorktreeMcpListResult,
  WorktreeMcpStatusResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { WorktreeMcpService } from "../../WorktreeMcpService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, WorktreeMcpService];

export const WorktreeHandoffTool = Tool.make("t3_worktree_handoff", {
  description:
    "Move this agent thread into a new git worktree. Creates the worktree branch (optionally from origin), re-points the thread at the worktree, and by default runs the project's setup script there. Changing the workspace detaches the live provider session, so the current turn ends shortly after the handoff is recorded; call this as the last action of the turn. To keep working after the handoff, pass continuationPrompt with the remaining work: it is queued as the thread's next message and starts a new turn inside the worktree with the conversation preserved. Without it the thread stays idle until the next message. The source worktree and the new worktree are not removed automatically.",
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

export const WorktreeStatusTool = Tool.make("t3_worktree_status", {
  description:
    "Report both the durable workspace recorded on this agent thread and the branch actually checked out on disk. The agreement field calls out a branch mismatch, a missing worktree binding, or a non-repository path. Call this before a handoff or checkout and after failures.",
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

export const WorktreeListTool = Tool.make("t3_worktree_list", {
  description:
    "Page through the calling thread's project root and Git-registered worktrees, including detached checkouts. Paths are canonicalized from Git's repository identity. Each entry includes the actual checked-out branch, dirty state, availability, and a bounded list plus total count of threads bound to that checkout. Use cursor until nextCursor is null. This tool does not create, remove, prune, or repair worktrees.",
  parameters: WorktreeMcpListInput,
  success: WorktreeMcpListResult,
  failure: WorktreeMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List project git worktrees")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadCheckoutTool = Tool.make("t3_thread_checkout", {
  description:
    "Change this existing T3 thread to a branch, project root, listed worktree, or a newly created worktree. This performs the git checkout when needed and updates the durable thread binding only after verifying the actual ref. It never stashes or discards files, deletes existing worktrees, or interrupts other threads. A workspace change detaches the calling provider session; pass continuationPrompt to queue the next turn in the selected checkout. Use t3_worktree_list and t3_worktree_status first.",
  parameters: WorktreeMcpCheckoutInput,
  success: WorktreeMcpCheckoutResult,
  failure: WorktreeMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Check out a branch or worktree for this thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const WorktreeToolkit = Toolkit.make(
  WorktreeHandoffTool,
  WorktreeStatusTool,
  WorktreeListTool,
  ThreadCheckoutTool,
);
