import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { GitCommandError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../../observability/Metrics.ts";
import * as GitVcsDriver from "../GitVcsDriver.ts";
import { explicitBareRepositoryEnv } from "../VcsProcess.ts";
import { parseRemoteNames } from "../../git/remoteRefs.ts";
import { makeIsServerInternalPath } from "../../auth/serverInternalPaths.ts";
import * as ServerConfig from "../../config.ts";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, NON_REPOSITORY_PATHS_CACHE_TTL, OUTPUT_TRUNCATED_MARKER, REPOSITORY_PATHS_CACHE_CAPACITY, REPOSITORY_PATHS_CACHE_TTL, REPOSITORY_PATHS_REFRESH_COALESCE_TTL, STATUS_UPSTREAM_FETCH_TIMEOUT, STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY, STATUS_UPSTREAM_REFRESH_ENV, STATUS_UPSTREAM_REFRESH_TIMEOUT, branchNameFromHeadRef, classifyGitFailure, gitCommandContext, gitFailureDetail, gitProcesses, isNonRepositoryGitStderr, parseUpstreamRefByFirstSeparator, parseUpstreamRefWithRemoteNames, statusUpstreamRefreshFailureCooldown, type ExecuteGitOptions, type GitRepositoryPaths } from "../GitVcsDriverCorePrelude/FetchFailureDetail.ts";
import { collectOutput, createTrace2Monitor, windowsLongPathConfigEnv } from "../GitVcsDriverCorePrelude/CreateTrace2Monitor.ts";
type Deps = Record<never, never>;

export const installExecuteRaw = Effect.fnUntraced(function* (deps: Deps) {
const fileSystem = yield* FileSystem.FileSystem;

const path = yield* Path.Path;

const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

const { worktreesDir } = yield* ServerConfig.ServerConfig;

const isServerInternalPath = yield* makeIsServerInternalPath;

const digest = yield* Digest.Digest;

const hostPlatform = yield* HostProcess.Platform;

const serviceScope = yield* Effect.scope;

const statusFetches = new Map<string, Fiber.Fiber<void, GitCommandError>>();

const statusFetchProcesses = yield* Semaphore.make(4);

const executeRaw: GitVcsDriver.GitVcsDriver["Service"]["execute"] = Effect.fnUntraced(
  function* (input) {
    const commandInput = {
      ...input,
      args: [...input.args],
    } as const;
    const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const appendTruncationMarker = input.appendTruncationMarker ?? false;

    const runGitCommand = Effect.fn("runGitCommand")(function* () {
      const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress).pipe(
        Effect.provideService(Path.Path, path),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              ...gitCommandContext(commandInput),
              detail: "Failed to create Git trace monitor.",
              cause,
            }),
        ),
      );
      const baseEnv = {
        ...process.env,
        // Concurrent status polls must not take index.lock to save refreshed indexes.
        GIT_OPTIONAL_LOCKS: "0",
        ...input.env,
        ...trace2Monitor.env,
      };
      const env = { ...baseEnv, ...explicitBareRepositoryEnv(baseEnv, hostPlatform) };
      const spawnEnv = { ...env, ...windowsLongPathConfigEnv(hostPlatform, env) };
      const resolved = yield* resolveSpawnCommand("git", [], { env: spawnEnv });
      // cmd wrappers truncate multiline commits; leave git.cmd handling to Node lookup.
      const executable = resolved.shell ? "git" : resolved.command;
      const child = yield* commandSpawner
        .spawn(
          ChildProcess.make(executable, commandInput.args, {
            cwd: commandInput.cwd,
            env: spawnEnv,
            forceKillAfter: input.forceKillAfterMs,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                ...gitCommandContext(commandInput),
                detail: "Failed to spawn Git process.",
                cause,
              }),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectOutput(
            commandInput,
            child.stdout,
            maxOutputBytes,
            appendTruncationMarker,
            input.progress?.onStdoutLine,
            input.keepLineCallbacksAfterTruncation,
          ),
          collectOutput(
            commandInput,
            child.stderr,
            maxOutputBytes,
            appendTruncationMarker,
            input.progress?.onStderrLine,
            input.keepLineCallbacksAfterTruncation,
          ),
          child.exitCode.pipe(
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  ...gitCommandContext(commandInput),
                  detail: "Failed to read Git process exit code.",
                  cause,
                }),
            ),
          ),
          input.stdin === undefined
            ? Effect.void
            : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
                Effect.mapError(
                  (cause) =>
                    new GitCommandError({
                      ...gitCommandContext(commandInput),
                      detail: "Failed to write Git process input.",
                      cause,
                    }),
                ),
              ),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map(([stdout, stderr, exitCode]) => [stdout, stderr, exitCode] as const));
      yield* trace2Monitor.flush;

      if (!input.allowNonZeroExit && exitCode !== 0) {
        const reason = classifyGitFailure(stderr.text);
        return yield* new GitCommandError({
          ...gitCommandContext(commandInput),
          ...(reason === null ? {} : { reason }),
          detail: gitFailureDetail(reason),
          exitCode,
          stdoutLength: stdout.text.length,
          stderrLength: stderr.text.length,
        });
      }

      return {
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      } satisfies GitVcsDriver.ExecuteGitResult;
    });

    const execution = runGitCommand().pipe(Effect.scoped);
    if (timeoutMs === null) {
      return yield* execution;
    }

    return yield* execution.pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap((result) =>
        Effect.fromOption(
          result,
          () =>
            new GitCommandError({
              ...gitCommandContext(commandInput),
              detail: "Git command timed out.",
            }),
        ),
      ),
    );
  },
);

