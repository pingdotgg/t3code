import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SourceControlProviderError, SourceControlProviderInfo } from "./sourceControl.ts";
import { VcsDriverKind } from "./vcs.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const GIT_LIST_BRANCHES_MAX_LIMIT = 200;

// Domain Types

export const GitStackedAction = Schema.Literals([
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
]);
export type GitStackedAction = typeof GitStackedAction.Type;
export const GitActionProgressPhase = Schema.Literals(["branch", "commit", "push", "pr"]);
export type GitActionProgressPhase = typeof GitActionProgressPhase.Type;
export const GitActionProgressKind = Schema.Literals([
  "action_started",
  "phase_started",
  "hook_started",
  "hook_output",
  "hook_finished",
  "action_finished",
  "action_failed",
]);
export type GitActionProgressKind = typeof GitActionProgressKind.Type;
export const GitActionProgressStream = Schema.Literals(["stdout", "stderr"]);
export type GitActionProgressStream = typeof GitActionProgressStream.Type;
const GitCommitStepStatus = Schema.Literals([
  "created",
  "skipped_no_changes",
  "skipped_not_requested",
]);
const GitPushStepStatus = Schema.Literals([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
const GitBranchStepStatus = Schema.Literals(["created", "skipped_not_requested"]);
const GitPrStepStatus = Schema.Literals(["created", "opened_existing", "skipped_not_requested"]);
const VcsStatusChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPullRequestReference = TrimmedNonEmptyStringSchema;
const GitPullRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPreparePullRequestThreadMode = Schema.Literals(["local", "worktree"]);
export const GitRunStackedActionToastRunAction = Schema.Struct({
  kind: GitStackedAction,
});
export type GitRunStackedActionToastRunAction = typeof GitRunStackedActionToastRunAction.Type;
const GitRunStackedActionToastCta = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("open_pr"),
    label: TrimmedNonEmptyStringSchema,
    url: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("run_action"),
    label: TrimmedNonEmptyStringSchema,
    action: GitRunStackedActionToastRunAction,
  }),
]);
export type GitRunStackedActionToastCta = typeof GitRunStackedActionToastCta.Type;
const GitRunStackedActionToast = Schema.Struct({
  title: TrimmedNonEmptyStringSchema,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  cta: GitRunStackedActionToastCta,
});
export type GitRunStackedActionToast = typeof GitRunStackedActionToast.Type;

export const VcsRef = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  isRemote: Schema.optional(Schema.Boolean),
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  upstreamName: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  lastActivityAt: Schema.optional(Schema.NullOr(Schema.String)),
  aheadCount: Schema.optional(NonNegativeInt),
  behindCount: Schema.optional(NonNegativeInt),
});
export type VcsRef = typeof VcsRef.Type;

const VcsWorktree = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
});
const GitResolvedPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitPullRequestState,
});
export type GitResolvedPullRequest = typeof GitResolvedPullRequest.Type;

// RPC Inputs

export const VcsStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsStatusInput = typeof VcsStatusInput.Type;

export const VcsPullInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsPullInput = typeof VcsPullInput.Type;

export const GitRunStackedActionInput = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
  featureBranch: Schema.optional(Schema.Boolean),
  filePaths: Schema.optional(
    Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
  ),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const VcsListRefsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  query: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(GIT_LIST_BRANCHES_MAX_LIMIT)),
  ),
});
export type VcsListRefsInput = typeof VcsListRefsInput.Type;

export const VcsCreateWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  newRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsCreateWorktreeInput = typeof VcsCreateWorktreeInput.Type;

export const GitPullRequestRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
});
export type GitPullRequestRefInput = typeof GitPullRequestRefInput.Type;

export const GitPreparePullRequestThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  mode: GitPreparePullRequestThreadMode,
  threadId: Schema.optional(ThreadId),
});
export type GitPreparePullRequestThreadInput = typeof GitPreparePullRequestThreadInput.Type;

