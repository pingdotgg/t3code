import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

import {
  GitCommandError,
  GitPullRequestMaterializationError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitManagerServiceError,
  type ServerSettings,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { canonicalRepositoryKey, isSshRemoteUrl } from "@t3tools/shared/sourceControl";

import type * as GitManager from "../git/GitManager.ts";
import {
  normalizePullRequestReference,
  parseRepositoryNameFromPullRequestUrl,
  pullRequestRepositoryKey,
  resolvePullRequestWorktreeLocalBranchName,
  toResolvedPullRequest,
} from "../sourceControl/ChangeRequestStep.ts";
import type { VcsWorkflowOps } from "../git/GitWorkflowService.ts";
import type * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import type * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as JjProcess from "../vcs/JjProcess.ts";
import { exactStringPattern, localBookmarkRevset } from "../vcs/JjRevset.ts";
import type { JjVcsDriverShape } from "../vcs/JjVcsDriver.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { jjFailure, mapJjFailure } from "./JjFailure.ts";
import type { JjRefsOps } from "./JjRefs.ts";
import { ensureJjRemote, trackRemoteBookmark, writeBookmarkUpstreamConfig } from "./JjRemotes.ts";
import type { JjWorkspaceOps } from "./JjWorkspaces.ts";

const FETCH_TIMEOUT_MS = 120_000;

export interface JjPullRequestThreadDeps {
  readonly driver: JjVcsDriverShape;
  readonly gitManager: GitManager.GitManager["Service"];
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly refs: JjRefsOps;
  readonly workspaces: JjWorkspaceOps;
  readonly sourceControlProviders: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];
  readonly projectSetupScriptRunner: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
  readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly readWorktreeSubmodules: (
    input: GitPreparePullRequestThreadInput,
  ) => Effect.Effect<ServerSettings["worktreeSubmodules"], never>;
}

