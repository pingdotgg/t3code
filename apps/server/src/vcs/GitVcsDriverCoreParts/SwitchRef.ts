import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { GitCommandError } from "@t3tools/contracts";
import * as GitVcsDriver from "../GitVcsDriver.ts";
import { removeEmptyDirectory } from "../removeEmptyDirectory.ts";
import { removeLinkedWorktree } from "../worktreeRemoval.ts";
import { parseRemoteRefWithRemoteNames } from "../../git/remoteRefs.ts";
import { STATUS_UPSTREAM_REFRESH_ENV, WORKTREE_REMOVE_TIMEOUT_MS, deriveLocalBranchNameFromRemoteRef, fetchFailureDetail, gitCommandContext, isMissingWorktreeStderr, isRefLockFailure, parseTrackingBranchByUpstreamRef, refuseOptionLikeRefName } from "../GitVcsDriverCorePrelude/FetchFailureDetail.ts";
import type { ExecuteRawPart } from "./ExecuteRaw.ts";
import type { ResolveBaseBranchForNoUpstreamPart } from "./ResolveBaseBranchForNoUpstream.ts";
import type { ReadStatusDetailsLocalPart } from "./ReadStatusDetailsLocal.ts";
import type { PushCurrentBranchPart } from "./PushCurrentBranch.ts";
import type { GetReviewDiffPreviewPart } from "./GetReviewDiffPreview.ts";
import type { CreateWorktreePart } from "./CreateWorktree.ts";

type Deps = Record<never, never> & ExecuteRawPart & ResolveBaseBranchForNoUpstreamPart & ReadStatusDetailsLocalPart & PushCurrentBranchPart & GetReviewDiffPreviewPart & CreateWorktreePart;

export const installSwitchRef = Effect.fnUntraced(function* (deps: Deps) {
  const { branchExists, createBranchAt, execute, executeGit, executeGitWithStableDiagnostics, executeWorktreeList, fileSystem, invalidateListRefsSnapshot, invalidateStatusStaticCaches, listRemoteNames, normalizeRepositoryPathsCacheKey, path, readGitCommonDir, remoteExists, repositoryPathsCache, repositoryPathsRefreshCache, resolveAvailableBranchName, resolveCommit, retryWhileConfigLocked, runGit, runGitStdout } = deps;

const refreshCheckedOutBranch: GitVcsDriver.GitVcsDriver["Service"]["refreshCheckedOutBranch"] =
  Effect.fn("refreshCheckedOutBranch")(function* (input) {
    const { commitSha: headCommit } = yield* resolveCommit({ cwd: input.cwd, revision: "HEAD" });
    if (headCommit === input.targetCommit) {
      return { headCommit, moved: false, onTarget: true };
    }

    const worktreeChanges = yield* runGitStdout(
      "GitVcsDriver.refreshCheckedOutBranch.status",
      input.cwd,
      ["status", "--porcelain"],
    );
    if (worktreeChanges.trim().length > 0) {
      return { headCommit, moved: false, onTarget: false };
    }

    const isAncestor = yield* executeGit(
      "GitVcsDriver.refreshCheckedOutBranch.isAncestor",
      input.cwd,
      ["merge-base", "--is-ancestor", headCommit, input.targetCommit],
      { allowNonZeroExit: true },
    ).pipe(Effect.map((result) => result.exitCode === 0));
    // Rewritten heads require reset; allow only clean checkouts still at the pre-fetch upstream commit.
    if (!isAncestor && headCommit !== input.resetWhenHeadCommit) {
      return { headCommit, moved: false, onTarget: false };
    }

    if (!isAncestor) {
      // Retain the reset-away commit; rewritten remote heads no longer provide a path back.
      yield* executeGit(
        "GitVcsDriver.refreshCheckedOutBranch.keepPrevious",
        input.cwd,
        ["update-ref", "refs/t3code/pre-refresh", headCommit],
        { fallbackErrorDetail: "git failed to record the previous checkout commit" },
      );
    }

    yield* executeGit(
      "GitVcsDriver.refreshCheckedOutBranch.move",
      input.cwd,
      // reset --merge refuses tracked edits racing our cleanliness check, preserving work like --ff-only does.
      isAncestor
        ? ["merge", "--ff-only", input.targetCommit]
        : ["reset", "--merge", input.targetCommit],
      {
        timeoutMs: 30_000,
        fallbackErrorDetail: "git failed to move the checkout onto the pull request head",
      },
    );

    return { headCommit: input.targetCommit, moved: true, onTarget: true };
  });

const fetchRemote = Effect.fn("fetchRemote")(function* (input: GitVcsDriver.GitFetchRemoteInput) {
  const args = ["fetch", "--quiet", "--", input.remoteName];
  const options = {
    env: STATUS_UPSTREAM_REFRESH_ENV,
    fallbackErrorDetail: `git fetch ${input.remoteName} failed`,
  };
  // Another fetch in the same repository, such as the background status
  // poll, can win the race for a remote-tracking ref. The loser fails, but
  // the ref is free again by the time a rerun needs it, so retry once.
  const runFetch = (fetchArgs: readonly string[]) => {
    const run = executeGitWithStableDiagnostics(
      "GitVcsDriver.fetchRemote",
      input.cwd,
      fetchArgs,
      {
        ...options,
        allowNonZeroExit: true,
      },
    );
    return run.pipe(
      Effect.filterOrElse(
        (result) => !(result.exitCode !== 0 && isRefLockFailure(result.stderr)),
        (_result) => run,
      ),
    );
  };
  const fetchAll = runFetch(args).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new GitCommandError({
              ...gitCommandContext({
                operation: "GitVcsDriver.fetchRemote",
                cwd: input.cwd,
                args,
              }),
              detail: fetchFailureDetail(result.stderr) ?? options.fallbackErrorDetail,
              ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
              stdoutLength: result.stdout.length,
              stderrLength: result.stderr.length,
            }),
          ),
    ),
  );
  if (input.refName === undefined) {
    return yield* fetchAll.pipe(Effect.as(true));
  }
  const branch =
    parseRemoteRefWithRemoteNames(input.refName, [input.remoteName])?.branchName ?? input.refName;
  const scopedArgs = [
    "fetch",
    "--quiet",
    "--no-tags",
    "--",
    input.remoteName,
    `+refs/heads/${branch}:refs/remotes/${input.remoteName}/${branch}`,
  ];
  const result = yield* runFetch(scopedArgs);
  if (result.exitCode === 0) return true;
  if (
    result.stderr.split(/\r?\n/).includes(`fatal: couldn't find remote ref refs/heads/${branch}`)
  ) {
    return false;
  }
  return yield* new GitCommandError({
    ...gitCommandContext({
      operation: "GitVcsDriver.fetchRemote",
      cwd: input.cwd,
      args: scopedArgs,
    }),
    detail: fetchFailureDetail(result.stderr) ?? options.fallbackErrorDetail,
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    stdoutLength: result.stdout.length,
    stderrLength: result.stderr.length,
  });
});