export const VcsRemoveWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});
export type VcsRemoveWorktreeInput = typeof VcsRemoveWorktreeInput.Type;

export const VcsCreateRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  switchRef: Schema.optional(Schema.Boolean),
});
export type VcsCreateRefInput = typeof VcsCreateRefInput.Type;

export const VcsCreateRefResult = Schema.Struct({
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsCreateRefResult = typeof VcsCreateRefResult.Type;

export const VcsSwitchRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsSwitchRefInput = typeof VcsSwitchRefInput.Type;

export const VcsInitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  kind: Schema.optional(VcsDriverKind),
});
export type VcsInitInput = typeof VcsInitInput.Type;

// RPC Results

const VcsStatusChangeRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseRef: TrimmedNonEmptyStringSchema,
  headRef: TrimmedNonEmptyStringSchema,
  state: VcsStatusChangeRequestState,
});

const VcsStatusLocalShape = {
  isRepo: Schema.Boolean,
  sourceControlProvider: Schema.optional(SourceControlProviderInfo),
  hasPrimaryRemote: Schema.Boolean,
  isDefaultRef: Schema.Boolean,
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: TrimmedNonEmptyStringSchema,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
};

const VcsStatusRemoteShape = {
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  aheadOfDefaultCount: Schema.optional(NonNegativeInt),
  pr: Schema.NullOr(VcsStatusChangeRequest),
};

export const VcsStatusLocalResult = Schema.Struct(VcsStatusLocalShape);
export type VcsStatusLocalResult = typeof VcsStatusLocalResult.Type;

export const VcsStatusRemoteResult = Schema.Struct(VcsStatusRemoteShape);
export type VcsStatusRemoteResult = typeof VcsStatusRemoteResult.Type;

export const VcsStatusResult = Schema.Struct({
  ...VcsStatusLocalShape,
  ...VcsStatusRemoteShape,
});
export type VcsStatusResult = typeof VcsStatusResult.Type;

export const VcsStatusStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    local: VcsStatusLocalResult,
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
  Schema.TaggedStruct("localUpdated", {
    local: VcsStatusLocalResult,
  }),
  Schema.TaggedStruct("remoteUpdated", {
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
]);
export type VcsStatusStreamEvent = typeof VcsStatusStreamEvent.Type;

export const VcsListRefsResult = Schema.Struct({
  refs: Schema.Array(VcsRef),
  isRepo: Schema.Boolean,
  hasPrimaryRemote: Schema.Boolean,
  nextCursor: NonNegativeInt.pipe(Schema.NullOr),
  totalCount: NonNegativeInt,
});
export type VcsListRefsResult = typeof VcsListRefsResult.Type;

export const VcsCreateWorktreeResult = Schema.Struct({
  worktree: VcsWorktree,
});
export type VcsCreateWorktreeResult = typeof VcsCreateWorktreeResult.Type;

export const GitResolvePullRequestResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
});
export type GitResolvePullRequestResult = typeof GitResolvePullRequestResult.Type;

export const GitPreparePullRequestThreadResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  branch: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type GitPreparePullRequestThreadResult = typeof GitPreparePullRequestThreadResult.Type;

