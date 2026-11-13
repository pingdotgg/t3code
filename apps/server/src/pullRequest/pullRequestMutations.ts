// @effect-diagnostics anyUnknownInErrorContext:off
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import { parseDiffFilePaths } from "@t3tools/source-control-core/server/diffFileRevisions";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  resolvePullRequestAuthorFilter,
  type OrchestrationProjectShell,
  type ProjectId,
  type PullRequestAction,
  type PullRequestActionInput,
  type PullRequestActivity,
  type PullRequestCommentInput,
  type PullRequestCommentUpdateInput,
  type PullRequestDetail,
  type PullRequestPreview,
  type PullRequestChecks,
  type PullRequestDiffFileContentsInput,
  type PullRequestDiffFileContentsResult,
  type PullRequestDiffStat,
  type PullRequestDiffInput,
  type PullRequestChangeBreakdown,
  type PullRequestFilesViewedResult,
  type PullRequestDiffResult,
  type PullRequestInvalidateInput,
  type PullRequestReportStateInput,
  type PullRequestListEntry,
  type PullRequestListFilters,
  type PullRequestListInput,
  type PullRequestListProjectError,
  type PullRequestListResult,
  type PullRequestListStatsInput,
  type PullRequestFilterOptions,
  type PullRequestFilterOptionsInput,
  type PullRequestActor,
  type PullRequestLabel,
  type PullRequestListStatsResult,
  type PullRequestProviderSummary,
  type PullRequestReactionInput,
  type PullRequestRef,
  type PullRequestRoutingResult,
  type PullRequestRoutingIdentityInput,
  type PullRequestRoutingIdentityResult,
  type PullRequestReviewVerdict,
  type PullRequestReviewerCandidateList,
  type PullRequestReviewerRequestInput,
  type PullRequestLabelCandidateList,
  type PullRequestLabelChangeInput,
  type PullRequestSetFilesViewedInput,
  type PullRequestState,
  type PullRequestSubmitReviewInput,
  PullRequestStack,
  PullRequestSummary,
  type PullRequestThreadReplyInput,
  type PullRequestThreadResolutionInput,
  type PullRequestThreadCommentsInput,
  type PullRequestThreadCommentsResult,
  type PullRequestUpdateInput,
  type SourceControlProviderInfo,
  SourceControlProviderKind,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import type { SourceControlProviderContext } from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  type ProviderChangeRequest,
  type ProviderDiffFilePaths,
  type ProviderFilterOptionPage,
  type ProviderListCursor,
  type ProviderChangeRequestWatchFingerprint,
  type PullRequestProviderApi,
  PullRequestProviderError,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as ViewedFiles from "./pullRequestViewedFiles.ts";
import { toChangeBreakdown } from "./pullRequestChangeBreakdown.ts";
import type { PullRequestService } from "./PullRequestService.ts";
import { ACTION_ACCESS_REFUSALS, LABEL_CHANGE_REFUSAL, REVIEWER_REQUEST_REFUSAL, VERDICT_LABELS, type SuccessOf } from "./pullRequestSupport.ts";
import type { PullRequestError } from "./pullRequestSupport.ts";
import { installRuntime } from "./pullRequestRuntime.ts";
import { installEpochs } from "./pullRequestEpochs.ts";
import { installWorkspace } from "./pullRequestWorkspace.ts";
import { installRouting } from "./pullRequestRouting.ts";
import { installDetailReads } from "./pullRequestDetailReads.ts";
import { installDiffs } from "./pullRequestDiffs.ts";
import { installListing } from "./pullRequestListing.ts";

export type Deps = SuccessOf<typeof installRuntime> & SuccessOf<typeof installEpochs> & SuccessOf<typeof installWorkspace> & SuccessOf<typeof installRouting> & SuccessOf<typeof installDetailReads> & SuccessOf<typeof installDiffs> & SuccessOf<typeof installListing>;

