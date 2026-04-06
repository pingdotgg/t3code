import { FileSystem, Effect, Layer, Path, Ref } from "effect";

import { GitCommandError, type GitBranch } from "@t3tools/contracts";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/vcs";
import { ServerConfig } from "../../config.ts";
import {
  type ExecuteGitResult,
  type GitCommitOptions,
  type GitCoreShape,
  type GitFetchPullRequestBranchInput,
  type GitFetchRemoteBranchInput,
  type GitPreparedCommitContext,
  type GitPushResult,
  type GitRangeContext,
  type GitRenameBranchInput,
  type GitStatusDetails,
} from "../../git/Services/GitCore.ts";
import { JjCore, type JjCoreShape } from "../Services/JjCore.ts";
import {
  branchConfigKey,
  canonicalizePath,
  parseJsonLines,
  parseMergeRefBranchName,
  readJjRepoBackendType,
  resolveJjRoot,
  resolveJjRepoDir,
  runJjCommand,
  runJjStdout,
} from "../Utils.ts";

const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;
const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;
const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_BRANCH_CANDIDATES = ["main", "master", "trunk"] as const;
const JJ_LIST_BRANCHES_DEFAULT_LIMIT = 100;
const WORKSPACE_REGISTRY_FILE = "t3-workspaces.json";

interface WorkspaceRegistry {
  readonly branches: Record<string, string>;
}

const EMPTY_WORKSPACE_REGISTRY: WorkspaceRegistry = { branches: {} };

interface ParsedBookmark {
  readonly name: string;
  readonly remoteName: string | null;
}

interface BranchUpstreamInfo {
  readonly remoteName: string;
  readonly remoteBranch: string;
  readonly upstreamRef: string;
}

interface GitRemoteEntry {
  readonly name: string;
  readonly url: string;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function isDefaultBranchName(branch: string | null | undefined): boolean {
  return (
    branch !== null && branch !== undefined && DEFAULT_BRANCH_CANDIDATES.includes(branch as never)
  );
}

function parseDiffStatEntries(
  stdout: string,
): Array<{ path: string; insertions: number; deletions: number }> {
  const entries: Array<{ path: string; insertions: number; deletions: number }> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0 || /^\d+\s+files?\s+changed,/.test(trimmedLine)) {
      continue;
    }

    const separatorIndex = line.lastIndexOf(" | ");
    if (separatorIndex < 0) {
      continue;
    }

    const rawPath = line.slice(0, separatorIndex).trim();
    if (rawPath.length === 0) {
      continue;
    }

    const statPart = line.slice(separatorIndex + 3).trim();
    const tokens = statPart.split(/\s+/g);
    const totalChanges = Number.parseInt(tokens[0] ?? "", 10);

    if (!Number.isFinite(totalChanges) || totalChanges === 0) {
      entries.push({ path: rawPath, insertions: 0, deletions: 0 });
      continue;
    }

    const markers = tokens[1] ?? "";
    const plusCount = (markers.match(/\+/g) ?? []).length;
    const minusCount = (markers.match(/-/g) ?? []).length;
    const totalMarkers = plusCount + minusCount;

    if (totalMarkers === 0) {
      entries.push({ path: rawPath, insertions: totalChanges, deletions: 0 });
      continue;
    }

    const insertions = Math.round(totalChanges * (plusCount / totalMarkers));
    const deletions = totalChanges - insertions;
    entries.push({ path: rawPath, insertions, deletions });
  }
  return entries;
}

function splitLineSeparatedPaths(input: string): string[] {
  return input
    .split(/\r?\n/g)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseGitRemoteEntries(stdout: string): GitRemoteEntry[] {
  return stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const separatorIndex = line.search(/\s/);
      if (separatorIndex < 0) {
        return [];
      }

      const name = line.slice(0, separatorIndex).trim();
      const url = line.slice(separatorIndex).trim();
      return name.length > 0 && url.length > 0 ? [{ name, url }] : [];
    });
}

function normalizeRemoteUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

