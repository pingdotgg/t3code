// @effect-diagnostics anyUnknownInErrorContext:off
// @effect-diagnostics missingReturnYieldStar:off
import * as Arr from "effect/Array";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  GitActionProgressEvent,
  GitActionProgressPhase,
  GitCommandError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  VcsStatusResult,
  ModelSelection,
  type OrchestrationV2TurnItem,
  type ProjectId,
  SourceControlProviderError,
  type SourceControlWritingStyleSettings,
  type ThreadId,
  type ThreadPullRequestKey,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
} from "@t3tools/contracts";

import { GitManagerError, GitPullRequestMaterializationError } from "@t3tools/contracts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { GitManagerServiceError } from "@t3tools/contracts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { GitManager, isCommitAction, normalizePullRequestReference, resolvePullRequestWorktreeLocalBranchName, toPullRequestHeadRemoteInfo, toResolvedPullRequest, type SuccessOf } from "./GitManager.ts";
import type { CommitAndBranchSuggestion } from "./GitManager.ts";
import { install0 } from "./gitManagerPart0.ts";
import { install1 } from "./gitManagerPart1.ts";
import { install2 } from "./gitManagerPart2.ts";
import { install3 } from "./gitManagerPart3.ts";

export type Deps = SuccessOf<typeof install0> & SuccessOf<typeof install1> & SuccessOf<typeof install2> & SuccessOf<typeof install3>;

