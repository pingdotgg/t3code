import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import { GitCommandError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as GitVcsDriver from "../GitVcsDriver.ts";
import { NON_REPOSITORY_STATUS_DETAILS, REVIEW_DIFF_ARGS, REVIEW_METADATA_MAX_OUTPUT_BYTES, REVIEW_UNTRACKED_MAX_FILES, gitCommandContext, isMissingGitCwdError, isNonRepositoryGitStderr, isUnbornHeadStderr, parseBranchAb, parsePorcelainPath, parseReviewNumstat, splitNullSeparatedGitStdoutPaths } from "../GitVcsDriverCorePrelude/FetchFailureDetail.ts";
import type { ExecuteRawPart } from "./ExecuteRaw.ts";
import type { ResolveBaseBranchForNoUpstreamPart } from "./ResolveBaseBranchForNoUpstream.ts";

type Deps = Record<never, never> & ExecuteRawPart & ResolveBaseBranchForNoUpstreamPart;

export const installReadStatusDetailsLocal = Effect.fnUntraced(function* (deps: Deps) {
  const { branchExists, computeAheadCountAgainstBase, defaultBranchCache, executeGit, executeGitWithStableDiagnostics, fileSystem, listRemoteNames, path, primaryRemoteExistsCache, readStatusDetailsRemote, refreshStatusUpstreamIfStale, resolveDefaultBranchName, resolveRepositoryPaths, resolveReviewMergeBase, runGit, runGitStdout, runGitStdoutWithOptions } = deps;

const readStatusDetailsLocal = Effect.fn("readStatusDetailsLocal")(function* (
  cwd: string,
  options?: GitVcsDriver.GitLocalStatusOptions,
) {
  const includeDivergence = options?.includeDivergence !== false;
  const statusArgs = [
    "status",
    "--porcelain=2",
    "--branch",
    "-z",
    ...(includeDivergence ? [] : ["--no-ahead-behind"]),
  ];
  const indexResult = yield* executeGitWithStableDiagnostics(
    "GitVcsDriver.statusDetails.indexPath",
    cwd,
    ["rev-parse", "--git-path", "index"],
    { allowNonZeroExit: true },
  ).pipe(
    Effect.catchTags({
      GitCommandError: (error) =>
        isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
    }),
  );
  if (indexResult === null) return NON_REPOSITORY_STATUS_DETAILS;
  if (indexResult.exitCode === 0) {
    const lockPath = `${path.resolve(cwd, indexResult.stdout.trim())}.lock`;
    const lockError = new GitCommandError({
      operation: "GitVcsDriver.statusDetails.indexPath",
      command: "git",
      cwd,
      detail: "Git index is locked. Status will resume when the index lock is removed.",
    });
    // Status can succeed while locked, repeatedly running LFS clean filters without caching.
    if (
      yield* fileSystem.exists(lockPath).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              ...lockError,
              detail: "Failed to check the Git index lock.",
              cause,
            }),
        ),
      )
    ) {
      return yield* lockError;
    }
  }
  const repositoryPaths = yield* resolveRepositoryPaths(cwd).pipe(
    Effect.catchTags({ GitCommandError: () => Effect.succeed(null) }),
  );
  const statusCacheKey = repositoryPaths?.gitCommonDir;
  const readStatus = executeGitWithStableDiagnostics(
    "GitVcsDriver.statusDetails.status",
    cwd,
    statusArgs,
    {
      allowNonZeroExit: true,
      maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES,
    },
  ).pipe(
    Effect.catchTags({
      GitCommandError: (error) =>
        isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
    }),
  );
  // diff-index does not read status output, so both spawn together; a non-repository discards it.
  const [statusResult, numstatResult, defaultBranch, hasPrimaryRemote] = yield* Effect.all(
    [
      readStatus,
      // Porcelain diff rewrites indexes despite GIT_OPTIONAL_LOCKS=0; plumbing with -M preserves rename detection.
      executeGitWithStableDiagnostics(
        "GitVcsDriver.statusDetails.numstat",
        cwd,
        ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"],
        { allowNonZeroExit: true, maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
      ).pipe(
        Effect.flatMap((result) => {
          if (result.exitCode === 0) return Effect.succeed(parseReviewNumstat(result.stdout));
          if (isUnbornHeadStderr(result.stderr)) {
            return Effect.map(
              Effect.all([
                runGitStdoutWithOptions(
                  "GitVcsDriver.statusDetails.numstat.unborn",
                  cwd,
                  ["diff-files", "--numstat", "-z"],
                  { maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
                ),
                runGitStdoutWithOptions(
                  "GitVcsDriver.statusDetails.numstat.unborn.staged",
                  cwd,
                  ["diff", "--cached", "--numstat", "-z"],
                  { maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
                ),
              ]),
              ([unstagedStdout, stagedStdout]) => [
                ...parseReviewNumstat(stagedStdout),
                ...parseReviewNumstat(unstagedStdout),
              ],
            );
          }
          return Effect.fail(
            new GitCommandError({
              ...gitCommandContext({
                operation: "GitVcsDriver.statusDetails.numstat",
                cwd,
                args: ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"],
              }),
              detail: "git diff-index HEAD --numstat failed.",
              exitCode: result.exitCode,
              stdoutLength: result.stdout.length,
              stderrLength: result.stderr.length,
            }),
          );
        }),
        Effect.result,
      ),
      statusCacheKey
        ? Cache.get(defaultBranchCache, statusCacheKey).pipe(Effect.orElseSucceed(() => null))
        : resolveDefaultBranchName(cwd, "origin").pipe(Effect.orElseSucceed(() => null)),
      statusCacheKey
        ? Cache.get(primaryRemoteExistsCache, statusCacheKey).pipe(
            Effect.orElseSucceed(() => false),
          )
        : listRemoteNames(cwd).pipe(
            Effect.map((remoteNames) => remoteNames.length > 0),
            Effect.orElseSucceed(() => false),
          ),
    ],
    { concurrency: "unbounded" },
  );
  if (statusResult === null) {
    return NON_REPOSITORY_STATUS_DETAILS;
  }

  if (statusResult.exitCode !== 0) {
    if (isNonRepositoryGitStderr(statusResult.stderr)) {
      return NON_REPOSITORY_STATUS_DETAILS;
    }
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.statusDetails.status",
        cwd,
        args: statusArgs,
      }),
      detail: "Git status failed.",
      exitCode: statusResult.exitCode,
      stdoutLength: statusResult.stdout.length,
      stderrLength: statusResult.stderr.length,
    });
  }

  const numstatEntries = yield* Effect.fromResult(numstatResult);
  const statusStdout = statusResult.stdout;

  let refName: string | null = null;
  let upstreamRef: string | null = null;
  let aheadCount = 0;
  let behindCount = 0;
  let aheadOfDefaultCount = 0;
  let hasWorkingTreeChanges = false;
  const changedFilesWithoutNumstat = new Set<string>();
  const untrackedRoots: string[] = [];

  const statusRecords = statusStdout.split("\0");
  for (let index = 0; index < statusRecords.length; index++) {
    const line = statusRecords[index]!;
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      refName = value.startsWith("(") ? null : value;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      const value = line.slice("# branch.upstream ".length).trim();
      upstreamRef = value.length > 0 ? value : null;
      continue;
    }
    if (includeDivergence && line.startsWith("# branch.ab ")) {
      const value = line.slice("# branch.ab ".length).trim();
      const parsed = parseBranchAb(value);
      aheadCount = parsed.ahead;
      behindCount = parsed.behind;
      continue;
    }
    if (line.length > 0 && !line.startsWith("#")) {
      hasWorkingTreeChanges = true;
      const pathValue = parsePorcelainPath(line);
      if (pathValue) {
        changedFilesWithoutNumstat.add(pathValue);
        if (line.startsWith("? ")) untrackedRoots.push(pathValue);
      }
      // A rename record is followed by its original path as a separate record. Listing it
      // keeps the deletion selectable when committing only some files.
      if (line.startsWith("2 ")) {
        const originalPath = statusRecords[++index];
        if (originalPath) changedFilesWithoutNumstat.add(originalPath);
      }
    }
  }

  const isDefaultBranch =
    refName !== null &&
    (refName === defaultBranch ||
      (defaultBranch === null && (refName === "main" || refName === "master")));
  const needsFallbackAhead = includeDivergence && !upstreamRef && refName !== null;
  const needsAheadOfDefault = includeDivergence && refName !== null && !isDefaultBranch;
  const [baseAheadCount, branchChanges] = yield* Effect.all(
    [
      refName !== null && (needsFallbackAhead || needsAheadOfDefault)
        ? computeAheadCountAgainstBase(cwd, refName, {
            knownOriginDefaultBranch: defaultBranch,
          }).pipe(Effect.orElseSucceed(() => 0))
        : Effect.succeed(0),
      options?.includeBranchChanges
        ? readBranchChangeTotals(repositoryPaths?.worktreeRoot ?? cwd, refName, {
            knownOriginDefaultBranch: defaultBranch,
            untrackedRoots,
          }).pipe(Effect.orElseSucceed(() => undefined))
        : Effect.undefined,
    ],
    { concurrency: "unbounded" },
  );

  if (needsFallbackAhead) {
    aheadCount = baseAheadCount;
    behindCount = 0;
  }
  if (needsAheadOfDefault) {
    aheadOfDefaultCount = baseAheadCount;
  }

  const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
  for (const entry of numstatEntries) {
    const stat = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
    stat.insertions += entry.additions;
    stat.deletions += entry.deletions;
    fileStatMap.set(entry.path, stat);
  }

  let insertions = 0;
  let deletions = 0;
  const files = Array.from(fileStatMap.entries()).map(([filePath, stat]) => {
    insertions += stat.insertions;
    deletions += stat.deletions;
    return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
  });

  for (const filePath of changedFilesWithoutNumstat) {
    if (fileStatMap.has(filePath)) continue;
    files.push({ path: filePath, insertions: 0, deletions: 0 });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    isRepo: true,
    hasOriginRemote: hasPrimaryRemote,
    isDefaultBranch,
    branch: refName,
    upstreamRef,
    hasWorkingTreeChanges,
    workingTree: {
      ...(repositoryPaths?.worktreeRoot ? { rootPath: repositoryPaths.worktreeRoot } : {}),
      files,
      insertions,
      deletions,
    },
    ...(branchChanges ? { branchChanges } : {}),
    hasUpstream: upstreamRef !== null,
    aheadCount,
    behindCount,
    aheadOfDefaultCount,
  };
});