export const installMutations = Effect.fn("pullRequest.installMutations")(function* (d: Deps) {
    const { bumpFilesViewedEpoch, bumpRefEpoch, canonicalRef, detail, mergedPullRequests, pullRequestRefreshes, readCache, refScope, refreshAfterTurn, requireProject, serverSettings, summaryUncached, toPullRequestError, viewedFiles, viewerPermissionsOf } = d;
  const runAction = (input: PullRequestActionInput): Effect.Effect<string, PullRequestError> =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<string, PullRequestError> => {
        if (input.action === "delete-branch" && project.api.capabilities.deleteBranch !== true) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: "This host cannot delete a change request's source branch.",
            }),
          );
        }
        if (
          input.stackNumber !== undefined &&
          (project.api.capabilities.stackActions !== true ||
            !["merge", "update-branch"].includes(input.action) ||
            input.expectedStackHeads === undefined ||
            (input.action === "update-branch" && input.updateMethod !== "rebase"))
        ) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: "This stack action is not supported or has no expected head revision.",
            }),
          );
        }
        if (!project.api.capabilities.actions.includes(input.action)) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: `This host cannot ${input.action} a change request.`,
            }),
          );
        }
        // Refuse unsupported strategies; providers silently map unrecognized methods to their default.
        if (
          input.mergeMethod !== undefined &&
          !project.api.capabilities.mergeMethods.includes(input.mergeMethod)
        ) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: `This host cannot merge with the ${input.mergeMethod} strategy.`,
            }),
          );
        }
        if (
          input.updateMethod !== undefined &&
          !(project.api.capabilities.updateMethods ?? []).includes(input.updateMethod)
        ) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "runAction",
              detail: `This host cannot update a branch by ${input.updateMethod}.`,
            }),
          );
        }
        const operation = viewerPermissionsOf(
          project,
          input,
          "runAction",
          input.action === "update-branch",
        ).pipe(
          Effect.flatMap((viewer): Effect.Effect<string, PullRequestError> => {
            const stackRebase = input.stackNumber !== undefined && input.action === "update-branch";
            if (
              stackRebase ? viewer.stackRebase !== true : !viewer.actions.includes(input.action)
            ) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "runAction",
                  detail: ACTION_ACCESS_REFUSALS[input.action],
                }),
              );
            }
            if (
              !stackRebase &&
              input.updateMethod !== undefined &&
              !(viewer.updateMethods ?? []).includes(input.updateMethod)
            ) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "runAction",
                  detail: ACTION_ACCESS_REFUSALS["update-branch"],
                }),
              );
            }
            const mergeSettings =
              project.api.mergeMessageRewrite !== undefined &&
              input.stackNumber === undefined &&
              (input.action === "merge" || input.action === "enable-auto-merge")
                ? serverSettings.getSettings.pipe(
                    Effect.map(
                      (settings) =>
                        resolveProjectSettings(settings, project.project.id).settings
                          .removeAgentCreditsOnMerge,
                    ),
                    Effect.mapError(
                      () =>
                        new PullRequestOperationError({
                          operation: "runAction",
                          detail: "Could not read merge settings.",
                        }),
                    ),
                  )
                : Effect.succeed(false);
            return mergeSettings.pipe(
              Effect.flatMap((removeAgentCreditsOnMerge) =>
                project.api
                  .runAction({
                    cwd: project.project.workspaceRoot,
                    repository: project.repository,
                    host: project.host,
                    number: input.number,
                    action: input.action,
                    ...(removeAgentCreditsOnMerge ? { removeAgentCreditsOnMerge: true } : {}),
                    ...(input.stackNumber === undefined ? {} : { stackNumber: input.stackNumber }),
                    ...(input.expectedStackHeads === undefined
                      ? {}
                      : { expectedStackHeads: input.expectedStackHeads }),
                    ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
                    ...(input.updateMethod === undefined
                      ? {}
                      : { updateMethod: input.updateMethod }),
                  })
                  .pipe(
                    Effect.ensuring(
                      input.stackNumber === undefined
                        ? Effect.void
                        : refreshAfterTurn(project.project.id),
                    ),
                    Effect.mapError(toPullRequestError("runAction")),
                    Effect.as(
                      project.repositoryKey !== null ? input.repository.trim() : project.repository,
                    ),
                  ),
              ),
            );
          }),
        );
        return input.action === "delete-branch" && project.api.withVerifiedCredential !== undefined
          ? project.api
              .withVerifiedCredential(
                {
                  cwd: project.project.workspaceRoot,
                  host: project.host,
                  repository: project.repository,
                },
                () => operation.pipe(Effect.result),
              )
              .pipe(
                Effect.mapError(toPullRequestError("runAction")),
                Effect.flatMap(Effect.fromResult),
              )
          : operation;
      }),
    );

  const runActionAndInvalidate: PullRequestService["Service"]["runAction"] = Effect.fn(
    "PullRequestService.runActionAndInvalidate",
  )(function* (input) {
    const ref = yield* canonicalRef(input);
    yield* readCache.invalidate(refScope(ref));
    const repository = yield* runAction(input).pipe(
      Effect.ensuring(readCache.invalidate(refScope(ref))),
    );
    bumpRefEpoch({ ...ref, repository });
    d.listingsEpoch = ++d.epochCounter;
    yield* SubscriptionRef.set(pullRequestRefreshes, d.listingsEpoch);
    if (input.action === "merge") {
      // A successful merge action can merely enqueue the PR or enable auto-merge.
      const confirmed = yield* summaryUncached({ ...input, repository }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to confirm pull request merge", { error }).pipe(
            Effect.as(null),
          ),
        ),
      );
      if (confirmed?.state !== "merged") return;
      yield* PubSub.publish(mergedPullRequests, {
        projectId: input.projectId,
        repository,
        number: input.number,
        mergedAt: DateTime.formatIso(yield* DateTime.now),
      });
    }
  });

  const comment: PullRequestService["Service"]["comment"] = (input) =>
    (input.body.trim().length === 0
      ? Effect.fail(
          new PullRequestOperationError({
            operation: "comment",
            detail: "A comment cannot be empty.",
          }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.comment) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "comment",
              detail: "This host cannot post a comment on a change request.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "comment").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.comment) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "comment",
                  detail:
                    "You need write access on this repository to comment on a change request.",
                }),
              );
            }
            return project.api
              .comment({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                body: input.body,
              })
              .pipe(Effect.mapError(toPullRequestError("comment")));
          }),
        );
      }),
    );

  // Hosts let authors edit without reporting that permission; checking it would wrongly deny access.

  const update: PullRequestService["Service"]["update"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        const rewrite = project.api.updateChangeRequest;
        if (project.api.capabilities.edit?.changeRequest !== true || rewrite === undefined) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "update",
              detail: "This host cannot rewrite a change request.",
            }),
          );
        }
        if (
          input.maintainerCanModify !== undefined &&
          project.api.capabilities.edit?.maintainerEdits !== true
        ) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "update",
              detail: "This host does not support maintainer edits.",
            }),
          );
        }
        if (
          input.title === undefined &&
          input.body === undefined &&
          input.maintainerCanModify === undefined
        ) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "update",
              detail: "Nothing was changed.",
            }),
          );
        }
        return rewrite({
          cwd: project.project.workspaceRoot,
          repository: project.repository,
          host: project.host,
          number: input.number,
          ...(input.maintainerCanModify === undefined
            ? {}
            : { maintainerCanModify: input.maintainerCanModify }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        }).pipe(Effect.mapError(toPullRequestError("update")));
      }),
    );

  const updateComment: PullRequestService["Service"]["updateComment"] = (input) =>
    (input.body.trim().length === 0
      ? Effect.fail(
          new PullRequestOperationError({
            operation: "updateComment",
            detail: "A comment cannot be empty.",
          }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        const rewrite = project.api.updateComment;
        if (project.api.capabilities.edit?.comment !== true || rewrite === undefined) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "updateComment",
              detail: "This host cannot rewrite a comment.",
            }),
          );
        }
        return rewrite({
          cwd: project.project.workspaceRoot,
          repository: project.repository,
          host: project.host,
          number: input.number,
          commentId: input.commentId,
          kind: input.kind,
          body: input.body,
        }).pipe(Effect.mapError(toPullRequestError("updateComment")));
      }),
    );

  const submitReview: PullRequestService["Service"]["submitReview"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        const review = project.api.capabilities.review;
        const refuse = (detail: string) =>
          Effect.fail(new PullRequestOperationError({ operation: "submitReview", detail }));
        if (!review.verdicts.includes(input.verdict)) {
          return refuse(`This host cannot ${VERDICT_LABELS[input.verdict]} a change request.`);
        }
        if (input.comments.length > 0 && !review.inlineComment) {
          return refuse("This host cannot comment on a line of a change request.");
        }
        if (
          input.verdict !== "approve" &&
          input.body.trim().length === 0 &&
          input.comments.length === 0
        ) {
          return refuse("A review needs a summary or at least one comment.");
        }
        return viewerPermissionsOf(project, input, "submitReview").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.verdicts.includes(input.verdict)) {
              return refuse(
                `You need write access on this repository to ${
                  VERDICT_LABELS[input.verdict]
                } a change request.`,
              );
            }
            if (input.comments.length > 0 && !viewer.comment) {
              return refuse(
                "You need write access on this repository to comment on a line of a change request.",
              );
            }
            return project.api
              .submitReview({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                verdict: input.verdict,
                body: input.body,
                comments: input.comments,
              })
              .pipe(Effect.mapError(toPullRequestError("submitReview")));
          }),
        );
      }),
    );

  const replyToThread: PullRequestService["Service"]["replyToThread"] = (input) =>
    (input.body.trim().length === 0
      ? Effect.fail(
          new PullRequestOperationError({
            operation: "replyToThread",
            detail: "A reply cannot be empty.",
          }),
        )
      : requireProject(input)
    ).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.review.reply) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "replyToThread",
              detail: "This host cannot reply to a review conversation.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "replyToThread").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.comment) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "replyToThread",
                  detail:
                    "You need write access on this repository to reply to a review conversation.",
                }),
              );
            }
            return project.api
              .replyToThread({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                threadId: input.threadId,
                body: input.body,
              })
              .pipe(Effect.mapError(toPullRequestError("replyToThread")));
          }),
        );
      }),
    );

  const setThreadResolution: PullRequestService["Service"]["setThreadResolution"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.review.resolve) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "setThreadResolution",
              detail: "This host cannot resolve a review conversation.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "setThreadResolution").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.resolve) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "setThreadResolution",
                  detail:
                    "You need write access on this repository, or to have opened this change request, to resolve a review conversation.",
                }),
              );
            }
            return project.api
              .setThreadResolution({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                threadId: input.threadId,
                resolved: input.resolved,
              })
              .pipe(Effect.mapError(toPullRequestError("setThreadResolution")));
          }),
        );
      }),
    );

  // Hosts permit reactions from any reader; reading the PR already checks access.

  const setReaction: PullRequestService["Service"]["setReaction"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (project.api.capabilities.reactions !== true) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "setReaction",
              detail: "This host has no reactions.",
            }),
          );
        }
        return project.api
          .setReaction({
            cwd: project.project.workspaceRoot,
            repository: project.repository,
            host: project.host,
            number: input.number,
            ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
            content: input.content,
            reacted: input.reacted,
          })
          .pipe(Effect.mapError(toPullRequestError("setReaction")));
      }),
    );

  const reviewerCandidates: PullRequestService["Service"]["reviewerCandidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap(
        (project): Effect.Effect<PullRequestReviewerCandidateList, PullRequestError> => {
          if (!project.api.capabilities.reviewers.listCandidates) {
            return Effect.fail(
              new PullRequestOperationError({
                operation: "reviewerCandidates",
                detail: "This host cannot say who may review a change request.",
              }),
            );
          }
          return viewerPermissionsOf(project, input, "reviewerCandidates").pipe(
            Effect.flatMap(
              (viewer): Effect.Effect<PullRequestReviewerCandidateList, PullRequestError> =>
                viewer.requestReviewers
                  ? project.api
                      .listReviewerCandidates({
                        cwd: project.project.workspaceRoot,
                        repository: project.repository,
                        host: project.host,
                        number: input.number,
                      })
                      .pipe(Effect.mapError(toPullRequestError("reviewerCandidates")))
                  : Effect.fail(
                      new PullRequestOperationError({
                        operation: "reviewerCandidates",
                        detail: REVIEWER_REQUEST_REFUSAL,
                      }),
                    ),
            ),
          );
        },
      ),
    );

  const requestReviewers: PullRequestService["Service"]["requestReviewers"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        if (!project.api.capabilities.reviewers.request) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "requestReviewers",
              detail: "This host cannot ask somebody for a review.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "requestReviewers").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> => {
            if (!viewer.requestReviewers) {
              return Effect.fail(
                new PullRequestOperationError({
                  operation: "requestReviewers",
                  detail: REVIEWER_REQUEST_REFUSAL,
                }),
              );
            }
            return project.api
              .setReviewerRequest({
                cwd: project.project.workspaceRoot,
                repository: project.repository,
                host: project.host,
                number: input.number,
                reviewers: input.reviewers,
                requested: input.requested,
              })
              .pipe(Effect.mapError(toPullRequestError("requestReviewers")));
          }),
        );
      }),
    );

  const setLabels: PullRequestService["Service"]["setLabels"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project): Effect.Effect<void, PullRequestError> => {
        const change = project.api.setLabels;
        if (project.api.capabilities.labels !== true || change === undefined) {
          return Effect.fail(
            new PullRequestOperationError({
              operation: "setLabels",
              detail: "This host cannot change the labels on a change request.",
            }),
          );
        }
        return viewerPermissionsOf(project, input, "setLabels").pipe(
          Effect.flatMap((viewer): Effect.Effect<void, PullRequestError> =>
            viewer.labels === false
              ? Effect.fail(
                  new PullRequestOperationError({
                    operation: "setLabels",
                    detail: LABEL_CHANGE_REFUSAL,
                  }),
                )
              : change({
                  cwd: project.project.workspaceRoot,
                  repository: project.repository,
                  host: project.host,
                  number: input.number,
                  labels: input.labels,
                  applied: input.applied,
                }).pipe(Effect.mapError(toPullRequestError("setLabels"))),
          ),
        );
      }),
    );

  /**
   * The line counts for rows already on the page, which the listing left out because on GitHub
   * they cost more than everything else on the row put together.
   */

  const setFilesViewed: PullRequestService["Service"]["setFilesViewed"] = (input) =>
    canonicalRef(input).pipe(
      Effect.flatMap((ref) =>
        viewedFiles.setFilesViewed(input).pipe(
          // Deliberately not `invalidatedByMutation`: ticking a file off says nothing about the
          // change request, and dropping a 300-file diff on every checkbox is the whole cost of
          // the feature.
          Effect.ensuring(Effect.sync(() => bumpFilesViewedEpoch(ref))),
        ),
      ),
    );

  const invalidatedByMutation =
    <I extends PullRequestRef>(
      method: (input: I) => Effect.Effect<void, PullRequestError>,
    ): ((input: I) => Effect.Effect<void, PullRequestError>) =>
    (input) =>
      Effect.gen(function* () {
        const ref = yield* canonicalRef(input);
        yield* readCache.invalidate(refScope(ref)).pipe(
          Effect.andThen(method(input)),
          Effect.ensuring(readCache.invalidate(refScope(ref))),
          Effect.tap(() =>
            Effect.sync(() => {
              bumpRefEpoch(ref);
              d.listingsEpoch = ++d.epochCounter;
            }),
          ),
        );
        yield* SubscriptionRef.set(pullRequestRefreshes, d.listingsEpoch);
      });
    return {
      runAction,
      runActionAndInvalidate,
      comment,
      update,
      updateComment,
      submitReview,
      replyToThread,
      setThreadResolution,
      setReaction,
      reviewerCandidates,
      requestReviewers,
      setLabels,
      setFilesViewed,
      invalidatedByMutation,
    };
  });