export interface JjPullRequestThreadOps {
  readonly resolvePullRequest: VcsWorkflowOps["resolvePullRequest"];
  readonly preparePullRequestThread: (
    input: GitPreparePullRequestThreadInput,
  ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
}

export const makeJjPullRequestThread = (deps: JjPullRequestThreadDeps): JjPullRequestThreadOps => {
  const {
    driver,
    gitManager,
    invalidateStatus,
    process,
    projectSetupScriptRunner,
    readWorktreeSubmodules,
    refs,
    sourceControlProviders,
    workspaces,
  } = deps;

  const run = JjProcess.jjRunner(process);

  /** `gh`/`glab`/`az` read `.git/config` themselves, so hosting calls run from the main workspace. */
  const resolvePullRequest: JjPullRequestThreadOps["resolvePullRequest"] = Effect.fn(
    "JjPullRequestThread.resolvePullRequest",
  )(function* (input) {
    const operation = "JjPullRequestThread.resolvePullRequest";
    const paths = yield* driver
      .ensureUsable(operation, input.cwd)
      .pipe(mapJjFailure(operation, input.cwd, "This Jujutsu repository cannot be used."));
    return yield* gitManager.resolvePullRequest({ ...input, cwd: paths.mainWorkspaceRoot });
  });

  const preparePullRequestThread: JjPullRequestThreadOps["preparePullRequestThread"] = Effect.fn(
    "JjPullRequestThread.preparePullRequestThread",
  )(function* (input) {
    const operation = "JjPullRequestThread.preparePullRequestThread";

    const maybeRunSetupScript = (worktreePath: string) =>
      input.threadId === undefined
        ? Effect.void
        : projectSetupScriptRunner
            .runForThread({
              threadId: input.threadId,
              projectCwd: input.cwd,
              worktreePath,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("JjWorkflow.preparePullRequestThread setup script failed", {
                  threadId: input.threadId,
                  worktreePath,
                  cause,
                }).pipe(Effect.asVoid),
              ),
            );

    return yield* Effect.gen(function* () {
      const paths = yield* driver
        .ensureUsable(operation, input.cwd)
        .pipe(mapJjFailure(operation, input.cwd, "This Jujutsu repository cannot be used."));
      const hostingCwd = paths.mainWorkspaceRoot;
      const provider = yield* sourceControlProviders.resolve({ cwd: hostingCwd });
      const summary = yield* provider.getChangeRequest({
        cwd: hostingCwd,
        reference: normalizePullRequestReference(input.reference),
      });
      const pullRequest = toResolvedPullRequest(summary);
      const localBranch = resolvePullRequestWorktreeLocalBranchName({
        ...pullRequest,
        ...(summary.isCrossRepository !== undefined
          ? { isCrossRepository: summary.isCrossRepository }
          : {}),
      });

      const remoteName = yield* driver
        .resolvePrimaryRemoteName(input.cwd)
        .pipe(Effect.orElseSucceed(() => null));
      const bookmarks = yield* driver.listBookmarks(input.cwd).pipe(Effect.orElseSucceed(() => []));
      const headOnRemote =
        remoteName !== null &&
        bookmarks.some(
          (bookmark) => bookmark.name === pullRequest.headBranch && bookmark.remote === remoteName,
        );

      const headOwner = summary.headRepositoryOwnerLogin?.trim();
      const repositoryName = parseRepositoryNameFromPullRequestUrl(summary.url);
      const sourceRepository =
        summary.isCrossRepository === true
          ? summary.headRepositoryNameWithOwner?.trim() ||
            (headOwner && repositoryName ? `${headOwner}/${repositoryName}` : null)
          : null;
      let sourceHeadCommitId: string | null = null;
      const importedSource = sourceRepository
        ? yield* Effect.gen(function* () {
            const cloneUrls = yield* provider.getRepositoryCloneUrls({
              cwd: hostingCwd,
              repository: sourceRepository,
            });
            const remotes = yield* driver
              .listRemotes(input.cwd)
              .pipe(mapJjFailure(operation, input.cwd, "Could not read repository remotes."));
            const primaryUrl = remotes.remotes.find((remote) => remote.name === remoteName)?.url;
            const sourceRemote = yield* ensureJjRemote({
              driver,
              process,
              cwd: input.cwd,
              operation,
              remoteName: sourceRepository.split("/")[0] ?? "fork",
              remoteUrl:
                primaryUrl && isSshRemoteUrl(primaryUrl) ? cloneUrls.sshUrl : cloneUrls.url,
            });
            const temporaryBookmark = `t3code/import/${(yield* Random.nextInt).toString(36)}${(yield* Random.nextInt).toString(36)}`;
            const temporaryRef = `refs/heads/${temporaryBookmark}`;
            const fetch = (remote: string, sourceRef: string) =>
              JjProcess.colocatedGitCommand(
                process,
                operation,
                { gitDir: paths.gitDir, cwd: hostingCwd },
                ["fetch", "--refmap=", remote, `+${sourceRef}:${temporaryRef}`],
                { timeoutMs: FETCH_TIMEOUT_MS },
              );
            yield* Effect.gen(function* () {
              yield* fetch(sourceRemote, `refs/heads/${pullRequest.headBranch}`).pipe(
                Effect.catch((primaryCause) =>
                  (remoteName === null
                    ? Effect.fail(primaryCause)
                    : fetch(remoteName, `refs/pull/${pullRequest.number}/head`)
                  ).pipe(
                    Effect.mapError(
                      (fallbackCause) =>
                        new GitPullRequestMaterializationError({
                          cwd: input.cwd,
                          pullRequestNumber: pullRequest.number,
                          headRepository: sourceRepository,
                          headBranch: pullRequest.headBranch,
                          localBranch,
                          cause: new AggregateError(
                            [primaryCause, fallbackCause],
                            `Repository-head and pull-request-ref fetches both failed for pull request #${pullRequest.number}.`,
                            { cause: primaryCause },
                          ),
                        }),
                    ),
                  ),
                ),
              );
              yield* run(operation, input.cwd, ["git", "import"], {
                timeoutMs: FETCH_TIMEOUT_MS,
              }).pipe(
                mapJjFailure(operation, input.cwd, "Could not import the source repository head."),
              );
              sourceHeadCommitId =
                (yield* driver
                  .changeAt(input.cwd, localBookmarkRevset(temporaryBookmark))
                  .pipe(
                    mapJjFailure(
                      operation,
                      input.cwd,
                      "Could not read the source pull-request head.",
                    ),
                  ))?.commitId ?? null;
              const existingHead = yield* driver
                .changeAt(input.cwd, localBookmarkRevset(localBranch))
                .pipe(
                  mapJjFailure(operation, input.cwd, "Could not read the local pull-request head."),
                );
              const canAdvance =
                existingHead === null
                  ? true
                  : (yield* driver
                      .countRevset(
                        input.cwd,
                        `${localBookmarkRevset(localBranch)} & ::(${localBookmarkRevset(temporaryBookmark)})`,
                      )
                      .pipe(
                        mapJjFailure(operation, input.cwd, "Could not compare pull-request heads."),
                      )) > 0;
              if (canAdvance) {
                yield* run(operation, input.cwd, [
                  "bookmark",
                  existingHead === null ? "create" : "set",
                  localBranch,
                  "-r",
                  localBookmarkRevset(temporaryBookmark),
                ]).pipe(
                  mapJjFailure(
                    operation,
                    input.cwd,
                    "Could not update the local pull-request head.",
                  ),
                );
              }
            }).pipe(
              Effect.ensuring(
                JjProcess.colocatedGitCommand(
                  process,
                  operation,
                  { gitDir: paths.gitDir, cwd: hostingCwd },
                  ["update-ref", "-d", temporaryRef],
                ).pipe(Effect.andThen(run(operation, input.cwd, ["git", "import"])), Effect.ignore),
              ),
            );
            // Import only the alias: a fork's head can be main, which must not move local main.
            yield* writeBookmarkUpstreamConfig(process, {
              cwd: input.cwd,
              gitDir: paths.gitDir,
              name: localBranch,
              remoteName: sourceRemote,
              remoteBranch: pullRequest.headBranch,
              importedPullRequest: true,
            });
            return true;
          })
        : false;

      if (
        !importedSource &&
        headOnRemote &&
        remoteName !== null &&
        localBranch === pullRequest.headBranch
      ) {
        yield* run(
          operation,
          input.cwd,
          [
            "git",
            "fetch",
            "--remote",
            exactStringPattern(remoteName),
            "--branch",
            exactStringPattern(pullRequest.headBranch),
          ],
          { timeoutMs: FETCH_TIMEOUT_MS },
        ).pipe(mapJjFailure(operation, input.cwd, "Could not fetch the pull request head."));
        yield* trackRemoteBookmark({
          process,
          operation,
          cwd: input.cwd,
          gitDir: paths.gitDir,
          remoteName,
          name: pullRequest.headBranch,
        });
      } else if (!importedSource) {
        // `jj git fetch` cannot take an arbitrary refspec. Forced refspecs can move a local
        // ref backwards, when jj's default would abandon commits during the import; the global
        // config prevents that.
        if (remoteName === null) {
          return yield* Effect.fail(
            jjFailure(operation, input.cwd, "This repository has no remote to fetch from."),
          );
        }
        yield* JjProcess.colocatedGitCommand(
          process,
          operation,
          { gitDir: paths.gitDir, cwd: paths.mainWorkspaceRoot },
          ["fetch", remoteName, `+refs/pull/${pullRequest.number}/head:refs/heads/${localBranch}`],
          { timeoutMs: FETCH_TIMEOUT_MS },
        ).pipe(
          Effect.catch((cause) =>
            summary.isCrossRepository === true || pullRequest.state !== "open"
              ? Effect.fail(cause)
              : Effect.gen(function* () {
                  const remote = yield* JjProcess.colocatedGitCommand(
                    process,
                    operation,
                    { gitDir: paths.gitDir, cwd: paths.mainWorkspaceRoot },
                    ["config", "--get", `remote.${remoteName}.url`],
                  );
                  const remoteUrl = remote.stdout.trim();
                  const pullRequestKey = pullRequestRepositoryKey(pullRequest.url);
                  if (
                    remoteUrl.length === 0 ||
                    pullRequestKey === null ||
                    canonicalRepositoryKey(pullRequestKey) !==
                      canonicalRepositoryKey(normalizeGitRemoteUrl(remoteUrl))
                  ) {
                    return yield* Effect.fail(cause);
                  }
                  // Some hosts publish no pull ref. Only an open PR in this repository can
                  // safely use its named branch: a closed head may have moved since closing.
                  yield* run(
                    operation,
                    input.cwd,
                    [
                      "git",
                      "fetch",
                      "--remote",
                      exactStringPattern(remoteName),
                      "--branch",
                      exactStringPattern(pullRequest.headBranch),
                    ],
                    { timeoutMs: FETCH_TIMEOUT_MS },
                  );
                  yield* trackRemoteBookmark({
                    process,
                    operation,
                    cwd: input.cwd,
                    gitDir: paths.gitDir,
                    remoteName,
                    name: pullRequest.headBranch,
                  });
                }),
          ),
          mapJjFailure(operation, input.cwd, "Could not fetch the pull request head."),
        );
        yield* run(operation, input.cwd, ["git", "import"], { timeoutMs: FETCH_TIMEOUT_MS }).pipe(
          mapJjFailure(operation, input.cwd, "Could not import the pull request head."),
        );
      }

      const headCommit = yield* driver
        .changeAt(input.cwd, localBookmarkRevset(localBranch))
        .pipe(Effect.orElseSucceed(() => null));
      const pullRequestHeadCommitId = sourceHeadCommitId ?? headCommit?.commitId;

      const isOnPullRequestHead = (workspaceCwd: string) =>
        pullRequestHeadCommitId === undefined
          ? Effect.succeed(false)
          : driver.countRevset(workspaceCwd, `${pullRequestHeadCommitId} & ::@`).pipe(
              Effect.map((count) => count > 0),
              Effect.orElseSucceed(() => false),
            );

      if (input.mode === "local") {
        // Never `gh pr checkout`: it writes a git ref and moves HEAD behind jj's back, leaving
        // the jj working copy stale.
        yield* refs.assertNoStrandedWork({
          cwd: input.cwd,
          operation,
          targetRefName: localBranch,
        });
        yield* run(operation, input.cwd, ["new", localBookmarkRevset(localBranch)], {
          timeoutMs: 60_000,
        }).pipe(mapJjFailure(operation, input.cwd, `Could not move onto ${localBranch}.`));
        return {
          pullRequest,
          branch: localBranch,
          worktreePath: null,
          isOnPullRequestHead: yield* isOnPullRequestHead(input.cwd),
        };
      }

      const worktree = yield* workspaces.createWorktree(
        {
          cwd: input.cwd,
          refName: localBranch,
          path: null,
        },
        { submodules: yield* readWorktreeSubmodules(input) },
      );
      yield* maybeRunSetupScript(worktree.worktree.path);

      return {
        pullRequest,
        branch: worktree.worktree.refName,
        worktreePath: worktree.worktree.path,
        isOnPullRequestHead: yield* isOnPullRequestHead(worktree.worktree.path),
      };
    }).pipe(Effect.ensuring(invalidateStatus(input.cwd)));
  });

  return { resolvePullRequest, preparePullRequestThread };
};
