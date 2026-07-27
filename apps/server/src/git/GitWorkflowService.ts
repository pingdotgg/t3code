import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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

/**
 * How long a completed remote-base refresh is reused before the next thread
 * worktree fetches again.
 *
 * The refresh sits on the interactive new-thread path, so an uncached fetch is
 * a network round trip the user waits through. Creating several sessions in a
 * row used to pay that cost once per session; within this window they now pay
 * it once. Origin moving inside the window is the accepted trade — a base at
 * most this stale is still far fresher than the unfetched local ref this
 * refresh replaced.
 */
const REMOTE_BASE_REFRESH_TTL = Duration.seconds(30);

/**
 * Upper bound on a single remote-base fetch. The generic git timeout is 30s,
 * which an interactive thread-open cannot afford to wait out: an unreachable
 * or hanging remote must degrade to the local ref quickly instead of stalling
 * the UI.
 */
const REMOTE_BASE_REFRESH_TIMEOUT = Duration.seconds(10);

const REMOTE_BASE_REFRESH_CACHE_CAPACITY = 256;

interface RemoteBaseRef {
  readonly cwd: string;
  readonly remoteName: string;
  readonly remoteBranch: string;
}

// The cache is keyed by string because `Cache` matches keys by value equality.
// NUL cannot appear in a path, remote name, or branch name, so it is an
// unambiguous separator.
const REMOTE_BASE_KEY_SEPARATOR = "\u0000";

function remoteBaseCacheKey(ref: RemoteBaseRef): string {
  return [ref.cwd, ref.remoteName, ref.remoteBranch].join(REMOTE_BASE_KEY_SEPARATOR);
}

function parseRemoteBaseCacheKey(key: string): RemoteBaseRef {
  const [cwd = "", remoteName = "", remoteBranch = ""] = key.split(REMOTE_BASE_KEY_SEPARATOR);
  return { cwd, remoteName, remoteBranch };
}

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitVcsDriver.GitRemoteStatusOptions,
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
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    /**
     * Best-effort refresh of a single remote-tracking branch, used to keep new
     * thread worktrees off stale bases. Never fails and never runs longer than
     * {@link REMOTE_BASE_REFRESH_TIMEOUT}: freshness must not hold up thread
     * creation. Repeat calls for the same branch within
     * {@link REMOTE_BASE_REFRESH_TTL} reuse the previous fetch, and concurrent
     * calls share one.
     *
     * Routes `cwd` through the VCS registry first, so a path that is not a Git
     * repository is skipped rather than handed to `git fetch`.
     */
    readonly refreshRemoteBase: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly remoteBranch: string;
    }) => Effect.Effect<void, never>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
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

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;

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

  const REMOTE_TRACKING_REF_PATTERN = /^origin\/(.+)$/;

  // Never fails: a stale base is a far better outcome than a thread that will
  // not open, so both a git error and a timeout degrade to a warning and leave
  // the caller on the local ref.
  const fetchRemoteBase = (key: string): Effect.Effect<void> => {
    const ref = parseRemoteBaseCacheKey(key);
    return git.fetchRemoteTrackingBranch(ref).pipe(
      Effect.timeoutOption(REMOTE_BASE_REFRESH_TIMEOUT),
      Effect.flatMap((finished) =>
        Option.isSome(finished)
          ? Effect.void
          : Effect.logWarning("Timed out fetching the latest remote base; using the local ref", {
              cwd: ref.cwd,
              remoteRef: `${ref.remoteName}/${ref.remoteBranch}`,
              timeoutMs: Duration.toMillis(REMOTE_BASE_REFRESH_TIMEOUT),
            }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Failed to fetch the latest remote base; using the local ref", {
          cwd: ref.cwd,
          remoteRef: `${ref.remoteName}/${ref.remoteBranch}`,
          detail: error.detail,
        }),
      ),
    );
  };

  // Collapses concurrent refreshes of the same branch into one fetch and reuses
  // a completed one for REMOTE_BASE_REFRESH_TTL. Because `fetchRemoteBase`
  // absorbs its own errors, a remote that is down is also cached, so an offline
  // machine pays the timeout once per window instead of once per new thread.
  // Interruption is the only non-success exit and must not be cached: a caller
  // that goes away mid-fetch would otherwise interrupt every later caller.
  const remoteBaseRefreshCache = yield* Cache.makeWith(fetchRemoteBase, {
    capacity: REMOTE_BASE_REFRESH_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? REMOTE_BASE_REFRESH_TTL : Duration.zero),
  });

  // For callers that have already routed `cwd` through the VCS registry.
  const refreshRoutedRemoteBase = (ref: RemoteBaseRef): Effect.Effect<void, never> =>
    Cache.get(remoteBaseRefreshCache, remoteBaseCacheKey(ref));

  // The public entry point cannot assume its caller routed `cwd` first. A
  // non-Git or unresolvable working directory must stop at the route rather
  // than reach `git fetch`: spawning a doomed process is exactly the cost on
  // the thread-open path this cache exists to remove, and it would report the
  // miss as a fetch failure instead of as the repository problem it is.
  const refreshRemoteBase = (ref: RemoteBaseRef): Effect.Effect<void, never> =>
    ensureGitCommand("GitWorkflowService.refreshRemoteBase", ref.cwd).pipe(
      Effect.andThen(refreshRoutedRemoteBase(ref)),
      Effect.catch((error) =>
        Effect.logWarning("Skipped the remote base refresh; no Git repository at this path", {
          cwd: ref.cwd,
          remoteRef: `${ref.remoteName}/${ref.remoteBranch}`,
          detail: error.detail,
        }),
      ),
    );

  const refreshRemoteTrackingBase = (input: VcsCreateWorktreeInput): Effect.Effect<void, never> => {
    const remoteBranch = REMOTE_TRACKING_REF_PATTERN.exec(input.refName)?.[1];
    if (!remoteBranch) {
      return Effect.void;
    }
    // `createWorktree` has already routed this cwd; resolving it again here
    // would just repeat the registry lookup.
    return refreshRoutedRemoteBase({ cwd: input.cwd, remoteName: "origin", remoteBranch });
  };

  return GitWorkflowService.of({
    status: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.status", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.status(input) : Effect.succeed(nonRepositoryStatus()),
        ),
      ),
    localStatus: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.localStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? gitManager.localStatus(input)
            : Effect.succeed(nonRepositoryLocalStatus()),
        ),
      ),
    remoteStatus: (input, options) =>
      detectGitRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.remoteStatus(input, options) : Effect.succeed(null),
        ),
      ),
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
        // When the worktree is based on a remote-tracking ref (`origin/<base>`),
        // refresh that ref from the remote first so new threads always branch
        // off the latest upstream state instead of a stale local copy. The
        // fetch is best-effort: when the remote is unreachable we log a
        // warning and fall back to the ref as-is.
        Effect.andThen(refreshRemoteTrackingBase(input)),
        Effect.andThen(git.createWorktree(input)),
      ),
    refreshRemoteBase,
    resolveRemoteTrackingCommit: (input) =>
      ensureGitCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
        Effect.andThen(git.resolveRemoteTrackingCommit(input)),
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

export const layer = Layer.effect(GitWorkflowService, make);