const resolveRemoteTrackingCommit: GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"] =
  Effect.fn("resolveRemoteTrackingCommit")(function* (input) {
    const remoteNames = yield* listRemoteNames(input.cwd);
    const parsedRemoteRef = parseRemoteRefWithRemoteNames(
      input.refName,
      remoteNames.toSorted((left, right) => right.length - left.length),
    );
    const remoteRefName =
      parsedRemoteRef?.remoteRef ?? `${input.fallbackRemoteName}/${input.refName}`;
    const commitSha = yield* runGitStdout("GitVcsDriver.resolveRemoteTrackingCommit", input.cwd, [
      "rev-parse",
      "--verify",
      `refs/remotes/${remoteRefName}^{commit}`,
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha, remoteRefName };
  });

const resolveWorktreeBaseRemote: GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"] =
  Effect.fn("resolveWorktreeBaseRemote")(function* (input) {
    const remoteNames = (yield* listRemoteNames(input.cwd)).toSorted(
      (left, right) => right.length - left.length,
    );
    // Upstream atoms read config even before the tracking ref has been fetched.
    // Match the exact local ref: for-each-ref also returns its descendants.
    const localBranch = yield* runGitStdout("GitVcsDriver.resolveWorktreeBaseRemote", input.cwd, [
      "for-each-ref",
      "--format=%(refname)\t%(upstream:remotename)\t%(upstream:remoteref)",
      `refs/heads/${input.refName}`,
    ]).pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .map((line) => line.split("\t"))
          .find(([refName]) => refName === `refs/heads/${input.refName}`),
      ),
    );
    let target: { remoteName: string; branchName: string } | null;
    if (localBranch) {
      // A remote of "." tracks another local branch; it is not a remote name.
      const [, remoteName = "", merge = ""] = localBranch;
      target =
        remoteNames.includes(remoteName) && merge.startsWith("refs/heads/")
          ? { remoteName, branchName: merge.slice("refs/heads/".length) }
          : null;
    } else {
      target = parseRemoteRefWithRemoteNames(input.refName, remoteNames);
    }
    const { remoteName, branchName } = target ?? {
      remoteName: "origin",
      branchName: input.refName,
    };
    return remoteNames.includes(remoteName) ? { remoteName, branchName } : null;
  });