export const install4 = Effect.fn("gitManager.install4")(function* (d: Deps) {
  const { asUserAction, buildCompletionToast, canonicalizeExistingPath, changeRequestHeadRef, changeRequestTermsFor, configurePullRequestHeadUpstream, createProgressEmitter, ensureNoTrackedChanges, gitCore, invalidateStatus, materializePullRequestHeadBranch, moveToPullRequestHead, projectSettingsFor, projectSetupScriptRunner, providerRegistry, pushCurrentBranch, readWorktreesDirectory, runCommitStep, runFeatureBranchStep, runPrStep, sourceControlProvider } = d;
  const preparePullRequestThread: GitManager["Service"]["preparePullRequestThread"] = Effect.fn(
    "preparePullRequestThread",
  )(function* (input) {
    const maybeRunSetupScript = (worktreePath: string) => {
      if (!input.threadId) {
        return Effect.void;
      }
      return projectSetupScriptRunner
        .runForThread({
          threadId: input.threadId,
          projectCwd: input.cwd,
          worktreePath,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("GitManager.preparePullRequestThread setup script failed", {
              threadId: input.threadId,
              worktreePath,
              cause: error,
            }).pipe(Effect.asVoid),
          ),
        );
    };
    return yield* Effect.gen(function* () {
      const normalizedReference = normalizePullRequestReference(input.reference);
      const rootWorktreePath = yield* canonicalizeExistingPath(input.cwd);
      const pullRequestSummary = yield* (yield* sourceControlProvider(input.cwd)).getChangeRequest({
        cwd: input.cwd,
        reference: normalizedReference,
      });
      const pullRequest = toResolvedPullRequest(pullRequestSummary);

      if (input.mode === "local") {
        yield* ensureNoTrackedChanges(input.cwd, pullRequest.number);
        yield* (yield* sourceControlProvider(input.cwd)).checkoutChangeRequest({
          cwd: input.cwd,
          reference: normalizedReference,
        });
        const details = yield* gitCore.statusDetails(input.cwd);
        const branch = details.branch ?? pullRequest.headBranch;
        yield* configurePullRequestHeadUpstream(
          input.cwd,
          {
            ...pullRequest,
            ...toPullRequestHeadRemoteInfo(pullRequestSummary),
          },
          branch,
        );
        return {
          pullRequest,
          branch,
          worktreePath: null,
          isOnPullRequestHead: yield* moveToPullRequestHead(input.cwd, pullRequestSummary.headSha),
        };
      }

      const ensureExistingWorktreeUpstream = Effect.fn("ensureExistingWorktreeUpstream")(function* (
        worktreePath: string,
      ) {
        const details = yield* gitCore.statusDetails(worktreePath);
        yield* configurePullRequestHeadUpstream(
          worktreePath,
          {
            ...pullRequest,
            ...toPullRequestHeadRemoteInfo(pullRequestSummary),
          },
          details.branch ?? pullRequest.headBranch,
        );
      });

      const pullRequestWithRemoteInfo = {
        ...pullRequest,
        ...toPullRequestHeadRemoteInfo(pullRequestSummary),
      } as const;
      const localPullRequestBranch =
        resolvePullRequestWorktreeLocalBranchName(pullRequestWithRemoteInfo);

      // Git refuses to move checked-out branches; advance reused checkouts from inside their worktree.
      const reuseExistingWorktree = Effect.fn("reuseExistingWorktree")(function* (
        worktreePath: string,
        checkedOutBranch: string,
      ) {
        if (checkedOutBranch !== localPullRequestBranch) {
          // Bare-name matches may be unrelated local branches; preserve their work and tracking config.
          return {
            pullRequest,
            branch: localPullRequestBranch,
            worktreePath,
            isOnPullRequestHead: false,
          };
        }

        // Capture upstream before its forced fetch so rewritten heads remain distinguishable from local commits.
        const upstreamCommitBeforeFetch = yield* gitCore
          .resolveCommit({ cwd: worktreePath, revision: "@{upstream}" })
          .pipe(
            Effect.map((resolved) => resolved.commitSha),
            Effect.orElseSucceed(() => null),
          );

        yield* ensureExistingWorktreeUpstream(worktreePath);

        // The pull request's own ref, because it is the only thing that certainly names its
        // head. The branch's upstream does not: configuring it is best-effort, so a branch cut
        // from `origin/main` whose head branch has since been deleted still resolves — and
        // following it would move the checkout onto main and call that the pull request.
        const refreshed = yield* changeRequestHeadRef(worktreePath, pullRequest.number).pipe(
          Effect.flatMap((ref) => gitCore.fetchRefCommit({ cwd: worktreePath, ref })),
          // A host that publishes no head ref leaves the remote-tracking branch,
          // taken only where it is the head branch's own rather than whatever the checkout
          // happened to be cut from.
          Effect.catch(() =>
            Effect.gen(function* () {
              const details = yield* gitCore.statusDetails(worktreePath);
              if (
                details.upstreamRef === null ||
                !details.upstreamRef.endsWith(`/${pullRequest.headBranch}`)
              ) {
                return yield* new GitManagerError({
                  operation: "preparePullRequestThread",
                  cwd: worktreePath,
                  detail: "The pull request head could not be resolved for this checkout.",
                });
              }
              return yield* gitCore.resolveCommit({
                cwd: worktreePath,
                revision: details.upstreamRef,
              });
            }),
          ),
          Effect.flatMap((target) =>
            gitCore.refreshCheckedOutBranch({
              cwd: worktreePath,
              targetCommit: target.commitSha,
              resetWhenHeadCommit: upstreamCommitBeforeFetch,
            }),
          ),
          Effect.catch((error) =>
            Effect.logWarning(
              "GitManager.preparePullRequestThread reused worktree refresh failed",
              {
                worktreePath,
                localBranch: localPullRequestBranch,
                cause: error,
              },
            ).pipe(Effect.as({ moved: false, onTarget: false })),
          ),
        );

        // Setup can disrupt other threads using this worktree; rerun only when the checkout moved.
        if (refreshed.moved) {
          yield* maybeRunSetupScript(worktreePath);
        }

        return {
          pullRequest,
          branch: localPullRequestBranch,
          worktreePath,
          isOnPullRequestHead: refreshed.onTarget,
        };
      });

      const findLocalHeadBranch = Effect.fn("findLocalHeadBranch")(function* (cwd: string) {
        for (const [index, name] of [
          ...new Set([localPullRequestBranch, pullRequest.headBranch]),
        ].entries()) {
          let cursor: number | undefined;
          do {
            const result = yield* gitCore.listRefs({
              cwd,
              refKind: "local",
              query: name,
              cursor,
              refresh: index === 0 && cursor === undefined,
            });
            for (const branch of result.refs) {
              if (branch.name !== name) {
                continue;
              }
              if (name === localPullRequestBranch) {
                return branch;
              }
              if (branch.worktreePath) {
                const worktreePath = yield* canonicalizeExistingPath(branch.worktreePath);
                if (worktreePath !== rootWorktreePath) {
                  return branch;
                }
              }
            }
            cursor = result.nextCursor ?? undefined;
          } while (cursor !== undefined);
        }

        return null;
      });

      const existingBranchBeforeFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchBeforeFetchPath = existingBranchBeforeFetch?.worktreePath
        ? yield* canonicalizeExistingPath(existingBranchBeforeFetch.worktreePath)
        : null;
      if (
        existingBranchBeforeFetch?.worktreePath &&
        existingBranchBeforeFetchPath !== rootWorktreePath
      ) {
        return yield* reuseExistingWorktree(
          existingBranchBeforeFetch.worktreePath,
          existingBranchBeforeFetch.name,
        );
      }
      if (existingBranchBeforeFetchPath === rootWorktreePath) {
        return yield* new GitManagerError({
          operation: "preparePullRequestThread",
          cwd: input.cwd,
          detail:
            "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        });
      }

      yield* materializePullRequestHeadBranch(
        input.cwd,
        pullRequestWithRemoteInfo,
        localPullRequestBranch,
      );

      const existingBranchAfterFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchAfterFetchPath = existingBranchAfterFetch?.worktreePath
        ? yield* canonicalizeExistingPath(existingBranchAfterFetch.worktreePath)
        : null;
      if (
        existingBranchAfterFetch?.worktreePath &&
        existingBranchAfterFetchPath !== rootWorktreePath
      ) {
        return yield* reuseExistingWorktree(
          existingBranchAfterFetch.worktreePath,
          existingBranchAfterFetch.name,
        );
      }
      if (existingBranchAfterFetchPath === rootWorktreePath) {
        return yield* new GitManagerError({
          operation: "preparePullRequestThread",
          cwd: input.cwd,
          detail:
            "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        });
      }

      const worktree = yield* gitCore.createWorktree(
        {
          cwd: input.cwd,
          refName: localPullRequestBranch,
          path: null,
        },
        {
          worktreesDirectory: yield* readWorktreesDirectory,
          submodules: yield* projectSettingsFor(input).pipe(
            Effect.map(({ settings }) => settings.worktreeSubmodules),
            Effect.orElseSucceed(() => null),
          ),
        },
      );
      yield* ensureExistingWorktreeUpstream(worktree.worktree.path);
      yield* maybeRunSetupScript(worktree.worktree.path);

      return {
        pullRequest,
        branch: worktree.worktree.refName,
        worktreePath: worktree.worktree.path,
        isOnPullRequestHead: true,
      };
    }).pipe(Effect.ensuring(invalidateStatus(input.cwd)));
  }, asUserAction);

  const runStackedAction: GitManager["Service"]["runStackedAction"] = Effect.fn("runStackedAction")(
    function* (input, options) {
      const progress = yield* createProgressEmitter(input, options);
      const currentPhase = yield* Ref.make<Option.Option<GitActionProgressPhase>>(Option.none());

      const runAction = Effect.fn("runStackedAction.runAction")(function* (): Effect.fn.Return<
        GitRunStackedActionResult,
        GitManagerServiceError
      > {
        const initialStatus = yield* gitCore.statusDetails(input.cwd);
        const wantsCommit = isCommitAction(input.action);
        const wantsPush =
          input.action === "push" ||
          input.action === "commit_push" ||
          input.action === "commit_push_pr" ||
          (input.action === "create_pr" &&
            (!initialStatus.hasUpstream || initialStatus.aheadCount > 0));
        const wantsPr = input.action === "create_pr" || input.action === "commit_push_pr";

        if (input.featureBranch && !wantsCommit) {
          return yield* new GitManagerError({
            operation: "runStackedAction",
            cwd: input.cwd,
            detail: "Feature-branch checkout is only supported for commit actions.",
          });
        }
        const phases: GitActionProgressPhase[] = [
          ...(input.featureBranch ? (["branch"] as const) : []),
          ...(wantsCommit ? (["commit"] as const) : []),
          ...(wantsPush ? (["push"] as const) : []),
          ...(wantsPr ? (["pr"] as const) : []),
        ];

        yield* progress.emit({
          kind: "action_started",
          phases,
        });

        if (!input.featureBranch && wantsPush && !initialStatus.branch) {
          return yield* new GitManagerError({
            operation: "runStackedAction",
            cwd: input.cwd,
            detail: "Cannot push from detached HEAD.",
          });
        }
        if (!input.featureBranch && wantsPr && !initialStatus.branch) {
          return yield* new GitManagerError({
            operation: "runStackedAction",
            cwd: input.cwd,
            detail: "Cannot create a pull request from detached HEAD.",
          });
        }

        let branchStep: { status: "created" | "skipped_not_requested"; name?: string };
        let commitMessageForStep = input.commitMessage;
        let preResolvedCommitSuggestion: CommitAndBranchSuggestion | undefined = undefined;

        const textGenerationSettings = yield* projectSettingsFor(input).pipe(
          Effect.flatMap(({ settings, projectId }) =>
            settings.sourceControlWriterModelSelection === null
              ? Effect.succeed({
                  modelSelection: settings.textGenerationModelSelection,
                  style: settings.sourceControlWritingStyle,
                })
              : providerRegistry.getProviders.pipe(
                  Effect.map((providers) => ({
                    modelSelection: ServerSettings.resolveSourceControlWriterModelSelection(
                      settings,
                      providers,
                      projectId,
                    ),
                    style: settings.sourceControlWritingStyle,
                  })),
                ),
          ),
          Effect.mapError(
            (cause) =>
              new GitManagerError({
                operation: "runStackedAction",
                cwd: input.cwd,
                detail: "Failed to get server settings.",
                cause,
              }),
          ),
        );

        if (input.featureBranch) {
          yield* Ref.set(currentPhase, Option.some("branch"));
          yield* progress.emit({
            kind: "phase_started",
            phase: "branch",
            label: "Preparing feature branch...",
          });
          const result = yield* runFeatureBranchStep(
            textGenerationSettings,
            input.cwd,
            initialStatus.branch,
            input.commitMessage,
            input.filePaths,
          );
          branchStep = result.branchStep;
          commitMessageForStep = result.resolvedCommitMessage;
          preResolvedCommitSuggestion = result.resolvedCommitSuggestion;
        } else {
          branchStep = { status: "skipped_not_requested" as const };
        }

        const currentBranch = branchStep.name ?? initialStatus.branch;
        const commitAction = isCommitAction(input.action) ? input.action : null;
        const changeRequestTerms = wantsPr ? yield* changeRequestTermsFor(input.cwd) : null;

        const commit = commitAction
          ? yield* Ref.set(currentPhase, Option.some("commit")).pipe(
              Effect.flatMap(() =>
                runCommitStep(
                  textGenerationSettings,
                  input.cwd,
                  commitAction,
                  currentBranch,
                  commitMessageForStep,
                  preResolvedCommitSuggestion,
                  input.filePaths,
                  options?.progressReporter,
                  progress.actionId,
                ),
              ),
            )
          : { status: "skipped_not_requested" as const };

        const push = wantsPush
          ? yield* progress
              .emit({
                kind: "phase_started",
                phase: "push",
                label: "Pushing...",
              })
              .pipe(
                Effect.tap(() => Ref.set(currentPhase, Option.some("push"))),
                Effect.flatMap(() => pushCurrentBranch(input.cwd, currentBranch)),
              )
          : { status: "skipped_not_requested" as const };

        const pr = wantsPr
          ? yield* progress
              .emit({
                kind: "phase_started",
                phase: "pr",
                label: `Preparing ${changeRequestTerms?.shortLabel ?? "PR"}...`,
              })
              .pipe(
                Effect.tap(() => Ref.set(currentPhase, Option.some("pr"))),
                Effect.flatMap(() =>
                  runPrStep(
                    textGenerationSettings,
                    input.cwd,
                    currentBranch,
                    input.threadId,
                    progress.emit,
                  ),
                ),
              )
          : { status: "skipped_not_requested" as const };

        const toast = yield* buildCompletionToast(input.cwd, {
          action: input.action,
          branch: branchStep,
          commit,
          push,
          pr,
        });

        const result = {
          action: input.action,
          branch: branchStep,
          commit,
          push,
          pr,
          toast,
        };
        yield* progress.emit({
          kind: "action_finished",
          result,
        });
        return result;
      });

      return yield* runAction().pipe(
        Effect.ensuring(invalidateStatus(input.cwd)),
        Effect.tapError((error) =>
          Effect.flatMap(Ref.get(currentPhase), (phase) =>
            progress.emit({
              kind: "action_failed",
              phase: Option.getOrNull(phase),
              message: error.message,
            }),
          ),
        ),
      );
    },
    asUserAction,
  );
  return {
    preparePullRequestThread,
    runStackedAction,
  };
});
