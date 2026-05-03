import { Context, Effect, Layer } from "effect";

import {
  GitManagerError,
  GitCommandError,
  type VcsDriverKind,
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

import { GitManager, type GitRunStackedActionOptions } from "./GitManager.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import { mergeGitStatusParts } from "@t3tools/shared/git";

export interface GitWorkflowServiceShape {
  readonly status: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
  readonly localStatus: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
  readonly remoteStatus: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
  readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
  readonly runStackedAction: (
    input: GitRunStackedActionInput,
    options?: GitRunStackedActionOptions,
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
  readonly removeWorktree: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
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

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  GitWorkflowServiceShape
>()("t3/git/GitWorkflowService") {}

const unsupportedGitWorkflow = (operation: string, cwd: string, detail: string) =>
  new GitManagerError({
    operation,
    detail: `${detail} (${cwd})`,
  });

const unsupportedGitCommand = (operation: string, cwd: string, detail: string) =>
  new GitCommandError({
    operation,
    command: "vcs-route",
    cwd,
    detail,
  });

const emptyWorkingTree = { files: [], insertions: 0, deletions: 0 } as const;

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

const nonGitLocalStatus = (kind: VcsDriverKind, isRepo: boolean): VcsStatusLocalResult => ({
  kind,
  isRepo,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  workingTree: emptyWorkingTree,
});

export const make = Effect.fn("makeGitWorkflowService")(function* () {
  const registry = yield* VcsDriverRegistry;
  const git = yield* GitVcsDriver;
  const gitManager = yield* GitManager;

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry
      .resolve({ cwd })
      .pipe(
        Effect.mapError((error) =>
          unsupportedGitWorkflow(
            operation,
            cwd,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    if (handle.kind !== "git") {
      return yield* unsupportedGitWorkflow(
        operation,
        cwd,
        `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}.`,
      );
    }
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry
      .resolve({ cwd })
      .pipe(
        Effect.mapError((error) =>
          unsupportedGitCommand(
            operation,
            cwd,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    if (handle.kind !== "git") {
      return yield* unsupportedGitCommand(
        operation,
        cwd,
        `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      );
    }
  });

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry
      .detect({ cwd })
      .pipe(
        Effect.mapError((error) =>
          unsupportedGitCommand(
            operation,
            cwd,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    if (!handle) {
      return false;
    }
    if (handle.kind !== "git") {
      return yield* unsupportedGitCommand(
        operation,
        cwd,
        `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      );
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

  const localStatus: GitWorkflowServiceShape["localStatus"] = Effect.fn(
    "GitWorkflowService.localStatus",
  )(function* (input) {
    const handle = yield* registry
      .detect({ cwd: input.cwd })
      .pipe(
        Effect.mapError((error) =>
          unsupportedGitWorkflow(
            "GitWorkflowService.localStatus",
            input.cwd,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    if (!handle) {
      return nonGitLocalStatus("unknown", false);
    }
    if (handle.kind === "git") {
      return yield* gitManager.localStatus(input);
    }
    return nonGitLocalStatus(handle.kind, true);
  });

  const remoteStatus: GitWorkflowServiceShape["remoteStatus"] = Effect.fn(
    "GitWorkflowService.remoteStatus",
  )(function* (input) {
    const handle = yield* registry
      .detect({ cwd: input.cwd })
      .pipe(
        Effect.mapError((error) =>
          unsupportedGitWorkflow(
            "GitWorkflowService.remoteStatus",
            input.cwd,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    if (handle?.kind === "git") {
      return yield* gitManager.remoteStatus(input);
    }
    return null;
  });

  const status: GitWorkflowServiceShape["status"] = Effect.fn("GitWorkflowService.status")(
    function* (input) {
      const [local, remote] = yield* Effect.all([localStatus(input), remoteStatus(input)]);
      return mergeGitStatusParts(local, remote);
    },
  );

  return GitWorkflowService.of({
    status,
    localStatus,
    remoteStatus,
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: (cwd) =>
      ensureGitCommand("GitWorkflowService.pullCurrentBranch", cwd).pipe(
        Effect.andThen(git.pullCurrentBranch(cwd)),
      ),
    runStackedAction: (input, options) =>
      ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
        Effect.andThen(gitManager.runStackedAction(input, options)),
      ),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: routeGitManager(
      "GitWorkflowService.preparePullRequestThread",
      gitManager.preparePullRequestThread,
    ),
    listRefs: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
        ),
      ),
    createWorktree: (input) =>
      ensureGitCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
        Effect.andThen(git.createWorktree(input)),
      ),
    removeWorktree: (input) =>
      ensureGitCommand("GitWorkflowService.removeWorktree", input.cwd).pipe(
        Effect.andThen(git.removeWorktree(input)),
      ),
    createRef: (input) =>
      ensureGitCommand("GitWorkflowService.createRef", input.cwd).pipe(
        Effect.andThen(git.createRef(input)),
      ),
    switchRef: (input) =>
      ensureGitCommand("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.andThen(Effect.scoped(git.switchRef(input))),
      ),
    renameBranch: (input) =>
      ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      ),
  });
});

export const layer = Layer.effect(GitWorkflowService, make());
