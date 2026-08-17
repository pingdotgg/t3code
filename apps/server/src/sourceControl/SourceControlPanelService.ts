import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DEFAULT_SOURCE_CONTROL_ALL_REMOTES_FETCH_INTERVAL,
  GitCommandError,
  type VcsPanelAddRemoteInput,
  type VcsPanelBranchActionInput,
  type VcsPanelBranchCommitsInput,
  type VcsPanelBranchCommitsResult,
  type VcsPanelBranchDetails,
  type VcsPanelBranchDetailsInput,
  type VcsPanelCommitActionInput,
  type VcsPanelCommitInput,
  type VcsPanelCompareInput,
  type VcsPanelCompareResult,
  type VcsPanelDeleteBranchInput,
  type VcsPanelFileActionInput,
  type VcsPanelFileChange,
  type VcsPanelFileDiffInput,
  type VcsPanelFileDiffResult,
  type VcsPanelFetchAllRemotesInput,
  type VcsPanelRemote,
  type VcsPanelRemoteInput,
  type VcsPanelRefActionInput,
  type VcsPanelSnapshotInput,
  type VcsPanelSnapshotResult,
  type VcsPanelStashDetails,
  type VcsPanelStashDetailsInput,
  type VcsPanelStashInput,
  type VcsPanelUndoCommitInput,
  type VcsPanelWorktreeChangeSet,
  type VcsPanelWorkingTreeFileEnrichmentInput,
  type VcsPanelWorkingTreeFileEnrichmentResult,
  type SourceControlProviderKind,
  type VcsPullResult,
  type VcsRef,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";

import { sanitizeErrorCause } from "../diagnostics/ErrorCause.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { GitVcsDriver, type ExecuteGitProgress } from "../vcs/GitVcsDriver.ts";
import { resolveGitCommandTimeoutMs } from "../vcs/GitCommandTimeout.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
import { makeSourceControlPanelActions } from "./SourceControlPanelActions.ts";
import {
  parseCommits,
  parseFileChangesFromNumstat,
  parseLocalBranches,
  parseNameStatus,
  parseRemoteBranches,
  parseRemoteVerbose,
  parseStashes,
  parseWorktreeBranchEntries,
  parseWorktreeBranchPaths,
  uniquePaths,
  type WorktreeBranchEntry,
} from "./SourceControlPanelParsers.ts";
import { makeSourceControlPanelReaders } from "./SourceControlPanelReaders.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";
import {
  mergeNumstats,
  panelStatusFromLocal,
  parseNumstat,
  readNulField,
  untrackedPathsFromPorcelain,
  unstagedFilesFromPorcelainStatus,
} from "./SourceControlPanelStatusParsers.ts";
const isGitCommandError = Schema.is(GitCommandError);
const LOCAL_BRANCHES_WITH_WORKTREE_PATH_ARGS = [
  "branch",
  "--format=%(refname:short)%09%(HEAD)%09%(worktreepath)%09%(committerdate:iso-strict)%09%(upstream:short)%09%(upstream:track)",
] as const;
const LOCAL_BRANCHES_WITHOUT_WORKTREE_PATH_ARGS = [
  "branch",
  "--format=%(refname:short)%09%(HEAD)%09%09%(committerdate:iso-strict)%09%(upstream:short)%09%(upstream:track)",
] as const;

type ConfiguredSourceControlProviderKind = Exclude<SourceControlProviderKind, "unknown">;

function isConfiguredSourceControlProviderKind(
  kind: SourceControlProviderKind,
): kind is ConfiguredSourceControlProviderKind {
  return kind !== "unknown";
}

interface PanelSnapshotCacheState {
  readonly latestRequestByCwd: ReadonlyMap<string, number>;
  readonly latestFullRequestByCwd: ReadonlyMap<string, number>;
  readonly completedFullRequestByCwd: ReadonlyMap<string, number>;
  readonly snapshotsByCwd: ReadonlyMap<string, VcsPanelSnapshotResult>;
}

const PANEL_SNAPSHOT_CACHE_CAPACITY = 64;
const COMMIT_HOOK_NATIVE_DEPENDENCY_FAILURE_DETAIL =
  "The Git pre-commit hook could not load a required native dependency. Reinstall the repository dependencies and try again.";
