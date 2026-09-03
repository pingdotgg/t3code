import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type {
  PullRequestActor,
  PullRequestCapabilities,
  PullRequestCheck,
  PullRequestReaction,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";

import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import type { GitHubViewerAccess, GitHubWorkflowRunApproval } from "./gitHubPullRequestJson.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
    "revert",
    "approve-workflows",
  ],
  mergeMethods: ["merge", "squash", "rebase"],
  updateMethods: ["merge", "rebase"],
  search: true,
  reactions: true,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
  labels: true,
};

/**
 * What the signed-in account may do here, from the three things GitHub says about it.
 *
 * Merging needs a role that can push, which is the one thing a stranger on an open-source
 * repository never has. The other four actions go by `viewerCanUpdate`, because the author of a
 * pull request may close it, reopen it and move it in and out of draft with no more than read
 * access on the repository it was opened against.
 *
 * Commenting and reviewing are not gated at all: read access is enough to say something and
 * enough to approve or ask for changes, which is what open-source review consists of. Resolving a
 * conversation is the exception — GitHub allows it to whoever can write, and to the author of the
 * pull request the conversation is on.
 *
 * Asking somebody else for a review needs write access, which is the one thing here an author
 * cannot do on their own pull request: GitHub shows an outside contributor the reviewer control
 * and refuses the request behind it.
 */
export function gitHubViewerPermissions(access: GitHubViewerAccess): PullRequestViewerPermissions {
  return {
    actions: [
      // Arming a merge and taking the arming back are the merge, deferred: whoever may not
      // merge here may not leave an instruction to merge later either.
      ...(access.canWrite
        ? ([
            "merge",
            "enable-auto-merge",
            "disable-auto-merge",
            "revert",
            "approve-workflows",
          ] as const)
        : []),
      ...(access.canUpdate ? (["ready", "draft", "close", "reopen"] as const) : []),
      // Whether this viewer may update the branch is GitHub's own answer, read with the
      // comparison; without it the action is offered to nobody rather than to everybody.
      ...(access.canUpdateBranch === true ? (["update-branch"] as const) : []),
    ],
    comment: true,
    resolve: access.canWrite || access.didAuthor,
    // Anyone may review a pull request they can see, except their own: GitHub refuses an author's
    // approval and their request for changes ("Can not approve your own pull request"), and
    // leaves them commenting, which is what an author has to say about their own change anyway.
    verdicts: access.didAuthor ? (["comment"] as const) : CAPABILITIES.review.verdicts,
    requestReviewers: access.canWrite,
    ...(access.canUpdateBranch === true ? { updateMethods: CAPABILITIES.updateMethods } : {}),
    // Triage is the one role that labels without writing, which is what triage is for.
    labels: access.canTriage,
  };
}

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
export function gitHubProviderFailure(
  error: GitHubPullRequestCli.GitHubPullRequestCliError,
): PullRequestProviderFailure {
  if (error._tag === "GitHubCliUnavailableError") return { reason: "missing-tool" };
  if (error._tag === "GitHubCliAuthenticationError") return { reason: "unauthenticated" };
  if (error._tag === "GitHubCliRateLimitError") return { reason: "rate-limited" };
  if (error._tag === "SourceControlRateLimitPausedError") {
    return { reason: "rate-limited", retryAt: error.retryAt };
  }
  return { reason: "failed" };
}

/**
 * `gh pr view --json` reports no avatar for anyone, so the ones the GraphQL read collected are
 * applied here by login. An actor already carrying one keeps it.
 *
 * A login GitHub did not answer for falls back to the picture every GitHub install serves at
 * `/<login>.png`. The lookup is one more request per repository and can be refused — a rate
 * limit, a slow host — and a face that comes and goes between two loads of the same page reads
 * as a bug in the page rather than as a request that failed quietly.
 */
function withAvatar(
  actor: PullRequestActor | null,
  avatarsByLogin: ReadonlyMap<string, string>,
  host: string,
): PullRequestActor | null {
  if (actor === null || actor.avatarUrl !== null) return actor;
  const avatarUrl = avatarsByLogin.get(actor.login) ?? loginAvatarUrl(actor.login, host);
  return avatarUrl === null ? actor : { ...actor, avatarUrl };
}

