import * as Effect from "effect/Effect";

import {
  GitCommandError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
} from "@t3tools/contracts";

import type * as GitManager from "../git/GitManager.ts";
import {
  normalizePullRequestReference,
  resolvePullRequestWorktreeLocalBranchName,
  toResolvedPullRequest,
} from "../git/GitManager.ts";
import type { VcsWorkflowOps } from "../git/GitWorkflowService.ts";
import type * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import type * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as JjProcess from "../vcs/JjProcess.ts";
import { localBookmarkRevset } from "../vcs/JjRevset.ts";
import type { JjVcsDriverShape } from "../vcs/JjVcsDriver.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { jjFailure, mapJjFailure } from "./JjFailure.ts";
import type { JjRefsOps } from "./JjRefs.ts";
import { trackRemoteBookmark } from "./JjRemotes.ts";
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
}

export interface JjPullRequestThreadOps {
  readonly resolvePullRequest: VcsWorkflowOps["resolvePullRequest"];
  readonly preparePullRequestThread: (
    input: GitPreparePullRequestThreadInput,
  ) => Effect.Effect<GitPreparePullRequestThreadResult, GitCommandError>;
}

export const makeJjPullRequestThread = (deps: JjPullRequestThreadDeps): JjPullRequestThreadOps => {
  const {
    driver,
    gitManager,
    invalidateStatus,
    process,
    projectSetupScriptRunner,
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
      const summary = yield* sourceControlProviders.resolve({ cwd: hostingCwd }).pipe(
        Effect.flatMap((provider) =>
          provider.getChangeRequest({
            cwd: hostingCwd,
            reference: normalizePullRequestReference(input.reference),
          }),
        ),
        mapJjFailure(operation, input.cwd, "Could not resolve this pull request."),
      );
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

      if (headOnRemote && remoteName !== null && localBranch === pullRequest.headBranch) {
        yield* run(
          operation,
          input.cwd,
          ["git", "fetch", "--remote", remoteName, "--branch", pullRequest.headBranch],
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
      } else {
        // A fork head lives only at `refs/pull/<n>/head`, and `jj git fetch` cannot take an
        // arbitrary refspec. The forced refspec can move a local ref backwards, exactly when
        // jj's default would abandon commits during the import, which the global config prevents.
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
        ).pipe(mapJjFailure(operation, input.cwd, "Could not fetch the pull request head."));
        yield* run(operation, input.cwd, ["git", "import"], { timeoutMs: FETCH_TIMEOUT_MS }).pipe(
          mapJjFailure(operation, input.cwd, "Could not import the pull request head."),
        );
      }

      const headCommit = yield* driver
        .changeAt(input.cwd, localBookmarkRevset(localBranch))
        .pipe(Effect.orElseSucceed(() => null));

      const isOnPullRequestHead = (workspaceCwd: string) =>
        headCommit === null
          ? Effect.succeed(false)
          : driver.countRevset(workspaceCwd, `${headCommit.commitId} & ::@`).pipe(
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

      const worktree = yield* workspaces.createWorktree({
        cwd: input.cwd,
        refName: localBranch,
        path: null,
      });
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