const sharedConfigLocks = new Map<string, Semaphore.Semaphore>();

const withSharedConfigLock = <A, E>(cwd: string, effect: Effect.Effect<A, E>) =>
  resolveRepositoryPaths(cwd).pipe(
    Effect.orElseSucceed(() => null),
    Effect.flatMap((repositoryPaths) => {
      if (repositoryPaths === null) return effect;
      let lock = sharedConfigLocks.get(repositoryPaths.gitCommonDir);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        sharedConfigLocks.set(repositoryPaths.gitCommonDir, lock);
      }
      return lock.withPermit(effect);
    }),
  );

const execute: GitVcsDriver.GitVcsDriver["Service"]["execute"] = (input) =>
  executeRaw(input).pipe(
    withMetrics({
      counter: gitCommandsTotal,
      timer: gitCommandDuration,
      attributes: {
        operation: input.operation,
      },
    }),
    (execution) =>
      input.timeoutMs === null || (input.timeoutMs ?? DEFAULT_TIMEOUT_MS) > DEFAULT_TIMEOUT_MS
        ? execution
        : gitProcesses.withPermits(1)(execution),
    Effect.withSpan(input.operation, {
      kind: "client",
      attributes: {
        "git.operation": input.operation,
        "git.cwd": input.cwd,
        "git.args_count": input.args.length,
      },
    }),
    // Outside the process permit: resolving the repository may itself need one.
    (execution) =>
      input.writesSharedConfig ? withSharedConfigLock(input.cwd, execution) : execution,
  );

const executeGit = (
  operation: string,
  cwd: string,
  args: readonly string[],
  options: ExecuteGitOptions = {},
): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
  execute({
    operation,
    cwd,
    args,
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    allowNonZeroExit: true,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.forceKillAfterMs !== undefined
      ? { forceKillAfterMs: options.forceKillAfterMs }
      : {}),
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options.appendTruncationMarker !== undefined
      ? { appendTruncationMarker: options.appendTruncationMarker }
      : {}),
    ...(options.progress ? { progress: options.progress } : {}),
    ...(options.writesSharedConfig ? { writesSharedConfig: true } : {}),
  }).pipe(
    Effect.flatMap((result) => {
      if (options.allowNonZeroExit || result.exitCode === 0) {
        return Effect.succeed(result);
      }
      const reason = classifyGitFailure(result.stderr);
      return Effect.fail(
        new GitCommandError({
          ...gitCommandContext({ operation, cwd, args }),
          ...(reason === null ? {} : { reason }),
          detail: options.fallbackErrorDetail ?? gitFailureDetail(reason),
          ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
          stdoutLength: result.stdout.length,
          stderrLength: result.stderr.length,
        }),
      );
    }),
  );

