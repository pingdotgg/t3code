import * as Effect from "effect/Effect";
import type {
  PullRequestActor,
  PullRequestCapabilities,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";

import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import type { GitHubViewerAccess } from "./gitHubPullRequestJson.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: ["merge", "ready", "draft", "close", "reopen"],
  mergeMethods: ["merge", "squash", "rebase"],
  search: true,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
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
      ...(access.canWrite ? (["merge"] as const) : []),
      ...(access.canUpdate ? (["ready", "draft", "close", "reopen"] as const) : []),
    ],
    comment: true,
    resolve: access.canWrite || access.didAuthor,
    // Anyone may review a pull request they can see, except their own: GitHub refuses an author's
    // approval and their request for changes ("Can not approve your own pull request"), and
    // leaves them commenting, which is what an author has to say about their own change anyway.
    verdicts: access.didAuthor ? (["comment"] as const) : CAPABILITIES.review.verdicts,
    requestReviewers: access.canWrite,
  };
}

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
function reasonFor(
  error: GitHubPullRequestCli.GitHubPullRequestCliError,
): PullRequestProviderError["reason"] {
  if (error._tag === "GitHubCliUnavailableError") return "missing-tool";
  if (error._tag === "GitHubCliAuthenticationError") return "unauthenticated";
  return "failed";
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

/**
 * Null for anything that is not a plain user login: an app posts as `dependabot[bot]`, which
 * names no page, and a guessed URL that 404s is worse than the initials it would replace.
 */
export function loginAvatarUrl(login: string, host: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,38}$/iu.test(login) ? `https://${host}/${login}.png?size=80` : null;
}

export const make = Effect.gen(function* () {
  const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;

  const fail = (operation: string) => (error: GitHubPullRequestCli.GitHubPullRequestCliError) =>
    new PullRequestProviderError({
      provider: "github",
      operation,
      reason: reasonFor(error),
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

    getChangeRequest: (input) =>
      Effect.all(
        [
          cli.getPullRequestDetail(input),
          cli.getRepositoryAccess({
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
          ([pullRequest, repository, viewerAccess]): ProviderChangeRequestDetail => ({
            ...pullRequest,
            reviewers: pullRequest.reviewRequestLogins.map((login) => ({
              login,
              name: null,
              avatarUrl: null,
            })),
            mergeCapabilities: repository.mergeCapabilities,
            viewerPermissions: gitHubViewerPermissions(viewerAccess),
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
                author: withAvatar(comment.author, reviewThreads.avatarsByLogin, input.host),
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

    getViewerPermissions: (input) =>
      cli
        .getViewerAccess(input)
        .pipe(Effect.mapError(fail("getViewerPermissions")), Effect.map(gitHubViewerPermissions)),

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

    runAction: (input) =>
      cli
        .runPullRequestAction({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),

    comment: (input) => cli.commentOnPullRequest(input).pipe(Effect.mapError(fail("comment"))),

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
