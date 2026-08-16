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
  workspaceRoot: Schema.NonEmptyString,
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
  workspaceRoot: Schema.NonEmptyString,
  projects: Schema.Array(WorktreeProjectRef),
  path: Schema.NonEmptyString,
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
  paths: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
});
export type VcsPruneWorktreesInput = typeof VcsPruneWorktreesInput.Type;

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
      path: Schema.NonEmptyString,
      workspaceRoot: Schema.NonEmptyString,
    }),
  ),
  skipped: Schema.Array(
    Schema.Struct({
      path: Schema.NonEmptyString,
      reason: WorktreePruneSkipReason,
      detail: Schema.optional(Schema.String),
    }),
  ),
});
export type VcsPruneWorktreesResult = typeof VcsPruneWorktreesResult.Type;

export const WorktreeInventoryErrorStage = Schema.Literals([
  "load_projects",
  "load_threads",
  "identify_repository",
  "inspect_repository",
]);
export type WorktreeInventoryErrorStage = typeof WorktreeInventoryErrorStage.Type;

export class WorktreeInventoryError extends Schema.TaggedErrorClass<WorktreeInventoryError>()(
  "WorktreeInventoryError",
  {
    stage: WorktreeInventoryErrorStage,
    projectId: Schema.optional(ProjectId),
    workspaceRoot: Schema.optional(Schema.NonEmptyString),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "load_projects":
        return "Failed to load projects for the worktree inventory.";
      case "load_threads":
        return "Failed to load V2 thread shells for the worktree inventory.";
      case "identify_repository":
        return "Failed to identify a project's repository.";
      case "inspect_repository":
        return "Failed to inspect a repository for the worktree inventory.";
    }
  }
}

export const WorktreeMutationErrorStage = Schema.Literals([
  "revalidate_inventory",
  "inspect_target_path",
  "resolve_target_path",
  "load_projects",
  "unmanaged_workspace",
  "inspect_registrations",
  "validate_branch",
  "invalid_branch",
  "check_branch",
  "missing_branch",
  "outside_managed_root",
  "registered_different_ref",
  "unregistered_existing_path",
  "stale_existing_registration",
  "branch_in_use",
  "prune_metadata",
  "stale_registration_remaining",
  "target_appeared",
  "create_worktree",
  "verify_worktree",
  "worktree_verification_failed",
  "load_project",
  "project_not_found",
  "run_setup",
]);
export type WorktreeMutationErrorStage = typeof WorktreeMutationErrorStage.Type;

export class WorktreeMutationError extends Schema.TaggedErrorClass<WorktreeMutationError>()(
  "WorktreeMutationError",
  {
    operation: Schema.Literals(["prune", "revive"]),
    stage: WorktreeMutationErrorStage,
    path: Schema.optional(Schema.NonEmptyString),
    conflictingPath: Schema.optional(Schema.NonEmptyString),
    workspaceRoot: Schema.optional(Schema.NonEmptyString),
    branch: Schema.optional(TrimmedNonEmptyString),
    projectId: Schema.optional(ProjectId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "revalidate_inventory":
        return "Failed to revalidate worktrees before pruning.";
      case "inspect_target_path":
        return "Failed to inspect the target worktree path.";
      case "resolve_target_path":
        return "Failed to resolve the target worktree path.";
      case "load_projects":
        return "Failed to load projects before reviving the worktree.";
      case "unmanaged_workspace":
        return `Cannot revive a worktree for unmanaged workspace '${this.workspaceRoot ?? "unknown"}'.`;
      case "inspect_registrations":
        return "Failed to inspect Git worktree registrations.";
      case "validate_branch":
        return "Failed to validate the worktree branch.";
      case "invalid_branch":
        return `Cannot revive the worktree: '${this.branch ?? "unknown"}' is not a valid local branch name.`;
      case "check_branch":
        return "Failed to check whether the worktree branch exists.";
      case "missing_branch":
        return `Cannot recreate the worktree: branch '${this.branch ?? "unknown"}' no longer exists.`;
      case "outside_managed_root":
        return `Cannot revive a worktree outside the managed worktrees directory: '${this.path ?? "unknown"}'.`;
      case "registered_different_ref":
        return `Cannot revive '${this.path ?? "unknown"}': Git already registers that path for a different ref.`;
      case "unregistered_existing_path":
        return `Cannot revive '${this.path ?? "unknown"}': the directory exists but is not a registered Git worktree.`;
      case "stale_existing_registration":
        return `Cannot revive '${this.path ?? "unknown"}': the existing directory has a stale Git worktree registration.`;
      case "branch_in_use":
        return `Cannot revive branch '${this.branch ?? "unknown"}': it is already checked out at '${this.conflictingPath ?? "unknown"}'.`;
      case "prune_metadata":
        return "Failed to clear stale Git worktree metadata.";
      case "stale_registration_remaining":
        return `Cannot revive '${this.path ?? "unknown"}': Git still has a worktree registration at that path.`;
      case "target_appeared":
        return `Cannot revive '${this.path ?? "unknown"}': the target directory appeared before creation.`;
      case "create_worktree":
        return "Failed to create the revived Git worktree.";
      case "verify_worktree":
        return "Failed to verify the revived worktree directory.";
      case "worktree_verification_failed":
        return `The worktree was created but could not be verified at '${this.path ?? "unknown"}'.`;
      case "load_project":
        return "Failed to load the project before reviving the worktree.";
      case "project_not_found":
        return `Cannot revive a worktree for project '${this.projectId ?? "unknown"}': the project was not found.`;
      case "run_setup":
        return "Failed to run the project setup script after revival.";
    }
  }
}