function commandError(
  operation: string,
  cwd: string,
  command: string,
  detail: string,
  cause?: unknown,
) {
  return new GitCommandError({
    operation,
    command,
    cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function filterBranchesForListQuery(
  branches: ReadonlyArray<GitBranch>,
  query?: string,
): ReadonlyArray<GitBranch> {
  if (!query) {
    return branches;
  }

  const normalizedQuery = query.toLowerCase();
  return branches.filter((branch) => branch.name.toLowerCase().includes(normalizedQuery));
}

function paginateBranches(input: {
  branches: ReadonlyArray<GitBranch>;
  cursor?: number | undefined;
  limit?: number | undefined;
}) {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? JJ_LIST_BRANCHES_DEFAULT_LIMIT;
  const totalCount = input.branches.length;
  const branches = input.branches.slice(cursor, cursor + limit);
  const nextCursor = cursor + branches.length < totalCount ? cursor + branches.length : null;

  return {
    branches,
    nextCursor,
    totalCount,
  };
}

function parseBookmarkEntries(stdout: string): ParsedBookmark[] {
  const rows = parseJsonLines<{
    name?: string;
    remote?: string;
    target?: string[];
  }>(stdout);

  return rows
    .map((row) => ({
      name: row.name?.trim() ?? "",
      remoteName: normalizeOptionalString(row.remote),
    }))
    .filter((row) => row.name.length > 0);
}

function parseCommitId(stdout: string): string | null {
  const row = parseJsonLines<{ commit_id?: string }>(stdout)[0];
  const commitId = row?.commit_id?.trim() ?? "";
  return commitId.length > 0 ? commitId : null;
}

function unique<T>(values: ReadonlyArray<T>): T[] {
  return [...new Set(values)];
}

function sortCurrentBranchCandidates(candidates: ReadonlyArray<string>): string[] {
  return [...candidates].toSorted((left, right) => {
    const leftDefault = isDefaultBranchName(left);
    const rightDefault = isDefaultBranchName(right);
    if (leftDefault !== rightDefault) {
      return leftDefault ? 1 : -1;
    }
    return left.localeCompare(right);
  });
}

function normalizeWorkspaceRegistry(value: unknown): WorkspaceRegistry {
  if (!value || typeof value !== "object" || !("branches" in value)) {
    return EMPTY_WORKSPACE_REGISTRY;
  }

  const branchesValue = (value as { branches?: unknown }).branches;
  if (!branchesValue || typeof branchesValue !== "object") {
    return EMPTY_WORKSPACE_REGISTRY;
  }

  const branches: Record<string, string> = Object.fromEntries(
    Object.entries(branchesValue).flatMap(([branchName, worktreePath]) =>
      typeof worktreePath === "string" ? [[branchName, worktreePath]] : [],
    ),
  );
  return { branches };
}

function resolveRemoteNameForBranch(input: {
  readonly branch: string;
  readonly remoteBookmarks: ReadonlyArray<ParsedBookmark>;
}): string | null {
  const remoteMatches = input.remoteBookmarks.filter((entry) => entry.name === input.branch);
  if (remoteMatches.length === 0) {
    return null;
  }

  return (
    remoteMatches.find((entry) => entry.remoteName === "origin")?.remoteName ??
    remoteMatches[0]?.remoteName ??
    null
  );
}

export const makeJjCore = Effect.fn("makeJjCore")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pendingCommitFilePaths = yield* Ref.make(new Map<string, readonly string[]>());
  const { worktreesDir } = yield* ServerConfig;

  const workspaceRegistryPath = (repoDir: string) => path.join(repoDir, WORKSPACE_REGISTRY_FILE);

  const readWorkspaceRegistry = (repoDir: string): Effect.Effect<WorkspaceRegistry, never> =>
    fileSystem.readFileString(workspaceRegistryPath(repoDir)).pipe(
      Effect.map((raw) => JSON.parse(raw) as unknown),
      Effect.catch(() => Effect.succeed(EMPTY_WORKSPACE_REGISTRY)),
      Effect.map(normalizeWorkspaceRegistry),
    );

  const writeWorkspaceRegistry = (
    repoDir: string,
    registry: WorkspaceRegistry,
  ): Effect.Effect<void, GitCommandError> =>
    fileSystem
      .writeFileString(workspaceRegistryPath(repoDir), JSON.stringify(registry, null, 2))
      .pipe(
        Effect.mapError((cause) =>
          commandError(
            "JjCore.writeWorkspaceRegistry",
            repoDir,
            "write workspace registry",
            cause instanceof Error ? cause.message : String(cause),
            cause,
          ),
        ),
      );

  const updateWorkspaceRegistry = (
    repoDir: string,
    update: (registry: WorkspaceRegistry) => WorkspaceRegistry,
  ) =>
    readWorkspaceRegistry(repoDir).pipe(
      Effect.flatMap((registry) => writeWorkspaceRegistry(repoDir, update(registry))),
    );

  const recordWorkspaceBranch = (repoDir: string, workspacePath: string, branch: string) =>
    updateWorkspaceRegistry(repoDir, (registry) => {
      const canonicalWorkspacePath = canonicalizePath(workspacePath);
      const branches: Record<string, string> = {};
      for (const [branchName, recordedPath] of Object.entries(registry.branches)) {
        if (branchName === branch || canonicalizePath(recordedPath) === canonicalWorkspacePath) {
          continue;
        }
        branches[branchName] = recordedPath;
      }
      branches[branch] = canonicalWorkspacePath;
      return { branches };
    });

  const readCurrentCommitId = (cwd: string, revset = "@") =>
    runJjStdout("JjCore.readCurrentCommitId", cwd, [
      "log",
      "-r",
      revset,
      "--no-graph",
      "-T",
      'json(self) ++ "\\n"',
    ]).pipe(Effect.map(parseCommitId));

  const resolveTrackTargetPaths = (cwd: string, filePaths?: readonly string[]) => {
    if (!filePaths || filePaths.length === 0) {
      return Effect.succeed(["."] as string[]);
    }

    return Effect.forEach(
      filePaths,
      (filePath) =>
        fileSystem.stat(path.join(cwd, filePath)).pipe(
          Effect.map(() => filePath),
          Effect.catch(() => Effect.succeed(null)),
        ),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((paths) => paths.filter((filePath): filePath is string => filePath !== null)),
    );
  };

  const trackPaths = (cwd: string, filePaths?: readonly string[]) =>
    resolveTrackTargetPaths(cwd, filePaths).pipe(
      Effect.flatMap((trackablePaths) => {
        if (trackablePaths.length === 0) {
          return Effect.void;
        }

        return runJjCommand({
          operation: "JjCore.trackPaths",
          cwd,
          args: ["file", "track", ...trackablePaths],
          allowNonZeroExit: true,
        }).pipe(
          Effect.flatMap((result) => {
            if (result.code === 0) {
              return Effect.void;
            }

            const detail = result.stderr.trim();
            if (detail.includes("No arguments")) {
              return Effect.void;
            }

            return Effect.fail(
              commandError(
                "JjCore.trackPaths",
                cwd,
                "jj file track",
                detail.length > 0 ? detail : "jj file track failed",
              ),
            );
          }),
        );
      }),
    );

  const listGitRemoteEntries = (cwd: string): Effect.Effect<readonly GitRemoteEntry[], never> =>
    readJjRepoBackendType(cwd).pipe(
      Effect.flatMap((backendType) => {
        if (backendType !== "git") {
          return Effect.succeed<readonly GitRemoteEntry[]>([]);
        }

        return runJjStdout("JjCore.listGitRemoteEntries", cwd, ["git", "remote", "list"]).pipe(
          Effect.map(parseGitRemoteEntries),
          Effect.catch(() => Effect.succeed<readonly GitRemoteEntry[]>([])),
        );
      }),
      Effect.catch(() => Effect.succeed<readonly GitRemoteEntry[]>([])),
    );

  const listGitRemoteNames = (cwd: string) =>
    listGitRemoteEntries(cwd).pipe(Effect.map((entries) => entries.map((entry) => entry.name)));

  const resolvePrimaryRemoteName = (cwd: string): Effect.Effect<string, GitCommandError> =>
    listGitRemoteNames(cwd).pipe(
      Effect.flatMap((remoteNames) => {
        const remoteName = remoteNames.includes("origin") ? "origin" : (remoteNames[0] ?? null);
        return remoteName
          ? Effect.succeed(remoteName)
          : Effect.fail(
              commandError(
                "JjCore.resolvePrimaryRemoteName",
                cwd,
                "git remote",
                "Cannot resolve a Git remote for this repository.",
              ),
            );
      }),
    );

  const resolveCurrentBookmarkCandidates = (cwd: string) =>
    runJjStdout("JjCore.resolveCurrentBookmarkCandidates", cwd, [
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      'json(self.bookmarks()) ++ "\\n"',
    ]).pipe(
      Effect.map((stdout) =>
        unique(
          parseJsonLines<Array<{ name?: string; remote?: string }>>(stdout)
            .flatMap((rows) => rows)
            .filter((row) => normalizeOptionalString(row.remote) === null)
            .map((row) => row.name?.trim() ?? "")
            .filter((name) => name.length > 0),
        ),
      ),
    );

  const resolveNearestBookmarkCandidates = (cwd: string) =>
    runJjStdout("JjCore.resolveNearestBookmarkCandidates", cwd, [
      "log",
      "-r",
      "heads(::@- & bookmarks())",
      "--no-graph",
      "-T",
      'json(self.bookmarks()) ++ "\\n"',
    ]).pipe(
      Effect.map((stdout) =>
        unique(
          parseJsonLines<Array<{ name?: string; remote?: string }>>(stdout)
            .flatMap((rows) => rows)
            .filter((row) => normalizeOptionalString(row.remote) === null)
            .map((row) => row.name?.trim() ?? "")
            .filter((name) => name.length > 0),
        ),
      ),
    );

  const resolveBookmarkState = (cwd: string) =>
    runJjStdout("JjCore.resolveBookmarkState", cwd, [
      "bookmark",
      "list",
      "--all-remotes",
      "-T",
      'json(self) ++ "\\n"',
    ]).pipe(
      Effect.map((stdout) => parseBookmarkEntries(stdout)),
      Effect.map((entries) => {
        const localBookmarks = entries.filter((entry) => entry.remoteName === null);
        const remoteBookmarks = entries.filter(
          (entry) => entry.remoteName !== null && entry.remoteName !== "git",
        );
        return {
          localBookmarks,
          remoteBookmarks,
        };
      }),
    );

  const resolveDefaultBranch = (
    localBranchNames: ReadonlyArray<string>,
    remoteBookmarks: ReadonlyArray<ParsedBookmark>,
  ): string | null => {
    for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
      if (
        localBranchNames.includes(candidate) ||
        remoteBookmarks.some(
          (bookmark) => bookmark.remoteName === "origin" && bookmark.name === candidate,
        )
      ) {
        return candidate;
      }
    }

    return localBranchNames[0] ?? null;
  };

  const resolveCurrentBranch = Effect.fn("JjCore.resolveCurrentBranch")(function* (cwd: string) {
    const [bookmarkState, currentCandidates, nearestCandidates, workspaceRoot, registry] =
      yield* Effect.all(
        [
          resolveBookmarkState(cwd),
          resolveCurrentBookmarkCandidates(cwd).pipe(Effect.catch(() => Effect.succeed([]))),
          resolveNearestBookmarkCandidates(cwd).pipe(Effect.catch(() => Effect.succeed([]))),
          resolveJjRoot(cwd).pipe(Effect.map(canonicalizePath)),
          resolveJjRepoDir(cwd).pipe(
            Effect.flatMap((root) => readWorkspaceRegistry(root)),
            Effect.catch(() => Effect.succeed(EMPTY_WORKSPACE_REGISTRY)),
          ),
        ],
        { concurrency: "unbounded" },
      );

    const localBranchNames = new Set(bookmarkState.localBookmarks.map((bookmark) => bookmark.name));
    const registryBranch = Object.entries(registry.branches).find(
      ([, worktreePath]) => canonicalizePath(worktreePath) === workspaceRoot,
    )?.[0];
    if (registryBranch && localBranchNames.has(registryBranch)) {
      return registryBranch;
    }

    const directCurrentCandidates = currentCandidates.filter((name) => localBranchNames.has(name));
    if (directCurrentCandidates.length > 0) {
      return sortCurrentBranchCandidates(directCurrentCandidates)[0] ?? null;
    }

    const candidates = nearestCandidates.filter((name) => localBranchNames.has(name));
    if (candidates.length === 0) {
      return null;
    }

    return sortCurrentBranchCandidates(candidates)[0] ?? null;
  });

  const readConfiguredUpstreamInfo = Effect.fn("JjCore.readConfiguredUpstreamInfo")(function* (
    cwd: string,
    branch: string,
  ) {
    const [remoteName, mergeRef] = yield* Effect.all(
      [
        readConfigValue(cwd, branchConfigKey(branch, "remote")).pipe(
          Effect.catch(() => Effect.succeed(null)),
        ),
        readConfigValue(cwd, branchConfigKey(branch, "merge")).pipe(
          Effect.catch(() => Effect.succeed(null)),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const remoteBranch = parseMergeRefBranchName(mergeRef);
    if (!remoteName || !remoteBranch) {
      return null;
    }

    return {
      remoteName,
      remoteBranch,
      upstreamRef: `${remoteName}/${remoteBranch}`,
    } satisfies BranchUpstreamInfo;
  });

  const resolveBranchUpstreamInfo = Effect.fn("JjCore.resolveBranchUpstreamInfo")(function* (
    cwd: string,
    branch: string,
    remoteBookmarks: ReadonlyArray<ParsedBookmark>,
  ) {
    const configured = yield* readConfiguredUpstreamInfo(cwd, branch);
    if (configured) {
      return configured;
    }

    const remoteName = resolveRemoteNameForBranch({
      branch,
      remoteBookmarks,
    });
    if (!remoteName) {
      return null;
    }

    return {
      remoteName,
      remoteBranch: branch,
      upstreamRef: `${remoteName}/${branch}`,
    } satisfies BranchUpstreamInfo;
  });

  const ensureLocalBookmark = Effect.fn("JjCore.ensureLocalBookmark")(function* (
    cwd: string,
    branch: string,
    revision: string,
  ) {
    const localBranchNames = yield* resolveBookmarkState(cwd).pipe(
      Effect.map((state) => state.localBookmarks.map((bookmark) => bookmark.name)),
    );

    if (localBranchNames.includes(branch)) {
      yield* runJjCommand({
        operation: "JjCore.ensureLocalBookmark.move",
        cwd,
        args: ["bookmark", "move", branch, "--to", revision],
      });
      return;
    }

    yield* runJjCommand({
      operation: "JjCore.ensureLocalBookmark.create",
      cwd,
      args: ["bookmark", "create", branch, "--revision", revision],
    });
  });
  const countRevset = (cwd: string, revset: string): Effect.Effect<number, never> =>
    runJjStdout("JjCore.countRevset", cwd, ["log", "-r", revset, "--count"]).pipe(
      Effect.map((stdout) => {
        const count = Number.parseInt(stdout.trim(), 10);
        return Number.isFinite(count) ? Math.max(0, count) : 0;
      }),
      Effect.catch(() => Effect.succeed(0)),
    );

  const readDiffStat = (cwd: string, fromCommit: string, toCommit: string) =>
    runJjCommand({
      operation: "JjCore.readDiffStat",
      cwd,
      args: ["diff", "--from", fromCommit, "--to", toCommit, "--stat"],
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.stdout));

  const statusDetails: JjCoreShape["statusDetails"] = Effect.fn("statusDetails")(function* (cwd) {
    const jjRoot = yield* resolveJjRoot(cwd).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!jjRoot) {
      return {
        isRepo: false,
        hasOriginRemote: false,
        isDefaultBranch: false,
        branch: null,
        upstreamRef: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
      } satisfies GitStatusDetails;
    }

    const [bookmarkState, branch, localCommit, currentCommit, gitRemoteNames] = yield* Effect.all(
      [
        resolveBookmarkState(cwd),
        resolveCurrentBranch(cwd),
        readCurrentCommitId(cwd, "@-"),
        readCurrentCommitId(cwd, "@"),
        listGitRemoteNames(cwd),
      ],
      { concurrency: "unbounded" },
    );

    const localBranchNames = bookmarkState.localBookmarks.map((bookmark) => bookmark.name);
    const defaultBranch = resolveDefaultBranch(localBranchNames, bookmarkState.remoteBookmarks);
    const upstreamInfo = branch
      ? yield* resolveBranchUpstreamInfo(cwd, branch, bookmarkState.remoteBookmarks)
      : null;
    const upstreamRef = upstreamInfo?.upstreamRef ?? null;
    const hasOriginRemote =
      gitRemoteNames.includes("origin") ||
      bookmarkState.remoteBookmarks.some((bookmark) => bookmark.remoteName === "origin");

    if (!localCommit || !currentCommit) {
      return {
        isRepo: true,
        hasOriginRemote,
        isDefaultBranch: branch !== null && branch === defaultBranch,
        branch,
        upstreamRef,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: upstreamRef !== null,
        aheadCount: 0,
        behindCount: 0,
      } satisfies GitStatusDetails;
    }

    const diffStatStdout = yield* readDiffStat(cwd, localCommit, currentCommit);
    const entries = parseDiffStatEntries(diffStatStdout);
    const workingTreeFiles = entries
      .map((entry) => ({
        path: entry.path,
        insertions: entry.insertions,
        deletions: entry.deletions,
      }))
      .toSorted((left, right) => left.path.localeCompare(right.path));

    const insertions = workingTreeFiles.reduce((sum, file) => sum + file.insertions, 0);
    const deletions = workingTreeFiles.reduce((sum, file) => sum + file.deletions, 0);
    const hasWorkingTreeChanges = workingTreeFiles.length > 0;

    let aheadCount = 0;
    let behindCount = 0;
    if (branch && upstreamInfo) {
      aheadCount = yield* countRevset(
        cwd,
        `${upstreamInfo.remoteBranch}@${upstreamInfo.remoteName}..${branch}`,
      );
      behindCount = yield* countRevset(
        cwd,
        `${branch}..${upstreamInfo.remoteBranch}@${upstreamInfo.remoteName}`,
      );
    } else if (branch && defaultBranch && branch !== defaultBranch) {
      aheadCount = yield* countRevset(cwd, `${defaultBranch}..${branch}`);
    }

    return {
      isRepo: true,
      hasOriginRemote,
      isDefaultBranch: branch !== null && branch === defaultBranch,
      branch,
      upstreamRef,
      hasWorkingTreeChanges,
      workingTree: {
        files: workingTreeFiles,
        insertions,
        deletions,
      },
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
    } satisfies GitStatusDetails;
  });

  const execute: JjCoreShape["execute"] = Effect.fn("execute")(function* (input) {
    const currentCommit = () =>
      readCurrentCommitId(input.cwd).pipe(
        Effect.flatMap((commitId) =>
          commitId
            ? Effect.succeed(commitId)
            : Effect.fail(
                commandError(
                  input.operation,
                  input.cwd,
                  `jj ${input.args.join(" ")}`,
                  "Unable to resolve the current working-copy commit.",
                ),
              ),
        ),
      );

    const args = [...input.args];
    const toResult = (result: {
      readonly code?: number;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly stdoutTruncated?: boolean;
      readonly stderrTruncated?: boolean;
    }) =>
      ({
        code: result.code ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        stdoutTruncated: result.stdoutTruncated ?? false,
        stderrTruncated: result.stderrTruncated ?? false,
      }) satisfies ExecuteGitResult;

    if (args[0] === "rev-parse" && (args.includes("HEAD") || args.includes("HEAD^{commit}"))) {
      const commitId = yield* currentCommit();
      return toResult({ stdout: `${commitId}\n` });
    }

    if (args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) {
      return toResult({ stdout: "true\n" });
    }

    if (args[0] === "diff") {
      const revisions = args.filter((arg) => !arg.startsWith("-")).slice(1);
      const [fromCommit, toCommit] = revisions.slice(-2);
      if (!fromCommit || !toCommit) {
        return yield* commandError(
          input.operation,
          input.cwd,
          `git ${args.join(" ")}`,
          "Unsupported diff invocation for jj repositories.",
        );
      }

      const result = yield* runJjCommand({
        operation: input.operation,
        cwd: input.cwd,
        args: ["diff", "--from", fromCommit, "--to", toCommit, "--git"],
        ...(input.allowNonZeroExit !== undefined
          ? { allowNonZeroExit: input.allowNonZeroExit }
          : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
        ...(input.truncateOutputAtMaxBytes !== undefined
          ? { truncateOutputAtMaxBytes: input.truncateOutputAtMaxBytes }
          : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
      });
      return toResult(result);
    }

    if (args[0] === "restore" && args.includes("--source")) {
      const sourceIndex = args.indexOf("--source");
      const source = args[sourceIndex + 1] ?? "";
      yield* trackPaths(input.cwd);
      const result = yield* runJjCommand({
        operation: input.operation,
        cwd: input.cwd,
        args: ["restore", "--from", source === "HEAD" ? yield* currentCommit() : source],
        ...(input.allowNonZeroExit !== undefined
          ? { allowNonZeroExit: input.allowNonZeroExit }
          : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
        ...(input.truncateOutputAtMaxBytes !== undefined
          ? { truncateOutputAtMaxBytes: input.truncateOutputAtMaxBytes }
          : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
      });
      return toResult(result);
    }

    return yield* commandError(
      input.operation,
      input.cwd,
      `git ${args.join(" ")}`,
      "Unsupported raw git command for jj repositories.",
    );
  });

  const status: JjCoreShape["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        isRepo: details.isRepo,
        hasOriginRemote: details.hasOriginRemote,
        isDefaultBranch: details.isDefaultBranch,
        branch: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        pr: null,
      })),
    );

  const prepareCommitContext: JjCoreShape["prepareCommitContext"] = Effect.fn(
    "prepareCommitContext",
  )(function* (cwd, filePaths) {
    yield* trackPaths(cwd, filePaths);

    yield* Ref.update(pendingCommitFilePaths, (state) => {
      const next = new Map(state);
      if (filePaths && filePaths.length > 0) {
        next.set(cwd, [...filePaths]);
      } else {
        next.delete(cwd);
      }
      return next;
    });

    const diffArgs = ["diff", "--summary", ...(filePaths ? [...filePaths] : [])];
    const stagedSummary = yield* runJjStdout(
      "JjCore.prepareCommitContext.summary",
      cwd,
      diffArgs,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (stagedSummary.length === 0) {
      return null;
    }

    const stagedPatchResult = yield* runJjCommand({
      operation: "JjCore.prepareCommitContext.patch",
      cwd,
      args: ["diff", "--git", ...(filePaths ? [...filePaths] : [])],
      maxOutputBytes: PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
      truncateOutputAtMaxBytes: true,
    });

    return {
      stagedSummary,
      stagedPatch: stagedPatchResult.stdout,
    } satisfies GitPreparedCommitContext;
  });

  const commit: JjCoreShape["commit"] = Effect.fn("commit")(function* (
    cwd,
    subject,
    body,
    _options?: GitCommitOptions,
  ) {
    const branchBeforeCommit = yield* resolveCurrentBranch(cwd);
    const pendingFilePaths = yield* Ref.modify(pendingCommitFilePaths, (state) => {
      const next = new Map(state);
      const filePaths = next.get(cwd);
      next.delete(cwd);
      return [filePaths, next] as const;
    });

    yield* trackPaths(cwd, pendingFilePaths);

    const description = body.trim().length > 0 ? `${subject}\n\n${body.trim()}` : subject;
    yield* runJjCommand({
      operation: "JjCore.commit",
      cwd,
      args: ["commit", "-m", description, ...(pendingFilePaths ?? [])],
      timeoutMs: 10 * 60_000,
    });

    if (branchBeforeCommit) {
      yield* runJjCommand({
        operation: "JjCore.commit.moveBookmark",
        cwd,
        args: ["bookmark", "move", branchBeforeCommit, "--to", "@-"],
      }).pipe(Effect.catch(() => Effect.void));
    }

    const commitSha =
      (yield* readCurrentCommitId(cwd, "@-").pipe(Effect.catch(() => Effect.succeed(null)))) ?? "";

    return { commitSha };
  });

  const pushCurrentBranch: JjCoreShape["pushCurrentBranch"] = Effect.fn("pushCurrentBranch")(
    function* (cwd, fallbackBranch) {
      const details = yield* statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* commandError(
          "JjCore.pushCurrentBranch",
          cwd,
          "jj git push",
          "Cannot push without an active bookmark.",
        );
      }

      const { remoteBookmarks } = yield* resolveBookmarkState(cwd);
      const upstreamInfo = yield* resolveBranchUpstreamInfo(cwd, branch, remoteBookmarks);
      const remoteName =
        upstreamInfo?.remoteName ??
        (yield* resolvePrimaryRemoteName(cwd).pipe(Effect.catch(() => Effect.succeed(null))));
      const remoteBranch = upstreamInfo?.remoteBranch ?? branch;

      if (!remoteName) {
        return yield* commandError(
          "JjCore.pushCurrentBranch",
          cwd,
          "jj git push",
          "Cannot push because no Git remote is configured for this repository.",
        );
      }

      const hasRemoteBookmark = remoteBookmarks.some(
        (bookmark) => bookmark.name === remoteBranch && bookmark.remoteName === remoteName,
      );
      if (hasRemoteBookmark && details.aheadCount === 0 && details.behindCount === 0) {
        return {
          status: "skipped_up_to_date" as const,
          branch,
          upstreamBranch: `${remoteName}/${remoteBranch}`,
        } satisfies GitPushResult;
      }

      if (remoteBranch !== branch) {
        yield* ensureLocalBookmark(cwd, remoteBranch, branch);
      }

      yield* runJjCommand({
        operation: "JjCore.pushCurrentBranch",
        cwd,
        args: [
          "git",
          "push",
          "--remote",
          remoteName,
          "--bookmark",
          remoteBranch === branch ? branch : remoteBranch,
        ],
        timeoutMs: 30_000,
      });

      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${remoteName}/${remoteBranch}`,
        setUpstream: upstreamInfo === null || !hasRemoteBookmark,
      } satisfies GitPushResult;
    },
  );

  const pullCurrentBranch: JjCoreShape["pullCurrentBranch"] = Effect.fn("pullCurrentBranch")(
    function* (cwd) {
      const details = yield* statusDetails(cwd);
      const branch = details.branch;
      if (!branch) {
        return yield* commandError(
          "JjCore.pullCurrentBranch",
          cwd,
          "jj git fetch",
          "Cannot pull without an active bookmark.",
        );
      }

      const { remoteBookmarks } = yield* resolveBookmarkState(cwd);
      const upstreamInfo = yield* resolveBranchUpstreamInfo(cwd, branch, remoteBookmarks);
      if (!upstreamInfo) {
        return yield* commandError(
          "JjCore.pullCurrentBranch",
          cwd,
          "jj git fetch",
          "Current bookmark has no tracked remote. Push it first.",
        );
      }

      // Snapshot the bookmark position before fetch so we can detect movement.
      // JJ auto-advances tracked local bookmarks during fetch, so the
      // before/after comparison is the source of truth — not behind-count.
      const bookmarkCommitBefore = yield* readCurrentCommitId(cwd, branch).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );

      yield* runJjCommand({
        operation: "JjCore.pullCurrentBranch.fetch",
        cwd,
        args: [
          "git",
          "fetch",
          "--remote",
          upstreamInfo.remoteName,
          "--branch",
          upstreamInfo.remoteBranch,
        ],
        timeoutMs: 30_000,
      });

      const bookmarkCommitAfter = yield* readCurrentCommitId(cwd, branch).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );

      if (bookmarkCommitBefore === bookmarkCommitAfter) {
        return {
          status: "skipped_up_to_date" as const,
          branch,
          upstreamBranch: upstreamInfo.upstreamRef,
        };
      }

      // Rebase the working copy on top of the updated branch to preserve any
      // in-progress changes.  JJ auto-snapshots the working copy, so there is
      // no "dirty working tree" concept that should block a pull.
      yield* runJjCommand({
        operation: "JjCore.pullCurrentBranch.rebaseWorkingCopy",
        cwd,
        args: ["rebase", "-r", "@", "-d", branch],
      }).pipe(Effect.catch(() => Effect.void));

      return {
        status: "pulled" as const,
        branch,
        upstreamBranch: upstreamInfo.upstreamRef,
      };
    },
  );

  const readRangeContext: JjCoreShape["readRangeContext"] = Effect.fn("readRangeContext")(
    function* (cwd, baseBranch) {
      const currentBranch = yield* resolveCurrentBranch(cwd);
      const targetRev = currentBranch ?? "@-";
      const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
        [
          runJjCommand({
            operation: "JjCore.readRangeContext.log",
            cwd,
            args: [
              "log",
              "-r",
              `${baseBranch}..${targetRev}`,
              "--no-graph",
              "-T",
              'description.first_line() ++ "\\n"',
            ],
            maxOutputBytes: RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          }).pipe(Effect.map((result) => result.stdout)),
          runJjCommand({
            operation: "JjCore.readRangeContext.diffStat",
            cwd,
            args: ["diff", "--from", baseBranch, "--to", targetRev, "--stat"],
            maxOutputBytes: RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          }).pipe(Effect.map((result) => result.stdout)),
          runJjCommand({
            operation: "JjCore.readRangeContext.diffPatch",
            cwd,
            args: ["diff", "--from", baseBranch, "--to", targetRev, "--git"],
            maxOutputBytes: RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          }).pipe(Effect.map((result) => result.stdout)),
        ],
        { concurrency: "unbounded" },
      );

      return {
        commitSummary,
        diffSummary,
        diffPatch,
      } satisfies GitRangeContext;
    },
  );

  const readConfigValue: JjCoreShape["readConfigValue"] = (cwd, key) =>
    Effect.gen(function* () {
      const remoteUrlMatch = /^remote\.([^.]+)\.url$/.exec(key);
      if (remoteUrlMatch) {
        const remoteName = remoteUrlMatch[1] ?? "";
        const remoteEntries = yield* listGitRemoteEntries(cwd);
        return remoteEntries.find((entry) => entry.name === remoteName)?.url ?? null;
      }

      const result = yield* runJjCommand({
        operation: "JjCore.readConfigValue",
        cwd,
        args: ["config", "get", key],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      });
      if (result.code !== 0) {
        return null;
      }

      const value = result.stdout.trim();
      return value.length > 0 ? value : null;
    });

  const isInsideWorkTree: JjCoreShape["isInsideWorkTree"] = (cwd) =>
    runJjCommand({
      operation: "JjCore.isInsideWorkTree",
      cwd,
      args: ["root"],
      allowNonZeroExit: true,
      timeoutMs: 5_000,
    }).pipe(Effect.map((result) => result.code === 0));

  const listWorkspaceFiles: JjCoreShape["listWorkspaceFiles"] = (cwd) =>
    runJjCommand({
      operation: "JjCore.listWorkspaceFiles",
      cwd,
      args: ["file", "list", "-r", "@", "-T", 'path ++ "\\n"'],
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
      truncateOutputAtMaxBytes: true,
    }).pipe(
      Effect.map((result) => ({
        paths: splitLineSeparatedPaths(result.stdout).filter(
          (value) => value !== ".jj" && !value.startsWith(".jj/"),
        ),
        truncated: result.stdoutTruncated,
      })),
    );

  const filterIgnoredPaths: JjCoreShape["filterIgnoredPaths"] = (cwd, relativePaths) => {
    if (relativePaths.length === 0) {
      return Effect.succeed(relativePaths);
    }

    return listWorkspaceFiles(cwd).pipe(
      Effect.map((result) => {
        const trackedPaths = new Set(result.paths);
        return relativePaths.filter((p) => trackedPaths.has(p));
      }),
      Effect.catch(() => Effect.succeed(relativePaths)),
    );
  };

  const listBranches: JjCoreShape["listBranches"] = Effect.fn("listBranches")(function* (input) {
    const jjRoot = yield* resolveJjRoot(input.cwd).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!jjRoot) {
      return {
        branches: [],
        isRepo: false,
        hasOriginRemote: false,
        nextCursor: null,
        totalCount: 0,
      };
    }

    const [bookmarkState, currentStatus, workspaceRoot, registry] = yield* Effect.all(
      [
        resolveBookmarkState(input.cwd),
        statusDetails(input.cwd),
        resolveJjRoot(input.cwd).pipe(Effect.map(canonicalizePath)),
        resolveJjRepoDir(input.cwd).pipe(
          Effect.flatMap((root) => readWorkspaceRegistry(root)),
          Effect.catch(() => Effect.succeed(EMPTY_WORKSPACE_REGISTRY)),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const defaultBranch = resolveDefaultBranch(
      bookmarkState.localBookmarks.map((bookmark) => bookmark.name),
      bookmarkState.remoteBookmarks,
    );
    const localBranches: GitBranch[] = bookmarkState.localBookmarks
      .map(
        (bookmark) =>
          ({
            name: bookmark.name,
            current: bookmark.name === currentStatus.branch,
            isRemote: false,
            isDefault: bookmark.name === defaultBranch,
            worktreePath: registry.branches[bookmark.name] ?? null,
          }) satisfies GitBranch,
      )
      .toSorted((left, right) => {
        const leftPriority = left.current ? 0 : left.isDefault ? 1 : 2;
        const rightPriority = right.current ? 0 : right.isDefault ? 1 : 2;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
        return left.name.localeCompare(right.name);
      });

    const remoteBranches: GitBranch[] = bookmarkState.remoteBookmarks
      .map(
        (bookmark) =>
          ({
            name: `${bookmark.remoteName}/${bookmark.name}`,
            current: false,
            isRemote: true,
            remoteName: bookmark.remoteName ?? undefined,
            isDefault: bookmark.name === defaultBranch,
            worktreePath: null,
          }) satisfies GitBranch,
      )
      .toSorted((left, right) => left.name.localeCompare(right.name));

    const registryCurrentPath = currentStatus.branch
      ? (registry.branches[currentStatus.branch] ?? null)
      : null;
    const adjustedLocalBranches: GitBranch[] = localBranches.map((branch) => {
      const worktreePath =
        branch.name === currentStatus.branch
          ? workspaceRoot
          : (branch.worktreePath ??
            (branch.name === currentStatus.branch ? registryCurrentPath : null));

      return {
        name: branch.name,
        current: branch.current,
        isRemote: branch.isRemote,
        isDefault: branch.isDefault,
        worktreePath,
      } satisfies GitBranch;
    });

    const paginated = paginateBranches({
      branches: filterBranchesForListQuery(
        dedupeRemoteBranchesWithLocalMatches([...adjustedLocalBranches, ...remoteBranches]),
        input.query,
      ),
      cursor: input.cursor,
      limit: input.limit,
    });

    return {
      branches: [...paginated.branches],
      isRepo: true,
      hasOriginRemote: currentStatus.hasOriginRemote,
      nextCursor: paginated.nextCursor,
      totalCount: paginated.totalCount,
    };
  });

  const createWorktree: JjCoreShape["createWorktree"] = Effect.fn("createWorktree")(
    function* (input) {
      const targetBranch = input.newBranch ?? input.branch;
      if (input.newBranch) {
        yield* runJjCommand({
          operation: "JjCore.createWorktree.createBookmark",
          cwd: input.cwd,
          args: ["bookmark", "create", targetBranch, "--revision", input.branch],
        });
      }

      const [workspaceRoot, repoDir] = yield* Effect.all(
        [resolveJjRoot(input.cwd), resolveJjRepoDir(input.cwd)],
        { concurrency: "unbounded" },
      );
      const repoName = path.basename(workspaceRoot);
      const sanitizedBranch = targetBranch.replace(/\//g, "-");
      const workspacePath = input.path ?? path.join(worktreesDir, repoName, sanitizedBranch);
      const workspaceName = sanitizedBranch;

      yield* fileSystem
        .makeDirectory(path.dirname(workspacePath), { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            commandError(
              "JjCore.createWorktree.prepareDirectory",
              input.cwd,
              "mkdir",
              cause instanceof Error ? cause.message : String(cause),
              cause,
            ),
          ),
        );

      yield* runJjCommand({
        operation: "JjCore.createWorktree.workspaceAdd",
        cwd: input.cwd,
        args: [
          "workspace",
          "add",
          "--name",
          workspaceName,
          "--revision",
          targetBranch,
          workspacePath,
        ],
      });

      yield* recordWorkspaceBranch(repoDir, workspacePath, targetBranch);

      return {
        worktree: {
          path: workspacePath,
          branch: targetBranch,
        },
      };
    },
  );

  const fetchPullRequestBranch: JjCoreShape["fetchPullRequestBranch"] = Effect.fn(
    "fetchPullRequestBranch",
  )(function* (input: GitFetchPullRequestBranchInput) {
    const remoteBranch = input.remoteBranch?.trim() ?? "";
    if (remoteBranch.length === 0) {
      return yield* commandError(
        "JjCore.fetchPullRequestBranch",
        input.cwd,
        "jj git fetch",
        "JJ-native PR fetch requires the pull request head branch name.",
      );
    }

    const remoteName =
      input.remoteName?.trim() ||
      (yield* resolvePrimaryRemoteName(input.cwd).pipe(Effect.catch(() => Effect.succeed(null))));
    if (!remoteName) {
      return yield* commandError(
        "JjCore.fetchPullRequestBranch",
        input.cwd,
        "jj git fetch",
        "Cannot resolve a Git remote for this pull request.",
      );
    }

    yield* runJjCommand({
      operation: "JjCore.fetchPullRequestBranch.fetch",
      cwd: input.cwd,
      args: ["git", "fetch", "--remote", remoteName, "--branch", remoteBranch],
      timeoutMs: 30_000,
    });

    yield* ensureLocalBookmark(input.cwd, input.branch, `${remoteBranch}@${remoteName}`);
  });

  const ensureRemote: JjCoreShape["ensureRemote"] = Effect.fn("ensureRemote")(function* (input) {
    const remoteEntries = yield* listGitRemoteEntries(input.cwd);
    const remoteNames = new Set(remoteEntries.map((entry) => entry.name));

    const preferredRemoteName =
      input.preferredName.trim().length > 0 ? input.preferredName.trim() : "fork";
    const normalizedUrl = normalizeRemoteUrl(input.url);
    for (const remoteEntry of remoteEntries) {
      if (normalizeRemoteUrl(remoteEntry.url) === normalizedUrl) {
        return remoteEntry.name;
      }
    }

    let resolvedName = preferredRemoteName;
    let suffix = 2;
    while (remoteNames.has(resolvedName)) {
      resolvedName = `${preferredRemoteName}-${suffix}`;
      suffix += 1;
    }

    yield* runJjCommand({
      operation: "JjCore.ensureRemote.remoteAdd",
      cwd: input.cwd,
      args: ["git", "remote", "add", resolvedName, input.url],
    }).pipe(Effect.asVoid);

    return resolvedName;
  });

  const fetchRemoteBranch: JjCoreShape["fetchRemoteBranch"] = Effect.fn("fetchRemoteBranch")(
    function* (input: GitFetchRemoteBranchInput) {
      yield* runJjCommand({
        operation: "JjCore.fetchRemoteBranch.fetch",
        cwd: input.cwd,
        args: ["git", "fetch", "--remote", input.remoteName, "--branch", input.remoteBranch],
        timeoutMs: 30_000,
      });

      yield* ensureLocalBookmark(
        input.cwd,
        input.localBranch,
        `${input.remoteBranch}@${input.remoteName}`,
      );
    },
  );

  const setBranchUpstream: JjCoreShape["setBranchUpstream"] = Effect.fn("setBranchUpstream")(
    function* (input) {
      yield* runJjCommand({
        operation: "JjCore.setBranchUpstream.trackRemoteBookmark",
        cwd: input.cwd,
        args: ["bookmark", "track", `${input.remoteBranch}@${input.remoteName}`],
        allowNonZeroExit: true,
      }).pipe(Effect.catch(() => Effect.void));

      yield* runJjCommand({
        operation: "JjCore.setBranchUpstream.remote",
        cwd: input.cwd,
        args: [
          "config",
          "set",
          "--repo",
          branchConfigKey(input.branch, "remote"),
          JSON.stringify(input.remoteName),
        ],
        timeoutMs: 5_000,
      }).pipe(Effect.asVoid);
      yield* runJjCommand({
        operation: "JjCore.setBranchUpstream.merge",
        cwd: input.cwd,
        args: [
          "config",
          "set",
          "--repo",
          branchConfigKey(input.branch, "merge"),
          JSON.stringify(`refs/heads/${input.remoteBranch}`),
        ],
        timeoutMs: 5_000,
      }).pipe(Effect.asVoid);
    },
  );

  const removeWorktree: JjCoreShape["removeWorktree"] = Effect.fn("removeWorktree")(
    function* (input) {
      const workspaceExists = yield* fileSystem.stat(input.path).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (!workspaceExists) {
        return yield* commandError(
          "JjCore.removeWorktree",
          input.cwd,
          "jj workspace forget",
          `Workspace path does not exist: ${input.path}`,
        );
      }

      const status = yield* statusDetails(input.path).pipe(
        Effect.catch(() =>
          Effect.succeed({
            hasWorkingTreeChanges: false,
            branch: null,
          } as Pick<GitStatusDetails, "hasWorkingTreeChanges" | "branch">),
        ),
      );
      if (status.hasWorkingTreeChanges && !input.force) {
        return yield* commandError(
          "JjCore.removeWorktree",
          input.cwd,
          "jj workspace forget",
          "Workspace has uncommitted changes. Pass force to remove it.",
        );
      }

      const repoDir = yield* resolveJjRepoDir(input.path);
      yield* runJjCommand({
        operation: "JjCore.removeWorktree.forget",
        cwd: input.path,
        args: ["workspace", "forget"],
      });
      yield* fileSystem
        .remove(input.path, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            commandError(
              "JjCore.removeWorktree.removePath",
              input.cwd,
              "remove workspace path",
              cause instanceof Error ? cause.message : String(cause),
              cause,
            ),
          ),
        );

      yield* updateWorkspaceRegistry(repoDir, (registry) => ({
        branches: Object.fromEntries(
          Object.entries(registry.branches).filter(
            ([branchName, worktreePath]) =>
              canonicalizePath(worktreePath) !== canonicalizePath(input.path) &&
              branchName !== status.branch,
          ),
        ),
      })).pipe(Effect.catch(() => Effect.void));
    },
  );

  const renameBranch: JjCoreShape["renameBranch"] = Effect.fn("renameBranch")(function* (
    input: GitRenameBranchInput,
  ) {
    if (input.oldBranch === input.newBranch) {
      return { branch: input.newBranch };
    }

    yield* runJjCommand({
      operation: "JjCore.renameBranch",
      cwd: input.cwd,
      args: ["bookmark", "rename", input.oldBranch, input.newBranch],
    });

    const repoDir = yield* resolveJjRepoDir(input.cwd);
    yield* updateWorkspaceRegistry(repoDir, (registry) => {
      const existingPath = registry.branches[input.oldBranch];
      if (!existingPath) {
        return registry;
      }
      const nextBranches = { ...registry.branches };
      delete nextBranches[input.oldBranch];
      nextBranches[input.newBranch] = existingPath;
      return { branches: nextBranches };
    }).pipe(Effect.catch(() => Effect.void));

    return { branch: input.newBranch };
  });

  const createBranch: JjCoreShape["createBranch"] = Effect.fn("createBranch")(function* (input) {
    yield* runJjCommand({
      operation: "JjCore.createBranch",
      cwd: input.cwd,
      args: ["bookmark", "create", input.branch, "--revision", "@"],
    });

    const [repoDir, workspaceRoot] = yield* Effect.all(
      [resolveJjRepoDir(input.cwd), resolveJjRoot(input.cwd)],
      { concurrency: "unbounded" },
    );
    yield* recordWorkspaceBranch(repoDir, workspaceRoot, input.branch).pipe(
      Effect.catch(() => Effect.void),
    );
  });

  const checkoutBranch: JjCoreShape["checkoutBranch"] = Effect.fn("checkoutBranch")(
    function* (input) {
      yield* runJjCommand({
        operation: "JjCore.checkoutBranch",
        cwd: input.cwd,
        args: ["new", input.branch],
      });

      const [repoDir, workspaceRoot] = yield* Effect.all(
        [resolveJjRepoDir(input.cwd), resolveJjRoot(input.cwd)],
        { concurrency: "unbounded" },
      );
      yield* recordWorkspaceBranch(repoDir, workspaceRoot, input.branch).pipe(
        Effect.catch(() => Effect.void),
      );
    },
  );

  const initRepo: JjCoreShape["initRepo"] = (input) =>
    runJjCommand({
      operation: "JjCore.initRepo",
      cwd: process.cwd(),
      args: ["git", "init", input.cwd],
    }).pipe(Effect.asVoid);

  const listLocalBranchNames: JjCoreShape["listLocalBranchNames"] = (cwd) =>
    resolveBookmarkState(cwd).pipe(
      Effect.map((state) => state.localBookmarks.map((bookmark) => bookmark.name).toSorted()),
    );

  return {
    execute,
    status,
    statusDetails,
    prepareCommitContext,
    commit,
    pushCurrentBranch,
    pullCurrentBranch,
    readRangeContext,
    readConfigValue,
    isInsideWorkTree,
    listWorkspaceFiles,
    filterIgnoredPaths,
    listBranches,
    createWorktree,
    fetchPullRequestBranch,
    ensureRemote,
    fetchRemoteBranch,
    setBranchUpstream,
    removeWorktree,
    renameBranch,
    createBranch,
    checkoutBranch,
    initRepo,
    listLocalBranchNames,
  } satisfies GitCoreShape;
});

export const JjCoreLive = Layer.effect(JjCore, makeJjCore());
