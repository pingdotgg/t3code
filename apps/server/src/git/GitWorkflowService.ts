import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";

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
} from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly isRepository: (cwd: string) => Effect.Effect<boolean, GitManagerServiceError>;
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
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
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
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
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

  const detectGitRepositoryForStatus = Effect.fn("GitWorkflowService.detectGitRepositoryForStatus")(
    function* (operation: string, cwd: string) {
      const handle = yield* registry.detect({ cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation,
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
      if (!handle) {
        return false;
      }
      if (handle.kind !== "git") {
        return yield* new GitManagerError({
          operation,
          cwd,
          detail: `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}. (${cwd})`,
        });
      }
      return true;
    },
  );

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
    if (!handle) {
      return false;
    }
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      });
    }
    return true;
  });

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

  return GitWorkflowService.of({
    isRepository: Effect.fn("GitWorkflowService.isRepository")(function (cwd) {
      return registry.detect({ cwd }).pipe(
        Effect.map((handle) => handle?.kind === "git"),
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.isRepository",
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
    }),
    hasCommit: Effect.fn("GitWorkflowService.hasCommit")(function (input) {
      return ensureGitCommand("GitWorkflowService.hasCommit", input.cwd).pipe(
        Effect.andThen(
          git.execute({
            operation: "GitWorkflowService.hasCommit",
            cwd: input.cwd,
            args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
            allowNonZeroExit: true,
          }),
        ),
        Effect.map((result) => result.exitCode === 0),
      );
    }),
    hasRefNamed: Effect.fn("GitWorkflowService.hasRefNamed")(function (input) {
      // Pattern characters would widen the ref match.
      return /[*?[\\]/.test(input.refName)
        ? Effect.succeed(false)
        : ensureGitCommand("GitWorkflowService.hasRefNamed", input.cwd).pipe(
            Effect.andThen(
              git.execute({
                operation: "GitWorkflowService.hasRefNamed",
                cwd: input.cwd,
                args: [
                  "for-each-ref",
                  "--count=1",
                  "--format=%(refname)",
                  `refs/**/${input.refName}`,
                ],
              }),
            ),
            Effect.map((result) => result.stdout.trim().length > 0),
          );
    }),
    status: Effect.fn("GitWorkflowService.status")(function (input) {
      return detectGitRepositoryForStatus("GitWorkflowService.status", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.status(input) : Effect.succeed(nonRepositoryStatus()),
        ),
      );
    }),
    localStatus: Effect.fn("GitWorkflowService.localStatus")(function (input) {
      return detectGitRepositoryForStatus("GitWorkflowService.localStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? gitManager.localStatus(input)
            : Effect.succeed(nonRepositoryLocalStatus()),
        ),
      );
    }),
    remoteStatus: Effect.fn("GitWorkflowService.remoteStatus")(function (input, options) {
      return detectGitRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.remoteStatus(input, options) : Effect.succeed(null),
        ),
      );
    }),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: Effect.fn("GitWorkflowService.pullCurrentBranch")(function (cwd) {
      return ensureGitCommand("GitWorkflowService.pullCurrentBranch", cwd).pipe(
        Effect.andThen(git.pullCurrentBranch(cwd)),
      );
    }),
    runStackedAction: Effect.fn("GitWorkflowService.runStackedAction")(function (input, options) {
      return ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
        Effect.flatMap((handle) =>
          input.featureBranch
            ? withCheckoutLease(
                handle.repository.rootPath,
                gitManager.runStackedAction(input, options),
              )
            : gitManager.runStackedAction(input, options),
        ),
      );
    }),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: Effect.fn("GitWorkflowService.preparePullRequestThread")(
      function (input) {
        return ensureGit("GitWorkflowService.preparePullRequestThread", input.cwd).pipe(
          Effect.flatMap((handle) =>
            input.mode === "local"
              ? withCheckoutLease(
                  handle.repository.rootPath,
                  gitManager.preparePullRequestThread(input),
                )
              : gitManager.preparePullRequestThread(input),
          ),
        );
      },
    ),
    listRefs: Effect.fn("GitWorkflowService.listRefs")(function (input) {
      return detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
        ),
      );
    }),
    createWorktree: Effect.fn("GitWorkflowService.createWorktree")(function (input, options) {
      return ensureGitCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
        Effect.andThen(gitManager.createWorktree(input, options)),
      );
    }),
    listLocalBranchNames: Effect.fn("GitWorkflowService.listLocalBranchNames")(function (cwd) {
      return ensureGitCommand("GitWorkflowService.listLocalBranchNames", cwd).pipe(
        Effect.andThen(git.listLocalBranchNames(cwd)),
      );
    }),
    fetchRemote: Effect.fn("GitWorkflowService.fetchRemote")(function (input) {
      return ensureGitCommand("GitWorkflowService.fetchRemote", input.cwd).pipe(
        Effect.andThen(git.fetchRemote(input)),
      );
    }),
    remoteExists: Effect.fn("GitWorkflowService.remoteExists")(function (input) {
      return ensureGitCommand("GitWorkflowService.remoteExists", input.cwd).pipe(
        Effect.andThen(git.remoteExists(input)),
      );
    }),
    remoteBranchExists: Effect.fn("GitWorkflowService.remoteBranchExists")(function (input) {
      return ensureGitCommand("GitWorkflowService.remoteBranchExists", input.cwd).pipe(
        Effect.andThen(git.remoteBranchExists(input)),
      );
    }),
    resolveRemoteTrackingCommit: Effect.fn("GitWorkflowService.resolveRemoteTrackingCommit")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
          Effect.andThen(git.resolveRemoteTrackingCommit(input)),
        );
      },
    ),
    resolveWorktreeBaseRemote: Effect.fn("GitWorkflowService.resolveWorktreeBaseRemote")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.resolveWorktreeBaseRemote", input.cwd).pipe(
          Effect.andThen(git.resolveWorktreeBaseRemote(input)),
        );
      },
    ),
    fetchWorktreeBaseCommit: Effect.fn("GitWorkflowService.fetchWorktreeBaseCommit")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.fetchWorktreeBaseCommit", input.cwd).pipe(
          Effect.andThen(git.fetchWorktreeBaseCommit(input)),
        );
      },
    ),
    removeWorktree: Effect.fn("GitWorkflowService.removeWorktree")(function (input) {
      return ensureGitCommand("GitWorkflowService.removeWorktree", input.cwd).pipe(
        Effect.andThen(git.removeWorktree(input)),
      );
    }),
    pruneWorktrees: Effect.fn("GitWorkflowService.pruneWorktrees")(function (input) {
      return ensureGitCommand("GitWorkflowService.pruneWorktrees", input.cwd).pipe(
        Effect.andThen(git.pruneWorktrees(input)),
      );
    }),
    deleteLocalBranch: Effect.fn("GitWorkflowService.deleteLocalBranch")(function (input) {
      return ensureGitCommand("GitWorkflowService.deleteLocalBranch", input.cwd).pipe(
        Effect.andThen(git.deleteLocalBranch(input)),
      );
    }),
    createRef: Effect.fn("GitWorkflowService.createRef")(function (input) {
      return ensureGitCommand("GitWorkflowService.createRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          input.switchRef
            ? withCheckoutLease(handle.repository.rootPath, git.createRef(input))
            : git.createRef(input),
        ),
      );
    }),
    switchRef: Effect.fn("GitWorkflowService.switchRef")(function (input) {
      return ensureGitCommand("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(handle.repository.rootPath, Effect.scoped(git.switchRef(input))),
        ),
      );
    }),
    renameBranch: Effect.fn("GitWorkflowService.renameBranch")(function (input) {
      return ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      );
    }),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