const COMMIT_HOOK_FAILURE_DETAIL =
  "The Git pre-commit hook failed. Run the repository pre-commit hook in a terminal for details.";

type CommitFailureHint = "hook-failed" | "native-dependency";

function commitFailureHintFromOutputLine(line: string): CommitFailureHint | null {
  if (
    line.includes("Cannot find native binding") ||
    line.includes("Cannot find module 'vite-plus/binding'") ||
    line.includes('Cannot find module "vite-plus/binding"')
  ) {
    return "native-dependency";
  }
  if (line.includes("VITE+ - pre-commit script failed")) {
    return "hook-failed";
  }
  return null;
}

function commitFailureDetail(hint: CommitFailureHint | null): string | null {
  switch (hint) {
    case "native-dependency":
      return COMMIT_HOOK_NATIVE_DEPENDENCY_FAILURE_DETAIL;
    case "hook-failed":
      return COMMIT_HOOK_FAILURE_DETAIL;
    case null:
      return null;
  }
}

function setBoundedMapEntry<K, V>(
  source: ReadonlyMap<K, V>,
  key: K,
  value: V,
  capacity: number,
): ReadonlyMap<K, V> {
  const next = new Map(source);
  next.delete(key);
  next.set(key, value);
  while (next.size > capacity) {
    const oldestKey = next.keys().next().value;
    if (oldestKey === undefined) break;
    next.delete(oldestKey);
  }
  return next;
}