const statusDetailsLocal: GitVcsDriver.GitVcsDriver["Service"]["statusDetailsLocal"] = Effect.fn(
  "statusDetailsLocal",
)(function* (cwd, options) {
  return yield* readStatusDetailsLocal(cwd, options);
});

const statusDetails: GitVcsDriver.GitVcsDriver["Service"]["statusDetails"] = Effect.fn(
  "statusDetails",
)(function* (cwd) {
  yield* refreshStatusUpstreamIfStale(cwd).pipe(
    Effect.catchTags({
      GitCommandError: (error) =>
        isMissingGitCwdError(error) ? Effect.void : Effect.fail(error),
    }),
    Effect.ignoreCause({ log: true }),
  );
  return yield* readStatusDetailsLocal(cwd);
});

const statusDetailsRemote: GitVcsDriver.GitVcsDriver["Service"]["statusDetailsRemote"] =
  Effect.fn("statusDetailsRemote")(function* (cwd, options) {
    if (options?.refreshUpstream !== false) {
      yield* refreshStatusUpstreamIfStale(cwd).pipe(
        Effect.catchTags({
          GitCommandError: (error) =>
            isMissingGitCwdError(error) ? Effect.void : Effect.fail(error),
        }),
        Effect.ignoreCause({ log: true }),
      );
    }
    return yield* readStatusDetailsRemote(cwd);
  });