function withWorkflowApprovals(
  checks: ReadonlyArray<PullRequestCheck>,
  runs: ReadonlyArray<GitHubWorkflowRunApproval>,
  unavailable: boolean,
): ReadonlyArray<PullRequestCheck> {
  const representedRunIds = new Set<number>();
  for (const check of checks) {
    if (check.status !== "action-required" || check.url === null) continue;
    const id = check.url.match(/\/actions\/runs\/(\d+)(?:\/|$)/)?.[1];
    if (id !== undefined) representedRunIds.add(Number(id));
  }
  const approvalChecks = runs
    .filter((run) => !representedRunIds.has(run.id))
    .map(
      (run): PullRequestCheck => ({
        name: run.name,
        status: "action-required",
        description: "A maintainer must approve this workflow before it can run.",
        url: run.url,
      }),
    );
  return [
    ...checks,
    ...approvalChecks,
    ...(unavailable
      ? [
          {
            name: "Workflow approval status",
            status: "action-required" as const,
            description: "GitHub could not determine whether workflows are awaiting approval.",
            url: null,
          },
        ]
      : []),
  ];
}

/**
 * Null for anything that is not a plain user login: an app posts as `dependabot[bot]`, which
 * names no page, and a guessed URL that 404s is worse than the initials it would replace.
 */
export function loginAvatarUrl(login: string, host: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,38}$/iu.test(login) ? `https://${host}/${login}.png?size=80` : null;
}

/** True where markdown would render nothing: whitespace, or only HTML comments. */
const rendersEmpty = (body: string): boolean =>
  body.replace(/<!--[\s\S]*?-->/g, "").trim().length === 0;

