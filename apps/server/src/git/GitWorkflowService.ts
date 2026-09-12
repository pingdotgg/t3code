import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  GitManagerError,
  GitCommandError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
  type VcsError,
} from "@t3tools/contracts";

import * as JjWorkflow from "../jj/JjWorkflow.ts";
import * as GitManager from "./GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

/**
 * The workflow surface every VCS kind implements. `GitWorkflowService` routes by kind; the Git and
 * Jujutsu implementations both satisfy this type, so a future change to a shared signature fails to
 * compile in both lanes instead of silently drifting in one.
 */
export interface VcsWorkflowOps {
  readonly status: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
  readonly localStatus: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
  readonly remoteStatus: (
    input: VcsStatusInput,
    options?: GitManager.GitRemoteStatusOptions,
  ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
  readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
  readonly runStackedAction: (
    input: GitRunStackedActionInput,
    options?: GitManager.GitRunStackedActionOptions,
  ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
  readonly resolvePullRequest: (
    input: GitPullRequestRefInput,
  ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
  readonly preparePullRequestThread: (
    input: GitPreparePullRequestThreadInput,
  ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
  readonly listRefs: (input: VcsListRefsInput) => Effect.Effect<VcsListRefsResult, GitCommandError>;
  readonly createWorktree: (
    input: VcsCreateWorktreeInput,
  ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
  readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
  readonly fetchRemote: (input: {
    readonly cwd: string;
    readonly remoteName: string;
  }) => Effect.Effect<void, GitCommandError>;
  readonly remoteExists: (input: {
    readonly cwd: string;
    readonly remoteName: string;
  }) => Effect.Effect<boolean, GitCommandError>;
  readonly remoteBranchExists: (input: {
    readonly cwd: string;
    readonly remoteName: string;
    readonly refName: string;
  }) => Effect.Effect<boolean, GitCommandError>;
  readonly resolveRemoteTrackingCommit: (input: {
    readonly cwd: string;
    readonly refName: string;
    readonly fallbackRemoteName: string;
  }) => Effect.Effect<
    { readonly commitSha: string; readonly remoteRefName: string },
    GitCommandError
  >;
  readonly removeWorktree: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
  readonly pruneWorktrees: (input: {
    readonly cwd: string;
  }) => Effect.Effect<void, GitCommandError>;
  readonly deleteLocalBranch: (
    input: GitVcsDriver.GitDeleteLocalBranchInput,
  ) => Effect.Effect<void, GitCommandError>;
  readonly createRef: (
    input: VcsCreateRefInput,
  ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
  readonly switchRef: (
    input: VcsSwitchRefInput,
  ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
  readonly renameBranch: (input: {
    readonly cwd: string;
    readonly oldBranch: string;
    readonly newBranch: string;
  }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
}

type WorkflowKind = "git" | "jj";

/** Routes every workflow call to the driver that owns the directory it names. */
export class GitWorkflowService extends Context.Service<GitWorkflowService, VcsWorkflowOps>()(
  "t3/git/GitWorkflowService",
) {}

function nonRepositoryLocalStatus(): VcsStatusLocalResult {
  return {
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

function nonRepositoryStatus(): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const jjWorkflow = yield* JjWorkflow.JjWorkflow;

  /**
   * The driver kind that owns a project cwd. `null` means "not a repository", which is what the
   * `nonRepository*` shapes already express, and an unknown kind degrades to it too. A detection
   * *failure* is a different thing and stays in the error channel: reporting a healthy repository
   * as absent hides the real reason from every caller and from the user.
   */
  const resolveWorkflowKind = (cwd: string): Effect.Effect<WorkflowKind | null, VcsError> =>
    registry
      .detect({ cwd })
      .pipe(
        Effect.map((handle) =>
          handle === null || handle.kind === "unknown" ? null : (handle.kind as WorkflowKind),
        ),
      );

  /**
   * The kind for an operation that names a workspace path as well as a project cwd. The path wins:
   * a Git worktree created before jj detection was enabled still lives inside a colocated jj
   * project and has to stay removable. A path that no longer exists, or that cannot be classified
   * at all, resolves to the project's kind so the thread can still be deregistered.
   */
  const resolveWorkspaceKind = (
    projectCwd: string,
    workspacePath: string,
  ): Effect.Effect<WorkflowKind | null, VcsError> =>
    resolveWorkflowKind(workspacePath).pipe(
      Effect.orElseSucceed(() => null),
      Effect.flatMap((kind) =>
        kind === null ? resolveWorkflowKind(projectCwd) : Effect.succeed(kind),
      ),
    );

  const notARepositoryCommand = (operation: string, cwd: string) =>
    Effect.fail(
      new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command found no version control repository here.`,
      }),
    );

  const notARepositoryWorkflow = (operation: string, cwd: string) =>
    Effect.fail(
      new GitManagerError({
        operation,
        cwd,
        detail: `The ${operation} workflow found no version control repository here. (${cwd})`,
      }),
    );

  const undetectableCommand = (operation: string, cwd: string) =>
    Effect.mapError(
      (cause: VcsError) =>
        new GitCommandError({
          operation,
          command: "vcs-route",
          cwd,
          detail: "Could not determine which version control system manages this directory.",
          cause,
        }),
    );

  const undetectableWorkflow = (operation: string, cwd: string) =>
    Effect.mapError(
      (cause: VcsError) =>
        new GitManagerError({
          operation,
          cwd,
          detail: `Could not determine which version control system manages this directory. (${cwd})`,
          cause,
        }),
    );

  const commandRouting = {
    kind: (operation: string, cwd: string) =>
      resolveWorkflowKind(cwd).pipe(undetectableCommand(operation, cwd)),
    notARepository: notARepositoryCommand,
  };

  const workflowRouting = {
    kind: (operation: string, cwd: string) =>
      resolveWorkflowKind(cwd).pipe(undetectableWorkflow(operation, cwd)),
    notARepository: notARepositoryWorkflow,
  };

  type Routing<Error> = {
    readonly kind: (operation: string, cwd: string) => Effect.Effect<WorkflowKind | null, Error>;
    readonly notARepository: (operation: string, cwd: string) => Effect.Effect<never, Error>;
  };

  type RouteArms<Input, Output, Error> = {
    readonly git: (input: Input) => Effect.Effect<Output, Error>;
    readonly jj: (input: Input) => Effect.Effect<Output, Error>;
  };

  /** Routes on the project cwd; `fallback` answers for a directory that is not a repository. */
  const routeOr =
    <Input extends { readonly cwd: string }, Output, Error>(
      operation: string,
      routing: Routing<Error>,
      fallback: (operation: string, cwd: string) => Effect.Effect<Output, Error>,
      arms: RouteArms<Input, Output, Error>,
    ) =>
    (input: Input) =>
      routing
        .kind(operation, input.cwd)
        .pipe(
          Effect.flatMap((kind) =>
            kind === null ? fallback(operation, input.cwd) : arms[kind](input),
          ),
        );

  /** Routes on the project cwd, failing when the directory is not a repository at all. */
  const route = <Input extends { readonly cwd: string }, Output, Error>(
    operation: string,
    routing: Routing<Error>,
    arms: RouteArms<Input, Output, Error>,
  ) => routeOr<Input, Output, Error>(operation, routing, routing.notARepository, arms);

  return GitWorkflowService.of({
    status: routeOr(
      "GitWorkflowService.status",
      workflowRouting,
      () => Effect.succeed(nonRepositoryStatus()),
      { git: gitManager.status, jj: jjWorkflow.status },
    ),
    localStatus: routeOr(
      "GitWorkflowService.localStatus",
      workflowRouting,
      () => Effect.succeed(nonRepositoryLocalStatus()),
      { git: gitManager.localStatus, jj: jjWorkflow.localStatus },
    ),
    remoteStatus: (input, options) =>
      routeOr("GitWorkflowService.remoteStatus", workflowRouting, () => Effect.succeed(null), {
        git: (statusInput: VcsStatusInput) => gitManager.remoteStatus(statusInput, options),
        jj: (statusInput: VcsStatusInput) => jjWorkflow.remoteStatus(statusInput, options),
      })(input),
    // Pure cache drops with no error channel: resolving the kind first would cost a detect on a
    // hot path for no benefit.
    invalidateLocalStatus: (cwd) =>
      Effect.all([gitManager.invalidateLocalStatus(cwd), jjWorkflow.invalidateLocalStatus(cwd)], {
        discard: true,
      }),
    invalidateRemoteStatus: (cwd) =>
      Effect.all([gitManager.invalidateRemoteStatus(cwd), jjWorkflow.invalidateRemoteStatus(cwd)], {
        discard: true,
      }),
    invalidateStatus: (cwd) =>
      Effect.all([gitManager.invalidateStatus(cwd), jjWorkflow.invalidateStatus(cwd)], {
        discard: true,
      }),
    pullCurrentBranch: (cwd) =>
      route("GitWorkflowService.pullCurrentBranch", commandRouting, {
        git: () => git.pullCurrentBranch(cwd),
        jj: () => jjWorkflow.pullCurrentBranch(cwd),
      })({ cwd }),
    runStackedAction: (input, options) =>
      route("GitWorkflowService.runStackedAction", workflowRouting, {
        git: (actionInput: GitRunStackedActionInput) =>
          gitManager.runStackedAction(actionInput, options),
        jj: (actionInput: GitRunStackedActionInput) =>
          jjWorkflow.runStackedAction(actionInput, options),
      })(input),
    resolvePullRequest: route("GitWorkflowService.resolvePullRequest", workflowRouting, {
      git: gitManager.resolvePullRequest,
      jj: jjWorkflow.resolvePullRequest,
    }),
    preparePullRequestThread: route(
      "GitWorkflowService.preparePullRequestThread",
      workflowRouting,
      {
        git: gitManager.preparePullRequestThread,
        jj: jjWorkflow.preparePullRequestThread,
      },
    ),
    listRefs: routeOr(
      "GitWorkflowService.listRefs",
      commandRouting,
      () => Effect.succeed(nonRepositoryListRefs()),
      { git: git.listRefs, jj: jjWorkflow.listRefs },
    ),
    createWorktree: route("GitWorkflowService.createWorktree", commandRouting, {
      git: git.createWorktree,
      jj: jjWorkflow.createWorktree,
    }),
    listLocalBranchNames: (cwd) =>
      route("GitWorkflowService.listLocalBranchNames", commandRouting, {
        git: () => git.listLocalBranchNames(cwd),
        jj: () => jjWorkflow.listLocalBranchNames(cwd),
      })({ cwd }),
    fetchRemote: route("GitWorkflowService.fetchRemote", commandRouting, {
      git: git.fetchRemote,
      jj: jjWorkflow.fetchRemote,
    }),
    remoteExists: route("GitWorkflowService.remoteExists", commandRouting, {
      git: git.remoteExists,
      jj: jjWorkflow.remoteExists,
    }),
    remoteBranchExists: route("GitWorkflowService.remoteBranchExists", commandRouting, {
      git: git.remoteBranchExists,
      jj: jjWorkflow.remoteBranchExists,
    }),
    resolveRemoteTrackingCommit: route(
      "GitWorkflowService.resolveRemoteTrackingCommit",
      commandRouting,
      {
        git: git.resolveRemoteTrackingCommit,
        jj: jjWorkflow.resolveRemoteTrackingCommit,
      },
    ),
    // Dispatched on the workspace path, not the project: a Git worktree inside a colocated jj
    // project must keep being removable after the detection flip.
    removeWorktree: (input) =>
      resolveWorkspaceKind(input.cwd, input.path).pipe(
        undetectableCommand("GitWorkflowService.removeWorktree", input.cwd),
        Effect.flatMap((kind) =>
          kind === null
            ? notARepositoryCommand("GitWorkflowService.removeWorktree", input.cwd)
            : kind === "git"
              ? git.removeWorktree(input)
              : jjWorkflow.removeWorktree(input),
        ),
      ),
    pruneWorktrees: route("GitWorkflowService.pruneWorktrees", commandRouting, {
      git: git.pruneWorktrees,
      jj: jjWorkflow.pruneWorktrees,
    }),
    deleteLocalBranch: route("GitWorkflowService.deleteLocalBranch", commandRouting, {
      git: git.deleteLocalBranch,
      jj: jjWorkflow.deleteLocalBranch,
    }),
    createRef: route("GitWorkflowService.createRef", commandRouting, {
      git: git.createRef,
      jj: jjWorkflow.createRef,
    }),
    // The Git driver's `switchRef` needs a `Scope` the service closes locally; the declared type
    // carries none, and leaking it would reach every caller. The jj arm needs no scope.
    switchRef: route("GitWorkflowService.switchRef", commandRouting, {
      git: (input) => Effect.scoped(git.switchRef(input)),
      jj: jjWorkflow.switchRef,
    }),
    renameBranch: route("GitWorkflowService.renameBranch", workflowRouting, {
      git: git.renameBranch,
      jj: jjWorkflow.renameBranch,
    }),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
