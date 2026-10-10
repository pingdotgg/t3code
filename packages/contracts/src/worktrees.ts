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

/**
 * Reasons the inventory will not remove a managed worktree by hand. `running`,
 * `session`, `terminal` and `status_unavailable` also stop configured
 * Storage cleanup. Its local-file policy determines whether untracked and
 * ignored files keep a checkout; tracked edits always do. `submodules` stops
 * both: Git refuses an unforced removal of a checkout with initialized
 * submodules, and forcing it could lose their unpublished commits.
 * `open_thread`, a named branch's `unpushed` commits and
 * `unrestorable_thread` only stop manual removal, since cleanup keeps the branch.
 * `unrestorable_thread` is a linked thread that revival could not bring back:
 * the checkout is detached, or the thread recorded a different branch or none.
 */
export const WorktreePruneBlocker = Schema.Literals([
  "running",
  "session",
  "terminal",
  "open_thread",
  "dirty",
  "submodules",
  "unpushed",
  "unrestorable_thread",
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
  /** Abbreviated HEAD commit, which tells detached checkouts apart. */
  headShortSha: Schema.NullOr(TrimmedNonEmptyString),
  threads: Schema.Array(WorktreeThreadRef),
  /** null when the working-tree status could not be read. */
  dirty: Schema.NullOr(Schema.Boolean),
  /** Number of changed/untracked files; null when status could not be read. */
  dirtyFileCount: Schema.NullOr(NonNegativeInt),
  /**
   * Ignored paths that removal would delete, other than reproducible
   * `node_modules`. Manual removal needs `allowIgnoredFiles` when this is not
   * zero. null when status could not be read.
   */
  ignoredFileCount: Schema.NullOr(NonNegativeInt),
  /** Up to five of those paths, relative to the worktree, for the confirmation. */
  ignoredFiles: Schema.Array(Schema.String),
  hasUpstream: Schema.NullOr(Schema.Boolean),
  /** Upstream is configured but its remote ref no longer exists. */
  upstreamGone: Schema.Boolean,
  aheadOfUpstreamCount: Schema.NullOr(NonNegativeInt),
  behindUpstreamCount: Schema.NullOr(NonNegativeInt),
  /**
   * Commits missing from the default branch. Only measured for a detached
   * checkout or a branch without a usable upstream; null otherwise or when it
   * could not be read.
   */
  aheadOfDefaultCount: Schema.NullOr(NonNegativeInt),
  /** Latest linked-thread activity; falls back to directory mtime without a live thread. */
  lastActivityAt: Schema.NullOr(IsoDateTime),
  safeToPrune: Schema.Boolean,
  pruneBlockers: Schema.Array(WorktreePruneBlocker),
});
export type WorktreeInfo = typeof WorktreeInfo.Type;

/**
 * Why a removal request left a worktree in place. Beyond the inventory
 * blockers: `ignored_files` needs the caller's opt-in, `protected_path` is a
 * project root, main checkout or path outside the managed directory,
 * `changed` means HEAD or the branch moved during the check, and
 * `policy_changed` means a cleanup rule no longer applies.
 */
export const WorktreePruneSkipReason = Schema.Literals([
  ...WorktreePruneBlocker.literals,
  "ignored_files",
  "protected_path",
  "unknown_worktree",
  "changed",
  "policy_changed",
  "remove_failed",
]);
export type WorktreePruneSkipReason = typeof WorktreePruneSkipReason.Type;

export const VcsListWorktreesInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type VcsListWorktreesInput = typeof VcsListWorktreesInput.Type;

export const VcsPruneWorktreesInput = Schema.Struct({
  /** The project whose repository registers these worktrees. */
  projectId: ProjectId,
  paths: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
  /**
   * Set only after the user confirmed the ignored paths shown for these
   * worktrees. Without it a worktree holding ignored data is skipped.
   */
  allowIgnoredFiles: Schema.optional(Schema.Boolean),
});
export type VcsPruneWorktreesInput = typeof VcsPruneWorktreesInput.Type;

export const VcsListWorktreesResult = Schema.Struct({
  worktrees: Schema.Array(WorktreeInfo),
  /** Inventory revision read before listing. A different change revision
      means this list may already be stale. */
  revision: NonNegativeInt,
});
export type VcsListWorktreesResult = typeof VcsListWorktreesResult.Type;

/**
 * An invalidation signal, not a counter to order by: it increases within one
 * server runtime and starts somewhere else after a restart. A subscriber
 * reads the list again whenever this differs from its list's revision.
 */
export const WorktreeInventoryChange = Schema.Struct({
  revision: NonNegativeInt,
});
export type WorktreeInventoryChange = typeof WorktreeInventoryChange.Type;

export const WorktreePruneSkip = Schema.Struct({
  path: Schema.NonEmptyString,
  reason: WorktreePruneSkipReason,
  detail: Schema.optional(Schema.String),
});
export type WorktreePruneSkip = typeof WorktreePruneSkip.Type;

export const VcsPruneWorktreesResult = Schema.Struct({
  removed: Schema.Array(
    Schema.Struct({
      path: Schema.NonEmptyString,
      workspaceRoot: Schema.NonEmptyString,
    }),
  ),
  skipped: Schema.Array(WorktreePruneSkip),
});
export type VcsPruneWorktreesResult = typeof VcsPruneWorktreesResult.Type;

export const WorktreeInventoryErrorStage = Schema.Literals([
  "load_projects",
  "load_threads",
  "inspect_repository",
]);
export type WorktreeInventoryErrorStage = typeof WorktreeInventoryErrorStage.Type;

export class WorktreeInventoryError extends Schema.TaggedError<WorktreeInventoryError>()(
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
      case "inspect_repository":
        return "Failed to inspect a repository for the worktree inventory.";
    }
  }
}

export const WorktreeMutationErrorStage = Schema.Literals([
  "inspect_target_path",
  "load_projects",
  "unmanaged_workspace",
  "inspect_registrations",
  "validate_branch",
  "invalid_branch",
  "check_branch",
  "missing_branch",
  "outside_managed_root",
  "registered_different_ref",
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
  "setup_exit_nonzero",
  "setup_readiness_changed",
]);
export type WorktreeMutationErrorStage = typeof WorktreeMutationErrorStage.Type;

export class WorktreeMutationError extends Schema.TaggedError<WorktreeMutationError>()(
  "WorktreeMutationError",
  {
    operation: Schema.Literals(["prune", "revive"]),
    stage: WorktreeMutationErrorStage,
    path: Schema.optional(Schema.NonEmptyString),
    conflictingPath: Schema.optional(Schema.NonEmptyString),
    workspaceRoot: Schema.optional(Schema.NonEmptyString),
    branch: Schema.optional(TrimmedNonEmptyString),
    projectId: Schema.optional(ProjectId),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "inspect_target_path":
        return "Failed to inspect the target worktree path.";
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
        return `Cannot revive a worktree outside the managed worktrees directories: '${this.path ?? "unknown"}'. Restore that checkout manually before sending another message.`;
      case "registered_different_ref":
        return `Cannot revive '${this.path ?? "unknown"}': Git already registers that path for a different ref.`;
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
        return "Failed to load the worktree's project.";
      case "project_not_found":
        return `Project '${this.projectId ?? "unknown"}' was not found for this worktree.`;
      case "run_setup":
        return "Failed to run the project setup script after revival.";
      case "setup_exit_nonzero":
        return `Project setup exited with ${this.exitCode ?? "no exit code"} after worktree revival.`;
      case "setup_readiness_changed":
        return "Worktree readiness changed during project setup. Retry the turn.";
    }
  }
}