const fetchWorktreeBaseCommit: GitVcsDriver.GitVcsDriver["Service"]["fetchWorktreeBaseCommit"] =
  Effect.fn("fetchWorktreeBaseCommit")(function* (input) {
    const target = input.remote ?? (yield* resolveWorktreeBaseRemote(input));
    if (target === null) return null;
    const { remoteName, branchName } = target;
    const remoteRefName = `${remoteName}/${branchName}`;
    // A missing remote branch can leave a stale tracking ref; never resolve it.
    if (!(yield* fetchRemote({ cwd: input.cwd, remoteName, refName: remoteRefName }))) {
      return null;
    }
    const resolved = yield* executeGit(
      "GitVcsDriver.fetchWorktreeBaseCommit",
      input.cwd,
      ["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteRefName}^{commit}`],
      { allowNonZeroExit: true },
    );
    return resolved.exitCode === 0 ? { commitSha: resolved.stdout.trim(), remoteRefName } : null;
  });

const fetchRemoteBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteBranch"] = Effect.fn(
  "fetchRemoteBranch",
)(function* (input) {
  yield* runGit("GitVcsDriver.fetchRemoteBranch.fetch", input.cwd, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--",
    input.remoteName,
    `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
  ]);

  const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
  const targetRef = `${input.remoteName}/${input.remoteBranch}`;
  if (!localBranchAlreadyExists) {
    return yield* createBranchAt(
      "GitVcsDriver.fetchRemoteBranch.materialize",
      { cwd: input.cwd, branch: input.localBranch, startPoint: targetRef },
      "git branch create failed",
    );
  }
  yield* runGit(
    "GitVcsDriver.fetchRemoteBranch.materialize",
    input.cwd,
    ["branch", "--force", "--", input.localBranch, targetRef],
    { writesSharedConfig: true },
  );
});

const fetchRemoteTrackingBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"] =
  Effect.fn("fetchRemoteTrackingBranch")(function* (input) {
    yield* runGit("GitVcsDriver.fetchRemoteTrackingBranch", input.cwd, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--",
      input.remoteName,
      `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
    ]);
  });

const setBranchUpstream: GitVcsDriver.GitVcsDriver["Service"]["setBranchUpstream"] = (input) =>
  executeGitWithStableDiagnostics(
    "GitVcsDriver.setBranchUpstream",
    input.cwd,
    [
      "branch",
      "--set-upstream-to",
      `${input.remoteName}/${input.remoteBranch}`,
      "--",
      input.branch,
    ],
    { writesSharedConfig: true },
  ).pipe(retryWhileConfigLocked, Effect.asVoid);

const removeLeftoverLinks = Effect.fnUntraced(function* (
  target: string,
): Effect.fn.Return<boolean, PlatformError.PlatformError | Cause.UnknownError> {
  if (Option.isSome(yield* fileSystem.readLink(target).pipe(Effect.option))) {
    yield* fileSystem.remove(target);
    return true;
  }
  if ((yield* fileSystem.stat(target)).type !== "Directory") return false;
  let empty = true;
  for (const name of yield* fileSystem.readDirectory(target)) {
    if (!(yield* removeLeftoverLinks(path.join(target, name)))) empty = false;
  }
  // Only an empty directory goes, so files written since the listing stay.
  return empty && (yield* removeEmptyDirectory(target));
});