export class SourceControlPanelService extends Context.Service<
  SourceControlPanelService,
  {
    readonly snapshot: (
      input: VcsPanelSnapshotInput,
    ) => Effect.Effect<VcsPanelSnapshotResult, GitCommandError>;
    readonly branchDetails: (
      input: VcsPanelBranchDetailsInput,
    ) => Effect.Effect<VcsPanelBranchDetails, GitCommandError>;
    readonly branchCommits: (
      input: VcsPanelBranchCommitsInput,
    ) => Effect.Effect<VcsPanelBranchCommitsResult, GitCommandError>;
    readonly stashDetails: (
      input: VcsPanelStashDetailsInput,
    ) => Effect.Effect<VcsPanelStashDetails, GitCommandError>;
    readonly stageFiles: (input: VcsPanelFileActionInput) => Effect.Effect<void, GitCommandError>;
    readonly unstageFiles: (input: VcsPanelFileActionInput) => Effect.Effect<void, GitCommandError>;
    readonly discardFiles: (input: VcsPanelFileActionInput) => Effect.Effect<void, GitCommandError>;
    readonly enrichWorkingTreeFiles: (
      input: VcsPanelWorkingTreeFileEnrichmentInput,
    ) => Effect.Effect<VcsPanelWorkingTreeFileEnrichmentResult, GitCommandError>;
    readonly readFileDiff: (
      input: VcsPanelFileDiffInput,
    ) => Effect.Effect<VcsPanelFileDiffResult, GitCommandError>;
    readonly commitStaged: (input: VcsPanelCommitInput) => Effect.Effect<void, GitCommandError>;
    readonly pullBranch: (
      input: VcsPanelBranchActionInput,
    ) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly pushBranch: (input: VcsPanelBranchActionInput) => Effect.Effect<void, GitCommandError>;
    readonly deleteBranch: (
      input: VcsPanelDeleteBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly undoLatestCommit: (
      input: VcsPanelUndoCommitInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly revertCommit: (
      input: VcsPanelCommitActionInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly checkoutCommit: (
      input: VcsPanelCommitActionInput,
    ) => Effect.Effect<{ readonly refName: string }, GitCommandError>;
    readonly createBranchFromCommit: (
      input: VcsPanelCommitActionInput,
    ) => Effect.Effect<{ readonly refName: string }, GitCommandError>;
    readonly mergeBranchIntoCurrent: (
      input: VcsPanelRefActionInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly rebaseCurrentOnto: (
      input: VcsPanelRefActionInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchBranch: (
      input: VcsPanelBranchActionInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchRemote: (input: VcsPanelRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly fetchAllRemotes: (
      input: VcsPanelFetchAllRemotesInput,
    ) => Effect.Effect<boolean, GitCommandError>;
    readonly addRemote: (input: VcsPanelAddRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly removeRemote: (input: VcsPanelRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly createStash: (input: VcsPanelStashInput) => Effect.Effect<void, GitCommandError>;
    readonly applyStash: (input: VcsPanelStashInput) => Effect.Effect<void, GitCommandError>;
    readonly popStash: (input: VcsPanelStashInput) => Effect.Effect<void, GitCommandError>;
    readonly dropStash: (input: VcsPanelStashInput) => Effect.Effect<void, GitCommandError>;
    readonly compare: (
      input: VcsPanelCompareInput,
    ) => Effect.Effect<VcsPanelCompareResult, GitCommandError>;
  }
>()("t3/sourceControl/SourceControlPanelService") {}

function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function gitError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
) {
  return new GitCommandError({
    operation,
    command: commandLabel(args),
    cwd,
    detail,
    ...(cause === undefined ? {} : { cause: sanitizeErrorCause(cause) }),
  });
}

function asGitCommandError(operation: string, cwd: string, args: readonly string[]) {
  return (cause: unknown) =>
    isGitCommandError(cause)
      ? cause
      : gitError(operation, cwd, args, "Source control operation failed.", cause);
}

function isUnsupportedWorktreePathFormat(detail: string) {
  detail = detail.toLowerCase();
  return detail.includes("worktreepath") && detail.includes("unknown field");
}

export const make = Effect.fn("makeSourceControlPanelService")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver;
  const path = yield* Path.Path;
  const workflow = yield* GitWorkflowService;
  const serverSettings = yield* ServerSettingsService;
  const sourceControlProviders = Option.getOrUndefined(
    yield* Effect.serviceOption(SourceControlProviderRegistry),
  );
  const sourceControlRateLimits = Option.getOrUndefined(
    yield* Effect.serviceOption(SourceControlRateLimit.SourceControlRateLimit),
  );
  const textGeneration = Option.getOrUndefined(yield* Effect.serviceOption(TextGeneration));

  const runResult = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options?: {
      readonly allowNonZeroExit?: boolean;
      readonly env?: NodeJS.ProcessEnv;
      readonly progress?: ExecuteGitProgress;
    },
  ) =>
    git
      .execute({
        operation,
        cwd,
        args,
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.progress !== undefined ? { progress: options.progress } : {}),
        allowNonZeroExit: options?.allowNonZeroExit ?? false,
        timeoutMs: resolveGitCommandTimeoutMs(args),
        maxOutputBytes: 8 * 1024 * 1024,
        appendTruncationMarker: true,
      })
      .pipe(Effect.mapError(asGitCommandError(operation, cwd, args)));

  const run = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options?: {
      readonly allowNonZeroExit?: boolean;
      readonly env?: NodeJS.ProcessEnv;
      readonly progress?: ExecuteGitProgress;
    },
  ) =>
    runResult(operation, cwd, args, options).pipe(
      Effect.flatMap((result) => {
        if (options?.allowNonZeroExit === true || result.exitCode === 0) {
          return Effect.succeed(result.stdout);
        }
        return Effect.fail(
          gitError(operation, cwd, args, result.stderr.trim() || result.stdout.trim()),
        );
      }),
    );

  const snapshotCacheRef = yield* Ref.make<PanelSnapshotCacheState>({
    latestRequestByCwd: new Map(),
    latestFullRequestByCwd: new Map(),
    completedFullRequestByCwd: new Map(),
    snapshotsByCwd: new Map(),
  });

  const sourceControlAllRemotesFetchInterval = serverSettings.getSettings.pipe(
    Effect.map(
      (settings) =>
        resolveServerBackgroundActivitySettings(settings).sourceControlAllRemotesFetchInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_SOURCE_CONTROL_ALL_REMOTES_FETCH_INTERVAL),
  );

  const fetchAllRemotesCache = yield* Cache.makeWith(
    (gitCommonDir: string) => {
      const fetchCwd =
        path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
      return Effect.gen(function* () {
        const interval = yield* sourceControlAllRemotesFetchInterval;
        yield* run("vcs.panel.fetchAllRemotes", fetchCwd, [
          "--git-dir",
          gitCommonDir,
          "fetch",
          "--all",
        ]).pipe(Effect.ensuring(git.invalidateRefs(fetchCwd)));
        return interval;
      });
    },
    {
      capacity: 128,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? exit.value : Duration.seconds(5)),
    },
  );

  yield* Stream.runForEach(serverSettings.streamChanges, () =>
    Cache.invalidateAll(fetchAllRemotesCache),
  ).pipe(Effect.forkScoped);

  const resolveGitCommonDir = Effect.fn("SourceControlPanelService.resolveGitCommonDir")(function* (
    cwd: string,
  ) {
    const commonDir = (yield* run("vcs.panel.resolveGitCommonDir", cwd, [
      "rev-parse",
      "--git-common-dir",
    ])).trim();
    return path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
  });

  const fetchAllRemotes: SourceControlPanelService["Service"]["fetchAllRemotes"] = Effect.fn(
    "fetchAllRemotes",
  )(function* (input) {
    if (input.force !== true) {
      const interval = yield* sourceControlAllRemotesFetchInterval;
      if (Duration.isZero(interval)) return false;
    }
    const gitCommonDir = yield* resolveGitCommonDir(input.cwd);
    if (input.force === true) {
      yield* Cache.invalidate(fetchAllRemotesCache, gitCommonDir);
    } else if (Option.isSome(yield* Cache.getOption(fetchAllRemotesCache, gitCommonDir))) {
      return false;
    }
    yield* Cache.get(fetchAllRemotesCache, gitCommonDir);
    return true;
  });

  const withTemporaryIntentToAddIndex = <A, E>(
    input: {
      readonly cwd: string;
      readonly paths: readonly string[];
      readonly operations: {
        readonly gitIndexPath: string;
        readonly tempIndexReadTree: string;
        readonly tempIndexIntentToAdd: string;
      };
    },
    body: (env: NodeJS.ProcessEnv) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const gitIndexPath = (yield* run(input.operations.gitIndexPath, input.cwd, [
        "rev-parse",
        "--git-path",
        "index",
      ])).trim();
      const sourceIndexPath = path.isAbsolute(gitIndexPath)
        ? gitIndexPath
        : path.resolve(input.cwd, gitIndexPath);
      const tempDir = yield* fileSystem.makeTempDirectory({ prefix: "t3-vcs-index-" });
      return yield* Effect.gen(function* () {
        const tempIndexPath = path.join(tempDir, "index");
        const env = { ...globalThis.process.env, GIT_INDEX_FILE: tempIndexPath };
        yield* fileSystem.copyFile(sourceIndexPath, tempIndexPath).pipe(
          Effect.catch(() =>
            run(input.operations.tempIndexReadTree, input.cwd, ["read-tree", "HEAD"], {
              env,
            }).pipe(
              Effect.asVoid,
              Effect.catch(() => Effect.void),
            ),
          ),
        );
        yield* run(
          input.operations.tempIndexIntentToAdd,
          input.cwd,
          ["--literal-pathspecs", "add", "-N", "--", ...input.paths],
          { env },
        ).pipe(Effect.asVoid);
        return yield* body(env);
      }).pipe(
        Effect.ensuring(
          fileSystem.remove(tempDir, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );
    });

  const withTemporarySelectedIndex = <A, E>(
    cwd: string,
    paths: readonly string[],
    body: (env: NodeJS.ProcessEnv) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const tempDir = yield* fileSystem
        .makeTempDirectory({ prefix: "t3-vcs-selected-index-" })
        .pipe(
          Effect.mapError(asGitCommandError("vcs.panel.commitStaged.tempIndex", cwd, ["commit"])),
        );
      return yield* Effect.gen(function* () {
        const env = {
          ...globalThis.process.env,
          GIT_INDEX_FILE: path.join(tempDir, "index"),
        };
        const headResult = yield* runResult(
          "vcs.panel.commitStaged.tempIndexResolveHead",
          cwd,
          ["rev-parse", "--verify", "HEAD"],
          { allowNonZeroExit: true, env },
        );
        yield* run(
          "vcs.panel.commitStaged.tempIndexReadTree",
          cwd,
          headResult.exitCode === 0 ? ["read-tree", "HEAD"] : ["read-tree", "--empty"],
          { env },
        ).pipe(Effect.asVoid);
        yield* run(
          "vcs.panel.commitStaged.tempIndexAddSelected",
          cwd,
          ["--literal-pathspecs", "add", "-A", "--", ...paths],
          { env },
        ).pipe(Effect.asVoid);
        return yield* body(env);
      }).pipe(
        Effect.ensuring(
          fileSystem.remove(tempDir, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );
    });

  const branchWithExistingWorktreePath = (branch: VcsRef) => {
    if (!branch.worktreePath) return Effect.succeed(branch);
    return fileSystem.exists(branch.worktreePath).pipe(
      Effect.map((exists) => (exists ? branch : { ...branch, worktreePath: null })),
      Effect.orElseSucceed(() => ({ ...branch, worktreePath: null })),
    );
  };

  const {
    actionableForkBranches,
    branchCommits,
    branchDetails,
    changeGroupsHaveFiles,
    generatedCommitMessage,
    generatedStashMessage,
    readWorkingTreeChangeGroups,
    refExists,
    stashDetails,
    upstreamForRef,
  } = makeSourceControlPanelReaders({
    run,
    serverSettings,
    sourceControlProviders,
    sourceControlRateLimits,
    textGeneration,
  });
  const unstagedFilesWithUntrackedRenames = (cwd: string, untrackedPaths: readonly string[]) =>
    Effect.gen(function* () {
      if (untrackedPaths.length === 0) return null;

      return yield* withTemporaryIntentToAddIndex(
        {
          cwd,
          paths: untrackedPaths,
          operations: {
            gitIndexPath: "vcs.panel.gitIndexPath",
            tempIndexReadTree: "vcs.panel.tempIndexReadTree",
            tempIndexIntentToAdd: "vcs.panel.tempIndexIntentToAdd",
          },
        },
        (env) =>
          Effect.gen(function* () {
            const [nameStatus, numstat] = yield* Effect.all(
              [
                run(
                  "vcs.panel.unstagedNameStatusWithUntracked",
                  cwd,
                  ["diff", "--name-status", "-z", "--find-renames=20%"],
                  { env },
                ),
                run(
                  "vcs.panel.unstagedNumstatWithUntracked",
                  cwd,
                  ["diff", "--numstat", "-z", "--find-renames=20%"],
                  { env },
                ),
              ],
              { concurrency: "unbounded" },
            );
            return parseFileChangesFromNumstat({
              numstat,
              statuses: parseNameStatus(nameStatus),
            });
          }),
      );
    }).pipe(Effect.orElseSucceed(() => null));

  const enrichWorkingTreeFiles: SourceControlPanelService["Service"]["enrichWorkingTreeFiles"] =
    Effect.fn("enrichWorkingTreeFiles")(function* (input) {
      const requestedPaths = uniquePaths(input.paths);
      const [porcelain, unstagedNumstat] = yield* Effect.all(
        [
          run("vcs.panel.enrichWorkingTreeFiles.statusPorcelain", input.cwd, [
            "status",
            "--porcelain=2",
            "--branch",
            "-uall",
          ]),
          run("vcs.panel.enrichWorkingTreeFiles.unstagedNumstat", input.cwd, [
            "diff",
            "--numstat",
            "-z",
            "--find-renames=20%",
          ]),
        ],
        { concurrency: "unbounded" },
      );

      const requestedPathSet = new Set(requestedPaths);
      const untrackedPaths = untrackedPathsFromPorcelain(porcelain);
      const untrackedPathSet = new Set(untrackedPaths);
      const unstagedFiles = unstagedFilesFromPorcelainStatus({
        status: porcelain,
        unstagedStats: parseNumstat(unstagedNumstat),
      });
      const deletedPathSet = new Set(
        unstagedFiles.filter((file) => file.status === "deleted").map((file) => file.path),
      );
      const requestedUntrackedPaths = requestedPaths.filter((path) => untrackedPathSet.has(path));
      const requestedDeletedPaths = requestedPaths.filter((path) => deletedPathSet.has(path));
      const renameCandidateUntrackedPaths =
        requestedDeletedPaths.length > 0 ? untrackedPaths : requestedUntrackedPaths;

      const [untrackedStats, renameCandidates] = yield* Effect.all(
        [
          Effect.forEach(
            requestedUntrackedPaths,
            (path) =>
              run(
                "vcs.panel.enrichWorkingTreeFiles.untrackedNumstat",
                input.cwd,
                ["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", path],
                { allowNonZeroExit: true },
              ).pipe(
                Effect.map(parseNumstat),
                Effect.orElseSucceed(() => new Map()),
              ),
            { concurrency: 4 },
          ).pipe(Effect.map((stats) => mergeNumstats(stats))),
          unstagedFilesWithUntrackedRenames(input.cwd, renameCandidateUntrackedPaths),
        ],
        { concurrency: "unbounded" },
      );

      const filesByPath = new Map<string, VcsPanelFileChange>();
      const hiddenPaths = new Set<string>();
      for (const file of renameCandidates ?? []) {
        if (file.status !== "renamed" || !file.originalPath) continue;
        if (!requestedPathSet.has(file.path) && !requestedPathSet.has(file.originalPath)) continue;
        filesByPath.set(file.path, file);
        hiddenPaths.add(file.originalPath);
      }

      for (const path of requestedUntrackedPaths) {
        if (filesByPath.has(path)) continue;
        const stats = untrackedStats.get(path);
        filesByPath.set(path, {
          path,
          originalPath: null,
          status: "untracked",
          insertions: stats?.insertions ?? 0,
          deletions: stats?.deletions ?? 0,
        });
      }
      for (const file of unstagedFiles) {
        if (file.status !== "deleted") continue;
        if (
          !requestedPathSet.has(file.path) ||
          hiddenPaths.has(file.path) ||
          filesByPath.has(file.path)
        ) {
          continue;
        }
        filesByPath.set(file.path, file);
      }

      return {
        files: [...filesByPath.values()].toSorted((left, right) =>
          left.path.localeCompare(right.path),
        ),
        hiddenPaths: [...hiddenPaths].toSorted((left, right) => left.localeCompare(right)),
      };
    });

  const readWorktreeChangeSets = Effect.fn("readWorktreeChangeSets")(function* (
    cwd: string,
    localBranches: ReadonlyArray<VcsRef>,
    worktreeBranchEntries: ReadonlyArray<WorktreeBranchEntry> | null,
  ) {
    return yield* Effect.forEach(
      localBranches.filter((branch) => {
        if (branch.current || !branch.worktreePath) return false;
        if (path.resolve(branch.worktreePath) === path.resolve(cwd)) return false;
        return (
          worktreeBranchEntries === null ||
          worktreeBranchEntries.some(
            (entry) =>
              entry.branchName === branch.name && entry.worktreePath === branch.worktreePath,
          )
        );
      }),
      (branch) =>
        readWorkingTreeChangeGroups(branch.worktreePath!).pipe(
          Effect.map((result): VcsPanelWorktreeChangeSet | null =>
            changeGroupsHaveFiles(result.changeGroups)
              ? {
                  branchName: branch.name,
                  worktreePath: branch.worktreePath!,
                  current: false,
                  lastActivityAt: branch.lastActivityAt ?? null,
                  changeGroups: result.changeGroups,
                }
              : null,
          ),
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: 4 },
    ).pipe(
      Effect.map((sets) =>
        sets
          .filter((set): set is VcsPanelWorktreeChangeSet => set !== null)
          .toSorted((left, right) => {
            const leftTime = Date.parse(left.lastActivityAt ?? "");
            const rightTime = Date.parse(right.lastActivityAt ?? "");
            const activity =
              (Number.isFinite(rightTime) ? rightTime : 0) -
              (Number.isFinite(leftTime) ? leftTime : 0);
            return activity !== 0 ? activity : left.branchName.localeCompare(right.branchName);
          }),
      ),
    );
  });

  const readFullSnapshot = Effect.fn("readFullSnapshot")(function* (cwd: string) {
    const [
      localStatus,
      localBranchesOutput,
      worktreeListOutput,
      workingTree,
      remotesOutput,
      stashes,
    ] = yield* Effect.all(
      [
        workflow
          .status({ cwd })
          .pipe(Effect.mapError(asGitCommandError("vcs.panel.status", cwd, ["status"]))),
        runResult("vcs.panel.localBranches", cwd, LOCAL_BRANCHES_WITH_WORKTREE_PATH_ARGS, {
          allowNonZeroExit: true,
        }).pipe(
          Effect.flatMap((result) => {
            if (result.exitCode === 0) return Effect.succeed(result.stdout);
            const detail = result.stderr.trim() || result.stdout.trim();
            return isUnsupportedWorktreePathFormat(detail)
              ? run("vcs.panel.localBranches", cwd, LOCAL_BRANCHES_WITHOUT_WORKTREE_PATH_ARGS)
              : Effect.fail(
                  gitError(
                    "vcs.panel.localBranches",
                    cwd,
                    LOCAL_BRANCHES_WITH_WORKTREE_PATH_ARGS,
                    detail,
                  ),
                );
          }),
        ),
        run("vcs.panel.worktrees", cwd, ["worktree", "list", "--porcelain"], {
          allowNonZeroExit: true,
        }),
        readWorkingTreeChangeGroups(cwd),
        run("vcs.panel.remotes", cwd, ["remote", "-v"]),
        run("vcs.panel.stashes", cwd, ["stash", "list", "--format=%gd%x09%H%x09%cI%x09%gs"]),
      ],
      { concurrency: "unbounded" },
    );

    const localBranches = yield* Effect.forEach(
      parseLocalBranches(
        localBranchesOutput,
        parseWorktreeBranchPaths(worktreeListOutput),
        localStatus.isDefaultRef ? localStatus.refName : null,
      ),
      branchWithExistingWorktreePath,
      { concurrency: "unbounded" },
    );
    const remotes = parseRemoteVerbose(remotesOutput);
    const remotesWithBranches = yield* Effect.forEach(
      remotes,
      (remote) =>
        run("vcs.panel.remoteBranches", cwd, [
          "branch",
          "-r",
          "--list",
          `${remote.name}/*`,
          "--format=%(refname:short)%09%(committerdate:iso-strict)",
        ]).pipe(
          Effect.map((branchesOutput) => ({
            ...remote,
            branches: parseRemoteBranches(branchesOutput, remote.name),
          })),
          Effect.orElseSucceed(() => remote),
        ),
      { concurrency: "unbounded" },
    );
    const defaultCompareRef =
      localBranches.find((ref) => ref.isDefault)?.name ??
      localBranches.find((ref) => !ref.current)?.name ??
      null;
    const forkBranches = yield* actionableForkBranches(cwd, localBranches, remotesWithBranches);
    const worktreeBranchEntries = parseWorktreeBranchEntries(worktreeListOutput);
    const worktreeChangeSets = yield* readWorktreeChangeSets(
      cwd,
      localBranches,
      worktreeBranchEntries,
    );
    return {
      status: panelStatusFromLocal(localStatus, workingTree.porcelain),
      changeGroups: workingTree.changeGroups,
      worktreeChangeSets,
      localBranches,
      branchDetails: [],
      remotes: remotesWithBranches,
      actionableForkBranches: forkBranches,
      stashes: parseStashes(stashes),
      recentCommits: [],
      defaultCompareRef,
    };
  });

  const readWorkingTreeSnapshot = Effect.fn("readWorkingTreeSnapshot")(function* (
    cwd: string,
    cached: VcsPanelSnapshotResult,
  ) {
    const [localStatus, workingTree] = yield* Effect.all(
      [
        workflow
          .status({ cwd })
          .pipe(Effect.mapError(asGitCommandError("vcs.panel.status", cwd, ["status"]))),
        readWorkingTreeChangeGroups(cwd),
      ],
      { concurrency: "unbounded" },
    );
    const status = panelStatusFromLocal(localStatus, workingTree.porcelain);
    const worktreeChangeSets = yield* readWorktreeChangeSets(cwd, cached.localBranches, null);
    return { status, workingTree, worktreeChangeSets };
  });

  const repositoryStatusChanged = (left: VcsStatusResult, right: VcsStatusResult): boolean =>
    left.isRepo !== right.isRepo ||
    left.hasPrimaryRemote !== right.hasPrimaryRemote ||
    left.isDefaultRef !== right.isDefaultRef ||
    left.refName !== right.refName ||
    left.hasUpstream !== right.hasUpstream ||
    left.aheadCount !== right.aheadCount ||
    left.behindCount !== right.behindCount ||
    left.aheadOfDefaultCount !== right.aheadOfDefaultCount ||
    JSON.stringify(left.sourceControlProvider ?? null) !==
      JSON.stringify(right.sourceControlProvider ?? null) ||
    JSON.stringify(left.pr) !== JSON.stringify(right.pr);

  const snapshot: SourceControlPanelService["Service"]["snapshot"] = Effect.fn("snapshot")(
    function* (input) {
      const cacheKey = path.resolve(input.cwd);
      const request = yield* Ref.modify(snapshotCacheRef, (state) => {
        const requestId = (state.latestRequestByCwd.get(cacheKey) ?? 0) + 1;
        const cached = state.snapshotsByCwd.get(cacheKey) ?? null;
        const latestFullRequest = state.latestFullRequestByCwd.get(cacheKey) ?? 0;
        const completedFullRequest = state.completedFullRequestByCwd.get(cacheKey) ?? 0;
        const full =
          input.refresh !== "working-tree" ||
          cached === null ||
          latestFullRequest > completedFullRequest;
        const latestRequestByCwd = setBoundedMapEntry(
          state.latestRequestByCwd,
          cacheKey,
          requestId,
          PANEL_SNAPSHOT_CACHE_CAPACITY,
        );
        const latestFullRequestByCwd = full
          ? setBoundedMapEntry(
              state.latestFullRequestByCwd,
              cacheKey,
              requestId,
              PANEL_SNAPSHOT_CACHE_CAPACITY,
            )
          : state.latestFullRequestByCwd;
        return [
          {
            requestId,
            cached,
            full,
          },
          { ...state, latestRequestByCwd, latestFullRequestByCwd },
        ] as const;
      });

      let nextSnapshot: VcsPanelSnapshotResult;
      if (!request.full && request.cached !== null) {
        const incremental = yield* readWorkingTreeSnapshot(input.cwd, request.cached);
        nextSnapshot = repositoryStatusChanged(request.cached.status, incremental.status)
          ? yield* readFullSnapshot(input.cwd)
          : {
              ...request.cached,
              status: incremental.status,
              changeGroups: incremental.workingTree.changeGroups,
              worktreeChangeSets: incremental.worktreeChangeSets,
            };
      } else {
        nextSnapshot = yield* readFullSnapshot(input.cwd).pipe(
          Effect.ensuring(
            Ref.update(snapshotCacheRef, (state) => ({
              ...state,
              completedFullRequestByCwd: setBoundedMapEntry(
                state.completedFullRequestByCwd,
                cacheKey,
                Math.max(state.completedFullRequestByCwd.get(cacheKey) ?? 0, request.requestId),
                PANEL_SNAPSHOT_CACHE_CAPACITY,
              ),
            })),
          ),
        );
      }

      yield* Ref.update(snapshotCacheRef, (state) => {
        if (state.latestRequestByCwd.get(cacheKey) !== request.requestId) {
          return state;
        }
        const snapshotsByCwd = setBoundedMapEntry(
          state.snapshotsByCwd,
          cacheKey,
          nextSnapshot,
          PANEL_SNAPSHOT_CACHE_CAPACITY,
        );
        return { ...state, snapshotsByCwd };
      });
      return nextSnapshot;
    },
  );

  const actions = makeSourceControlPanelActions({
    generatedCommitMessage,
    generatedStashMessage,
    invalidateRefs: git.invalidateRefs,
    refExists,
    run,
    snapshot,
    upstreamForRef,
    withTemporaryIntentToAddIndex,
    withTemporarySelectedIndex,
    workflow,
  });

  return SourceControlPanelService.of({
    snapshot,
    branchDetails: (input) =>
      branchDetails(input.cwd, input.branch, input.defaultCompareRef, input.compareBaseRef),
    branchCommits: (input) =>
      branchCommits(input.cwd, input.branch, input.baseRef, input.kind, input.skip, input.limit),
    stashDetails: (input) => stashDetails(input.cwd, input.stashRef),
    enrichWorkingTreeFiles,
    fetchAllRemotes,
    ...actions,
  });
});

export const layer = Layer.effect(SourceControlPanelService, make());