export const VcsSwitchRefResult = Schema.Struct({
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsSwitchRefResult = typeof VcsSwitchRefResult.Type;

export const GitRunStackedActionResult = Schema.Struct({
  action: GitStackedAction,
  branch: Schema.Struct({
    status: GitBranchStepStatus,
    name: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  commit: Schema.Struct({
    status: GitCommitStepStatus,
    commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
    subject: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  push: Schema.Struct({
    status: GitPushStepStatus,
    branch: Schema.optional(TrimmedNonEmptyStringSchema),
    upstreamBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: GitPrStepStatus,
    url: Schema.optional(Schema.String),
    number: Schema.optional(PositiveInt),
    baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    headBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    title: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  toast: GitRunStackedActionToast,
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

export const VcsPullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  refName: TrimmedNonEmptyStringSchema,
  upstreamRef: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsPullResult = typeof VcsPullResult.Type;

export const VcsPanelFileStatus = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
]);
export type VcsPanelFileStatus = typeof VcsPanelFileStatus.Type;

export const VcsPanelChangeGroupKind = Schema.Literals(["staged", "unstaged", "conflicts"]);
export type VcsPanelChangeGroupKind = typeof VcsPanelChangeGroupKind.Type;

export const VcsPanelFileChange = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  originalPath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  status: VcsPanelFileStatus,
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type VcsPanelFileChange = typeof VcsPanelFileChange.Type;

export const VcsPanelChangeGroup = Schema.Struct({
  kind: VcsPanelChangeGroupKind,
  files: Schema.Array(VcsPanelFileChange),
});
export type VcsPanelChangeGroup = typeof VcsPanelChangeGroup.Type;

export const VcsPanelRemote = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  fetchUrl: Schema.NullOr(TrimmedNonEmptyStringSchema),
  pushUrl: Schema.NullOr(TrimmedNonEmptyStringSchema),
  provider: Schema.NullOr(SourceControlProviderInfo),
  branches: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyStringSchema,
      fullRefName: TrimmedNonEmptyStringSchema,
      isDefaultRemoteHead: Schema.Boolean,
      lastActivityAt: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
export type VcsPanelRemote = typeof VcsPanelRemote.Type;

export const VcsPanelActionableForkBranch = Schema.Struct({
  localBranchName: TrimmedNonEmptyStringSchema,
  remoteName: TrimmedNonEmptyStringSchema,
  remoteBranchName: TrimmedNonEmptyStringSchema,
  remoteRefName: TrimmedNonEmptyStringSchema,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  lastActivityAt: Schema.optional(Schema.NullOr(Schema.String)),
});
export type VcsPanelActionableForkBranch = typeof VcsPanelActionableForkBranch.Type;

export const VcsPanelStash = Schema.Struct({
  refName: TrimmedNonEmptyStringSchema,
  sha: Schema.NullOr(TrimmedNonEmptyStringSchema),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  message: TrimmedNonEmptyStringSchema,
});
export type VcsPanelStash = typeof VcsPanelStash.Type;

export const VcsPanelCommitSummary = Schema.Struct({
  sha: TrimmedNonEmptyStringSchema,
  shortSha: TrimmedNonEmptyStringSchema,
  message: TrimmedNonEmptyStringSchema,
  authorName: Schema.NullOr(Schema.String),
  authorEmail: Schema.NullOr(Schema.String),
  authorAvatarUrl: Schema.NullOr(Schema.String),
  authoredAt: Schema.NullOr(Schema.String),
  headRefs: Schema.Array(TrimmedNonEmptyStringSchema),
  tags: Schema.Array(TrimmedNonEmptyStringSchema),
  files: Schema.Array(VcsPanelFileChange),
});
export type VcsPanelCommitSummary = typeof VcsPanelCommitSummary.Type;

export const VcsPanelBranchDetails = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  fullRefName: TrimmedNonEmptyStringSchema,
  isRemote: Schema.Boolean,
  remoteName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  upstreamRef: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  baseRef: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  unsyncedCommitShas: Schema.Array(TrimmedNonEmptyStringSchema),
  aheadCommits: Schema.Array(VcsPanelCommitSummary),
  aheadCommitsRemaining: NonNegativeInt,
  behindCommits: Schema.Array(VcsPanelCommitSummary),
  behindCommitsRemaining: NonNegativeInt,
  compareCommits: Schema.Array(VcsPanelCommitSummary),
  compareCommitsRemaining: NonNegativeInt,
  commits: Schema.Array(VcsPanelCommitSummary),
  commitsRemaining: NonNegativeInt,
  compareFiles: Schema.Array(VcsPanelFileChange),
});
export type VcsPanelBranchDetails = typeof VcsPanelBranchDetails.Type;

export const VcsPanelBranchDetailsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: VcsRef,
  defaultCompareRef: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  compareBaseRef: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type VcsPanelBranchDetailsInput = typeof VcsPanelBranchDetailsInput.Type;

export const VcsPanelBranchCommitsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: VcsRef,
  baseRef: Schema.optional(TrimmedNonEmptyStringSchema.pipe(Schema.NullOr)),
  kind: Schema.optional(Schema.Literals(["history", "compare-history", "ahead", "behind"])),
  skip: NonNegativeInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(50)),
});
export type VcsPanelBranchCommitsInput = typeof VcsPanelBranchCommitsInput.Type;

export const VcsPanelBranchCommitsResult = Schema.Struct({
  commits: Schema.Array(VcsPanelCommitSummary),
  remaining: NonNegativeInt,
});
export type VcsPanelBranchCommitsResult = typeof VcsPanelBranchCommitsResult.Type;

export const VcsPanelStashDetailsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  stashRef: TrimmedNonEmptyStringSchema,
});
export type VcsPanelStashDetailsInput = typeof VcsPanelStashDetailsInput.Type;

export const VcsPanelStashDetails = Schema.Struct({
  refName: TrimmedNonEmptyStringSchema,
  files: Schema.Array(VcsPanelFileChange),
});
export type VcsPanelStashDetails = typeof VcsPanelStashDetails.Type;

export const VcsPanelSnapshotInput = VcsStatusInput;
export type VcsPanelSnapshotInput = typeof VcsPanelSnapshotInput.Type;

export const VcsPanelSnapshotResult = Schema.Struct({
  status: VcsStatusResult,
  changeGroups: Schema.Array(VcsPanelChangeGroup),
  localBranches: Schema.Array(VcsRef),
  branchDetails: Schema.Array(VcsPanelBranchDetails),
  remotes: Schema.Array(VcsPanelRemote),
  actionableForkBranches: Schema.Array(VcsPanelActionableForkBranch),
  stashes: Schema.Array(VcsPanelStash),
  recentCommits: Schema.Array(VcsPanelCommitSummary),
  defaultCompareRef: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsPanelSnapshotResult = typeof VcsPanelSnapshotResult.Type;

export const VcsPanelFileActionInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  paths: Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
  staged: Schema.optional(Schema.Boolean),
});
export type VcsPanelFileActionInput = typeof VcsPanelFileActionInput.Type;

const VcsPanelFileDiffSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("working-tree"),
    staged: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("commit"),
    sha: TrimmedNonEmptyStringSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("compare"),
    baseRef: TrimmedNonEmptyStringSchema,
    refName: TrimmedNonEmptyStringSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("stash"),
    stashRef: TrimmedNonEmptyStringSchema,
  }),
]);

