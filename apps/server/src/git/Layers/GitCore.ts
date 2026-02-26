import { Cache, Data, Duration, Effect, Exit, FileSystem, Layer, Path } from "effect";

import { GitCommandError } from "../Errors.ts";
import { GitService } from "../Services/GitService.ts";
import { GitCore, type GitCoreShape } from "../Services/GitCore.ts";

const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;

class StatusUpstreamRefreshCacheKey extends Data.Class<{
  cwd: string;
  upstreamRef: string;
  remoteName: string;
  upstreamBranch: string;
}> {}

interface ExecuteGitOptions {
  timeoutMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorMessage?: string | undefined;
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

function parseNumstatEntries(
  stdout: string,
): Array<{ path: string; insertions: number; deletions: number }> {
  const entries: Array<{ path: string; insertions: number; deletions: number }> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    if (line.trim().length === 0) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const rawPath =
      pathParts.length > 1 ? (pathParts.at(-1) ?? "").trim() : pathParts.join("\t").trim();
    if (rawPath.length === 0) continue;
    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    const renameArrowIndex = rawPath.indexOf(" => ");
    const normalizedPath =
      renameArrowIndex >= 0 ? rawPath.slice(renameArrowIndex + " => ".length).trim() : rawPath;
    entries.push({
      path: normalizedPath.length > 0 ? normalizedPath : rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return entries;
}

function parsePorcelainPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) {
    const simple = line.slice(2).trim();
    return simple.length > 0 ? simple : null;
  }

  if (!(line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u "))) {
    return null;
  }

  const tabIndex = line.indexOf("\t");
  if (tabIndex >= 0) {
    const fromTab = line.slice(tabIndex + 1);
    const [filePath] = fromTab.split("\t");
    return filePath?.trim().length ? filePath.trim() : null;
  }

  const parts = line.trim().split(/\s+/g);
  const filePath = parts.at(-1) ?? "";
  return filePath.length > 0 ? filePath : null;
}

function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function createGitCommandError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
): GitCommandError {
  return new GitCommandError({
    operation,
    command: commandLabel(args),
    cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const makeGitCore = Effect.gen(function* () {
  const git = yield* GitService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const executeGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<{ code: number; stdout: string; stderr: string }, GitCommandError> =>
    git
      .execute({
        operation,
        cwd,
        args,
        allowNonZeroExit: true,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      })
      .pipe(
        Effect.flatMap((result) => {
          if (options.allowNonZeroExit || result.code === 0) {
            return Effect.succeed(result);
          }
          const stderr = result.stderr.trim();
          if (stderr.length > 0) {
            return Effect.fail(createGitCommandError(operation, cwd, args, stderr));
          }
          if (options.fallbackErrorMessage) {
            return Effect.fail(
              createGitCommandError(operation, cwd, args, options.fallbackErrorMessage),
            );
          }
          return Effect.fail(
            createGitCommandError(
              operation,
              cwd,
              args,
              `${commandLabel(args)} failed: code=${result.code ?? "null"}`,
            ),
          );
        }),
      );

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<void, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(Effect.asVoid);

  const runGitStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
      Effect.map((result) => result.stdout),
    );

  const resolveCurrentUpstream = (
    cwd: string,
  ): Effect.Effect<
    { upstreamRef: string; remoteName: string; upstreamBranch: string } | null,
    GitCommandError
  > =>
    Effect.gen(function* () {
      const upstreamRef = yield* runGitStdout(
        "GitCore.resolveCurrentUpstream",
        cwd,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
        return null;
      }

      const separatorIndex = upstreamRef.indexOf("/");
      if (separatorIndex <= 0) {
        return null;
      }
      const remoteName = upstreamRef.slice(0, separatorIndex);
      const upstreamBranch = upstreamRef.slice(separatorIndex + 1);
      if (remoteName.length === 0 || upstreamBranch.length === 0) {
        return null;
      }

      return {
        upstreamRef,
        remoteName,
        upstreamBranch,
      };
    });

  const fetchUpstreamRef = (
    cwd: string,
    upstream: { upstreamRef: string; remoteName: string; upstreamBranch: string },
  ): Effect.Effect<void, GitCommandError> => {
    const refspec = `+refs/heads/${upstream.upstreamBranch}:refs/remotes/${upstream.upstreamRef}`;
    return runGit(
      "GitCore.fetchUpstreamRef",
      cwd,
      ["fetch", "--quiet", "--no-tags", upstream.remoteName, refspec],
      true,
    );
  };

  const fetchUpstreamRefForStatus = (
    cwd: string,
    upstream: { upstreamRef: string; remoteName: string; upstreamBranch: string },
  ): Effect.Effect<void, GitCommandError> => {
    const refspec = `+refs/heads/${upstream.upstreamBranch}:refs/remotes/${upstream.upstreamRef}`;
    return executeGit(
      "GitCore.fetchUpstreamRefForStatus",
      cwd,
      ["fetch", "--quiet", "--no-tags", upstream.remoteName, refspec],
      {
        allowNonZeroExit: true,
        timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
      },
    ).pipe(Effect.asVoid);
  };

  const statusUpstreamRefreshCache = yield* Cache.makeWith({
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    lookup: (cacheKey: StatusUpstreamRefreshCacheKey) =>
      Effect.gen(function* () {
        yield* fetchUpstreamRefForStatus(cacheKey.cwd, {
          upstreamRef: cacheKey.upstreamRef,
          remoteName: cacheKey.remoteName,
          upstreamBranch: cacheKey.upstreamBranch,
        });
        return true as const;
      }),
    // Keep successful refreshes warm; drop failures immediately so next request can retry.
    timeToLive: (exit) => (Exit.isSuccess(exit) ? STATUS_UPSTREAM_REFRESH_INTERVAL : Duration.zero),
  });

  const refreshStatusUpstreamIfStale = (cwd: string): Effect.Effect<void, GitCommandError> =>
    Effect.gen(function* () {
      const upstream = yield* resolveCurrentUpstream(cwd);
      if (!upstream) return;
      yield* Cache.get(
        statusUpstreamRefreshCache,
        new StatusUpstreamRefreshCacheKey({
          cwd,
          upstreamRef: upstream.upstreamRef,
          remoteName: upstream.remoteName,
          upstreamBranch: upstream.upstreamBranch,
        }),
      );
    });

  const refreshCheckedOutBranchUpstream = (cwd: string): Effect.Effect<void, GitCommandError> =>
    Effect.gen(function* () {
      const upstream = yield* resolveCurrentUpstream(cwd);
      if (!upstream) return;
      yield* fetchUpstreamRef(cwd, upstream);
    });

  const readBranchRecency = (cwd: string): Effect.Effect<Map<string, number>, GitCommandError> =>
    Effect.gen(function* () {
      const branchRecency = yield* executeGit(
        "GitCore.readBranchRecency",
        cwd,
        ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"],
        {
          timeoutMs: 15_000,
          allowNonZeroExit: true,
        },
      );

      const branchLastCommit = new Map<string, number>();
      if (branchRecency.code !== 0) {
        return branchLastCommit;
      }

      for (const line of branchRecency.stdout.split("\n")) {
        if (line.length === 0) {
          continue;
        }
        const [name, lastCommitRaw] = line.split("\t");
        if (!name) {
          continue;
        }
        const lastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
        branchLastCommit.set(name, Number.isFinite(lastCommit) ? lastCommit : 0);
      }

      return branchLastCommit;
    });

  const statusDetails: GitCoreShape["statusDetails"] = (cwd) =>
    Effect.gen(function* () {
      yield* refreshStatusUpstreamIfStale(cwd).pipe(Effect.catch(() => Effect.void));

      const [statusStdout, unstagedNumstatStdout, stagedNumstatStdout] = yield* Effect.all(
        [
          runGitStdout("GitCore.statusDetails.status", cwd, [
            "status",
            "--porcelain=2",
            "--branch",
          ]),
          runGitStdout("GitCore.statusDetails.unstagedNumstat", cwd, ["diff", "--numstat"]),
          runGitStdout("GitCore.statusDetails.stagedNumstat", cwd, [
            "diff",
            "--cached",
            "--numstat",
          ]),
        ],
        { concurrency: "unbounded" },
      );

      let branch: string | null = null;
      let upstreamRef: string | null = null;
      let aheadCount = 0;
      let behindCount = 0;
      let hasWorkingTreeChanges = false;
      const changedFilesWithoutNumstat = new Set<string>();

      for (const line of statusStdout.split(/\r?\n/g)) {
        if (line.startsWith("# branch.head ")) {
          const value = line.slice("# branch.head ".length).trim();
          branch = value.startsWith("(") ? null : value;
          continue;
        }
        if (line.startsWith("# branch.upstream ")) {
          const value = line.slice("# branch.upstream ".length).trim();
          upstreamRef = value.length > 0 ? value : null;
          continue;
        }
        if (line.startsWith("# branch.ab ")) {
          const value = line.slice("# branch.ab ".length).trim();
          const parsed = parseBranchAb(value);
          aheadCount = parsed.ahead;
          behindCount = parsed.behind;
          continue;
        }
        if (line.trim().length > 0 && !line.startsWith("#")) {
          hasWorkingTreeChanges = true;
          const pathValue = parsePorcelainPath(line);
          if (pathValue) changedFilesWithoutNumstat.add(pathValue);
        }
      }
      const stagedEntries = parseNumstatEntries(stagedNumstatStdout);
      const unstagedEntries = parseNumstatEntries(unstagedNumstatStdout);
      const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
      for (const entry of [...stagedEntries, ...unstagedEntries]) {
        const existing = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
        existing.insertions += entry.insertions;
        existing.deletions += entry.deletions;
        fileStatMap.set(entry.path, existing);
      }

      let insertions = 0;
      let deletions = 0;
      const files = Array.from(fileStatMap.entries())
        .map(([filePath, stat]) => {
          insertions += stat.insertions;
          deletions += stat.deletions;
          return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
        })
        .toSorted((a, b) => a.path.localeCompare(b.path));

      for (const filePath of changedFilesWithoutNumstat) {
        if (fileStatMap.has(filePath)) continue;
        files.push({ path: filePath, insertions: 0, deletions: 0 });
      }
      files.sort((a, b) => a.path.localeCompare(b.path));

      return {
        branch,
        upstreamRef,
        hasWorkingTreeChanges,
        workingTree: {
          files,
          insertions,
          deletions,
        },
        hasUpstream: upstreamRef !== null,
        aheadCount,
        behindCount,
      };
    });

  const status: GitCoreShape["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        branch: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        openPr: null,
      })),
    );

  const prepareCommitContext: GitCoreShape["prepareCommitContext"] = (cwd) =>
    Effect.gen(function* () {
      yield* runGit("GitCore.prepareCommitContext.addAll", cwd, ["add", "-A"]);

      const stagedSummary = yield* runGitStdout("GitCore.prepareCommitContext.stagedSummary", cwd, [
        "diff",
        "--cached",
        "--name-status",
      ]).pipe(Effect.map((stdout) => stdout.trim()));
      if (stagedSummary.length === 0) {
        return null;
      }

      const stagedPatch = yield* runGitStdout("GitCore.prepareCommitContext.stagedPatch", cwd, [
        "diff",
        "--cached",
        "--patch",
        "--minimal",
      ]);

      return {
        stagedSummary,
        stagedPatch,
      };
    });

  const commit: GitCoreShape["commit"] = (cwd, subject, body) =>
    Effect.gen(function* () {
      const args = ["commit", "-m", subject];
      const trimmedBody = body.trim();
      if (trimmedBody.length > 0) {
        args.push("-m", trimmedBody);
      }
      yield* runGit("GitCore.commit.commit", cwd, args);
      const commitSha = yield* runGitStdout("GitCore.commit.revParseHead", cwd, [
        "rev-parse",
        "HEAD",
      ]).pipe(Effect.map((stdout) => stdout.trim()));

      return { commitSha };
    });

  const pushCurrentBranch: GitCoreShape["pushCurrentBranch"] = (cwd, fallbackBranch) =>
    Effect.gen(function* () {
      const details = yield* statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pushCurrentBranch",
          cwd,
          ["push"],
          "Cannot push from detached HEAD.",
        );
      }

      if (details.hasUpstream && details.aheadCount === 0 && details.behindCount === 0) {
        return {
          status: "skipped_up_to_date" as const,
          branch,
          ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        };
      }

      if (!details.hasUpstream) {
        yield* runGit("GitCore.pushCurrentBranch.pushWithUpstream", cwd, [
          "push",
          "-u",
          "origin",
          branch,
        ]);
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: `origin/${branch}`,
          setUpstream: true,
        };
      }

