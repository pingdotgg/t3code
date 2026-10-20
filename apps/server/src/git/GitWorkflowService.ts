import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";

import {
  GitManagerError,
  GitCommandError,
  VcsUnsupportedOperationError,
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
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

/**
 * The workflow surface every VCS kind implements. `GitWorkflowService` routes by kind; the Git and
 * Jujutsu implementations both satisfy this type, so a future change to a shared signature fails to
 * compile in both lanes instead of silently drifting in one.
 */
export interface VcsWorkflowOps {
  readonly hasCommit: (input: {
    readonly cwd: string;
    readonly refName: string;
  }) => Effect.Effect<boolean, GitCommandError>;
  readonly hasRefNamed: (input: {
    readonly cwd: string;
    readonly refName: string;
  }) => Effect.Effect<boolean, GitCommandError>;
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
    options?: GitVcsDriver.CreateWorktreeOptions,
  ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
  readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
  readonly fetchRemote: (input: {
    readonly cwd: string;
    readonly remoteName: string;
    readonly refName?: string;
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
  readonly resolveWorktreeBaseRemote: GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"];
  readonly fetchWorktreeBaseCommit: (input: {
    readonly cwd: string;
    readonly refName: string;
  }) => Effect.Effect<
    { readonly commitSha: string; readonly remoteRefName: string } | null,
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
    readonly exactName?: boolean;
    readonly cwd: string;
    readonly oldBranch: string;
    readonly newBranch: string;
  }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
}

type WorkflowKind = "git" | "jj";

/** Routes every workflow call to the driver that owns the directory it names. */
export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  VcsWorkflowOps & {
    /** Whether this service supports the repository containing the supplied path. */
    readonly isRepository: (cwd: string) => Effect.Effect<boolean, GitManagerServiceError>;
    readonly providerCwd: (cwd: string) => Effect.Effect<string, GitManagerServiceError>;
    readonly committedBase: (cwd: string) => Effect.Effect<string | null, GitCommandError>;
    readonly listWorkspacePaths: (
      cwd: string,
    ) => Effect.Effect<ReadonlyArray<string>, GitCommandError>;
    readonly currentRefName: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
    readonly validateWorkspace: (
      projectCwd: string,
      workspacePath: string | null,
    ) => Effect.Effect<boolean, GitManagerServiceError>;
  }
>()("t3/git/GitWorkflowService") {}

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

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const fileSystem = yield* FileSystem.FileSystem;

  // Nested projects and path aliases must share the checkout's branch-mutation lease.
  const withCheckoutLease = <A, E, R>(rootPath: string, effect: Effect.Effect<A, E, R>) =>
    fileSystem.realPath(rootPath).pipe(
      Effect.orElseSucceed(() => rootPath),
      Effect.flatMap((cwd) => withWorkspaceLease(cwd, effect)),
    );

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to resolve the VCS driver for this Git workflow.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitManagerError({
        operation,
        cwd,
        detail: `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}. (${cwd})`,
      });
    }
    return handle;
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      });
    }
    return handle;
  });

  const jjWorkflow = yield* JjWorkflow.JjWorkflow;
  const jj = yield* JjVcsDriver.JjVcsDriver;

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
        Effect.map((handle) => (handle === null || handle.kind === "unknown" ? null : handle.kind)),
      );

  /**
   * Only jj projects need the workspace path classified: an older Git worktree inside a
   * colocated jj project must remain removable. Non-jj projects keep their project's kind.
   * An unclassified workspace falls back to jj; classification errors still propagate.
   */
  const resolveWorkspaceKind = (
    projectCwd: string,
    workspacePath: string,
  ): Effect.Effect<WorkflowKind | null, VcsError> =>
    Effect.gen(function* () {
      const projectKind = yield* resolveWorkflowKind(projectCwd);
      if (projectKind !== "jj") return projectKind;
      return yield* resolveWorkflowKind(workspacePath).pipe(Effect.map((kind) => kind ?? "jj"));
    });

  const missingRepositoryCause = (cwd: string) =>
    new VcsUnsupportedOperationError({
      operation: "VcsDriverRegistry.resolve",
      kind: "unknown",
      detail: `No supported VCS repository was detected at ${cwd}.`,
    });

  const notARepositoryCommand = (operation: string, cwd: string) =>
    Effect.fail(
      new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: "Failed to resolve the VCS driver for this Git command.",
        cause: missingRepositoryCause(cwd),
      }),
    );

  const notARepositoryWorkflow = (operation: string, cwd: string) =>
    Effect.fail(
      new GitManagerError({
        operation,
        cwd,
        detail: "Failed to resolve the VCS driver for this Git workflow.",
        cause: missingRepositoryCause(cwd),
      }),
    );

  const undetectableCommand = (operation: string, cwd: string, detecting = false) =>
    Effect.mapError(
      (cause: VcsError) =>
        new GitCommandError({
          operation,
          command: "vcs-route",
          cwd,
          detail: detecting
            ? "Failed to detect a VCS repository for this Git command."
            : "Failed to resolve the VCS driver for this Git command.",
          cause,
        }),
    );

  const undetectableWorkflow = (operation: string, cwd: string, detecting = false) =>
    Effect.mapError(
      (cause: VcsError) =>
        new GitManagerError({
          operation,
          cwd,
          detail: detecting
            ? "Failed to detect a VCS repository for this Git workflow."
            : "Failed to resolve the VCS driver for this Git workflow.",
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
  const statusRouting = {
    ...workflowRouting,
    kind: (operation: string, cwd: string) =>
      resolveWorkflowKind(cwd).pipe(undetectableWorkflow(operation, cwd, true)),
  };

  const refsRouting = {
    ...commandRouting,
    kind: (operation: string, cwd: string) =>
      resolveWorkflowKind(cwd).pipe(undetectableCommand(operation, cwd, true)),
  };

  // Existing Git paths must remain usable when repository detection is unavailable.
  const detectForFacade = (cwd: string) =>
    registry.detect({ cwd, jjOnly: true }).pipe(Effect.orElseSucceed(() => null));

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

  const invalidate =
    (method: "invalidateLocalStatus" | "invalidateRemoteStatus" | "invalidateStatus") =>
    (cwd: string): Effect.Effect<void> =>
      detectForFacade(cwd).pipe(
        Effect.flatMap((handle) => (handle?.kind === "jj" ? jjWorkflow : gitManager)[method](cwd)),
      );

  return GitWorkflowService.of({
    providerCwd: (cwd) =>
      detectForFacade(cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "jj"
            ? jj.ensureUsable("GitWorkflowService.providerCwd", cwd).pipe(
                Effect.map((paths) => paths.mainWorkspaceRoot),
                Effect.mapError(
                  (cause) =>
                    new GitManagerError({
                      operation: "GitWorkflowService.providerCwd",
                      cwd,
                      detail: "Failed to resolve the provider working directory.",
                      cause,
                    }),
                ),
              )
            : Effect.succeed(cwd),
        ),
      ),
    committedBase: (cwd) =>
      detectForFacade(cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "jj"
            ? jj.changeAt(cwd, "@-").pipe(
                Effect.map((change) => change?.commitId ?? null),
                Effect.mapError(
                  (cause) =>
                    new GitCommandError({
                      operation: "GitWorkflowService.committedBase",
                      command: "jj log",
                      cwd,
                      detail: "Failed to resolve the committed base.",
                      cause,
                    }),
                ),
              )
            : git
                .resolveCommit({ cwd, revision: "HEAD" })
                .pipe(Effect.map((commit) => commit.commitSha)),
        ),
      ),
    listWorkspacePaths: (cwd) =>
      detectForFacade(cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "jj"
            ? Effect.gen(function* () {
                const workspaces = yield* jj.listWorkspaces(cwd).pipe(
                  Effect.mapError(
                    (cause) =>
                      new GitCommandError({
                        operation: "GitWorkflowService.listWorkspacePaths",
                        command: "jj workspace list",
                        cwd,
                        detail: "Failed to list workspace paths.",
                        cause,
                      }),
                  ),
                );
                const gitPaths = yield* git
                  .listWorktreePaths(cwd)
                  .pipe(Effect.orElseSucceed(() => []));
                return [
                  ...new Set([...workspaces.map((workspace) => workspace.root), ...gitPaths]),
                ];
              })
            : git.listWorktreePaths(cwd).pipe(Effect.orElseSucceed(() => [])),
        ),
      ),
    currentRefName: (cwd) =>
      detectForFacade(cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "jj"
            ? jjWorkflow.localStatus({ cwd }).pipe(Effect.map((status) => status.refName))
            : git.resolveBranchName(cwd, "HEAD"),
        ),
      ),
    validateWorkspace: (projectCwd, workspacePath) =>
      registry.detect({ cwd: projectCwd, jjOnly: true }).pipe(
        undetectableWorkflow("GitWorkflowService.validateWorkspace", projectCwd, true),
        Effect.flatMap((project) => {
          if (project?.kind !== "jj") return Effect.succeed(true);
          if (workspacePath === null) return Effect.succeed(false);
          return registry.detect({ cwd: workspacePath, jjOnly: true }).pipe(
            undetectableWorkflow("GitWorkflowService.validateWorkspace", workspacePath, true),
            Effect.map(
              (workspace) =>
                workspace?.kind === "jj" &&
                workspace.repository.rootPath !== project.repository.rootPath,
            ),
          );
        }),
      ),
    isRepository: (cwd) =>
      resolveWorkflowKind(cwd).pipe(
        Effect.map((kind) => kind !== null),
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.isRepository",
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      ),
    hasCommit: route("GitWorkflowService.hasCommit", commandRouting, {
      git: (input: { readonly cwd: string; readonly refName: string }) =>
        git
          .execute({
            operation: "GitWorkflowService.hasCommit",
            cwd: input.cwd,
            args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
            allowNonZeroExit: true,
          })
          .pipe(Effect.map((result) => result.exitCode === 0)),
      jj: jjWorkflow.hasCommit,
    }),
    hasRefNamed: (input) =>
      // No ref name holds a pattern character, and one here would widen the match.
      /[*?[\\]/.test(input.refName)
        ? Effect.succeed(false)
        : route("GitWorkflowService.hasRefNamed", commandRouting, {
            git: (refInput: { readonly cwd: string; readonly refName: string }) =>
              git
                .execute({
                  operation: "GitWorkflowService.hasRefNamed",
                  cwd: refInput.cwd,
                  args: [
                    "for-each-ref",
                    "--count=1",
                    "--format=%(refname)",
                    `refs/**/${refInput.refName}`,
                  ],
                })
                .pipe(Effect.map((result) => result.stdout.trim().length > 0)),
            jj: jjWorkflow.hasRefNamed,
          })(input),
    status: routeOr(
      "GitWorkflowService.status",
      statusRouting,
      () => Effect.succeed(nonRepositoryStatus()),
      { git: gitManager.status, jj: jjWorkflow.status },
    ),
    localStatus: routeOr(
      "GitWorkflowService.localStatus",
      statusRouting,
      () => Effect.succeed(nonRepositoryLocalStatus()),
      { git: gitManager.localStatus, jj: jjWorkflow.localStatus },
    ),
    remoteStatus: (input, options) =>
      routeOr("GitWorkflowService.remoteStatus", statusRouting, () => Effect.succeed(null), {
        git: (statusInput: VcsStatusInput) => gitManager.remoteStatus(statusInput, options),
        jj: (statusInput: VcsStatusInput) => jjWorkflow.remoteStatus(statusInput, options),
      })(input),
    invalidateLocalStatus: invalidate("invalidateLocalStatus"),
    invalidateRemoteStatus: invalidate("invalidateRemoteStatus"),
    invalidateStatus: invalidate("invalidateStatus"),
    pullCurrentBranch: (cwd) =>
      route("GitWorkflowService.pullCurrentBranch", commandRouting, {
        git: () => git.pullCurrentBranch(cwd),
        jj: () => jjWorkflow.pullCurrentBranch(cwd),
      })({ cwd }),
    runStackedAction: (input, options) =>
      route("GitWorkflowService.runStackedAction", workflowRouting, {
        git: (actionInput: GitRunStackedActionInput) =>
          actionInput.featureBranch
            ? ensureGit("GitWorkflowService.runStackedAction", actionInput.cwd).pipe(
                Effect.flatMap((handle) =>
                  withCheckoutLease(
                    handle.repository.rootPath,
                    gitManager.runStackedAction(actionInput, options),
                  ),
                ),
              )
            : gitManager.runStackedAction(actionInput, options),
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
        git: (input) =>
          input.mode === "local"
            ? ensureGit("GitWorkflowService.preparePullRequestThread", input.cwd).pipe(
                Effect.flatMap((handle) =>
                  withCheckoutLease(
                    handle.repository.rootPath,
                    gitManager.preparePullRequestThread(input),
                  ),
                ),
              )
            : gitManager.preparePullRequestThread(input),
        jj: jjWorkflow.preparePullRequestThread,
      },
    ),
    listRefs: routeOr(
      "GitWorkflowService.listRefs",
      refsRouting,
      () => Effect.succeed(nonRepositoryListRefs()),
      { git: git.listRefs, jj: jjWorkflow.listRefs },
    ),
    createWorktree: (input, options) =>
      route("GitWorkflowService.createWorktree", commandRouting, {
        git: (worktreeInput: VcsCreateWorktreeInput) =>
          gitManager.createWorktree(worktreeInput, options),
        jj: (worktreeInput: VcsCreateWorktreeInput) =>
          jjWorkflow.createWorktree(worktreeInput, options),
      })(input),
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
    resolveWorktreeBaseRemote: route(
      "GitWorkflowService.resolveWorktreeBaseRemote",
      commandRouting,
      {
        git: (input) =>
          ensureGitCommand("GitWorkflowService.resolveWorktreeBaseRemote", input.cwd).pipe(
            Effect.andThen(git.resolveWorktreeBaseRemote(input)),
          ),
        jj: jjWorkflow.resolveWorktreeBaseRemote,
      },
    ),
    fetchWorktreeBaseCommit: route(
      "GitWorkflowService.fetchWorktreeBaseCommit",
      commandRouting,
      {
        git: (input) =>
          ensureGitCommand("GitWorkflowService.fetchWorktreeBaseCommit", input.cwd).pipe(
            Effect.andThen(git.fetchWorktreeBaseCommit(input)),
          ),
        jj: jjWorkflow.fetchWorktreeBaseCommit,
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
      git: (input) =>
        input.switchRef
          ? ensureGitCommand("GitWorkflowService.createRef", input.cwd).pipe(
              Effect.flatMap((handle) =>
                withCheckoutLease(handle.repository.rootPath, git.createRef(input)),
              ),
            )
          : git.createRef(input),
      jj: jjWorkflow.createRef,
    }),
    // The Git driver's `switchRef` needs a `Scope` the service closes locally; the declared type
    // carries none, and leaking it would reach every caller. The jj arm needs no scope.
    switchRef: route("GitWorkflowService.switchRef", commandRouting, {
      git: (input) =>
        ensureGitCommand("GitWorkflowService.switchRef", input.cwd).pipe(
          Effect.flatMap((handle) =>
            withCheckoutLease(handle.repository.rootPath, Effect.scoped(git.switchRef(input))),
          ),
        ),
      jj: jjWorkflow.switchRef,
    }),
    renameBranch: route("GitWorkflowService.renameBranch", workflowRouting, {
      git: git.renameBranch,
      jj: jjWorkflow.renameBranch,
    }),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