const executeGitWithStableDiagnostics = (
  operation: string,
  cwd: string,
  args: readonly string[],
  options: ExecuteGitOptions = {},
): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
  executeGit(operation, cwd, args, {
    ...options,
    env: {
      ...options.env,
      // English diagnostics without overriding LC_CTYPE, which hooks inherit.
      LANGUAGE: "C",
    },
  });

const runGit = (
  operation: string,
  cwd: string,
  args: readonly string[],
  options: ExecuteGitOptions = {},
): Effect.Effect<void, GitCommandError> =>
  executeGit(operation, cwd, args, options).pipe(Effect.asVoid);

const runGitStdout = (
  operation: string,
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
): Effect.Effect<string, GitCommandError> =>
  executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
    Effect.map((result) => result.stdout),
  );

const executeWorktreeList = Effect.fn("executeWorktreeList")(function* (
  operation: string,
  cwd: string,
  gitArgs: readonly string[],
  options: ExecuteGitOptions = {},
) {
  const args = [...gitArgs, "worktree", "list", "--porcelain"];
  const result = yield* executeGit(operation, cwd, [...args, "-z"], {
    ...options,
    allowNonZeroExit: true,
  });
  if (result.exitCode === 0) return result;
  const lineResult = yield* executeGit(operation, cwd, args, options);
  return { ...lineResult, stdout: lineResult.stdout.replaceAll("\n", "\0") };
});

const runGitStdoutWithOptions = (
  operation: string,
  cwd: string,
  args: readonly string[],
  options: ExecuteGitOptions = {},
): Effect.Effect<string, GitCommandError> =>
  executeGit(operation, cwd, args, options).pipe(
    Effect.map((result) =>
      result.stdoutTruncated ? `${result.stdout}${OUTPUT_TRUNCATED_MARKER}` : result.stdout,
    ),
  );

const branchExists = (cwd: string, refName: string): Effect.Effect<boolean, GitCommandError> =>
  executeGit(
    "GitVcsDriver.branchExists",
    cwd,
    ["show-ref", "--verify", "--quiet", `refs/heads/${refName}`],
    {
      allowNonZeroExit: true,
      timeoutMs: 5_000,
    },
  ).pipe(Effect.map((result) => result.exitCode === 0));

const resolveAvailableBranchName = Effect.fn("resolveAvailableBranchName")(function* (
  cwd: string,
  requestedBranch: string,
) {
  // A branch at a parent path (such as `t3`) blocks every ref nested under it, so no suffix
  // would help; flatten to a sibling the way temporary worktree branches already do.
  const segments = requestedBranch.split("/");
  let blockedByParent = false;
  for (let index = 1; index < segments.length && !blockedByParent; index += 1) {
    blockedByParent = yield* branchExists(cwd, segments.slice(0, index).join("/"));
  }
  const desiredBranch = blockedByParent ? segments.join("-") : requestedBranch;
  // A branch nested under the name (`t3-fix/child`) blocks it as surely as one with the name.
  const isBranchNameTaken = (name: string) =>
    Effect.zipWith(
      branchExists(cwd, name),
      runGitStdout(
        "GitVcsDriver.branchExists",
        cwd,
        ["for-each-ref", "--count=1", "--format=%(refname)", `refs/heads/${name}/`],
        true,
      ),
      (exists, nested) => exists || nested.trim().length > 0,
    );

  const isDesiredTaken = yield* isBranchNameTaken(desiredBranch);
  if (!isDesiredTaken) {
    return desiredBranch;
  }

  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const candidate = `${desiredBranch}-${suffix}`;
    const isCandidateTaken = yield* isBranchNameTaken(candidate);
    if (!isCandidateTaken) {
      return candidate;
    }
  }

  return yield* new GitCommandError({
    ...gitCommandContext({
      operation: "GitVcsDriver.renameBranch",
      cwd,
      args: ["branch", "-m", "--", desiredBranch],
    }),
    detail: `Could not find an available branch name for '${desiredBranch}'.`,
  });
});