const removeWorktree: GitVcsDriver.GitVcsDriver["Service"]["removeWorktree"] = Effect.fn(
  "removeWorktree",
)(function* (input) {
  // Git also matches a worktree by its short name, which can name a different
  // folder than this path. Resolving it once keeps Git, the Windows deletion
  // in removeLinkedWorktree, and the leftover cleanup below on one directory.
  const target = path.resolve(input.cwd, input.path);
  const result = yield* removeLinkedWorktree({
    operation: "GitVcsDriver.removeWorktree",
    cwd: input.cwd,
    worktreePath: target,
    force: input.force === true,
    execute,
    run: (args) =>
      executeGitWithStableDiagnostics("GitVcsDriver.removeWorktree", input.cwd, args, {
        timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
        allowNonZeroExit: true,
      }).pipe(Effect.map((result) => ({ ...result, args }))),
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );
  if (result.exitCode === 0) {
    // Git for Windows reports success without removing NTFS junctions or their parent directories.
    // Log leftover cleanup failures: Git already unregistered the worktree, so removal cannot be retried.
    if (yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false))) {
      const removed = yield* removeLeftoverLinks(target).pipe(
        Effect.catch((error) =>
          Effect.logWarning("GitVcsDriver.removeWorktree: failed to delete leftover links", {
            path: target,
            error,
          }).pipe(Effect.as(true)),
        ),
      );
      if (!removed) {
        yield* Effect.logWarning(
          "GitVcsDriver.removeWorktree: kept files written after git removed the worktree",
          { path: target },
        );
      }
    }
    return;
  }
  // Threads share paths and outside Git can remove worktrees; already-gone removals are no-ops.
  const alreadyGone =
    isMissingWorktreeStderr(result.stderr) &&
    !(yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false)));
  if (alreadyGone) {
    yield* pruneWorktrees({ cwd: input.cwd });
    return;
  }
  yield* Effect.logWarning(
    `GitVcsDriver.removeWorktree: git worktree remove exited with code ${result.exitCode} for ${input.path} (stderr length ${result.stderr.length}).`,
  );
  return yield* new GitCommandError({
    ...gitCommandContext({
      operation: "GitVcsDriver.removeWorktree",
      cwd: input.cwd,
      args: result.args,
    }),
    detail: "git worktree remove failed",
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    stdoutLength: result.stdout.length,
    stderrLength: result.stderr.length,
  });
});

const pruneWorktrees: GitVcsDriver.GitVcsDriver["Service"]["pruneWorktrees"] = Effect.fn(
  "pruneWorktrees",
)(function* (input) {
  yield* executeGit("GitVcsDriver.pruneWorktrees", input.cwd, ["worktree", "prune"], {
    timeoutMs: 15_000,
    fallbackErrorDetail: "git worktree prune failed",
  });
});

const renameBranch: GitVcsDriver.GitVcsDriver["Service"]["renameBranch"] = Effect.fn(
  "renameBranch",
)(function* (input) {
  if (input.oldBranch === input.newBranch) {
    return { branch: input.newBranch };
  }
  const targetBranch = input.exactName
    ? input.newBranch
    : yield* resolveAvailableBranchName(input.cwd, input.newBranch);

  yield* executeGit(
    "GitVcsDriver.renameBranch",
    input.cwd,
    ["branch", "-m", "--", input.oldBranch, targetBranch],
    {
      timeoutMs: 10_000,
      fallbackErrorDetail: "git branch rename failed",
      writesSharedConfig: true,
    },
  );

  return { branch: targetBranch };
});

const switchRef: GitVcsDriver.GitVcsDriver["Service"]["switchRef"] = Effect.fn("switchRef")(
  function* (input) {
    const [localInputExists, remoteExists] = yield* Effect.all(
      [
        executeGit(
          "GitVcsDriver.switchRef.localInputExists",
          input.cwd,
          ["show-ref", "--verify", "--quiet", `refs/heads/${input.refName}`],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ).pipe(Effect.map((result) => result.exitCode === 0)),
        executeGit(
          "GitVcsDriver.switchRef.remoteExists",
          input.cwd,
          ["show-ref", "--verify", "--quiet", `refs/remotes/${input.refName}`],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ).pipe(Effect.map((result) => result.exitCode === 0)),
      ],
      { concurrency: "unbounded" },
    );

    const localTrackingBranch =
      remoteExists && !localInputExists
        ? yield* executeGit(
            "GitVcsDriver.switchRef.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(
            Effect.map((result) =>
              result.exitCode === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.refName)
                : null,
            ),
          )
        : null;

    const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.refName);
    const localTrackedBranchTargetExists =
      remoteExists && !localInputExists && !localTrackingBranch && localTrackedBranchCandidate
        ? yield* executeGit(
            "GitVcsDriver.switchRef.localTrackedBranchTargetExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0))
        : false;

    const checkoutArgs = localInputExists
      ? ["checkout", input.refName]
      : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
        ? ["checkout", input.refName]
        : remoteExists && !localTrackingBranch
          ? ["checkout", "--track", input.refName]
          : remoteExists && localTrackingBranch
            ? ["checkout", localTrackingBranch]
            : ["checkout", input.refName];

    yield* refuseOptionLikeRefName("GitVcsDriver.switchRef", input.cwd, checkoutArgs.at(-1));

    // A stale ref must not turn into a path checkout that discards local edits.
    yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.switchRef.checkout",
      input.cwd,
      [...checkoutArgs, "--"],
      {
        timeoutMs: 10_000,
        fallbackErrorDetail: "git checkout failed",
        // Checking out a remote branch creates a local one that tracks it.
        writesSharedConfig: !localInputExists,
      },
    );

    const refName = yield* runGitStdout("GitVcsDriver.switchRef.currentBranch", input.cwd, [
      "branch",
      "--show-current",
    ]).pipe(Effect.map((stdout) => stdout.trim() || null));

    return { refName };
  },
);

