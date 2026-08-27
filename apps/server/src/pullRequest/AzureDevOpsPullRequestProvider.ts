import * as Effect from "effect/Effect";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";

import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import type { AzureDevOpsPullRequest } from "./azureDevOpsPullRequestJson.ts";

const CAPABILITIES: PullRequestCapabilities = {
  // `az repos pr` has no diff command, and the REST route reports changed files without their
  // contents, so there is no patch to show. The Code tab is hidden rather than empty.
  diff: false,
  // Reading a conversation is a plain REST read, but posting one is not something this can
  // claim without having run it, so the composer stays hidden.
  comment: false,
  actions: [
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "enable-auto-merge",
    "disable-auto-merge",
  ],
  // Azure squashes as a completion option; it has no rebase strategy of its own.
  mergeMethods: ["merge", "squash"],
  // `az repos pr list` filters by status, creator, reviewer and branch, and by no text at all.
  search: false,
  reactions: false,
  // With no patch to show there are no lines to write against, so nothing here is offered.
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  // `az repos pr reviewer add` and `remove` name identities, and nothing anywhere in `az repos`
  // lists the ones this repository could name — that lives behind the identity and graph APIs, a
  // different service with its own permissions. So the page takes a name here rather than being
  // handed a menu built out of a guess.
  reviewers: { request: true, listCandidates: false },
  // A new title and description travel on the same `az repos pr update` that moves a pull request.
  // Rewriting a remark is false for the same reason posting one is: this cannot put a remark on
  // Azure DevOps at all, so there is nothing here it could rewrite either.
  edit: { changeRequest: true, comment: false },
};

/**
 * Everything this host offers, granted to whoever is signed in. Azure DevOps states no permission
 * anywhere `az repos pr show` or `az repos pr list` reach: the answer lives in the security
 * namespaces, behind identity descriptors and token paths that would be several calls per pull
 * request to resolve.
 *
 * So the actions stay live and a viewer who may not take one is told so by Azure, at the moment
 * they try. That is the safer half of an unknown: hiding a control from someone entitled to it
 * leaves them no way through and no reason given.
 */
export const AZURE_DEVOPS_VIEWER_PERMISSIONS: PullRequestViewerPermissions = {
  actions: CAPABILITIES.actions,
  comment: CAPABILITIES.comment,
  resolve: CAPABILITIES.review.resolve,
  verdicts: CAPABILITIES.review.verdicts,
  requestReviewers: CAPABILITIES.reviewers.request,
};

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
export function azureDevOpsProviderFailure(
  error: AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCliError,
): PullRequestProviderFailure {
  if (error._tag === "AzureDevOpsCliUnavailableError") return { reason: "missing-tool" };
  if (error._tag === "AzureDevOpsCliAuthenticationError") return { reason: "unauthenticated" };
  if (error._tag === "AzureDevOpsCliRateLimitError") return { reason: "rate-limited" };
  return { reason: "failed" };
}

function toChangeRequest(pullRequest: AzureDevOpsPullRequest): ProviderChangeRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    mergeability: pullRequest.mergeability,
    // Azure reports no line counts on a pull request, and with no patch to read there is
    // nothing to count them from either.
    additions: 0,
    deletions: 0,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    reviewRequestLogins: pullRequest.reviewRequestLogins,
    // Azure keeps labels on work items rather than on the pull request.
    labels: [],
  };
}