const readCurrentUpstreamRef = Effect.fn("readCurrentUpstreamRef")(function* (cwd: string) {
  const upstreamRef = yield* runGitStdout(
    "GitVcsDriver.resolveCurrentUpstream",
    cwd,
    ["rev-parse", "--symbolic-full-name", "@{upstream}"],
    true,
  ).pipe(Effect.map((stdout) => stdout.trim().replace(/^refs\/(?:remotes|heads)\//, "")));

  if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
    return null;
  }
  return upstreamRef;
});

const resolveCurrentUpstream = Effect.fn("resolveCurrentUpstream")(function* (
  cwd: string,
  knownUpstreamRef?: string,
) {
  const upstreamRef = knownUpstreamRef ?? (yield* readCurrentUpstreamRef(cwd));
  if (upstreamRef === null) {
    return null;
  }

  const remoteNames = yield* runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
    Effect.map(parseRemoteNames),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  return (
    parseUpstreamRefWithRemoteNames(upstreamRef, remoteNames) ??
    parseUpstreamRefByFirstSeparator(upstreamRef)
  );
});

const fetchRemoteForStatus = Effect.fn("GitVcsDriver.fetchRemoteForStatus.wait")(function* (
  gitCommonDir: string,
  remoteName: string,
) {
  const fetchCwd =
    path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
  // `--no-auto-gc` (a synonym of `--no-auto-maintenance` that older Git also knows) keeps
  // this poll from starting `git gc --auto`. When that gc fails, for example on a repository
  // with missing objects, Git retries it on every fetch and leaves a full-size `tmp_pack_*`
  // behind each time, so a background poll could fill the disk.
  const args = [
    "--git-dir",
    gitCommonDir,
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-auto-gc",
    "--",
    remoteName,
  ];
  const key = `${gitCommonDir}\0${remoteName}`;
  const failure = statusRemoteRefreshFailures.get(key);
  if (failure && (yield* Clock.currentTimeMillis) < failure.retryAt) return;
  const fiber = yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const pending = statusFetches.get(key);
      if (pending) return pending;
      // Frequent poll deadlines and disconnected clients must not interrupt a
      // healthy writer. A separate safety limit prevents a hung transport from
      // occupying its worker slot indefinitely.
      const started = yield* executeGit("GitVcsDriver.fetchRemoteForStatus", fetchCwd, args, {
        env: STATUS_UPSTREAM_REFRESH_ENV,
        fallbackErrorDetail: "Background Git fetch exited with a non-zero status.",
        timeoutMs: Duration.toMillis(STATUS_UPSTREAM_FETCH_TIMEOUT),
        forceKillAfterMs: 1_000,
      }).pipe(
        Effect.asVoid,
        Effect.tap(() =>
          Effect.sync(() => {
            statusRemoteRefreshFailures.delete(key);
          }),
        ),
        Effect.tapError(() => recordStatusRemoteRefreshFailure(key)),
        Effect.tapCause((cause) => Effect.logWarning("Background Git fetch failed", cause)),
        statusFetchProcesses.withPermits(1),
        Effect.onExit(() =>
          Effect.sync(() => {
            statusFetches.delete(key);
          }),
        ),
        Effect.forkIn(serviceScope, { startImmediately: false, uninterruptible: false }),
      );
      statusFetches.set(key, started);
      return started;
    }),
  );
  const result = yield* Fiber.join(fiber).pipe(
    Effect.timeoutOption(STATUS_UPSTREAM_REFRESH_TIMEOUT),
  );
  if (Option.isNone(result)) {
    yield* Effect.logDebug(
      "Background Git fetch is still running; using the last fetched references.",
    );
  }
});

