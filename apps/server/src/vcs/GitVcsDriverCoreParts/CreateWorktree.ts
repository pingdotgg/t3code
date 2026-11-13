import * as Cache from "effect/Cache";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import { GitCommandError, T3_PROJECT_FILE_NAME, type VcsRef } from "@t3tools/contracts";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { resolveProjectFileBackedSetting } from "@t3tools/shared/projectSettings";
import * as GitVcsDriver from "../GitVcsDriver.ts";
import { resolveWorktreesDirectory } from "../../worktreesDirectory.ts";
import { parseRemoteNames, parseRemoteRefWithRemoteNames } from "../../git/remoteRefs.ts";
import { GitRefsRefreshCacheKey, GitRefsSnapshotCacheKey, LIST_REFS_REFRESH_COALESCE_TTL, LIST_REFS_REFRESH_FAILURE_COOLDOWN, LIST_REFS_SNAPSHOT_CACHE_CAPACITY, LIST_REFS_SNAPSHOT_CACHE_TTL, branchBaseConfigKey, filterBranchesForListQuery, isMissingGitCwdError, paginateBranches, parseWorktreeBranchPaths, refuseOptionLikeRefName, type GitRefsSnapshot } from "../GitVcsDriverCorePrelude/FetchFailureDetail.ts";
import { parseGitCheckoutProgressLine } from "../GitVcsDriverCorePrelude/CreateTrace2Monitor.ts";
import type { ExecuteRawPart } from "./ExecuteRaw.ts";
import type { ResolveBaseBranchForNoUpstreamPart } from "./ResolveBaseBranchForNoUpstream.ts";
import type { ReadStatusDetailsLocalPart } from "./ReadStatusDetailsLocal.ts";
import type { PushCurrentBranchPart } from "./PushCurrentBranch.ts";
import type { GetReviewDiffPreviewPart } from "./GetReviewDiffPreview.ts";

type Deps = Record<never, never> & ExecuteRawPart & ResolveBaseBranchForNoUpstreamPart & ReadStatusDetailsLocalPart & PushCurrentBranchPart & GetReviewDiffPreviewPart;