      yield* runGit("GitCore.pushCurrentBranch.push", cwd, ["push"]);
      return {
        status: "pushed" as const,
        branch,
        ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        setUpstream: false,
      };
    });

  const pullCurrentBranch: GitCoreShape["pullCurrentBranch"] = (cwd) =>
    Effect.gen(function* () {
      const details = yield* statusDetails(cwd);
      const branch = details.branch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Cannot pull from detached HEAD.",
        );
      }
      if (!details.hasUpstream) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Current branch has no upstream configured. Push with upstream first.",
        );
      }
      const beforeSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.beforeSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));
      yield* executeGit("GitCore.pullCurrentBranch.pull", cwd, ["pull", "--ff-only"], {
        timeoutMs: 30_000,
        fallbackErrorMessage: "git pull failed",
      });
      const afterSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.afterSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      const refreshed = yield* statusDetails(cwd);
      return {
        status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
        branch,
        upstreamBranch: refreshed.upstreamRef,
      };
    });

  const readRangeContext: GitCoreShape["readRangeContext"] = (cwd, baseBranch) =>
    Effect.gen(function* () {
      const range = `${baseBranch}..HEAD`;
      const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
        [
          runGitStdout("GitCore.readRangeContext.log", cwd, ["log", "--oneline", range]),
          runGitStdout("GitCore.readRangeContext.diffStat", cwd, ["diff", "--stat", range]),
          runGitStdout("GitCore.readRangeContext.diffPatch", cwd, [
            "diff",
            "--patch",
            "--minimal",
            range,
          ]),
        ],
        { concurrency: "unbounded" },
      );

      return {
        commitSummary,
        diffSummary,
        diffPatch,
      };
    });

  const readConfigValue: GitCoreShape["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitCore.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  const listBranches: GitCoreShape["listBranches"] = (input) =>
    Effect.gen(function* () {
      const branchRecencyPromise = readBranchRecency(input.cwd).pipe(
        Effect.catch(() => Effect.succeed(new Map<string, number>())),
      );
      const result = yield* executeGit(
        "GitCore.listBranches.branchNoColor",
        input.cwd,
        ["branch", "--no-color"],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        },
      );

      if (result.code !== 0) {
        const stderr = result.stderr.trim();
        if (stderr.toLowerCase().includes("not a git repository")) {
          return { branches: [], isRepo: false };
        }
        return yield* createGitCommandError(
          "GitCore.listBranches",
          input.cwd,
          ["branch", "--no-color"],
          stderr || "git branch failed",
        );
      }

      const [defaultRef, worktreeList, branchLastCommit] = yield* Effect.all(
        [
          executeGit(
            "GitCore.listBranches.defaultRef",
            input.cwd,
            ["symbolic-ref", "refs/remotes/origin/HEAD"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ),
          executeGit(
            "GitCore.listBranches.worktreeList",
            input.cwd,
            ["worktree", "list", "--porcelain"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ),
          branchRecencyPromise,
        ],
        { concurrency: "unbounded" },
      );

      const defaultBranch =
        defaultRef.code === 0
          ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
          : null;

      const worktreeMap = new Map<string, string>();
      if (worktreeList.code === 0) {
        let currentPath: string | null = null;
        for (const line of worktreeList.stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            const candidatePath = line.slice("worktree ".length);
            const exists = yield* fileSystem.stat(candidatePath).pipe(
              Effect.map(() => true),
              Effect.catch(() => Effect.succeed(false)),
            );
            currentPath = exists ? candidatePath : null;
          } else if (line.startsWith("branch refs/heads/") && currentPath) {
            worktreeMap.set(line.slice("branch refs/heads/".length), currentPath);
          } else if (line === "") {
            currentPath = null;
          }
        }
      }

      const branches = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const name = line.replace(/^[*+]\s+/, "");
          return {
            name,
            current: line.startsWith("* "),
            isDefault: name === defaultBranch,
            worktreePath: worktreeMap.get(name) ?? null,
          };
        })
        .toSorted((a, b) => {
          const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
          const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
          if (aPriority !== bPriority) return aPriority - bPriority;

          const aLastCommit = branchLastCommit.get(a.name) ?? 0;
          const bLastCommit = branchLastCommit.get(b.name) ?? 0;
          if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
          return a.name.localeCompare(b.name);
        });

      return { branches, isRepo: true };
    });

  const createWorktree: GitCoreShape["createWorktree"] = (input) =>
    Effect.gen(function* () {
      const sanitizedBranch = input.newBranch.replace(/\//g, "-");
      const repoName = path.basename(input.cwd);
      const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
      const worktreePath =
        input.path ?? path.join(homeDir, ".t3", "worktrees", repoName, sanitizedBranch);

      yield* executeGit(
        "GitCore.createWorktree",
        input.cwd,
        ["worktree", "add", "-b", input.newBranch, worktreePath, input.branch],
        {
          fallbackErrorMessage: "git worktree add failed",
        },
      );

      return {
        worktree: {
          path: worktreePath,
          branch: input.newBranch,
        },
      };
    });

  const removeWorktree: GitCoreShape["removeWorktree"] = (input) =>
    Effect.gen(function* () {
      const args = ["worktree", "remove"];
      if (input.force) {
        args.push("--force");
      }
      args.push(input.path);
      yield* executeGit("GitCore.removeWorktree", input.cwd, args, {
        timeoutMs: 15_000,
        fallbackErrorMessage: "git worktree remove failed",
      }).pipe(
        Effect.mapError((error) =>
          createGitCommandError(
            "GitCore.removeWorktree",
            input.cwd,
            args,
            `${commandLabel(args)} failed (cwd: ${input.cwd}): ${error instanceof Error ? error.message : String(error)}`,
            error,
          ),
        ),
      );
    });

  const createBranch: GitCoreShape["createBranch"] = (input) =>
    executeGit("GitCore.createBranch", input.cwd, ["branch", input.branch], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git branch create failed",
    }).pipe(Effect.asVoid);

  const checkoutBranch: GitCoreShape["checkoutBranch"] = (input) =>
    Effect.gen(function* () {
      yield* executeGit("GitCore.checkoutBranch.checkout", input.cwd, ["checkout", input.branch], {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git checkout failed",
      });

      // Refresh upstream refs in the background so checkout remains responsive.
      yield* Effect.sync(() => {
        void Effect.runPromise(
          refreshCheckedOutBranchUpstream(input.cwd).pipe(Effect.catch(() => Effect.void)),
        );
      });
    });

  const initRepo: GitCoreShape["initRepo"] = (input) =>
    executeGit("GitCore.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git init failed",
    }).pipe(Effect.asVoid);

  return {
    status,
    statusDetails,
    prepareCommitContext,
    commit,
    pushCurrentBranch,
    pullCurrentBranch,
    readRangeContext,
    readConfigValue,
    listBranches,
    createWorktree,
    removeWorktree,
    createBranch,
    checkoutBranch,
    initRepo,
  } satisfies GitCoreShape;
});

export const GitCoreLive = Layer.effect(GitCore, makeGitCore);
