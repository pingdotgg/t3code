import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  VcsDriverRegistry.VcsDriverRegistry,
  FileSystem.FileSystem,
  Path.Path,
];

export const WorktreeHandoffInput = Schema.Struct({
  path: TrimmedNonEmptyString.annotate({
    description:
      "Absolute path of a linked git worktree of this thread's project repository. A path inside the worktree resolves to its root.",
  }),
});
export type WorktreeHandoffInput = typeof WorktreeHandoffInput.Type;

export class WorktreeHandoffPathInvalidError extends Schema.TaggedError<WorktreeHandoffPathInvalidError>()(
  "WorktreeHandoffPathInvalidError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class WorktreeHandoffThreadNotFoundError extends Schema.TaggedError<WorktreeHandoffThreadNotFoundError>()(
  "WorktreeHandoffThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class WorktreeHandoffFailedError extends Schema.TaggedError<WorktreeHandoffFailedError>()(
  "WorktreeHandoffFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not hand the thread off to the worktree.";
  }
}

export const WorktreeToolError = Schema.Union([
  McpCapabilityUnavailableError,
  WorktreeHandoffPathInvalidError,
  WorktreeHandoffThreadNotFoundError,
  WorktreeHandoffFailedError,
]);
export type WorktreeToolError = typeof WorktreeToolError.Type;

export const WorktreeHandoffResult = Schema.Struct({
  worktreePath: Schema.String,
  branch: Schema.NullOr(Schema.String).annotate({
    description: "Branch checked out in the worktree, or null for a detached HEAD.",
  }),
  previousWorktreePath: Schema.NullOr(Schema.String).annotate({
    description: "The worktree the thread was bound to before, or null for the project checkout.",
  }),
});
export type WorktreeHandoffResult = typeof WorktreeHandoffResult.Type;

const WorktreeHandoffTool = Tool.make("t3_worktree_handoff", {
  description:
    "Point this thread at a git worktree you created for it. T3 Code then labels the thread as a worktree thread, opens that folder from the Open button, and restarts the provider session inside the worktree on the next turn. Call it right after `git worktree add` when you continue the task there. Only linked worktrees of this thread's project repository are accepted.",
  parameters: WorktreeHandoffInput,
  success: WorktreeHandoffResult,
  failure: WorktreeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Hand thread off to a worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const WorktreeToolkit = Toolkit.make(WorktreeHandoffTool);
