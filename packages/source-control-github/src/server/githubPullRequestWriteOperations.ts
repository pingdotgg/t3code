import { isCommitSha, normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import { removeAgentCredits } from "@t3tools/source-control-core/server/mergeMessage";
import { KnownWorkflowRuns, makeChecksRevalidator } from "./gitHubConditionalChecks.ts";
import { runGitHubStackAction, type GitHubStackActionError } from "./githubStackActions.ts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { GraphQLClient, GraphQLClientError, GraphQLGroup, GraphQLResolver } from "effect/graphql";
import { HttpClient } from "effect/http";
import * as RequestResolver from "effect/RequestResolver";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  resolvePullRequestAuthorFilter,
  PositiveInt,
  TrimmedNonEmptyString,
  type PullRequestAction,
  type PullRequestStackHead,
  type PullRequestActor,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestFileViewed,
  type PullRequestInvolvement,
  type PullRequestListFilters,
  type PullRequestListState,
  type PullRequestMergeMethod,
  type PullRequestOmittedFileStat,
  type PullRequestReaction,
  type PullRequestReactionContent,
  type PullRequestReviewCommentDraft,
  type PullRequestReviewVerdict,
  type PullRequestReviewerCandidateList,
  type PullRequestReviewerKind,
  type PullRequestLabel,
  type PullRequestLabelCandidateList,
  type PullRequestThreadCommentsResult,
  type PullRequestUpdateMethod,
  type PullRequestPreview,
} from "@t3tools/contracts";