export const make = Effect.gen(function* () {
  const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

  const fail =
    (operation: string) => (error: AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCliError) =>
      new PullRequestProviderError({
        provider: "azure-devops",
        operation,
        ...azureDevOpsProviderFailure(error),
        detail: error.detail,
        cause: error,
      });

  /** Refuses what the capabilities already say this host cannot do. */
  const unsupported = (operation: string) =>
    Effect.fail(
      new PullRequestProviderError({
        provider: "azure-devops",
        operation,
        reason: "failed",
        detail: "Azure DevOps reviews cannot be written from here yet.",
      }),
    );

  const provider: PullRequestProviderApi = {
    kind: "azure-devops",
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      cli.getViewer({ cwd: input.cwd }).pipe(Effect.mapError(fail("getViewer"))),

    // `input.query` is deliberately dropped: `az repos pr list` filters by status, creator,
    // reviewer and branch, and has nothing that matches text. Sending it as one of those would
    // narrow by the wrong thing, so the page comes back unnarrowed and the caller filters it.
    listChangeRequests: (input) =>
      cli
        .listPullRequests({
          cwd: input.cwd,
          repository: input.repository,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          cursor: input.cursor,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.map((batch) => ({
            items: batch.items.map(toChangeRequest),
            truncated: batch.truncated,
            cursorAdvance: batch.cursorAdvance,
            // Azure answers in one order whether or not it is being carried on from, so a slice
            // can always be stepped past — by counting, which is all Azure offers.
            continues: true,
          })),
        ),

    getChangeRequest: (input) =>
      cli.getPullRequest({ cwd: input.cwd, number: input.number }).pipe(
        Effect.mapError(fail("getChangeRequest")),
        Effect.map(
          (pullRequest): ProviderChangeRequestDetail => ({
            ...toChangeRequest(pullRequest),
            body: pullRequest.body,
            changedFiles: 0,
            mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
            closedAt: pullRequest.state === "closed" ? pullRequest.closedAt : null,
            reviewers: pullRequest.reviewers,
            checks: [],
            mergeCapabilities: { merge: true, squash: true, rebase: false },
            viewerPermissions: AZURE_DEVOPS_VIEWER_PERMISSIONS,
            autoMergeEnabled: pullRequest.autoMergeEnabled,
          }),
        ),
      ),

    getChangeRequestActivity: (input) =>
      cli.getPullRequest({ cwd: input.cwd, number: input.number }).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.flatMap((pullRequest) =>
          (pullRequest.threadsUrl === null
            ? Effect.succeed({ comments: [], truncated: true })
            : cli.listThreads({ cwd: input.cwd, threadsUrl: pullRequest.threadsUrl }).pipe(
                Effect.map((comments) => ({ comments, truncated: false })),
                Effect.orElseSucceed(() => ({ comments: [], truncated: true })),
              )
          ).pipe(
            Effect.map(
              (conversation): ProviderChangeRequestActivity => ({
                comments: conversation.comments,
                commentCount: conversation.comments.length,
                commentsTruncated: conversation.truncated,
                reviewThreads: [],
                commits: [],
              }),
            ),
          ),
        ),
      ),

    // No request at all: Azure has nothing to say about the viewer that a pull request read can
    // reach, so the answer is the same constant the detail carries.
    getViewerPermissions: () => Effect.succeed(AZURE_DEVOPS_VIEWER_PERMISSIONS),

    // Never called: `capabilities.diff` is false, and the service refuses a diff without it.
    getDiff: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: "azure-devops",
          operation: "getDiff",
          reason: "failed",
          detail: "Azure DevOps cannot produce a patch for a pull request.",
        }),
      ),

    runAction: (input) =>
      cli
        .runPullRequestAction({
          cwd: input.cwd,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),

    updateChangeRequest: (input) =>
      cli
        .updatePullRequest({
          cwd: input.cwd,
          number: input.number,
          title: input.title,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("updateChangeRequest"))),

    // Never called: `capabilities.reviewers.listCandidates` is false, and the service refuses the
    // list without it.
    listReviewerCandidates: () =>
      Effect.fail(
        new PullRequestProviderError({
          provider: "azure-devops",
          operation: "listReviewerCandidates",
          reason: "failed",
          detail: "Azure DevOps cannot say who may review a pull request.",
        }),
      ),

    setReviewerRequest: (input) =>
      cli
        .setPullRequestReviewers({
          cwd: input.cwd,
          number: input.number,
          // Azure names an identity by an email address or a guid, and has no team to ask, so a
          // candidate's id is the whole of what it takes.
          reviewers: input.reviewers.map((reviewer) => reviewer.id),
          requested: input.requested,
        })
        .pipe(Effect.mapError(fail("setReviewerRequest"))),

    // Never called: `capabilities.comment` is false, and the service refuses a comment without it.
    comment: () => unsupported("comment"),

    // Declared unsupported above, so the service refuses these before a provider is reached.
    // They exist because every provider answers the whole port.
    submitReview: () => unsupported("submitReview"),

    replyToThread: () => unsupported("replyToThread"),

    setThreadResolution: () => unsupported("setThreadResolution"),

    setReaction: () => unsupported("setReaction"),
  };

  return provider;
});