const readGitCommonDir = Effect.fn("readGitCommonDir")(function* (cwd: string) {
  // Git reports relative paths from the physical cwd, which can differ from a symlink.
  const commonDirResult = yield* executeGitWithStableDiagnostics(
    "GitVcsDriver.resolveRepositoryPaths.commonDir",
    cwd,
    ["rev-parse", "--git-common-dir"],
    {
      timeoutMs: 5_000,
      allowNonZeroExit: true,
    },
  );
  if (commonDirResult.exitCode !== 0) {
    const stderr = commonDirResult.stderr.trim();
    if (isNonRepositoryGitStderr(stderr)) {
      return null;
    }
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.resolveRepositoryPaths.commonDir",
        cwd,
        args: ["rev-parse", "--git-common-dir"],
      }),
      detail: "Failed to resolve the Git common directory.",
      exitCode: commonDirResult.exitCode,
      stdoutLength: commonDirResult.stdout.length,
      stderrLength: commonDirResult.stderr.length,
    });
  }

  const commonDirOutput = commonDirResult.stdout.trim();
  const physicalCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
  const resolvedGitCommonDir = path.isAbsolute(commonDirOutput)
    ? path.normalize(commonDirOutput)
    : path.resolve(physicalCwd, commonDirOutput);
  return yield* fileSystem
    .realPath(resolvedGitCommonDir)
    .pipe(Effect.orElseSucceed(() => resolvedGitCommonDir));
});

const readWorktreeRoot = Effect.fn("readWorktreeRoot")(function* (cwd: string) {
  const result = yield* executeGit(
    "GitVcsDriver.resolveRepositoryPaths.worktreeRoot",
    cwd,
    ["rev-parse", "--show-toplevel"],
    {
      timeoutMs: 5_000,
      allowNonZeroExit: true,
    },
  );
  // Git terminates --show-toplevel with exactly one "\n" on every platform (stdout is
  // binary mode on Windows). Whitespace before it belongs to the path and must survive,
  // because this root becomes the editor target for every repository-relative status path.
  const output = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  return result.exitCode === 0 && output.length > 0
    ? path.normalize(path.isAbsolute(output) ? output : path.resolve(cwd, output))
    : null;
});

const resolveRepositoryPathsUncached = Effect.fn("resolveRepositoryPathsUncached")(function* (
  cwd: string,
) {
  const gitCommonDir = yield* readGitCommonDir(cwd);
  if (gitCommonDir === null) return null;
  const [worktreeRoot, currentBranchResult] = yield* Effect.all(
    [
      readWorktreeRoot(cwd),
      executeGit(
        "GitVcsDriver.resolveRepositoryPaths.currentBranch",
        cwd,
        ["symbolic-ref", "--quiet", "HEAD"],
        {
          timeoutMs: 5_000,
          allowNonZeroExit: true,
        },
      ),
    ],
    { concurrency: 2 },
  );
  // Git reports physical roots, so resolve project aliases before comparing.
  const isAtRepositoryRoot =
    worktreeRoot === null
      ? undefined
      : yield* fileSystem.realPath(cwd).pipe(
          Effect.map((physicalCwd) => path.relative(worktreeRoot, physicalCwd) === ""),
          Effect.orElseSucceed(() => undefined),
        );
  const currentBranch =
    currentBranchResult.exitCode === 0 ? branchNameFromHeadRef(currentBranchResult.stdout) : null;

  return {
    gitCommonDir,
    worktreeRoot,
    isAtRepositoryRoot,
    currentBranch,
  } satisfies GitRepositoryPaths;
});