const status: GitVcsDriver.GitVcsDriver["Service"]["status"] = (input) =>
  statusDetails(input.cwd).pipe(
    Effect.map((details) => ({
      isRepo: details.isRepo,
      hasPrimaryRemote: details.hasOriginRemote,
      isDefaultRef: details.isDefaultBranch,
      refName: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      workingTree: details.workingTree,
      hasUpstream: details.hasUpstream,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
      aheadOfDefaultCount: details.aheadOfDefaultCount,
      pr: null,
    })),
  );

const stageCommitChanges = Effect.fnUntraced(function* (
  cwd: string,
  filePaths?: readonly string[],
  env?: NodeJS.ProcessEnv,
) {
  const config = env
    ? ["-c", "core.splitIndex=false", "-c", "splitIndex.sharedIndexExpire=never"]
    : [];
  if (filePaths && filePaths.length > 0) {
    if (env) {
      const head = yield* executeGit(
        "GitVcsDriver.prepareCommitContext.head",
        cwd,
        ["rev-parse", "--verify", "--quiet", "HEAD"],
        { allowNonZeroExit: true },
      );
      // Even with GIT_INDEX_FILE, reset clears the repository's merge state.
      yield* runGit(
        "GitVcsDriver.prepareCommitContext.readTree",
        cwd,
        [...config, "read-tree", ...(head.exitCode === 0 ? ["HEAD"] : ["--empty"])],
        { env },
      );
    } else {
      const mergeHeadPath = yield* runGitStdout("GitVcsDriver.commit.mergeHead", cwd, [
        "rev-parse",
        "--git-path",
        "MERGE_HEAD",
      ]);
      const isMerging = yield* fileSystem.exists(path.resolve(cwd, mergeHeadPath.trim())).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.commit.mergeHead",
              command: "git commit",
              cwd,
              detail: "Could not check whether a merge is in progress.",
              cause,
            }),
        ),
      );
      // Like git commit --only, reject partial merges before reset can discard their ancestry.
      if (isMerging) {
        return yield* new GitCommandError({
          operation: "GitVcsDriver.commit",
          command: "git commit",
          cwd,
          detail:
            "Cannot commit selected files during a merge. Commit all files to finish the merge.",
        });
      }
      yield* runGit("GitVcsDriver.commit.reset", cwd, ["reset", "--quiet"]);
    }
    yield* runGit(
      "GitVcsDriver.commit.addSelected",
      cwd,
      // Status paths are repository-relative, while cwd can be a subdirectory.
      [...config, "add", "-A", "--", ...filePaths.map((file) => `:(top,literal)${file}`)],
      env ? { env } : {},
    );
  } else {
    yield* runGit(
      "GitVcsDriver.commit.addAll",
      cwd,
      [...config, "add", "-A"],
      env ? { env } : {},
    );
  }
});

