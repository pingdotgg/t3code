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

export class GitBranch extends Schema.Class<GitBranch>("GitBranch")({
  name: TrimmedNonEmptyString,
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyString.pipe(Schema.NullOr),
}) {}

export class GitWorktree extends Schema.Class<GitWorktree>("GitWorktree")({
  path: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
}) {}

// RPC Inputs

export class GitStatusInput extends Schema.Class<GitStatusInput>("GitStatusInput")({
  cwd: TrimmedNonEmptyString,
}) {}

export class GitPullInput extends Schema.Class<GitPullInput>("GitPullInput")({
  cwd: TrimmedNonEmptyString,
}) {}

export class GitRunStackedActionInput extends Schema.Class<GitRunStackedActionInput>(
  "GitRunStackedActionInput",
)({
  cwd: TrimmedNonEmptyString,
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(10_000))),
}) {}

export class GitListBranchesInput extends Schema.Class<GitListBranchesInput>(
  "GitListBranchesInput",
)({
  cwd: TrimmedNonEmptyString,
}) {}

export class GitCreateWorktreeInput extends Schema.Class<GitCreateWorktreeInput>(
  "GitCreateWorktreeInput",
)({
  cwd: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  newBranch: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString.pipe(Schema.NullOr),
}) {}

export class GitRemoveWorktreeInput extends Schema.Class<GitRemoveWorktreeInput>(
  "GitRemoveWorktreeInput",
)({
  cwd: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  force: Schema.Boolean.pipe(Schema.NullOr),
}) {}

export class GitCreateBranchInput extends Schema.Class<GitCreateBranchInput>(
  "GitCreateBranchInput",
)({
  cwd: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
}) {}

export class GitCheckoutInput extends Schema.Class<GitCheckoutInput>("GitCheckoutInput")({
  cwd: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
}) {}

export class GitInitInput extends Schema.Class<GitInitInput>("GitInitInput")({
  cwd: TrimmedNonEmptyString,
}) {}

// RPC Results

export class GitStatusResult extends Schema.Class<GitStatusResult>("GitStatusResult")({
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
}) {}

export class GitListBranchesResult extends Schema.Class<GitListBranchesResult>(
  "GitListBranchesResult",
)({
  branches: Schema.Array(GitBranch),
  isRepo: Schema.Boolean,
}) {}

export class GitCreateWorktreeResult extends Schema.Class<GitCreateWorktreeResult>(
  "GitCreateWorktreeResult",
)({
  worktree: GitWorktree,
}) {}

export class GitRunStackedActionResult extends Schema.Class<GitRunStackedActionResult>(
  "GitRunStackedActionResult",
)({
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
}) {}

export class GitPullResult extends Schema.Class<GitPullResult>("GitPullResult")({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  branch: TrimmedNonEmptyString,
  upstreamBranch: TrimmedNonEmptyString.pipe(Schema.NullOr),
}) {}