export const VcsPanelFileDiffInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  staged: Schema.optional(Schema.Boolean),
  source: Schema.optional(VcsPanelFileDiffSource),
});
export type VcsPanelFileDiffInput = typeof VcsPanelFileDiffInput.Type;

export const VcsPanelFileDiffResult = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  staged: Schema.Boolean,
  patch: Schema.String,
});
export type VcsPanelFileDiffResult = typeof VcsPanelFileDiffResult.Type;

export const VcsPanelCommitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  message: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000)),
  push: Schema.optional(Schema.Boolean),
});
export type VcsPanelCommitInput = typeof VcsPanelCommitInput.Type;

export const VcsPanelBranchActionInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branchName: TrimmedNonEmptyStringSchema,
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  force: Schema.optional(Schema.Boolean),
  merge: Schema.optional(Schema.Boolean),
});
export type VcsPanelBranchActionInput = typeof VcsPanelBranchActionInput.Type;

export const VcsPanelDeleteBranchInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: VcsRef,
  force: Schema.optional(Schema.Boolean),
});
export type VcsPanelDeleteBranchInput = typeof VcsPanelDeleteBranchInput.Type;

export const VcsPanelCommitActionInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  sha: TrimmedNonEmptyStringSchema,
  branchName: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type VcsPanelCommitActionInput = typeof VcsPanelCommitActionInput.Type;