const prepareReviewIndex = Effect.fn("prepareReviewIndex")(function* (
  cwd: string,
  untrackedPaths: ReadonlyArray<string>,
) {
  const [stagedDeletionsStdout, indexValue] = yield* Effect.all(
    [
      runGitStdoutWithOptions(
        "GitVcsDriver.readUnifiedWorkingTreeReviewDiff.stagedDeletions",
        cwd,
        [
          "diff",
          "--cached",
          "--no-renames",
          "--name-only",
          "--diff-filter=D",
          "-z",
          "HEAD",
          "--",
        ],
        { allowNonZeroExit: true, maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
      ),
      runGitStdout("GitVcsDriver.readUnifiedWorkingTreeReviewDiff.indexPath", cwd, [
        "rev-parse",
        "--git-path",
        "index",
      ]),
    ],
    { concurrency: 2 },
  );
  const stagedDeletions = new Set(stagedDeletionsStdout.split("\0").filter(Boolean));
  const pathsToAdd = untrackedPaths.filter((relativePath) => !stagedDeletions.has(relativePath));
  if (pathsToAdd.length === 0) return undefined;

  const indexPath = path.isAbsolute(indexValue.trim())
    ? indexValue.trim()
    : path.resolve(cwd, indexValue.trim());
  const tempIndexPath = yield* fileSystem.makeTempFileScoped({
    prefix: `t3code-review-index-${process.pid}-`,
  });
  const indexExists = yield* fileSystem.exists(indexPath);
  if (indexExists) {
    const { mtime } = yield* fileSystem.stat(indexPath);
    yield* fileSystem.copyFile(indexPath, tempIndexPath);
    // stat truncates bigint times to ms; floor seconds to avoid making preceding-second files racy.
    const indexTime = Option.isSome(mtime)
      ? Math.max(0, Math.floor(mtime.value.getTime() / 1000))
      : 0;
    yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
  }
  const env = { GIT_INDEX_FILE: tempIndexPath } satisfies NodeJS.ProcessEnv;
  const tempIndexConfig = [
    "-c",
    "core.splitIndex=false",
    "-c",
    "splitIndex.sharedIndexExpire=never",
  ];
  if (!indexExists) {
    yield* executeGit("GitVcsDriver.review.emptyIndex", cwd, ["read-tree", "--empty"], { env });
  }
  yield* executeGit(
    "GitVcsDriver.readUnifiedWorkingTreeReviewDiff.expandSplitIndex",
    cwd,
    [...tempIndexConfig, "update-index", "--no-split-index"],
    { env },
  );
  yield* executeGit(
    "GitVcsDriver.readUnifiedWorkingTreeReviewDiff.addUntracked",
    cwd,
    [
      ...tempIndexConfig,
      // Avoid redundant tracked-entry pathspec matching in this disposable index.
      "-c",
      "core.preloadIndex=false",
      // Sparse checkout refuses to add untracked files outside the cone, failing the whole review.
      "-c",
      "core.sparseCheckout=false",
      "--literal-pathspecs",
      "add",
      "--intent-to-add",
      "--pathspec-from-file=-",
      "--pathspec-file-nul",
    ],
    { env, stdin: `${pathsToAdd.join("\0")}\0` },
  );
  return env;
});

const readEmptyTreeHash = Effect.fn("readEmptyTreeHash")(function* (cwd: string) {
  const stdout = yield* runGitStdout("GitVcsDriver.review.emptyTree", cwd, [
    "hash-object",
    "-t",
    "tree",
    (yield* HostProcess.Platform) === "win32" ? "NUL" : "/dev/null",
  ]);
  return stdout.trim();
});

const prepareUntrackedReviewIndex = Effect.fn("prepareUntrackedReviewIndex")(function* (
  cwd: string,
  pathArgs: ReadonlyArray<string>,
  onlyPath?: string,
) {
  const untracked = yield* executeGit(
    "GitVcsDriver.review.listUntracked",
    cwd,
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathArgs],
    { maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES },
  ).pipe(Effect.orElseSucceed(() => null));
  if (untracked === null) return null;
  // ls-files lists a nested repository with a trailing slash; its diff path has none.
  const paths = splitNullSeparatedGitStdoutPaths(untracked).filter(
    (candidate) =>
      onlyPath === undefined || candidate === onlyPath || candidate === `${onlyPath}/`,
  );
  if (paths.length === 0) return { env: undefined };
  if (paths.length > REVIEW_UNTRACKED_MAX_FILES) return null;
  const env = yield* prepareReviewIndex(cwd, paths).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        Effect.fail(
          new GitCommandError({
            operation: "GitVcsDriver.prepareReviewIndex",
            cwd,
            command: "git diff",
            detail: "Could not prepare the review index.",
            cause,
          }),
        ),
    }),
  );
  return { env };
});

