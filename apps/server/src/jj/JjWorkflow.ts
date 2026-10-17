import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { ServerConfig } from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import type { VcsWorkflowOps } from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { readProjectSettings } from "../sourceControl/ChangeRequestStep.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as JjProcess from "../vcs/JjProcess.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import { jjFailure } from "./JjFailure.ts";
import { makeJjRefs } from "./JjRefs.ts";
import { makeJjRemotes } from "./JjRemotes.ts";
import { makeJjStatus } from "./JjStatus.ts";
import { makeJjWorkspaces } from "./JjWorkspaces.ts";

type JjWorkflowOps = Omit<
  VcsWorkflowOps,
  "pullCurrentBranch" | "runStackedAction" | "resolvePullRequest" | "preparePullRequestThread"
>;

export class JjWorkflow extends Context.Service<JjWorkflow, JjWorkflowOps>()("t3/jj/JjWorkflow") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const home = yield* HostProcess.HomeDirectory;
  const driver = yield* JjVcsDriver.JjVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const gitManager = yield* GitManager.GitManager;
  const path = yield* Path.Path;
  const process = yield* VcsProcess.VcsProcess;
  const serverSettingsService = yield* ServerSettings.ServerSettingsService;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;

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

  const remotes = makeJjRemotes({ driver, process });
  const refs = yield* makeJjRefs({ driver, process });
  const workspaceOps = makeJjWorkspaces({
    driver,
    process,
    fileSystem,
    path,
    worktreesDir: config.worktreesDir,
    bookmarkTo: remotes.bookmarkTo,
  });
  const projectSettingsFor = (input: Parameters<typeof readProjectSettings>[0]) =>
    readProjectSettings(input).pipe(
      Effect.provideService(ServerSettings.ServerSettingsService, serverSettingsService),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, threads),
      Effect.provideService(ProjectStore.ProjectStoreV2, projects),
    );
  const workspaces: typeof workspaceOps = {
    ...workspaceOps,
    createWorktree: (input, options) =>
      Effect.gen(function* () {
        const setting =
          options?.worktreesDirectory ??
          (yield* serverSettingsService.getSettings.pipe(
            Effect.map((settings) => settings.worktreesDirectory),
            Effect.orElseSucceed(() => ""),
          ));
        const directory = resolveWorktreesDirectory(setting, config.worktreesDir, path, home);
        if ((input.path === undefined || input.path === null) && directory === null) {
          return yield* Effect.fail(
            jjFailure(
              "JjWorkflow.createWorktree",
              input.cwd,
              `The worktree location "${setting}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Storage.`,
            ),
          );
        }
        const submodules =
          options?.submodules !== undefined
            ? options.submodules
            : yield* projectSettingsFor(input).pipe(
                Effect.map(({ settings }) => settings.worktreeSubmodules),
                Effect.orElseSucceed(() => null),
              );
        return yield* workspaceOps.createWorktree(input, {
          ...options,
          worktreesDirectory: directory ?? config.worktreesDir,
          submodules,
        });
      }),
  };
  const status = yield* makeJjStatus({ driver, process, gitManager, sourceControlProviders });

  const invalidateStatus = (cwd: string) => driver.invalidateRepoCaches(cwd);

  /** Commit existence is a Git-store question; jj has no bookmark-independent equivalent. */
  const hasCommit: VcsWorkflowOps["hasCommit"] = (input) =>
    executeGit({
      operation: "JjWorkflow.hasCommit",
      cwd: input.cwd,
      args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.exitCode === 0));

  return JjWorkflow.of({
    hasCommit,
    hasRefNamed: refs.hasRefNamed,
    status: status.status,
    localStatus: status.localStatus,
    remoteStatus: status.remoteStatus,
    // Status reads are live; polling must not evict the longer-lived repository metadata or refs.
    // Full invalidation below is reserved for mutations and explicit refreshes.
    invalidateLocalStatus: () => Effect.void,
    invalidateRemoteStatus: () => Effect.void,
    invalidateStatus,
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
    resolveWorktreeBaseRemote: remotes.resolveWorktreeBaseRemote,
    fetchWorktreeBaseCommit: remotes.fetchWorktreeBaseCommit,
  });
});

export const layer = Layer.effect(JjWorkflow, make);
