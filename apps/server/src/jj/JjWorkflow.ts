import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { GitCommandError } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import type { ChangeRequestStepServices, ChangeRequestVcsReads } from "../git/GitManager.ts";
import * as GitManager from "../git/GitManager.ts";
import type { VcsWorkflowOps } from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as JjProcess from "../vcs/JjProcess.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { jjFailure } from "./JjFailure.ts";
import { makeJjPullRequestThread } from "./JjPullRequestThread.ts";
import { makeJjRefs } from "./JjRefs.ts";
import { makeJjRemotes } from "./JjRemotes.ts";
import { makeJjStackedAction } from "./JjStackedAction.ts";
import { makeJjStatus, refNameFromSegment, resolveUpstreamContext } from "./JjStatus.ts";
import { makeJjWorkspaces } from "./JjWorkspaces.ts";

const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 64 * 1024;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 64 * 1024;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 1024 * 1024;

export class JjWorkflow extends Context.Service<
  JjWorkflow,
  VcsWorkflowOps & {
    /**
     * Publish a fresh repository to a hosting remote: `git remote add` then the bookmark move and
     * push, because in a colocated repository Git's own HEAD is usually detached.
     */
    readonly publishRepository: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly remoteUrl: string;
    }) => Effect.Effect<
      { readonly refName: string; readonly status: "pushed" | "remote_added" },
      GitCommandError
    >;
  }