const readBranchChangeTotals = Effect.fn("readBranchChangeTotals")(function* (
  cwd: string,
  branch: string | null,
  options?: {
    readonly knownOriginDefaultBranch: string | null;
    readonly untrackedRoots: ReadonlyArray<string>;
  },
) {
  const resolved = yield* resolveReviewMergeBase(
    cwd,
    branch,
    undefined,
    options?.knownOriginDefaultBranch ?? null,
  );
  // A rename after `git status` read HEAD moves the base config away, so the base was guessed.
  const { baseRef, mergeBase } =
    branch === null || (yield* branchExists(cwd, branch))
      ? resolved
      : { baseRef: null, mergeBase: "HEAD" };
  const roots = options?.untrackedRoots ?? [];
  // Bound pathspec matching work and stay below Windows' command-line limit.
  const pathspecs =
    roots.length <= 128 && roots.reduce((length, root) => length + root.length + 16, 0) < 8_000
      ? roots.map((root) => `:(top,literal)${root}`)
      : [];
  // Empty status can mean untracked files are hidden; retain the full scan.
  const untracked = yield* prepareUntrackedReviewIndex(cwd, pathspecs);
  if (untracked === null) {
    return yield* new GitCommandError({
      operation: "GitVcsDriver.readBranchChangeTotals",
      command: "git ls-files",
      cwd,
      detail: "Too many untracked files to count.",
    });
  }
  const readNumstat = (ref: string) =>
    executeGit(
      "GitVcsDriver.readBranchChangeTotals",
      cwd,
      [...REVIEW_DIFF_ARGS, "--numstat", "-z", ref, "--"],
      {
        allowNonZeroExit: true,
        maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES,
        env: untracked.env,
      },
    );
  let result = yield* readNumstat(mergeBase);
  if (result.exitCode !== 0 && mergeBase === "HEAD" && isUnbornHeadStderr(result.stderr)) {
    result = yield* readNumstat(yield* readEmptyTreeHash(cwd));
  }
  if (result.exitCode !== 0) {
    return yield* new GitCommandError({
      operation: "GitVcsDriver.readBranchChangeTotals",
      command: "git diff --numstat",
      cwd,
      detail: "Could not read Changes totals.",
      exitCode: result.exitCode,
    });
  }
  let insertions = 0;
  let deletions = 0;
  for (const file of parseReviewNumstat(result.stdout)) {
    insertions += file.additions;
    deletions += file.deletions;
  }
  return { baseRef, insertions, deletions };
}, Effect.scoped);

  return { readStatusDetailsLocal, statusDetailsLocal, statusDetails, statusDetailsRemote, status, stageCommitChanges, prepareReviewIndex, readEmptyTreeHash, prepareUntrackedReviewIndex, readBranchChangeTotals };
});

export type ReadStatusDetailsLocalPart = ReturnType<typeof installReadStatusDetailsLocal> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installReadStatusDetailsLocal>;