export const VcsPanelUndoCommitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branchName: Schema.optional(TrimmedNonEmptyStringSchema),
  sha: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type VcsPanelUndoCommitInput = typeof VcsPanelUndoCommitInput.Type;

export const VcsPanelRefActionInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsPanelRefActionInput = typeof VcsPanelRefActionInput.Type;

export const VcsPanelRemoteInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  remoteName: TrimmedNonEmptyStringSchema,
});
export type VcsPanelRemoteInput = typeof VcsPanelRemoteInput.Type;

export const VcsPanelAddRemoteInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  name: TrimmedNonEmptyStringSchema,
  url: TrimmedNonEmptyStringSchema,
});
export type VcsPanelAddRemoteInput = typeof VcsPanelAddRemoteInput.Type;

export const VcsPanelStashInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  stashRef: Schema.optional(TrimmedNonEmptyStringSchema),
  message: Schema.optional(TrimmedNonEmptyStringSchema),
  includeUntracked: Schema.optional(Schema.Boolean),
  mode: Schema.optional(Schema.Literals(["all", "staged", "unstaged"])),
  paths: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1))),
});
export type VcsPanelStashInput = typeof VcsPanelStashInput.Type;

const VcsPanelCompareTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("working-tree") }),
  Schema.Struct({ kind: Schema.Literal("branch"), refName: TrimmedNonEmptyStringSchema }),
  Schema.Struct({ kind: Schema.Literal("stash"), refName: TrimmedNonEmptyStringSchema }),
]);

export const VcsPanelCompareInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  left: VcsPanelCompareTarget,
  right: VcsPanelCompareTarget,
});
export type VcsPanelCompareInput = typeof VcsPanelCompareInput.Type;

export const VcsPanelCompareResult = Schema.Struct({
  patch: Schema.String,
});
export type VcsPanelCompareResult = typeof VcsPanelCompareResult.Type;

// RPC / domain errors
export class GitCommandError extends Schema.TaggedErrorClass<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git command failed in ${this.operation}: ${this.command} (${this.cwd}) - ${this.detail}`;
  }
}

export class TextGenerationError extends Schema.TaggedErrorClass<TextGenerationError>()(
  "TextGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Text generation failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitManagerError extends Schema.TaggedErrorClass<GitManagerError>()("GitManagerError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git manager failed in ${this.operation}: ${this.detail}`;
  }
}

export const GitManagerServiceError = Schema.Union([
  GitManagerError,
  GitCommandError,
  SourceControlProviderError,
  TextGenerationError,
]);
export type GitManagerServiceError = typeof GitManagerServiceError.Type;

const GitActionProgressBase = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
});

const GitActionStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_started"),
  phases: Schema.Array(GitActionProgressPhase),
});
const GitActionPhaseStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("phase_started"),
  phase: GitActionProgressPhase,
  label: TrimmedNonEmptyStringSchema,
});
const GitActionHookStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_started"),
  hookName: TrimmedNonEmptyStringSchema,
});
const GitActionHookOutputEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_output"),
  hookName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  stream: GitActionProgressStream,
  text: TrimmedNonEmptyStringSchema,
});
const GitActionHookFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_finished"),
  hookName: TrimmedNonEmptyStringSchema,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(NonNegativeInt),
});
const GitActionFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_finished"),
  result: GitRunStackedActionResult,
});
const GitActionFailedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_failed"),
  phase: Schema.NullOr(GitActionProgressPhase),
  message: TrimmedNonEmptyStringSchema,
});

export const GitActionProgressEvent = Schema.Union([
  GitActionStartedEvent,
  GitActionPhaseStartedEvent,
  GitActionHookStartedEvent,
  GitActionHookOutputEvent,
  GitActionHookFinishedEvent,
  GitActionFinishedEvent,
  GitActionFailedEvent,
]);
export type GitActionProgressEvent = typeof GitActionProgressEvent.Type;