const resolveReviewWorktreeRoot = Effect.fn("resolveReviewWorktreeRoot")(function* (cwd: string) {
  const worktreeRoot = yield* readWorktreeRoot(cwd);
  if (worktreeRoot !== null) return { worktreeRoot, currentBranch: null };
  // Full discovery tells bare and non-repository directories apart from real Git failures.
  return yield* resolveRepositoryPathsUncached(cwd);
});

const repositoryPathsCache = yield* Cache.makeWith(
  (cwd: string) => resolveRepositoryPathsUncached(cwd),
  {
    capacity: REPOSITORY_PATHS_CACHE_CAPACITY,
    timeToLive: Exit.match({
      onSuccess: (repositoryPaths) =>
        repositoryPaths === null ? NON_REPOSITORY_PATHS_CACHE_TTL : REPOSITORY_PATHS_CACHE_TTL,
      onFailure: () => Duration.zero,
    }),
  },
);

const repositoryPathsRefreshCache = yield* Cache.makeWith(
  (cwd: string) =>
    Cache.invalidate(repositoryPathsCache, cwd).pipe(
      Effect.andThen(Cache.get(repositoryPathsCache, cwd)),
    ),
  {
    capacity: REPOSITORY_PATHS_CACHE_CAPACITY,
    timeToLive: Exit.match({
      onSuccess: (repositoryPaths) =>
        repositoryPaths === null
          ? NON_REPOSITORY_PATHS_CACHE_TTL
          : REPOSITORY_PATHS_REFRESH_COALESCE_TTL,
      onFailure: () => Duration.zero,
    }),
  },
);

const normalizeRepositoryPathsCacheKey = (cwd: string) => path.normalize(path.resolve(cwd));

const resolveRepositoryPaths = (cwd: string, refresh = false) => {
  const cacheKey = normalizeRepositoryPathsCacheKey(cwd);
  return Cache.get(refresh ? repositoryPathsRefreshCache : repositoryPathsCache, cacheKey);
};

const statusRemoteRefreshFailures = new Map<string, { count: number; retryAt: number }>();

const recordStatusRemoteRefreshFailure = Effect.fn(
  "GitVcsDriver.recordStatusRemoteRefreshFailure",
)(function* (key: string) {
  const nextCount = (statusRemoteRefreshFailures.get(key)?.count ?? 0) + 1;
  const now = yield* Clock.currentTimeMillis;
  statusRemoteRefreshFailures.delete(key);
  statusRemoteRefreshFailures.set(key, {
    count: nextCount,
    retryAt: now + Duration.toMillis(statusUpstreamRefreshFailureCooldown(nextCount)),
  });
  if (statusRemoteRefreshFailures.size > STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY) {
    const oldestKey = statusRemoteRefreshFailures.keys().next().value;
    if (oldestKey !== undefined) {
      statusRemoteRefreshFailures.delete(oldestKey);
    }
  }
});

  return { fileSystem, path, commandSpawner, worktreesDir, isServerInternalPath, digest, hostPlatform, serviceScope, statusFetches, statusFetchProcesses, executeRaw, sharedConfigLocks, withSharedConfigLock, execute, executeGit, executeGitWithStableDiagnostics, runGit, runGitStdout, executeWorktreeList, runGitStdoutWithOptions, branchExists, resolveAvailableBranchName, readCurrentUpstreamRef, resolveCurrentUpstream, fetchRemoteForStatus, readGitCommonDir, readWorktreeRoot, resolveRepositoryPathsUncached, resolveReviewWorktreeRoot, repositoryPathsCache, repositoryPathsRefreshCache, normalizeRepositoryPathsCacheKey, resolveRepositoryPaths, statusRemoteRefreshFailures, recordStatusRemoteRefreshFailure };
});

export type ExecuteRawPart = ReturnType<typeof installExecuteRaw> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installExecuteRaw>;
