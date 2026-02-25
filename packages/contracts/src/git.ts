import { Schema } from "effect";

const TrimmedNonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty());

// Domain Types

export const GitStackedAction = Schema.Literals(["commit", "commit_push", "commit_push_pr"]);
export type GitStackedAction = typeof GitStackedAction.Type;
export const GitCommitStepStatus = Schema.Literals(["created", "skipped_no_changes"]);
export const GitPushStepStatus = Schema.Literals([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
export const GitPrStepStatus = Schema.Literals([
  "created",
  "opened_existing",
  "skipped_not_requested",
]);

export const GitBranch = Schema.Struct({
  name: TrimmedNonEmptyString,
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyString.pipe(Schema.NullOr),
});
export type GitBranch = typeof GitBranch.Type;

export const GitWorktree = Schema.Struct({
  path: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});
export type GitWorktree = typeof GitWorktree.Type;

// RPC Inputs

export const GitStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type GitStatusInput = typeof GitStatusInput.Type;

export const GitPullInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type GitPullInput = typeof GitPullInput.Type;

export const GitRunStackedActionInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(10_000))),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const GitListBranchesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type GitListBranchesInput = typeof GitListBranchesInput.Type;

export const GitCreateWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  newBranch: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString.pipe(Schema.NullOr),
});
export type GitCreateWorktreeInput = typeof GitCreateWorktreeInput.Type;

export const GitRemoveWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  force: Schema.optional(Schema.Boolean),
});
export type GitRemoveWorktreeInput = typeof GitRemoveWorktreeInput.Type;

export const GitCreateBranchInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});
export type GitCreateBranchInput = typeof GitCreateBranchInput.Type;

export const GitCheckoutInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});
export type GitCheckoutInput = typeof GitCheckoutInput.Type;

export const GitInitInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type GitInitInput = typeof GitInitInput.Type;

// RPC Results

export const GitStatusResult = Schema.Struct({
  branch: TrimmedNonEmptyString.pipe(Schema.NullOr),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: TrimmedNonEmptyString,
        insertions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        deletions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
    ),
    insertions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    deletions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  hasUpstream: Schema.Boolean,
  aheadCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  behindCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  openPr: Schema.Struct({
    number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    title: TrimmedNonEmptyString,
    url: Schema.String,
    baseBranch: TrimmedNonEmptyString,
    headBranch: TrimmedNonEmptyString,
  }).pipe(Schema.NullOr),
});
export type GitStatusResult = typeof GitStatusResult.Type;

export const GitListBranchesResult = Schema.Struct({
  branches: Schema.Array(GitBranch),
  isRepo: Schema.Boolean,
});
export type GitListBranchesResult = typeof GitListBranchesResult.Type;

export const GitCreateWorktreeResult = Schema.Struct({
  worktree: GitWorktree,
});
export type GitCreateWorktreeResult = typeof GitCreateWorktreeResult.Type;

export const GitRunStackedActionResult = Schema.Struct({
  action: GitStackedAction,
  commit: Schema.Struct({
    status: GitCommitStepStatus,
    commitSha: Schema.optional(TrimmedNonEmptyString),
    subject: Schema.optional(TrimmedNonEmptyString),
  }),
  push: Schema.Struct({
    status: GitPushStepStatus,
    branch: Schema.optional(TrimmedNonEmptyString),
    upstreamBranch: Schema.optional(TrimmedNonEmptyString),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: GitPrStepStatus,
    url: Schema.optional(Schema.String),
    number: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    baseBranch: Schema.optional(TrimmedNonEmptyString),
    headBranch: Schema.optional(TrimmedNonEmptyString),
    title: Schema.optional(TrimmedNonEmptyString),
  }),
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

export const GitPullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  branch: TrimmedNonEmptyString,
  upstreamBranch: TrimmedNonEmptyString.pipe(Schema.NullOr),
});
export type GitPullResult = typeof GitPullResult.Type;
