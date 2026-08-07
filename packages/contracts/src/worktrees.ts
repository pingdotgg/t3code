import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const WorktreeThreadStatus = Schema.Literals(["active", "settled", "archived", "deleted"]);
export type WorktreeThreadStatus = typeof WorktreeThreadStatus.Type;

export const WorktreeThreadRef = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  status: WorktreeThreadStatus,
});
export type WorktreeThreadRef = typeof WorktreeThreadRef.Type;

export const WorktreeProjectRef = Schema.Struct({
  projectId: ProjectId,
  projectTitle: Schema.String,
  workspaceRoot: TrimmedNonEmptyString,
});
export type WorktreeProjectRef = typeof WorktreeProjectRef.Type;

/** Reasons a managed worktree must not be pruned automatically. */
export const WorktreePruneBlocker = Schema.Literals([
  "active_thread",
  "dirty",
  "unpushed",
  "status_unavailable",
]);
export type WorktreePruneBlocker = typeof WorktreePruneBlocker.Type;

export const WorktreeInfo = Schema.Struct({
  /** Primary project retained for simple callers; `projects` preserves all references. */
  projectId: ProjectId,
  projectTitle: Schema.String,
  workspaceRoot: TrimmedNonEmptyString,
  projects: Schema.Array(WorktreeProjectRef),
  path: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  threads: Schema.Array(WorktreeThreadRef),
  /** No non-deleted V2 shell references this worktree. */
  orphaned: Schema.Boolean,
  /** null when the working-tree status could not be read. */
  dirty: Schema.NullOr(Schema.Boolean),
  /** Number of changed/untracked files; null when status could not be read. */
  dirtyFileCount: Schema.NullOr(NonNegativeInt),
  hasUpstream: Schema.NullOr(Schema.Boolean),
  /** Upstream is configured but its remote ref no longer exists. */
  upstreamGone: Schema.Boolean,
  aheadOfUpstreamCount: Schema.NullOr(NonNegativeInt),
  behindUpstreamCount: Schema.NullOr(NonNegativeInt),
  aheadOfDefaultCount: Schema.NullOr(NonNegativeInt),
  /** Latest linked-thread activity; falls back to directory mtime for orphans. */
  lastActivityAt: Schema.NullOr(IsoDateTime),
  safeToPrune: Schema.Boolean,
  pruneBlockers: Schema.Array(WorktreePruneBlocker),
});
export type WorktreeInfo = typeof WorktreeInfo.Type;

export const WorktreePruneSkipReason = Schema.Literals([
  "active_thread",
  "dirty",
  "unpushed",
  "status_unavailable",
  "unknown_worktree",
  "remove_failed",
]);
export type WorktreePruneSkipReason = typeof WorktreePruneSkipReason.Type;

export const VcsListWorktreesInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type VcsListWorktreesInput = typeof VcsListWorktreesInput.Type;

export const VcsPruneWorktreesInput = Schema.Struct({
  paths: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
});
export type VcsPruneWorktreesInput = typeof VcsPruneWorktreesInput.Type;

export const VcsReviveWorktreeInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});
export type VcsReviveWorktreeInput = typeof VcsReviveWorktreeInput.Type;

export const VcsListWorktreesResult = Schema.Struct({
  worktrees: Schema.Array(WorktreeInfo),
});
export type VcsListWorktreesResult = typeof VcsListWorktreesResult.Type;

/** Monotonic for one server runtime; subscribers use it only as an invalidation signal. */
export const WorktreeInventoryChange = Schema.Struct({
  revision: NonNegativeInt,
});
export type WorktreeInventoryChange = typeof WorktreeInventoryChange.Type;

export const VcsPruneWorktreesResult = Schema.Struct({
  removed: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      workspaceRoot: TrimmedNonEmptyString,
    }),
  ),
  skipped: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      reason: WorktreePruneSkipReason,
      detail: Schema.optional(Schema.String),
    }),
  ),
});
export type VcsPruneWorktreesResult = typeof VcsPruneWorktreesResult.Type;

export const VcsReviveWorktreeResult = Schema.Struct({
  revived: Schema.Boolean,
});
export type VcsReviveWorktreeResult = typeof VcsReviveWorktreeResult.Type;

export class WorktreeInventoryError extends Schema.TaggedErrorClass<WorktreeInventoryError>()(
  "WorktreeInventoryError",
  {
    operation: Schema.Literal("list"),
    message: Schema.String,
    projectId: Schema.optional(ProjectId),
    workspaceRoot: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class WorktreeMutationError extends Schema.TaggedErrorClass<WorktreeMutationError>()(
  "WorktreeMutationError",
  {
    operation: Schema.Literals(["prune", "revive"]),
    message: Schema.String,
    path: Schema.optional(TrimmedNonEmptyString),
    workspaceRoot: Schema.optional(TrimmedNonEmptyString),
    branch: Schema.optional(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