>()("t3/jj/JjWorkflow") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const driver = yield* JjVcsDriver.JjVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const gitManager = yield* GitManager.GitManager;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettingsService = yield* ServerSettings.ServerSettingsService;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;

  /** The shared change-request step takes its services from context; discharge them once. */
  const withChangeRequestServices = <A, E>(
    effect: Effect.Effect<A, E, ChangeRequestStepServices>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ServerSettings.ServerSettingsService, serverSettingsService),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProviderRegistry.ProviderRegistry, providerRegistry),
      Effect.provideService(
        SourceControlProviderRegistry.SourceControlProviderRegistry,
        sourceControlProviders,
      ),
      Effect.provideService(TextGeneration.TextGeneration, textGeneration),
    );

  /** Git against the colocated object store. A secondary workspace has no `.git` to discover. */
  const executeGit: GitVcsDriver.GitVcsDriver["Service"]["execute"] = Effect.fn(
    "JjWorkflow.executeGit",
  )(function* (input) {
    const paths = yield* driver
      .repoPaths(input.cwd)
      .pipe(
        Effect.mapError((cause) =>
          jjFailure(input.operation, input.cwd, "This is not a Jujutsu workspace.", cause),
        ),
      );
    const gitDir = paths.gitDir;
    if (gitDir === null) {
      return yield* Effect.fail(
        jjFailure(
          input.operation,
          input.cwd,
          "This Jujutsu repository has no colocated Git store.",
        ),
      );
    }
    // `colocatedGitCommand` picks the options it passes through; only the nullable timeout, which
    // it has no notion of, has to be dropped here.
    const { timeoutMs, ...passthrough } = input;
    return yield* JjProcess.colocatedGitCommand(
      process,
      input.operation,
      { gitDir, cwd: input.cwd },
      input.args,
      typeof timeoutMs === "number" ? { ...passthrough, timeoutMs } : passthrough,
    ).pipe(
      Effect.mapError((cause) =>
        jjFailure(input.operation, input.cwd, "Colocated Git command failed.", cause),
      ),
    );
  });

  const readConfigValue = (cwd: string, key: string) =>
    executeGit({
      operation: "JjWorkflow.readConfigValue",
      cwd,
      args: ["config", "--get", key],
      allowNonZeroExit: true,
      timeoutMs: 10_000,
    }).pipe(
      Effect.map((result) =>
        result.exitCode === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null,
      ),
      Effect.orElseSucceed(() => null),
    );

  const remotes = makeJjRemotes({ driver, process });
  const refs = yield* makeJjRefs({ driver, process });
  const workspaces = makeJjWorkspaces({
    driver,
    process,
    fileSystem,
    path,
    worktreesDir: config.worktreesDir,
    bookmarkTo: remotes.bookmarkTo,
  });
  const status = yield* makeJjStatus({ driver, process, gitManager, sourceControlProviders });

  const invalidateStatus = (cwd: string) =>
    Effect.all([refs.invalidateSnapshot(cwd), driver.invalidateRepoCaches(cwd)], {
      discard: true,
    });

  /** The colocated-Git half of the shared change-request step. */
  const changeRequestReads = Effect.fn("JjWorkflow.changeRequestReads")(function* (
    cwd: string,
  ): Effect.fn.Return<ChangeRequestVcsReads, GitCommandError> {
    const paths = yield* driver
      .ensureUsable("JjWorkflow.changeRequestReads", cwd)
      .pipe(
        Effect.mapError((cause) =>
          jjFailure(
            "JjWorkflow.changeRequestReads",
            cwd,
            "This Jujutsu repository cannot be used.",
            cause,
          ),
        ),
      );
    const segment = yield* driver.currentSegment(cwd).pipe(Effect.orElseSucceed(() => []));
    const refName = refNameFromSegment(segment);
    const upstream =
      refName === null
        ? { primaryRemote: null, hasUpstream: false }
        : yield* resolveUpstreamContext(driver, cwd, refName);

    const rangeHead = refName ?? "HEAD";
    const readRange = (
      operation: string,
      rangeCwd: string,
      args: ReadonlyArray<string>,
      max: number,
    ) =>
      executeGit({
        operation,
        cwd: rangeCwd,
        args,
        maxOutputBytes: max,
        appendTruncationMarker: true,
      }).pipe(Effect.map((result) => result.stdout));

    return {
      refName,
      hasUpstream: upstream.hasUpstream,
      upstreamRef:
        upstream.hasUpstream && upstream.primaryRemote !== null
          ? `${upstream.primaryRemote}/${refName}`
          : null,
      readRangeContext: (rangeCwd, baseRef) =>
        Effect.all(
          [
            readRange(
              "JjWorkflow.readRangeContext.log",
              rangeCwd,
              ["log", "--oneline", `${baseRef}..${rangeHead}`],
              RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES,
            ),
            readRange(
              "JjWorkflow.readRangeContext.diffStat",
              rangeCwd,
              ["diff", "--stat", `${baseRef}..${rangeHead}`],
              RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES,
            ),
            readRange(
              "JjWorkflow.readRangeContext.diffPatch",
              rangeCwd,
              ["diff", "--no-ext-diff", "--patch", "--minimal", `${baseRef}..${rangeHead}`],
              RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(([commitSummary, diffSummary, diffPatch]) => ({
            commitSummary,
            diffSummary,
            diffPatch,
          })),
        ),
      executeGit,
      providerCwd: paths.mainWorkspaceRoot,
      readConfigValue,
      resolvePrimaryRemoteName: (remoteCwd) =>
        remotes.requirePrimaryRemoteName("JjWorkflow.resolvePrimaryRemoteName", remoteCwd),
      resolveDefaultRefName: (defaultCwd) =>
        driver
          .resolveDefaultBookmark(defaultCwd)
          .pipe(Effect.orElseSucceed(() => null as string | null)),
      resolveRemoteTrackingCommit: remotes.resolveRemoteTrackingCommit,
    };
  });

  const stackedAction = makeJjStackedAction({
    driver,
    executeGit,
    process,
    remotes,
    sourceControlProviders,
    changeRequestReads,
    invalidateStatus,
  });

  const pullRequestThread = makeJjPullRequestThread({
    driver,
    gitManager,
    process,
    refs,
    workspaces,
    sourceControlProviders,
    projectSetupScriptRunner,
    invalidateStatus,
  });

  return JjWorkflow.of({
    status: status.status,
    localStatus: status.localStatus,
    remoteStatus: status.remoteStatus,
    invalidateLocalStatus: invalidateStatus,
    invalidateRemoteStatus: invalidateStatus,
    invalidateStatus,
    pullCurrentBranch: remotes.pullCurrentBranch,
    runStackedAction: (input, options) =>
      withChangeRequestServices(stackedAction.runStackedAction(input, options)),
    resolvePullRequest: pullRequestThread.resolvePullRequest,
    preparePullRequestThread: pullRequestThread.preparePullRequestThread,
    listRefs: refs.listRefs,
    createWorktree: workspaces.createWorktree,
    removeWorktree: workspaces.removeWorktree,
    pruneWorktrees: workspaces.pruneWorktrees,
    createRef: refs.createRef,
    switchRef: refs.switchRef,
    renameBranch: refs.renameBranch,
    listLocalBranchNames: refs.listLocalBranchNames,
    deleteLocalBranch: refs.deleteLocalBranch,
    fetchRemote: remotes.fetchRemote,
    remoteExists: remotes.remoteExists,
    remoteBranchExists: remotes.remoteBranchExists,
    resolveRemoteTrackingCommit: remotes.resolveRemoteTrackingCommit,
    publishRepository: remotes.publishRepository,
  });
});

export const layer = Layer.effect(JjWorkflow, make);
