import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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
import { ServerSettingsService } from "../serverSettings.ts";
import { makeWorkspaceOwnership, type WorkspaceKind } from "../vcs/WorkspaceOwnership.ts";
import { workspaceNameForRef } from "../jj/JjWorkspaceNaming.ts";
import { workspaceSettings, makeWorkspaceQueries } from "../project/WorkspaceSettings.ts";
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
  readonly status: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
  readonly localStatus: (
    input: VcsStatusInput,
    options?: GitManager.GitLocalStatusOptions,
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
  readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
  readonly resolveRemoteTrackingCommit: (input: {
    readonly cwd: string;
    readonly refName: string;
    readonly fallbackRemoteName: string;
  }) => Effect.Effect<
    { readonly commitSha: string; readonly remoteRefName: string },
    GitCommandError
  >;
  readonly resolveWorktreeBaseRemote: GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"];
  readonly fetchWorktreeBaseCommit: GitVcsDriver.GitVcsDriver["Service"]["fetchWorktreeBaseCommit"];
  readonly removeWorktree: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
  readonly pruneWorktrees: (input: {
    readonly cwd: string;
  }) => Effect.Effect<void, GitCommandError>;
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

export class WorktreeRecreateNoBaseError extends Schema.TaggedError<WorktreeRecreateNoBaseError>()(
  "WorktreeRecreateNoBaseError",
  { worktreePath: Schema.String, branch: Schema.String },
) {
  override get message(): string {
    return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no commit to start it from.`;
  }
}

const isGitCommandError = Schema.is(GitCommandError);
const isWorktreeRecreateNoBaseError = Schema.is(WorktreeRecreateNoBaseError);

/** Routes every workflow call to the driver that owns the directory it names. */
export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  VcsWorkflowOps & {
    readonly repositoryRoot: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
    /**
     * Whether a ref in any namespace ends in this name: a local branch, a
     * remote-tracking branch of any remote, a tag. Git falls back to these
     * when a branch name is not a revision by itself.
     */
    readonly hasRefNamed: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    /** The checkout's own HEAD file, inside a linked worktree's admin directory when there is one. */
    readonly headPath: (cwd: string) => Effect.Effect<string | null, never>;
    readonly upstreamDivergence: (cwd: string) => Effect.Effect<
      {
        readonly refName: string;
        readonly aheadCount: number;
        readonly behindCount: number;
      } | null,
      GitManagerServiceError
    >;
    readonly readRefSnapshot: (cwd: string) => Effect.Effect<string | null>;
    readonly resolveDefaultBranchName: (
      cwd: string,
      remoteName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitVcsDriver.GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly ensureWorkspace: (
      input: VcsCreateWorktreeInput & { readonly path: string },
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<void, GitCommandError | WorktreeRecreateNoBaseError>;
    readonly currentBranch: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
    readonly branchPullRequest: GitManager.GitManager["Service"]["branchPullRequest"];
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
  const withWorkspaceQueries = yield* makeWorkspaceQueries;
  const settingsService = yield* ServerSettingsService;
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const jjWorkflow = yield* JjWorkflow.JjWorkflow;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ownership = makeWorkspaceOwnership({ fileSystem, path, execute: git.execute });
  const workspaceOps = { git, jj: jjWorkflow };
  const workspaceCreators = { git: gitManager, jj: jjWorkflow };

  // Nested projects and path aliases must share the checkout's branch-mutation lease.
  const withCheckoutLease = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "GitWorkflowService.withCheckoutLease",
            command: "vcs-route",
            cwd,
            detail: "Could not resolve the checkout for a branch mutation.",
            cause,
          }),
      ),
      Effect.flatMap((handle) =>
        fileSystem.realPath(handle.repository.rootPath).pipe(
          Effect.orElseSucceed(() => handle.repository.rootPath),
          Effect.flatMap((rootPath) => withWorkspaceLease(rootPath, effect)),
        ),
      ),
    );

  const commandFailure = (operation: string, cwd: string) =>
    Effect.mapError((cause) =>
      isGitCommandError(cause)
        ? cause
        : new GitCommandError({
            operation,
            command: "vcs",
            cwd,
            detail: "The workspace operation failed.",
            cause,
          }),
    );

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
          handle?.kind === "git" || handle?.kind === "jj" ? handle.kind : null,
        ),
      );

  const resolveWorkspaceKind = Effect.fn("GitWorkflowService.resolveWorkspaceKind")(
    function* (input: { readonly cwd: string; readonly path: string; readonly refName?: string }) {
      const detected = yield* resolveWorkflowKind(input.path);
      if (detected !== null) return detected;
      const remembered = yield* ownership.read(input);
      if (remembered !== null) return remembered;
      const repositoryCwd = yield* ownership.repositoryCwd(input.cwd);
      const registered = yield* git.execute({
        operation: "GitWorkflowService.registeredWorkspaces",
        cwd: repositoryCwd,
        args: ["worktree", "list", "--porcelain", "-z"],
      });
      const normalized = yield* ownership.normalize(input.path);
      for (const row of registered.stdout.split("\0")) {
        if (
          row.startsWith("worktree ") &&
          (yield* ownership.normalize(row.slice(9))) === normalized
        )
          return "git" as const;
      }
      if ((yield* resolveWorkflowKind(input.cwd)) === "jj") {
        const workspaces = yield* jjWorkflow.registeredWorkspaces(input.cwd);
        for (const workspace of workspaces) {
          if (
            workspace.root !== null &&
            (yield* ownership.normalize(workspace.root)) === normalized
          )
            return "jj" as const;
          if (
            workspace.root === null &&
            input.refName !== undefined &&
            workspace.name === workspaceNameForRef(input.refName)
          )
            return "jj" as const;
        }
      }
      return yield* new GitCommandError({
        operation: "GitWorkflowService.resolveWorkspaceKind",
        command: "vcs",
        cwd: input.cwd,
        detail: `The original VCS owner of ${input.path} is unavailable. Restore its registration before resuming.`,
      });
    },
  );

  const createWorkspaceWithKind = Effect.fn("GitWorkflowService.createWorkspaceWithKind")(
    function* (
      kind: WorkspaceKind,
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) {
      const { settings } = yield* workspaceSettings(input).pipe(
        withWorkspaceQueries,
        Effect.provideService(ServerSettingsService, settingsService),
      );
      const result = yield* workspaceCreators[kind].createWorktree(input, {
        ...options,
        worktreesDirectory: options?.worktreesDirectory ?? settings.worktreesDirectory,
        projectFolders: options?.projectFolders ?? settings.worktreeProjectFolders,
        submodules: options?.submodules ?? settings.worktreeSubmodules,
      });
      yield* ownership.remember({ cwd: input.cwd, path: result.worktree.path, kind });
      return result;
    },
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

  const readGitBranch = Effect.fn("GitWorkflowService.currentBranch")(function* (cwd: string) {
    const result = yield* git.execute({
      operation: "GitWorkflowService.currentBranch",
      cwd,
      args: ["symbolic-ref", "--quiet", "HEAD"],
      allowNonZeroExit: true,
      timeoutMs: 5_000,
    });
    if (result.exitCode === 0) return result.stdout.trim().replace(/^refs\/heads\//, "") || null;
    if (result.exitCode === 1) return null;
    return yield* new GitCommandError({
      operation: "GitWorkflowService.currentBranch",
      command: "git symbolic-ref",
      cwd,
      argumentCount: 3,
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
      detail: "Failed to read the checked-out branch.",
    });
  });

  const hasGitCommit = (cwd: string, refName: string): Effect.Effect<boolean, GitCommandError> =>
    git
      .execute({
        operation: "GitWorkflowService.hasCommit",
        cwd,
        args: ["rev-parse", "--verify", `${refName}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.exitCode === 0));

  const recoverGitWorkspace = Effect.fn("GitWorkflowService.recoverGitWorkspace")(function* (
    input: VcsCreateWorktreeInput & { readonly path: string },
    options?: GitVcsDriver.CreateWorktreeOptions,
  ) {
    const { cwd, refName: branch } = input;
    if ((yield* git.listLocalBranchNames(cwd)).includes(branch)) {
      yield* createWorkspaceWithKind("git", input, options);
      return;
    }
    const remoteName = yield* git
      .resolvePrimaryRemoteName(cwd)
      .pipe(Effect.orElseSucceed(() => null));
    const pushedRef = remoteName === null ? null : `refs/remotes/${remoteName}/${branch}`;
    if (pushedRef !== null && (yield* hasGitCommit(cwd, pushedRef))) {
      yield* createWorkspaceWithKind(
        "git",
        { ...input, refName: pushedRef, newRefName: branch },
        options,
      );
      return;
    }
    const currentBranch = yield* readGitBranch(cwd);
    if (currentBranch !== null) {
      const baseRefName = `refs/heads/${currentBranch}`;
      yield* createWorkspaceWithKind(
        "git",
        { ...input, refName: baseRefName, baseRefName, newRefName: branch },
        options,
      );
      return;
    }
    const remoteHead = `refs/remotes/${remoteName}/HEAD`;
    if (remoteName !== null && (yield* hasGitCommit(cwd, remoteHead))) {
      const { commitSha } = yield* git.resolveRemoteTrackingCommit({
        cwd,
        refName: "HEAD",
        fallbackRemoteName: remoteName,
      });
      yield* createWorkspaceWithKind(
        "git",
        {
          ...input,
          refName: commitSha,
          baseRefName: remoteHead,
          newRefName: branch,
        },
        options,
      );
      return;
    }
    if (yield* hasGitCommit(cwd, "HEAD")) {
      yield* createWorkspaceWithKind(
        "git",
        { ...input, refName: "HEAD", newRefName: branch },
        options,
      );
      return;
    }
    return yield* new WorktreeRecreateNoBaseError({ worktreePath: input.path, branch });
  });

  return GitWorkflowService.of({
    repositoryRoot: Effect.fn("GitWorkflowService.repositoryRoot")((cwd) =>
      registry.detect({ cwd }).pipe(
        Effect.map((handle) =>
          handle !== null && handle.kind !== "unknown" ? handle.repository.rootPath : null,
        ),
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.repositoryRoot",
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
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
    status: routeOr(
      "GitWorkflowService.status",
      workflowRouting,
      () => Effect.succeed(nonRepositoryStatus()),
      { git: gitManager.status, jj: jjWorkflow.status },
    ),
    localStatus: Effect.fn("GitWorkflowService.localStatus")((input, options) =>
      routeOr(
        "GitWorkflowService.localStatus",
        workflowRouting,
        () => Effect.succeed(nonRepositoryLocalStatus()),
        {
          git: (request: VcsStatusInput) => gitManager.localStatus(request, options),
          jj: jjWorkflow.localStatus,
        },
      )(input),
    ),
    readRefSnapshot: Effect.fn("GitWorkflowService.readRefSnapshot")((cwd) =>
      resolveWorkflowKind(cwd).pipe(
        Effect.flatMap((kind) =>
          kind === "git" ? git.readRefSnapshot(cwd) : Effect.succeed(null),
        ),
        Effect.orElseSucceed(() => null),
      ),
    ),
    resolveDefaultBranchName: Effect.fn("GitWorkflowService.resolveDefaultBranchName")(
      (cwd, remoteName) =>
        ownership.repositoryCwd(cwd).pipe(
          Effect.flatMap((repositoryCwd) =>
            git.resolveDefaultBranchName(repositoryCwd, remoteName),
          ),
          commandFailure("GitWorkflowService.resolveDefaultBranchName", cwd),
        ),
    ),
    currentBranch: Effect.fn("GitWorkflowService.currentBranch")((cwd) =>
      routeOr<{ readonly cwd: string }, string | null, GitManagerServiceError>(
        "GitWorkflowService.currentBranch",
        workflowRouting,
        () => Effect.succeed(null),
        {
          git: () => readGitBranch(cwd),
          jj: () => jjWorkflow.currentRefName(cwd),
        },
      )({ cwd }),
    ),
    hasRefNamed: Effect.fn("GitWorkflowService.hasRefNamed")((input) =>
      // No ref name holds a pattern character, and one here would widen the match.
      /[*?[\\]/.test(input.refName)
        ? Effect.succeed(false)
        : route("GitWorkflowService.hasRefNamed", commandRouting, {
            git: () =>
              git
                .execute({
                  operation: "GitWorkflowService.hasRefNamed",
                  cwd: input.cwd,
                  args: [
                    "for-each-ref",
                    "--count=1",
                    "--format=%(refname)",
                    `refs/**/${input.refName}`,
                  ],
                })
                .pipe(Effect.map((result) => result.stdout.trim().length > 0)),
            jj: () => jjWorkflow.hasCommit(input),
          })(input),
    ),
    remoteStatus: Effect.fn("GitWorkflowService.remoteStatus")((input, options) =>
      routeOr("GitWorkflowService.remoteStatus", workflowRouting, () => Effect.succeed(null), {
        git: (statusInput: VcsStatusInput) => gitManager.remoteStatus(statusInput, options),
        jj: (statusInput: VcsStatusInput) => jjWorkflow.remoteStatus(statusInput, options),
      })(input),
    ),
    // Pure cache drops with no error channel: resolving the kind first would cost a detect on a
    // hot path for no benefit.
    invalidateLocalStatus: Effect.fn("GitWorkflowService.invalidateLocalStatus")((cwd) =>
      Effect.all([gitManager.invalidateLocalStatus(cwd), jjWorkflow.invalidateLocalStatus(cwd)], {
        discard: true,
      }),
    ),
    invalidateRemoteStatus: Effect.fn("GitWorkflowService.invalidateRemoteStatus")((cwd) =>
      Effect.all([gitManager.invalidateRemoteStatus(cwd), jjWorkflow.invalidateRemoteStatus(cwd)], {
        discard: true,
      }),
    ),
    invalidateStatus: Effect.fn("GitWorkflowService.invalidateStatus")((cwd) =>
      Effect.all([gitManager.invalidateStatus(cwd), jjWorkflow.invalidateStatus(cwd)], {
        discard: true,
      }),
    ),
    pullCurrentBranch: Effect.fn("GitWorkflowService.pullCurrentBranch")((cwd) =>
      route("GitWorkflowService.pullCurrentBranch", commandRouting, {
        git: () => git.pullCurrentBranch(cwd),
        jj: () => jjWorkflow.pullCurrentBranch(cwd),
      })({ cwd }),
    ),
    runStackedAction: Effect.fn("GitWorkflowService.runStackedAction")((input, options) =>
      route("GitWorkflowService.runStackedAction", workflowRouting, {
        git: (actionInput: GitRunStackedActionInput) =>
          withCheckoutLease(actionInput.cwd, gitManager.runStackedAction(actionInput, options)),
        jj: (actionInput: GitRunStackedActionInput) =>
          jjWorkflow.runStackedAction(actionInput, options),
      })(input),
    ),
    resolvePullRequest: route("GitWorkflowService.resolvePullRequest", workflowRouting, {
      git: gitManager.resolvePullRequest,
      jj: jjWorkflow.resolvePullRequest,
    }),
    preparePullRequestThread: Effect.fn("GitWorkflowService.preparePullRequestThread")((input) =>
      route("GitWorkflowService.preparePullRequestThread", workflowRouting, {
        git: (request: GitPreparePullRequestThreadInput) =>
          request.mode === "local"
            ? withCheckoutLease(request.cwd, gitManager.preparePullRequestThread(request))
            : gitManager.preparePullRequestThread(request),
        jj: jjWorkflow.preparePullRequestThread,
      })(input).pipe(
        Effect.tap((result) =>
          result.worktreePath === null
            ? Effect.void
            : Effect.gen(function* () {
                const workspacePath = result.worktreePath;
                if (workspacePath === null) return;
                const kind = yield* resolveWorkspaceKind({ cwd: input.cwd, path: workspacePath });
                yield* ownership.remember({ cwd: input.cwd, path: workspacePath, kind });
              }).pipe(commandFailure("GitWorkflowService.preparePullRequestThread", input.cwd)),
        ),
      ),
    ),
    listRefs: routeOr(
      "GitWorkflowService.listRefs",
      commandRouting,
      () => Effect.succeed(nonRepositoryListRefs()),
      { git: git.listRefs, jj: jjWorkflow.listRefs },
    ),
    createWorktree: Effect.fn("GitWorkflowService.createWorktree")((input, options) =>
      route("GitWorkflowService.createWorktree", commandRouting, {
        git: (worktreeInput: VcsCreateWorktreeInput) =>
          createWorkspaceWithKind("git", worktreeInput, options).pipe(
            commandFailure("GitWorkflowService.createWorktree", input.cwd),
          ),
        jj: (worktreeInput: VcsCreateWorktreeInput) =>
          createWorkspaceWithKind("jj", worktreeInput, options).pipe(
            commandFailure("GitWorkflowService.createWorktree", input.cwd),
          ),
      })(input),
    ),
    ensureWorkspace: Effect.fn("GitWorkflowService.ensureWorkspace")(
      function* (
        input: VcsCreateWorktreeInput & { readonly path: string },
        options?: GitVcsDriver.CreateWorktreeOptions,
      ) {
        const kind = yield* resolveWorkspaceKind(input);
        yield* ownership.remember({ cwd: input.cwd, path: input.path, kind });
        if (
          (yield* fileSystem.exists(input.path)) &&
          (yield* fileSystem.readDirectory(input.path)).length > 0
        )
          return;
        const repositoryCwd = yield* ownership.repositoryCwd(input.cwd);
        yield* workspaceOps[kind].pruneWorktrees({ cwd: repositoryCwd });
        if (kind === "git") {
          yield* recoverGitWorkspace({ ...input, cwd: repositoryCwd }, options);
          return;
        }
        yield* createWorkspaceWithKind(kind, input, options);
      },
      (effect, input) =>
        effect.pipe(
          Effect.catchIf(
            (cause) => !isWorktreeRecreateNoBaseError(cause),
            (cause) =>
              Effect.fail(
                isGitCommandError(cause)
                  ? cause
                  : new GitCommandError({
                      operation: "GitWorkflowService.ensureWorkspace",
                      command: "vcs",
                      cwd: input.cwd,
                      detail: "The workspace operation failed.",
                      cause,
                    }),
              ),
          ),
        ),
    ),
    branchPullRequest: Effect.fn("GitWorkflowService.branchPullRequest")((input, options) =>
      route("GitWorkflowService.branchPullRequest", workflowRouting, {
        git: (request: typeof input) => gitManager.branchPullRequest(request, options),
        jj: (request: typeof input) => jjWorkflow.branchPullRequest(request, options),
      })(input),
    ),
    upstreamDivergence: Effect.fn("GitWorkflowService.upstreamDivergence")(function* (cwd) {
      return yield* routeOr(
        "GitWorkflowService.upstreamDivergence",
        workflowRouting,
        () => Effect.succeed(null),
        {
          git: () =>
            git.statusDetailsRemote(cwd, { refreshUpstream: false }).pipe(
              Effect.map((details) =>
                details.hasUpstream && details.branch !== null
                  ? {
                      refName: details.branch,
                      aheadCount: details.aheadCount,
                      behindCount: details.behindCount,
                    }
                  : null,
              ),
            ),
          jj: () =>
            Effect.all([
              jjWorkflow.currentRefName(cwd),
              jjWorkflow.remoteStatus({ cwd }, { refreshUpstream: false }),
            ]).pipe(
              Effect.map(([refName, status]) =>
                status?.hasUpstream && refName !== null
                  ? {
                      refName,
                      aheadCount: status.aheadCount,
                      behindCount: status.behindCount,
                    }
                  : null,
              ),
            ),
        },
      )({ cwd });
    }),
    headPath: Effect.fn("GitWorkflowService.headPath")(function (cwd) {
      return git
        .execute({
          operation: "GitWorkflowService.headPath",
          cwd,
          args: ["rev-parse", "--path-format=absolute", "--git-path", "HEAD"],
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
          Effect.orElseSucceed(() => null),
        );
    }),
    listLocalBranchNames: Effect.fn("GitWorkflowService.listLocalBranchNames")((cwd) =>
      route("GitWorkflowService.listLocalBranchNames", commandRouting, {
        git: () => git.listLocalBranchNames(cwd),
        jj: () => jjWorkflow.listLocalBranchNames(cwd),
      })({ cwd }),
    ),
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
        git: git.resolveWorktreeBaseRemote,
        jj: jjWorkflow.resolveWorktreeBaseRemote,
      },
    ),
    fetchWorktreeBaseCommit: route("GitWorkflowService.fetchWorktreeBaseCommit", commandRouting, {
      git: git.fetchWorktreeBaseCommit,
      jj: jjWorkflow.fetchWorktreeBaseCommit,
    }),
    resolvePrimaryRemoteName: Effect.fn("GitWorkflowService.resolvePrimaryRemoteName")((cwd) =>
      route("GitWorkflowService.resolvePrimaryRemoteName", commandRouting, {
        git: () => git.resolvePrimaryRemoteName(cwd),
        jj: () => jjWorkflow.resolvePrimaryRemoteName(cwd),
      })({ cwd }),
    ),
    // Dispatched on the workspace path, not the project: a Git worktree inside a colocated jj
    // project must keep being removable after the detection flip.
    removeWorktree: Effect.fn("GitWorkflowService.removeWorktree")(
      function* (input: VcsRemoveWorktreeInput) {
        const kind = yield* resolveWorkspaceKind(input);
        yield* ownership.remember({ cwd: input.cwd, path: input.path, kind });
        const repositoryCwd = yield* ownership.repositoryCwd(input.cwd);
        yield* workspaceOps[kind].removeWorktree({ ...input, cwd: repositoryCwd });
      },
      (effect, input) =>
        effect.pipe(commandFailure("GitWorkflowService.removeWorktree", input.cwd)),
    ),
    pruneWorktrees: route("GitWorkflowService.pruneWorktrees", commandRouting, {
      git: git.pruneWorktrees,
      jj: jjWorkflow.pruneWorktrees,
    }),
    deleteLocalBranch: Effect.fn("GitWorkflowService.deleteLocalBranch")((input) =>
      route("GitWorkflowService.deleteLocalBranch", commandRouting, {
        git: git.deleteLocalBranch,
        jj: (request: GitVcsDriver.GitDeleteLocalBranchInput) =>
          jjWorkflow.deleteLocalBranch(request),
      })(input),
    ),
    createRef: route("GitWorkflowService.createRef", commandRouting, {
      git: (input) =>
        input.switchRef ? withCheckoutLease(input.cwd, git.createRef(input)) : git.createRef(input),
      jj: jjWorkflow.createRef,
    }),
    // The Git driver's `switchRef` needs a `Scope` the service closes locally; the declared type
    // carries none, and leaking it would reach every caller. The jj arm needs no scope.
    switchRef: route("GitWorkflowService.switchRef", commandRouting, {
      git: (input) => withCheckoutLease(input.cwd, Effect.scoped(git.switchRef(input))),
      jj: jjWorkflow.switchRef,
    }),
    renameBranch: route("GitWorkflowService.renameBranch", workflowRouting, {
      git: git.renameBranch,
      jj: jjWorkflow.renameBranch,
    }),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