export const make = Effect.gen(function* () {
  const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

  const repositoryAccessCache = yield* Cache.makeWith(
    (key: string) => {
      const [cwd, repository, host] = JSON.parse(key) as [string, string, string];
      return cli.getRepositoryAccess({ cwd, repository, host });
    },
    {
      capacity: 128,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(10) : Duration.zero),
    },
  );
  const getRepositoryAccess = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
  }) => Cache.get(repositoryAccessCache, JSON.stringify([input.cwd, input.repository, input.host]));

  const fail = (operation: string) => (error: GitHubPullRequestCli.GitHubPullRequestCliError) =>
    new PullRequestProviderError({
      provider: "github",
      operation,
      ...gitHubProviderFailure(error),
      detail: error.detail,
      cause: error,
    });

  const provider: PullRequestProviderApi = {
    kind: "github",
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      cli.getViewerLogin({ cwd: input.cwd }).pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      cli
        .listPullRequests({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
          filters: input.filters,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.flatMap((page) =>
            cli
              .listActorAvatars({
                cwd: input.cwd,
                repository: input.repository,
                host: input.host,
                ids: [...new Set(page.items.flatMap((item) => item.authorId ?? []))],
              })
              // A listing without faces is still a listing, so a failed lookup falls back to
              // the initials rather than taking the rows down with it.
              .pipe(
                Effect.orElseSucceed(() => new Map<string, string>()),
                Effect.map((avatarsByLogin) => ({
                  ...page,
                  items: page.items.map((item) => ({
                    ...item,
                    author: withAvatar(item.author, avatarsByLogin, input.host),
                  })),
                })),
              ),
          ),
        ),

    /**
     * The same listing for a whole host in one search. The avatar lookup the per-repository read
     * needs is not here: a search reports an author's picture itself, so a face costs no request
     * of its own — `withAvatar` still stands behind it for the login GitHub answered nothing for.
     */
    listChangeRequestsAcross: (input) =>
      cli
        .searchPullRequests({
          cwd: input.cwd,
          host: input.host,
          repositories: input.repositories,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
          filters: input.filters,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequestsAcross")),
          Effect.map((batch) => ({
            truncated: batch.truncated,
            items: batch.items.map((item) => ({
              ...item,
              author: withAvatar(item.author, new Map<string, string>(), input.host),
            })),
          })),
        ),

    listChangeRequestStats: (input) =>
      cli
        .listPullRequestStats({
          cwd: input.cwd,
          host: input.host,
          changeRequests: input.changeRequests,
        })
        .pipe(Effect.mapError(fail("listChangeRequestStats"))),

    getChangeRequestSummary: (input) =>
      cli.getPullRequestSummary(input).pipe(Effect.mapError(fail("getChangeRequestSummary"))),

    getChangeRequest: (input) =>
      Effect.all(
        [
          cli.getPullRequestDetail(input).pipe(
            Effect.flatMap((pullRequest) =>
              Effect.all({
                // Only an open pull request can be behind anything worth saying so about, and
                // only one whose head repository is known can be compared at all.
                comparison:
                  pullRequest.state !== "open" || pullRequest.headRepositoryOwner === null
                    ? Effect.succeed(null)
                    : cli
                        .getPullRequestBaseComparison({
                          ...input,
                          headRef: `${pullRequest.headRepositoryOwner}:${pullRequest.headBranch}`,
                        })
                        .pipe(Effect.orElseSucceed(() => null)),
                // GitHub omits a fork workflow that has not been approved from the normal check
                // rollup. Read the action-required runs by head revision so "all passed" cannot
                // be shown while a whole workflow is still waiting to start.
                workflowApprovals:
                  pullRequest.state !== "open" || pullRequest.isCrossRepository !== true
                    ? Effect.succeed({
                        runs: [] as ReadonlyArray<GitHubWorkflowRunApproval>,
                        unavailable: false,
                      })
                    : pullRequest.headSha == null || pullRequest.headRepositoryOwner == null
                      ? Effect.succeed({
                          runs: [] as ReadonlyArray<GitHubWorkflowRunApproval>,
                          unavailable: true,
                        })
                      : cli
                          .listWorkflowRunsRequiringApproval({
                            ...input,
                            headSha: pullRequest.headSha,
                            headBranch: pullRequest.headBranch,
                            headRepositoryOwner: pullRequest.headRepositoryOwner,
                            isCrossRepository: true,
                          })
                          .pipe(
                            Effect.matchEffect({
                              onFailure: (error) =>
                                error._tag === "GitHubCliRateLimitError" ||
                                error._tag === "SourceControlRateLimitPausedError"
                                  ? Effect.fail(error)
                                  : Effect.succeed({
                                      runs: [] as ReadonlyArray<GitHubWorkflowRunApproval>,
                                      unavailable: true,
                                    }),
                              onSuccess: (runs) => Effect.succeed({ runs, unavailable: false }),
                            }),
                          ),
              }).pipe(Effect.map((extra) => ({ pullRequest, ...extra }))),
            ),
          ),
          getRepositoryAccess({
            cwd: input.cwd,
            repository: input.repository,
            host: input.host,
          }),
          // A small permissions query replaces the deeply paginated review-thread walk on the
          // core path. Writes ask again immediately before mutating, so this is presentation.
          cli.getViewerAccess(input),
        ],
        { concurrency: 3 },
      ).pipe(
        Effect.mapError(fail("getChangeRequest")),
        Effect.map(
          ([detail, repository, viewerAccess]): ProviderChangeRequestDetail => ({
            ...detail.pullRequest,
            checks: withWorkflowApprovals(
              detail.pullRequest.checks,
              detail.workflowApprovals.runs,
              detail.workflowApprovals.unavailable,
            ),
            ...(detail.workflowApprovals.unavailable
              ? {}
              : { workflowApprovalsRequired: detail.workflowApprovals.runs.length }),
            reviewers: detail.pullRequest.reviewRequestLogins.map((login) => ({
              login,
              name: null,
              avatarUrl: null,
            })),
            mergeCapabilities: repository.mergeCapabilities,
            viewerPermissions: gitHubViewerPermissions({
              ...viewerAccess,
              canUpdateBranch: detail.comparison?.viewerCanUpdate === true,
            }),
            baseComparison:
              detail.comparison === null || detail.comparison.behindBy === null
                ? "unknown"
                : detail.comparison.behindBy > 0
                  ? "behind"
                  : "up-to-date",
            ...(detail.comparison?.behindBy == null
              ? {}
              : { behindBy: detail.comparison.behindBy }),
          }),
        ),
      ),

    getChangeRequestActivity: (input) =>
      Effect.all(
        [
          cli.getPullRequestActivity(input),
          // Line comments live on review threads, which `gh pr view --json` cannot reach. A
          // GraphQL hiccup degrades to a truncated conversation rather than blanking activity.
          cli.listReviewThreadComments(input).pipe(
            Effect.orElseSucceed(() => ({
              comments: [],
              dismissalsByReviewId: new Map<string, string>(),
              reactions: [],
              reactionsById: new Map<string, ReadonlyArray<PullRequestReaction>>(),
              reviewThreads: [],
              commentCount: 0,
              truncated: true,
              reviewers: [],
              avatarsByLogin: new Map<string, string>(),
              commitStats: new Map<
                string,
                { readonly additions: number; readonly deletions: number }
              >(),
              commits: [],
              viewer: { canUpdate: true, didAuthor: false },
            })),
          ),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(
          ([pullRequest, reviewThreads]): ProviderChangeRequestActivity => ({
            author: withAvatar(pullRequest.author, reviewThreads.avatarsByLogin, input.host),
            reviewers: reviewThreads.reviewers,
            reactions: reviewThreads.reactions,
            commits: (reviewThreads.commits.length > 0
              ? reviewThreads.commits
              : pullRequest.commits
            ).map((commit) => ({
              ...commit,
              ...reviewThreads.commitStats.get(commit.oid),
              authors: commit.authors?.map(
                (author) => withAvatar(author, reviewThreads.avatarsByLogin, input.host) ?? author,
              ),
            })),
            comments: [...pullRequest.comments, ...reviewThreads.comments]
              .map((comment) => ({
                ...comment,
                // GitHub keeps the dismissal reason on the timeline event, not on the review,
                // so a dismissed review with nothing visible of its own reads its words from
                // there. "Visible" and not "empty": bot reviews often carry only an HTML
                // marker comment, which markdown renders as nothing.
                body:
                  comment.kind === "review" &&
                  comment.reviewState?.toUpperCase() === "DISMISSED" &&
                  rendersEmpty(comment.body)
                    ? (reviewThreads.dismissalsByReviewId.get(comment.id) ?? comment.body)
                    : comment.body,
                author: withAvatar(comment.author, reviewThreads.avatarsByLogin, input.host),
                // A comment out of `gh pr view --json` carries none of its own: that read
                // reports no reaction at all, so they arrive from the GraphQL page by node id.
                reactions: comment.reactions ?? reviewThreads.reactionsById.get(comment.id) ?? [],
              }))
              .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
            // `gh pr view --json comments,reviews` follows GitHub's cursors itself, so those two
            // are always whole and only the thread walk can stop short of the host.
            commentCount: pullRequest.comments.length + reviewThreads.commentCount,
            commentsTruncated: reviewThreads.truncated,
            reviewThreads: reviewThreads.reviewThreads.map((thread) => ({
              ...thread,
              comments: thread.comments.map((comment) => ({
                ...comment,
                author: withAvatar(comment.author, reviewThreads.avatarsByLogin, input.host),
              })),
            })),
          }),
        ),
      ),

    getReviewThreadComments: (input) =>
      cli.getReviewThreadComments(input).pipe(Effect.mapError(fail("getReviewThreadComments"))),

    getViewerPermissions: (input) =>
      Effect.all(
        [
          cli.getViewerAccess({ ...input, allowReserve: true }),
          // Whether this viewer may update the branch is only on the comparison, and the
          // comparison only resolves through the head ref the detail carries. A failure here
          // withholds that one action rather than the whole answer, the way the detail path
          // leaves the banner unknown.
          cli.getPullRequestDetail(input).pipe(
            Effect.flatMap((pullRequest) =>
              pullRequest.state !== "open" || pullRequest.headRepositoryOwner === null
                ? Effect.succeed(false)
                : cli
                    .getPullRequestBaseComparison({
                      ...input,
                      headRef: `${pullRequest.headRepositoryOwner}:${pullRequest.headBranch}`,
                      allowReserve: true,
                    })
                    .pipe(Effect.map((comparison) => comparison.viewerCanUpdate === true)),
            ),
            Effect.orElseSucceed(() => false),
          ),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(fail("getViewerPermissions")),
        Effect.map(([access, canUpdateBranch]) =>
          gitHubViewerPermissions({ ...access, canUpdateBranch }),
        ),
      ),

    getDiff: (input) => cli.getPullRequestDiff(input).pipe(Effect.mapError(fail("getDiff"))),

    getDiffFileContents: (input) =>
      cli.getPullRequestDiffFileContents(input).pipe(Effect.mapError(fail("getDiffFileContents"))),

    listReviewerCandidates: (input) =>
      cli.listReviewerCandidates(input).pipe(Effect.mapError(fail("listReviewerCandidates"))),

    setReviewerRequest: (input) =>
      cli
        .setReviewerRequest({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          reviewers: input.reviewers,
          requested: input.requested,
        })
        .pipe(Effect.mapError(fail("setReviewerRequest"))),

    listLabelCandidates: (input) =>
      cli.listLabelCandidates(input).pipe(Effect.mapError(fail("listLabelCandidates"))),

    setLabels: (input) =>
      cli
        .setLabels({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          labels: input.labels,
          applied: input.applied,
        })
        .pipe(Effect.mapError(fail("setLabels"))),

    runAction: (input) =>
      cli
        .runPullRequestAction({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
          ...(input.updateMethod === undefined ? {} : { updateMethod: input.updateMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),

    updateChangeRequest: (input) =>
      cli
        .updatePullRequest({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        })
        .pipe(Effect.mapError(fail("updateChangeRequest"))),

    comment: (input) => cli.commentOnPullRequest(input).pipe(Effect.mapError(fail("comment"))),

    updateComment: (input) =>
      cli
        .updateComment({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          commentId: input.commentId,
          kind: input.kind,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("updateComment"))),

    submitReview: (input) => cli.submitReview(input).pipe(Effect.mapError(fail("submitReview"))),

    replyToThread: (input) =>
      cli
        .replyToReviewThread({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          threadId: input.threadId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("replyToThread"))),

    setReaction: (input) =>
      cli
        .setReaction({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
          content: input.content,
          reacted: input.reacted,
        })
        .pipe(Effect.mapError(fail("setReaction"))),

    setThreadResolution: (input) =>
      cli
        .setReviewThreadResolution({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          threadId: input.threadId,
          resolved: input.resolved,
        })
        .pipe(Effect.mapError(fail("setThreadResolution"))),
  };

  return provider;
});