import * as GitHubAppAccess from "./GitHubAppAccess.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubGraphQlClient from "./gitHubGraphQlClient.ts";
import { PullRequestBatchesGraphQLGroup } from "./pullRequestBatches.graphql.ts";
import { PullRequestMutationsGraphQLGroup } from "./pullRequestMutations.graphql.ts";
import { PullRequestReadsGraphQLGroup } from "./pullRequestReads.graphql.ts";
import { PullRequestReviewsGraphQLGroup } from "./pullRequestReviews.graphql.ts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  buildReviewSubmission,
  buildReviewerRequest,
  decodeCommitFilesJson,
  pullRequestChecksFromContexts,
  decodeWorkflowRunsJson,
  type GitHubPullRequestCore,
  type GitHubPullRequestFileStat,
  type GitHubPullRequestWatchFingerprint,
  isSubjectOfPullRequest,
  LenientPullRequestList,
  LenientPullRequestSearch,
  pageRows,
  pullRequestLookup,
  toLabelCandidates,
  toRepositoryAuthors,
  toRepositoryLabels,
  toPullRequestActivityPage,
  toPullRequestCommitStats,
  toPullRequestCheckContextsPage,
  toPullRequestCore,
  toPullRequestFilesViewedPage,
  toPullRequestFileStatsPage,
  toPullRequestHeads,
  toPullRequestNodeId,
  toPullRequestPreview,
  toPullRequestRows,
  toPullRequestSummary,
  toPullRequestWatchFingerprint,
  toReviewDismissalsPage,
  toReviewerCandidates,
  toReviewThreadCommentsPage,
  toReviewThreadPage,
  toStackMembership,
  toViewerPermissions,
  decodePullRequestFilesJson,
  decodePullRequestStacksJson,
  buildLabelRequest,
  PULL_REQUEST_SEARCH_MAX_ROWS,
  gitHubReactionContent,
  reviewThreadConversation,
  type GitHubPullRequestActivity,
  type GitHubPullRequestActivityPage,
  type GitHubWorkflowRunPage,
  type GitHubPullRequestHead,
  type GitHubPullRequestListItem,
  type GitHubPullRequestSearchItem,
  type GitHubPullRequestStack,
  type GitHubReviewThreadComments,
  type GitHubRepositoryAccess,
  type GitHubWorkflowRunApproval,
  type GitHubReviewThreadEntry,
  type GitHubReviewThreadPage,
  type GitHubViewerAccess,
  IMMEDIATELY_MERGEABLE,
} from "./gitHubPullRequestJson.ts";
import type {
  ProviderChangeRequestSummary,
  ProviderListCursor,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import { GitHubPullRequestReadError, GitHubViewerLoginUnavailableError, GitHubDiffCursorError, GitHubDiffCommitError, GitHubDiffRevisionsUnavailableError, GitHubDiffFileContentsUnavailableError, GitHubRepositorySelectorError, GitHubSubjectScopeError, GitHubWorkflowApprovalRefusedError, GitHubWorkflowApprovalHeadUnavailableError, GitHubWorkflowApprovalHeadChangedError, GitHubBranchDeletionRefusedError } from "./githubPullRequestErrors.ts";
import { PullRequestGraphQLGroup } from "./githubPullRequestQuery.ts";
import type { PullRequestReads } from "./githubPullRequestReads.ts";
import type { GitHubPullRequestApi } from "./GitHubPullRequestApi.ts";
import { FILES_VIEWED_MAX_PAGES } from "./githubPullRequestSupport.ts";
import { GRAPHQL_MERGE_METHODS, parseRepositorySelector } from "./githubPullRequestQuery.ts";

export interface MakePullRequestWriteOperationsDeps {
  readonly api: import("./GitHubRest.ts").GitHubRest["Service"];
  readonly appAccess: import("./GitHubAppAccess.ts").GitHubAppAccess["Service"];
  readonly client: GraphQLClient.FromGroup<typeof PullRequestGraphQLGroup>;
  readonly fileSystem: import("effect/FileSystem").FileSystem;
  readonly httpClient: import("effect/http").HttpClient.HttpClient;
  readonly policy: import("./GitHubRequestPolicy.ts").GitHubRequestPolicy["Service"];
  readonly sourceControlHost: import("@t3tools/source-control-core/server/SourceControlHost").SourceControlHost["Service"];
  readonly reads: PullRequestReads;
}

export const makePullRequestWriteOperations = (
  deps: MakePullRequestWriteOperationsDeps,
): Pick<
  GitHubPullRequestApi["Service"],
  | "setLabels"
  | "runPullRequestAction"
  | "commentOnPullRequest"
  | "submitReview"
  | "replyToReviewThread"
  | "getPullRequestFilesViewed"
  | "getPullRequestFileStats"
  | "setPullRequestFilesViewed"
  | "setReviewThreadResolution"
  | "setReaction"
  | "updatePullRequest"
  | "updateComment"
> => {
  const { api, appAccess, client, fileSystem, httpClient, policy, sourceControlHost, reads } = deps;
  const {
    graphql,
    found,
    readPages,
    pullRequestNodeId,
    subjectBelongsToPullRequest,
    simpleActionMutations,
    setFileViewedResolver,
    getPullRequestDetail,
    listWorkflowRunsRequiringApproval,
  } = reads;
  return ({
  setLabels: Effect.fn("GitHubPullRequestApi.setLabels")(function (input) {
    const { owner, name } = parseRepositorySelector(input.repository);
    const issue = `repos/${owner}/${name}/issues/${input.number}/labels`;
    if (input.applied) {
      return api
        .rest({
          host: input.host,
          operation: "setLabels",
          method: "POST",
          path: issue,
          body: buildLabelRequest(input.labels),
        })
        .pipe(Effect.asVoid);
    }
    return Effect.forEach(
      input.labels,
      (label) =>
        api.rest({
          host: input.host,
          operation: "setLabels",
          method: "DELETE",
          path: `${issue}/${encodeURIComponent(label)}`,
        }),
      { concurrency: 1, discard: true },
    );
  }),

  runPullRequestAction: Effect.fn("GitHubPullRequestApi.runPullRequestAction")(function (input) {
    if (input.action === "delete-branch") {
      return Effect.gen(function* () {
        if (input.stackNumber !== undefined) {
          return yield* new GitHubBranchDeletionRefusedError({
            number: input.number,
            reason: "stack",
          });
        }
        const { owner, name } = parseRepositorySelector(input.repository);
        const target = { ...input, operation: "deletePullRequestBranch" };
        const branch = yield* client
          .PullRequestBranchToDelete({ owner, name, number: input.number })
          .pipe(
            graphql({ ...target, allowReserve: true }),
            Effect.map((result) => result.repository?.pullRequest ?? null),
            Effect.flatMap(found(target)),
          );
        if (branch.state === "OPEN") {
          return yield* new GitHubBranchDeletionRefusedError({
            number: input.number,
            reason: "open-pr",
          });
        }
        const repositoryId = branch.headRepository?.id;
        if (!repositoryId || !branch.headRefName || !branch.headRefOid) {
          return yield* new GitHubBranchDeletionRefusedError({
            number: input.number,
            reason: "source-unavailable",
          });
        }
        if (branch.headRefName === branch.baseRefName) {
          return yield* new GitHubBranchDeletionRefusedError({
            number: input.number,
            reason: "unsafe-branch",
          });
        }
        const ref = `refs/heads/${branch.headRefName}`;
        const source = yield* client
          .PullRequestSourceBranch({ repositoryId, ref })
          .pipe(graphql({ ...target, allowReserve: true }));
        const repository = source.node?.__typename === "Repository" ? source.node : null;
        if (repository === null) {
          return yield* new GitHubBranchDeletionRefusedError({
            number: input.number,
            reason: "source-unavailable",
          });
        }
        if (repository.ref === null) return;
        if (
          repository.defaultBranchRef === null ||
          branch.headRefName === repository.defaultBranchRef.name
        ) {
          return yield* new GitHubBranchDeletionRefusedError({
            number: input.number,
            reason: "unsafe-branch",
          });
        }
        if (repository.ref.target?.oid !== branch.headRefOid) {
          return yield* new GitHubBranchDeletionRefusedError({
            number: input.number,
            reason: "head-changed",
          });
        }
        yield* client
          .DeletePullRequestBranch({
            input: {
              repositoryId,
              refUpdates: [
                {
                  name: ref,
                  beforeOid: branch.headRefOid,
                  afterOid: "0000000000000000000000000000000000000000",
                },
              ],
            },
          })
          .pipe(graphql(target));
      });
    }
    if (input.stackNumber !== undefined)
      return runGitHubStackAction({ ...input, stackNumber: input.stackNumber }).pipe(
        Effect.provideService(GitHubRest.GitHubRest, api),
        Effect.provideService(GitHubAppAccess.GitHubAppAccess, appAccess),
        Effect.provideService(GitHubRequestPolicy.GitHubRequestPolicy, policy),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(SourceControlHost.SourceControlHost, sourceControlHost),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
    if (input.action === "revert") {
      return pullRequestNodeId({ ...input, operation: "revertPullRequest" }).pipe(
        Effect.flatMap((pullRequestId) =>
          client
            .RevertPullRequest({ pullRequestId })
            .pipe(graphql({ ...input, operation: "revertPullRequest" })),
        ),
        Effect.asVoid,
      );
    }
    if (input.action === "approve-workflows") {
      const { owner, name } = parseRepositorySelector(input.repository);
      return getPullRequestDetail(input).pipe(
        Effect.flatMap((detail) => {
          if (detail.isCrossRepository !== true) return Effect.void;
          if (detail.headSha == null || detail.headRepositoryOwner == null) {
            return Effect.fail(
              new GitHubWorkflowApprovalHeadUnavailableError({
                cwd: input.cwd,
                number: input.number,
              }),
            );
          }
          const expectedHeadSha = detail.headSha;
          const expectedHeadBranch = detail.headBranch;
          const expectedHeadRepositoryOwner = detail.headRepositoryOwner;
          return listWorkflowRunsRequiringApproval({
            ...input,
            headSha: expectedHeadSha,
            headBranch: expectedHeadBranch,
            headRepositoryOwner: expectedHeadRepositoryOwner,
            isCrossRepository: true,
          }).pipe(
            Effect.flatMap((runs) =>
              Effect.forEach(
                runs,
                (run) =>
                  getPullRequestDetail(input).pipe(
                    Effect.flatMap((current) => {
                      if (current.headSha == null || current.headRepositoryOwner == null) {
                        return Effect.fail(
                          new GitHubWorkflowApprovalHeadUnavailableError({
                            cwd: input.cwd,
                            number: input.number,
                          }),
                        );
                      }
                      if (
                        current.isCrossRepository !== true ||
                        current.headSha !== expectedHeadSha ||
                        current.headBranch !== expectedHeadBranch ||
                        current.headRepositoryOwner.toLowerCase() !==
                          expectedHeadRepositoryOwner.toLowerCase()
                      ) {
                        return Effect.fail(
                          new GitHubWorkflowApprovalHeadChangedError({
                            cwd: input.cwd,
                            number: input.number,
                          }),
                        );
                      }
                      return listWorkflowRunsRequiringApproval({
                        ...input,
                        headSha: current.headSha,
                        headBranch: current.headBranch,
                        headRepositoryOwner: current.headRepositoryOwner,
                        isCrossRepository: true,
                      });
                    }),
                    Effect.flatMap((currentRuns) =>
                      currentRuns.some((current) => current.id === run.id)
                        ? api
                            .rest({
                              host: input.host,
                              operation: "approveWorkflowRun",
                              method: "POST",
                              path: `repos/${owner}/${name}/actions/runs/${run.id}/approve`,
                            })
                            .pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  ),
                { concurrency: 1, discard: true },
              ),
            ),
          );
        }),
      );
    }
    const action = input.action;
    if (action in simpleActionMutations) {
      const mutate = simpleActionMutations[action as keyof typeof simpleActionMutations];
      return pullRequestNodeId({ ...input, operation: "runPullRequestAction" }).pipe(
        Effect.flatMap((pullRequestId) =>
          mutate(pullRequestId).pipe(graphql({ ...input, operation: "runPullRequestAction" })),
        ),
      );
    }
    return Effect.gen(function* () {
      const { owner, name } = parseRepositorySelector(input.repository);
      // Fresh head and merge-queue state determine the mutation's revision and route.
      const target = { ...input, operation: "runPullRequestAction" };
      const state = yield* client
        .PullRequestActionState({
          owner,
          name,
          number: input.number,
          headRef: `refs/pull/${input.number}/head`,
        })
        .pipe(
          graphql({ ...target, allowReserve: true }),
          Effect.map((result) => result.repository?.pullRequest ?? null),
          Effect.flatMap(found(target)),
        );
      if (action === "update-branch") {
        if (state.baseRef?.compare?.behindBy === 0) return;
        return yield* client
          .UpdatePullRequestBranch({
            pullRequestId: state.id,
            expectedHeadOid: state.headRefOid,
            updateMethod: input.updateMethod === "rebase" ? "REBASE" : "MERGE",
          })
          .pipe(graphql(target), Effect.asVoid);
      }
      let body: string | undefined;
      let expectedHead: string | undefined;
      if (input.removeAgentCreditsOnMerge === true && input.mergeMethod !== "rebase") {
        const message = yield* client
          .PullRequestMergeMessage({
            owner,
            name,
            number: input.number,
            method: input.mergeMethod === "squash" ? "SQUASH" : "MERGE",
          })
          .pipe(
            graphql({ ...target, allowReserve: true }),
            Effect.map((result) => result.repository?.pullRequest ?? null),
            Effect.flatMap(found(target)),
          );
        // GitHub's merge queue chooses its own message and ignores custom text.
        if (!message.isMergeQueueEnabled) {
          const cleaned = removeAgentCredits(message.viewerMergeBodyText);
          if (cleaned !== message.viewerMergeBodyText) {
            body = cleaned;
            expectedHead = message.headRefOid;
          }
        }
      }
      // Merge queues always use auto-merge. A PR that became ready since detail loaded
      // merges directly, matching `gh pr merge --auto`.
      const auto =
        state.isMergeQueueEnabled === true ||
        (action === "enable-auto-merge" &&
          !IMMEDIATELY_MERGEABLE.has(state.mergeStateStatus?.toUpperCase() ?? ""));
      const merge = {
        pullRequestId: state.id,
        mergeMethod: GRAPHQL_MERGE_METHODS[input.mergeMethod ?? "merge"],
        ...(expectedHead === undefined ? {} : { expectedHeadOid: expectedHead }),
        ...(body === undefined ? {} : { commitBody: body }),
      };
      yield* (
        auto
          ? client.EnablePullRequestAutoMerge({ input: merge }).pipe(Effect.asVoid)
          : client.MergePullRequest({ input: merge }).pipe(Effect.asVoid)
      ).pipe(graphql(target));
    });
  }),

  commentOnPullRequest: Effect.fn("GitHubPullRequestApi.commentOnPullRequest")(function (input) {
    return pullRequestNodeId({ ...input, operation: "commentOnPullRequest" }).pipe(
      Effect.flatMap((subjectId) =>
        client
          .AddComment({ subjectId, body: input.body })
          .pipe(graphql({ ...input, operation: "commentOnPullRequest" })),
      ),
      Effect.asVoid,
    );
  }),

  submitReview: Effect.fn("GitHubPullRequestApi.submitReview")(function (input) {
    const { owner, name } = parseRepositorySelector(input.repository);
    return api
      .rest({
        host: input.host,
        operation: "submitReview",
        method: "POST",
        path: `repos/${owner}/${name}/pulls/${input.number}/reviews`,
        body: buildReviewSubmission({
          verdict: input.verdict,
          body: input.body,
          comments: input.comments,
        }),
      })
      .pipe(Effect.asVoid);
  }),

  replyToReviewThread: Effect.fn("GitHubPullRequestApi.replyToReviewThread")(function (input) {
    return client
      .AddReviewThreadReply({ threadId: input.threadId, body: input.body })
      .pipe(graphql({ ...input, operation: "replyToReviewThread" }), Effect.asVoid);
  }),

  getPullRequestFilesViewed: Effect.fn("GitHubPullRequestApi.getPullRequestFilesViewed")(
    function (input) {
      const { owner, name } = parseRepositorySelector(input.repository);
      const target = { ...input, operation: "getPullRequestFilesViewed" };
      return readPages(
        GraphQLClient.pages(client.PullRequestFilesViewed, {
          variables: { owner, name, number: input.number },
          connection: (result) => {
            const page = toPullRequestFilesViewedPage(result);
            return {
              ...page,
              pageInfo: { hasNextPage: page.nextCursor !== null, endCursor: page.nextCursor },
            };
          },
        }),
        {
          ...target,
          maxPages: FILES_VIEWED_MAX_PAGES,
          hasNextPage: (page) => page.nextCursor !== null,
        },
      ).pipe(
        graphql(target),
        Effect.map(({ pages, truncated }) => ({
          files: pages.flatMap((page) => page.files),
          truncated,
        })),
      );
    },
  ),

  getPullRequestFileStats: Effect.fn("GitHubPullRequestApi.getPullRequestFileStats")(
    function (input) {
      const { owner, name } = parseRepositorySelector(input.repository);
      const target = { ...input, operation: "getPullRequestFileStats" };
      return readPages(
        GraphQLClient.pages(client.PullRequestFileStats, {
          variables: { owner, name, number: input.number },
          connection: (result) => {
            const page = toPullRequestFileStatsPage(result);
            return {
              ...page,
              pageInfo: { hasNextPage: page.nextCursor !== null, endCursor: page.nextCursor },
            };
          },
        }),
        {
          ...target,
          maxPages: FILES_VIEWED_MAX_PAGES,
          hasNextPage: (page) => page.nextCursor !== null,
        },
      ).pipe(
        graphql(target),
        Effect.map(({ pages, truncated }) => ({
          files: pages.flatMap((page) => page.files),
          truncated,
        })),
      );
    },
  ),

  setPullRequestFilesViewed: Effect.fn("GitHubPullRequestApi.setPullRequestFilesViewed")(
    function (input) {
      if (input.files.length === 0) return Effect.void;
      const target = { ...input, operation: "setPullRequestFilesViewed" };
      return pullRequestNodeId(target).pipe(
        Effect.flatMap((pullRequestId) =>
          // Top-level mutation fields run in order, so the last toggle for a path wins.
          Effect.forEach(
            input.files,
            (file) =>
              GraphQLResolver.request(
                { pullRequestId, path: file.path, viewed: file.viewed },
                setFileViewedResolver,
              ),
            { concurrency: "unbounded", discard: true },
          ),
        ),
        graphql(target),
      );
    },
  ),

  setReviewThreadResolution: Effect.fn("GitHubPullRequestApi.setReviewThreadResolution")(
    function (input) {
      return (
        input.resolved
          ? client.ResolveReviewThread({ threadId: input.threadId }).pipe(Effect.asVoid)
          : client.UnresolveReviewThread({ threadId: input.threadId }).pipe(Effect.asVoid)
      ).pipe(graphql({ ...input, operation: "setReviewThreadResolution" }));
    },
  ),

  setReaction: Effect.fn("GitHubPullRequestApi.setReaction")(function (input) {
    const givenSubjectId = input.subjectId;
    const subjectId =
      givenSubjectId === undefined
        ? pullRequestNodeId({ ...input, operation: "setReaction" })
        : subjectBelongsToPullRequest({
            ...input,
            subjectId: givenSubjectId,
            operation: "setReaction",
          }).pipe(
            Effect.flatMap((belongs) =>
              belongs
                ? Effect.succeed(givenSubjectId)
                : Effect.fail(
                    new GitHubSubjectScopeError({
                      cwd: input.cwd,
                      operation: "setReaction",
                    }),
                  ),
            ),
          );
    return subjectId.pipe(
      Effect.flatMap((subjectId) => {
        const variables = { subjectId, content: gitHubReactionContent(input.content) };
        return (
          input.reacted
            ? client.AddReaction(variables).pipe(Effect.asVoid)
            : client.RemoveReaction(variables).pipe(Effect.asVoid)
        ).pipe(graphql({ ...input, operation: "setReaction" }));
      }),
    );
  }),

  updatePullRequest: Effect.fn("GitHubPullRequestApi.updatePullRequest")(function (input) {
    return pullRequestNodeId({ ...input, operation: "updatePullRequest" }).pipe(
      Effect.flatMap((pullRequestId) =>
        client
          .UpdatePullRequest({
            pullRequestId,
            ...(input.maintainerCanModify === undefined
              ? {}
              : { maintainerCanModify: input.maintainerCanModify }),
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
          })
          .pipe(graphql({ ...input, operation: "updatePullRequest" })),
      ),
      Effect.asVoid,
    );
  }),

  updateComment: Effect.fn("GitHubPullRequestApi.updateComment")(function (input) {
    return subjectBelongsToPullRequest({
      cwd: input.cwd,
      repository: input.repository,
      host: input.host,
      number: input.number,
      subjectId: input.commentId,
      operation: "updateComment",
    }).pipe(
      Effect.flatMap((belongs) =>
        belongs
          ? Effect.succeed(input.commentId)
          : Effect.fail(
              new GitHubSubjectScopeError({
                cwd: input.cwd,
                operation: "updateComment",
              }),
            ),
      ),
      Effect.flatMap((commentId) => {
        const variables = { commentId, body: input.body };
        return (
          input.kind === "issue-comment"
            ? client.UpdateIssueComment(variables).pipe(Effect.asVoid)
            : client.UpdateReviewComment(variables).pipe(Effect.asVoid)
        ).pipe(graphql({ ...input, operation: "updateComment" }));
      }),
    );
  }),
});
};