export const installCreateWorktree = Effect.fnUntraced(function* (deps: Deps) {
  const { createBranchAt, digest, executeGit, executeGitWithStableDiagnostics, executeWorktreeList, fileSystem, normalizeRepositoryPathsCacheKey, path, readConfigValue, repositoryPathsCache, repositoryPathsRefreshCache, resolveBranchBase, resolvePrimaryRemoteName, resolveRepositoryPaths, runGit, runGitStdout, worktreesDir, writeConfigValue } = deps;

const readGitRefsSnapshot = Effect.fn("readGitRefsSnapshot")(function* (gitCommonDir: string) {
  const fetchCwd =
    path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
  const gitDirArgs = ["--git-dir", gitCommonDir] as const;
  const [refsResult, defaultRefResult, worktreeListResult, remoteNamesResult] = yield* Effect.all(
    [
      executeGitWithStableDiagnostics(
        "GitVcsDriver.listRefs.snapshotRefs",
        fetchCwd,
        [
          ...gitDirArgs,
          "for-each-ref",
          "--format=%(refname)%09%(committerdate:unix)%09%(symref)%09%(upstream)",
          "refs/heads",
          "refs/remotes",
        ],
        {
          timeoutMs: 30_000,
          maxOutputBytes: 16 * 1024 * 1024,
          fallbackErrorDetail: "Git ref snapshot enumeration failed.",
        },
      ),
      executeGit(
        "GitVcsDriver.listRefs.defaultRef",
        fetchCwd,
        [...gitDirArgs, "symbolic-ref", "refs/remotes/origin/HEAD"],
        {
          timeoutMs: 5_000,
          allowNonZeroExit: true,
        },
      ),
      executeWorktreeList("GitVcsDriver.listRefs.worktreeList", fetchCwd, gitDirArgs, {
        timeoutMs: 30_000,
        allowNonZeroExit: true,
        maxOutputBytes: 16 * 1024 * 1024,
      }),
      executeGit("GitVcsDriver.listRefs.remoteNames", fetchCwd, [...gitDirArgs, "remote"], {
        timeoutMs: 5_000,
        allowNonZeroExit: true,
      }),
    ],
    { concurrency: 2 },
  );

  const remoteNames =
    remoteNamesResult.exitCode === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
  if (remoteNamesResult.exitCode !== 0 && remoteNamesResult.stderr.trim().length > 0) {
    yield* Effect.logWarning(
      `GitVcsDriver.listRefs: remote name lookup returned code ${remoteNamesResult.exitCode} for ${gitCommonDir}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
    );
  }
  const defaultBranch =
    defaultRefResult.exitCode === 0
      ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
      : null;
  const parsedWorktreeEntries =
    worktreeListResult.exitCode === 0
      ? [...parseWorktreeBranchPaths(worktreeListResult.stdout)].map(
          ([branchName, worktreePath]) =>
            [branchName, path.normalize(path.resolve(worktreePath))] as const,
        )
      : [];
  // Without `core.worktree`, Git reports a separate git dir as the main checkout.
  const normalizedGitCommonDir = path.normalize(path.resolve(gitCommonDir));
  const existingWorktreeEntries = yield* Effect.filter(
    parsedWorktreeEntries,
    ([, worktreePath]) =>
      worktreePath === normalizedGitCommonDir
        ? Effect.succeed(false)
        : fileSystem.stat(worktreePath).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
    { concurrency: 16 },
  );
  const worktreeMap = new Map(existingWorktreeEntries);
  const localBranches: Array<{ readonly ref: VcsRef; readonly lastCommit: number }> = [];
  const remoteBranches: Array<{ readonly ref: VcsRef; readonly lastCommit: number }> = [];

  for (const line of refsResult.stdout.split("\n")) {
    if (line.length === 0) continue;
    const [fullRefName, lastCommitRaw, symbolicTarget, upstreamRef] = line.split("\t");
    if (!fullRefName || symbolicTarget) continue;
    const parsedLastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
    const lastCommit = Number.isFinite(parsedLastCommit) ? parsedLastCommit : 0;

    if (fullRefName.startsWith("refs/heads/")) {
      const name = fullRefName.slice("refs/heads/".length);
      localBranches.push({
        ref: {
          name,
          current: false,
          isRemote: false,
          isDefault: name === defaultBranch,
          worktreePath: worktreeMap.get(name) ?? null,
          ...(upstreamRef ? { upstreamRef } : {}),
        },
        lastCommit,
      });
      continue;
    }
    if (!fullRefName.startsWith("refs/remotes/")) continue;

    const name = fullRefName.slice("refs/remotes/".length);
    const parsedRemoteRef = parseRemoteRefWithRemoteNames(name, remoteNames);
    const remoteBranch: VcsRef = {
      name,
      current: false,
      isRemote: true,
      isDefault:
        defaultBranch !== null &&
        parsedRemoteRef?.remoteName === "origin" &&
        parsedRemoteRef.branchName === defaultBranch,
      worktreePath: null,
      ...(parsedRemoteRef ? { remoteName: parsedRemoteRef.remoteName } : {}),
    };
    remoteBranches.push({ ref: remoteBranch, lastCommit });
  }

  const byRecencyThenName = (
    left: { readonly ref: VcsRef; readonly lastCommit: number },
    right: { readonly ref: VcsRef; readonly lastCommit: number },
  ) =>
    left.lastCommit !== right.lastCommit
      ? right.lastCommit - left.lastCommit
      : left.ref.name.localeCompare(right.ref.name);

  return {
    localBranches: localBranches.toSorted(byRecencyThenName).map(({ ref }) => ref),
    remoteBranches: remoteBranches.toSorted(byRecencyThenName).map(({ ref }) => ref),
    hasPrimaryRemote: remoteNames.length > 0,
  } satisfies GitRefsSnapshot;
});

const listRefsEpochByCommonDir = new Map<string, number>();

let listRefsEpochSequence = 0;

const bumpListRefsEpoch = (gitCommonDir: string): number => {
  const nextEpoch = ++listRefsEpochSequence;
  listRefsEpochByCommonDir.delete(gitCommonDir);
  listRefsEpochByCommonDir.set(gitCommonDir, nextEpoch);
  if (listRefsEpochByCommonDir.size > LIST_REFS_SNAPSHOT_CACHE_CAPACITY) {
    const oldestKey = listRefsEpochByCommonDir.keys().next().value;
    if (oldestKey !== undefined) {
      listRefsEpochByCommonDir.delete(oldestKey);
    }
  }
  return nextEpoch;
};

const listRefsGenerationByCommonDir = new Map<string, number>();

let listRefsGenerationSequence = 0;

const setListRefsGeneration = (gitCommonDir: string, generation: number): number => {
  listRefsGenerationByCommonDir.delete(gitCommonDir);
  listRefsGenerationByCommonDir.set(gitCommonDir, generation);
  if (listRefsGenerationByCommonDir.size > LIST_REFS_SNAPSHOT_CACHE_CAPACITY) {
    const oldestKey = listRefsGenerationByCommonDir.keys().next().value;
    if (oldestKey !== undefined) {
      listRefsGenerationByCommonDir.delete(oldestKey);
    }
  }
  return generation;
};

const currentListRefsGeneration = (gitCommonDir: string): number => {
  const current = listRefsGenerationByCommonDir.get(gitCommonDir);
  return current === undefined
    ? setListRefsGeneration(gitCommonDir, ++listRefsGenerationSequence)
    : setListRefsGeneration(gitCommonDir, current);
};

const bumpListRefsGeneration = (gitCommonDir: string): number =>
  setListRefsGeneration(gitCommonDir, ++listRefsGenerationSequence);

const listRefsSnapshotCache = yield* Cache.makeWith(
  (cacheKey: GitRefsSnapshotCacheKey) => readGitRefsSnapshot(cacheKey.gitCommonDir),
  {
    capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_REFS_SNAPSHOT_CACHE_TTL : Duration.zero),
  },
);

const listRefsRefreshSnapshotCache = yield* Cache.makeWith(
  (cacheKey: GitRefsRefreshCacheKey) =>
    Effect.suspend(() => {
      const epoch = bumpListRefsEpoch(cacheKey.gitCommonDir);
      return Cache.get(
        listRefsSnapshotCache,
        new GitRefsSnapshotCacheKey({ gitCommonDir: cacheKey.gitCommonDir, epoch }),
      );
    }),
  {
    capacity: LIST_REFS_SNAPSHOT_CACHE_CAPACITY,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) ? LIST_REFS_REFRESH_COALESCE_TTL : LIST_REFS_REFRESH_FAILURE_COOLDOWN,
  },
);

const resolveListRefsSnapshot = Effect.fn("resolveListRefsSnapshot")(function* (
  gitCommonDir: string,
  refresh: boolean,
) {
  while (true) {
    const generation = currentListRefsGeneration(gitCommonDir);
    const currentEpoch = listRefsEpochByCommonDir.get(gitCommonDir);
    const snapshot =
      refresh || currentEpoch === undefined
        ? // Cache the entire snapshot read so slow scans stay single-flight beyond the coalescing TTL.
          yield* Cache.get(
            listRefsRefreshSnapshotCache,
            new GitRefsRefreshCacheKey({ gitCommonDir, generation }),
          )
        : yield* Cache.get(
            listRefsSnapshotCache,
            new GitRefsSnapshotCacheKey({ gitCommonDir, epoch: currentEpoch }),
          );
    if (currentListRefsGeneration(gitCommonDir) === generation) {
      return snapshot;
    }
  }
});

const invalidateListRefsSnapshot = Effect.fn("invalidateListRefsSnapshot")(function* (
  cwd: string,
  gitCommonDir?: string | null,
) {
  const repositoryPathsCacheKey = normalizeRepositoryPathsCacheKey(cwd);
  const commonDir =
    gitCommonDir === undefined
      ? (yield* Cache.get(repositoryPathsCache, repositoryPathsCacheKey))?.gitCommonDir
      : gitCommonDir;
  if (commonDir == null) return;
  const previousGeneration = currentListRefsGeneration(commonDir);
  bumpListRefsGeneration(commonDir);
  bumpListRefsEpoch(commonDir);
  yield* Cache.invalidate(
    listRefsRefreshSnapshotCache,
    new GitRefsRefreshCacheKey({
      gitCommonDir: commonDir,
      generation: previousGeneration,
    }),
  );
  yield* Cache.invalidate(repositoryPathsRefreshCache, repositoryPathsCacheKey);
  yield* Cache.invalidate(repositoryPathsCache, repositoryPathsCacheKey);
});

const listRefs: GitVcsDriver.GitVcsDriver["Service"]["listRefs"] = Effect.fn("listRefs")(
  function* (input) {
    const repositoryPaths = yield* resolveRepositoryPaths(input.cwd, input.refresh === true).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
    if (repositoryPaths === null) {
      return {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      };
    }

    const snapshot = yield* resolveListRefsSnapshot(
      repositoryPaths.gitCommonDir,
      input.refresh === true,
    );
    const hasCurrentWorktreeBranch =
      repositoryPaths.worktreeRoot !== null &&
      snapshot.localBranches.some((ref) => ref.worktreePath === repositoryPaths.worktreeRoot);
    const localBranches = snapshot.localBranches.map((ref) => ({
      ...ref,
      worktreePath:
        ref.worktreePath ??
        (ref.name === repositoryPaths.currentBranch ? repositoryPaths.worktreeRoot : null),
      current: hasCurrentWorktreeBranch
        ? ref.worktreePath === repositoryPaths.worktreeRoot
        : ref.name === repositoryPaths.currentBranch,
    }));
    const combinedBranches = input.includeMatchingRemoteRefs
      ? [...localBranches, ...snapshot.remoteBranches]
      : dedupeRemoteBranchesWithLocalMatches([...localBranches, ...snapshot.remoteBranches]);
    const allBranches = combinedBranches.toSorted((left, right) => {
      const leftPriority = left.current ? 0 : left.isDefault ? 1 : 2;
      const rightPriority = right.current ? 0 : right.isDefault ? 1 : 2;
      return leftPriority - rightPriority;
    });
    const branchesForKind =
      input.refKind === "local"
        ? allBranches.filter((ref) => !ref.isRemote)
        : input.refKind === "remote"
          ? allBranches.filter((ref) => ref.isRemote)
          : allBranches;
    const refs = paginateBranches({
      refs: filterBranchesForListQuery(branchesForKind, input.query),
      cursor: input.cursor,
      limit: input.limit,
    });

    return {
      ...(repositoryPaths.isAtRepositoryRoot === undefined
        ? {}
        : { isAtRepositoryRoot: repositoryPaths.isAtRepositoryRoot }),
      refs: [...refs.refs],
      isRepo: true,
      hasPrimaryRemote: snapshot.hasPrimaryRemote,
      nextCursor: refs.nextCursor,
      totalCount: refs.totalCount,
    };
  },
);

const createWorktree: GitVcsDriver.GitVcsDriver["Service"]["createWorktree"] = Effect.fn(
  "createWorktree",
)(function* (input, options) {
  yield* refuseOptionLikeRefName("GitVcsDriver.createWorktree", input.cwd, input.refName);
  yield* refuseOptionLikeRefName("GitVcsDriver.createWorktree", input.cwd, input.newRefName);
  const targetBranch = input.newRefName ?? input.refName;
  // Resolve sub/.. before taking the basename.
  const repoName = path.basename(path.resolve(input.cwd));
  let worktreePath = input.path;
  if (worktreePath == null) {
    const parentDir = resolveWorktreesDirectory(
      options?.worktreesDirectory ?? "",
      worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    );
    if (parentDir === null) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.createWorktree",
        command: "git worktree add",
        cwd: input.cwd,
        detail: `The worktree location "${options?.worktreesDirectory}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Worktrees.`,
      });
    }
    let directoryName = targetBranch.replace(/\//g, "-");
    // Leave room for files beneath the worktree on Windows, regardless of branch length.
    if (directoryName.length > 40) {
      const hash = yield* digest.digest(Digest.sha256, new TextEncoder().encode(targetBranch));
      // Avoid splitting a surrogate pair, which Git would list back as a different path.
      const prefix = directoryName.slice(0, 23).replace(/[\uD800-\uDBFF]$/, "");
      directoryName = `${prefix}-${Hex.encode(hash).slice(0, 16)}`;
    }
    worktreePath = path.join(parentDir, repoName, directoryName);
  }
  const newRefName = input.newRefName;
  if (newRefName) {
    // Kept apart from the checkout so the shared-config lock only covers the tracking write.
    yield* createBranchAt(
      "GitVcsDriver.createWorktree.createBranch",
      { cwd: input.cwd, branch: newRefName, startPoint: input.refName },
      "git worktree add failed",
    );
  }
  const args = ["worktree", "add", "--", worktreePath, newRefName ?? input.refName];
  const progress = options?.progress;
  const onCheckoutProgress = progress?.onCheckoutProgress;

  // Both reads leave the repository alone, so they share one round trip before the checkout.
  const [configuredCheckoutWorkers, base] = yield* Effect.all(
    [
      readConfigValue(input.cwd, "checkout.workers"),
      input.newRefName && input.baseRefName
        ? resolveBranchBase(input.cwd, input.baseRefName)
        : Effect.succeed(null),
    ],
    { concurrency: "unbounded" },
  );
  const checkoutWorkers = configuredCheckoutWorkers ?? "0";
  yield* executeGitWithStableDiagnostics(
    "GitVcsDriver.createWorktree",
    input.cwd,
    ["-c", `checkout.workers=${checkoutWorkers}`, ...args],
    {
      fallbackErrorDetail: "git worktree add failed",
      // Large checkouts and post-checkout hooks can legitimately run for many
      // minutes; a fixed deadline kills them and leaves an orphaned worktree.
      timeoutMs: null,
      ...(onCheckoutProgress
        ? {
            // Git only prints checkout progress when stderr is a tty or the
            // delay elapsed. GIT_PROGRESS_DELAY=0 forces it through the pipe.
            env: { GIT_PROGRESS_DELAY: "0" },
            progress: {
              onStderrLine: (line) => {
                const parsed = parseGitCheckoutProgressLine(line);
                return parsed ? onCheckoutProgress(parsed) : Effect.void;
              },
            },
          }
        : {}),
    },
  ).pipe(
    Effect.onError(() =>
      newRefName
        ? deleteLocalBranch({ cwd: input.cwd, refName: newRefName, force: true }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("could not remove the branch of a failed worktree", { cause }),
            ),
          )
        : Effect.void,
    ),
  );

  if (progress?.onWorktreeClaimed) {
    yield* progress.onWorktreeClaimed(worktreePath);
  }

  // worktree add leaves submodules empty, potentially omitting project skills, tools or source.
  const hasSubmodules = yield* fileSystem
    .exists(path.join(worktreePath, ".gitmodules"))
    .pipe(Effect.orElseSucceed(() => false));
  const submoduleMode = !hasSubmodules
    ? { value: "none" as const, source: "environment" as const }
    : resolveProjectFileBackedSetting(
        "worktreeSubmodules",
        options?.submodules ?? null,
        options?.submodules != null
          ? null
          : yield* fileSystem.readFileString(path.join(worktreePath, T3_PROJECT_FILE_NAME)).pipe(
              Effect.flatMap((contents) => {
                const file = parseT3ProjectFile(contents);
                return file === null
                  ? Effect.logWarning("t3.json is invalid; initializing submodules recursively", {
                      worktreePath,
                    }).pipe(Effect.as(null))
                  : Effect.succeed(file);
              }),
              Effect.orElseSucceed(() => null),
            ),
      );
  if (hasSubmodules && submoduleMode.value === "none" && progress?.onSubmodulesDisabled) {
    yield* progress.onSubmodulesDisabled({
      source: submoduleMode.source === "t3.json" ? "t3.json" : "settings",
    });
  }
  if (submoduleMode.value !== "none") {
    if (progress?.onSubmodulesStarted) {
      yield* progress.onSubmodulesStarted();
    }
    const onSubmoduleLine = progress?.onSubmoduleLine;
    // Registering submodule URLs writes the shared config; the clones that follow do not.
    yield* runGit(
      "GitVcsDriver.createWorktree.initSubmodules",
      worktreePath,
      ["submodule", "init"],
      { writesSharedConfig: true },
    ).pipe(
      Effect.andThen(
        runGit(
          "GitVcsDriver.createWorktree.updateSubmodules",
          worktreePath,
          submoduleMode.value === "recursive"
            ? ["submodule", "update", "--init", "--recursive"]
            : ["submodule", "update", "--init"],
          {
            // Cloning scales with remote size; let it finish or be cancelled, like worktree add.
            timeoutMs: null,
            ...(onSubmoduleLine
              ? {
                  env: { LANGUAGE: "C" },
                  progress: { onStdoutLine: onSubmoduleLine, onStderrLine: onSubmoduleLine },
                }
              : {}),
          },
        ),
      ),
      Effect.matchEffect({
        onFailure: (cause) =>
          Effect.logWarning("worktree submodule checkout failed; submodules may be incomplete", {
            worktreePath,
            cause,
          }).pipe(
            Effect.andThen(
              progress?.onSubmodulesFinished
                ? progress.onSubmodulesFinished({ ok: false, detail: cause.message })
                : Effect.void,
            ),
          ),
        onSuccess: () =>
          progress?.onSubmodulesFinished
            ? progress.onSubmodulesFinished({ ok: true, detail: null })
            : Effect.void,
      }),
    );
  }

  if (newRefName && base) {
    yield* Effect.gen(function* () {
      yield* writeConfigValue({
        cwd: input.cwd,
        key: branchBaseConfigKey(newRefName),
        value: base.branchName,
      });
      if (base.baseRef.startsWith("refs/remotes/")) {
        // The base key names a branch on the host; this one keeps the remote it came from.
        yield* writeConfigValue({
          cwd: input.cwd,
          key: `branch.${newRefName}.t3-merge-base-ref`,
          value: base.baseRef,
        });
      }
    }).pipe(
      Effect.catchTags({
        GitCommandError: () =>
          Effect.logWarning("worktree base-ref configuration failed; using base-branch fallback"),
      }),
    );
  }

  return {
    worktree: {
      path: worktreePath,
      refName: targetBranch,
    },
  };
});

const fetchRefIntoBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRefIntoBranch"] = Effect.fn(
  "GitVcsDriver.fetchRefIntoBranch",
)(function* (input) {
  const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
  yield* executeGit(
    "GitVcsDriver.fetchRefIntoBranch",
    input.cwd,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--",
      remoteName,
      `+${input.ref}:refs/heads/${input.branch}`,
    ],
    {
      fallbackErrorDetail: "git fetch ref into branch failed",
    },
  );
});

const resolveCommit: GitVcsDriver.GitVcsDriver["Service"]["resolveCommit"] = Effect.fn(
  "resolveCommit",
)(function* (input) {
  const commitSha = yield* runGitStdout("GitVcsDriver.resolveCommit", input.cwd, [
    "rev-parse",
    "--verify",
    `${input.revision}^{commit}`,
  ]).pipe(Effect.map((stdout) => stdout.trim()));

  return { commitSha };
});

const fetchRefCommit: GitVcsDriver.GitVcsDriver["Service"]["fetchRefCommit"] = Effect.fn(
  "GitVcsDriver.fetchRefCommit",
)(function* (input) {
  const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
  // No refspec destination: the ref lands in FETCH_HEAD (per worktree) instead of a branch,
  // which is the only way to read it while that branch is checked out somewhere.
  yield* executeGit(
    "GitVcsDriver.fetchRefCommit",
    input.cwd,
    ["fetch", "--quiet", "--no-tags", "--", remoteName, input.ref],
    {
      fallbackErrorDetail: "git fetch ref failed",
    },
  );

  return yield* resolveCommit({ cwd: input.cwd, revision: "FETCH_HEAD" });
});

const deleteLocalBranch: GitVcsDriver.GitVcsDriver["Service"]["deleteLocalBranch"] = Effect.fn(
  "deleteLocalBranch",
)(function* (input) {
  yield* executeGit(
    "GitVcsDriver.deleteLocalBranch",
    input.cwd,
    ["branch", input.force === true ? "-D" : "-d", "--", input.refName],
    {
      timeoutMs: 10_000,
      fallbackErrorDetail: "git branch delete failed",
      // Under contention Git deletes the ref but keeps its config section.
      writesSharedConfig: true,
    },
  );
});

  return { readGitRefsSnapshot, listRefsEpochByCommonDir, listRefsEpochSequence, bumpListRefsEpoch, listRefsGenerationByCommonDir, listRefsGenerationSequence, setListRefsGeneration, currentListRefsGeneration, bumpListRefsGeneration, listRefsSnapshotCache, listRefsRefreshSnapshotCache, resolveListRefsSnapshot, invalidateListRefsSnapshot, listRefs, createWorktree, fetchRefIntoBranch, resolveCommit, fetchRefCommit, deleteLocalBranch };
});

export type CreateWorktreePart = ReturnType<typeof installCreateWorktree> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installCreateWorktree>;