const createRef: GitVcsDriver.GitVcsDriver["Service"]["createRef"] = Effect.fn("createRef")(
  function* (input) {
    yield* executeGit("GitVcsDriver.createRef", input.cwd, ["branch", "--", input.refName], {
      timeoutMs: 10_000,
      fallbackErrorDetail: "git branch create failed",
      // `branch.autoSetupMerge=always` records HEAD's branch as the upstream.
      writesSharedConfig: true,
    });
    if (input.switchRef) {
      yield* switchRef({ cwd: input.cwd, refName: input.refName });
    }

    return { refName: input.refName };
  },
);

const initRepo: GitVcsDriver.GitVcsDriver["Service"]["initRepo"] = (input) =>
  executeGit("GitVcsDriver.initRepo", input.cwd, ["init"], {
    timeoutMs: 10_000,
    fallbackErrorDetail: "git init failed",
  }).pipe(Effect.asVoid);

const listLocalBranchNames: GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"] = (
  cwd,
) =>
  runGitStdout("GitVcsDriver.listLocalBranchNames", cwd, [
    "branch",
    "--list",
    "--no-column",
    "--format=%(refname:lstrip=2)",
  ]).pipe(
    Effect.map((stdout) => {
      const branchNames: Array<string> = [];
      for (const line of stdout.split("\n")) {
        const branchName = line.trim();
        if (branchName.length > 0) {
          branchNames.push(branchName);
        }
      }
      return branchNames;
    }),
  );

const listWorktreePaths: GitVcsDriver.GitVcsDriver["Service"]["listWorktreePaths"] = (cwd) =>
  executeWorktreeList("GitVcsDriver.listWorktreePaths", cwd, []).pipe(
    // A `prunable` record's directory is gone; another checkout may now sit there.
    Effect.map(({ stdout }) =>
      stdout.split("\0\0").flatMap((record) => {
        const fields = record.split("\0");
        const worktree = fields.find((field) => field.startsWith("worktree "));
        return worktree === undefined || fields.some((field) => field.startsWith("prunable"))
          ? []
          : [path.resolve(cwd, worktree.slice("worktree ".length))];
      }),
    ),
  );

const withListRefsInvalidation = <A, E>(
  cwd: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.ensuring(
      Effect.all([
        invalidateListRefsSnapshot(cwd).pipe(Effect.ignore),
        invalidateStatusStaticCaches(cwd).pipe(Effect.ignore),
      ]),
    ),
  );

const invalidateWorktreeCreationCaches = Effect.fn(
  "GitVcsDriverCore.invalidateWorktreeCreationCaches",
)(function* (cwd: string) {
  let gitCommonDir = yield* readGitCommonDir(cwd).pipe(
    Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
  );
  if (gitCommonDir === null) {
    gitCommonDir = yield* Cache.getOption(
      repositoryPathsCache,
      normalizeRepositoryPathsCacheKey(cwd),
    ).pipe(
      Effect.map((cached) => Option.getOrNull(cached)?.gitCommonDir ?? null),
      Effect.orElseSucceed(() => null),
    );
  }
  yield* Effect.all([
    invalidateListRefsSnapshot(cwd, gitCommonDir).pipe(Effect.ignore),
    invalidateStatusStaticCaches(cwd, gitCommonDir).pipe(Effect.ignore),
  ]);
});

const initRepoWithListRefsInvalidation: GitVcsDriver.GitVcsDriver["Service"]["initRepo"] = (
  input,
) =>
  initRepo(input).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const cacheKey = normalizeRepositoryPathsCacheKey(input.cwd);
        yield* Cache.invalidate(repositoryPathsRefreshCache, cacheKey);
        yield* Cache.invalidate(repositoryPathsCache, cacheKey);
        yield* invalidateListRefsSnapshot(input.cwd).pipe(Effect.ignore);
      }),
    ),
  );

  return { refreshCheckedOutBranch, fetchRemote, resolveRemoteTrackingCommit, resolveWorktreeBaseRemote, fetchWorktreeBaseCommit, fetchRemoteBranch, fetchRemoteTrackingBranch, setBranchUpstream, removeLeftoverLinks, removeWorktree, pruneWorktrees, renameBranch, switchRef, createRef, initRepo, listLocalBranchNames, listWorktreePaths, withListRefsInvalidation, invalidateWorktreeCreationCaches, initRepoWithListRefsInvalidation };
});

export type SwitchRefPart = ReturnType<typeof installSwitchRef> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installSwitchRef>;
