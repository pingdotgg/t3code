import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type {
  PullRequestCapabilities,
  PullRequestReaction,
  PullRequestReviewDecision,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";

import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import { definition } from "../shared/definition.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  // GitLab has no merge-target-into-source operation.
  updateMethods: ["rebase"],
  search: true,
  reactions: true,
  // GitLab's viewed marks live in browser-local storage.
  viewedFiles: "environment",
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    // GitLab has no requested-changes verdict.
    verdicts: ["comment", "approve"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
};

const UNAVAILABLE_REQUIREMENT = {
  missing:
    "GitLab CLI (`glab`) is required to browse change requests on this host. Install it from https://gitlab.com/gitlab-org/cli and reload.",
  unauthenticated: "GitLab CLI is not authenticated. Run `glab auth login` and retry.",
};

/**
 * The actions `user.can_merge` answers for. Rebasing writes to the source branch rather than to
 * the target, so it is not literally the same permission — but GitLab reports nothing narrower,
 * and someone it will not let land this change has no business rewriting its branch either.
 */
const MERGE_ACTIONS: ReadonlySet<string> = new Set([
  "merge",
  "update-branch",
  "enable-auto-merge",
  "disable-auto-merge",
]);

/** Authors may close/reopen/change draft state regardless of role; REST omits authorship. */
export function gitLabViewerPermissions(input: {
  readonly viewerCanMerge: boolean;
}): PullRequestViewerPermissions {
  return {
    actions: CAPABILITIES.actions.filter(
      (action) => !MERGE_ACTIONS.has(action) || input.viewerCanMerge,
    ),
    comment: true,
    resolve: true,
    verdicts: CAPABILITIES.review.verdicts,
    requestReviewers: true,
    ...(input.viewerCanMerge ? { updateMethods: CAPABILITIES.updateMethods } : {}),
  };
}

/**
 * One page view asks for the detail and then its checks within a second, and the poll that
 * follows asks again. A minute keeps those to one `glab` call without hiding a pipeline for long;
 * a refresh or a finished turn drops it sooner through `forgetChangeRequestReads`.
 */
const MERGE_REQUEST_DETAIL_TTL = Duration.minutes(1);
/** A project's merge methods change in its settings, which nobody does between page views. */
const PROJECT_MERGE_CAPABILITIES_TTL = Duration.minutes(15);
const READ_CACHE_CAPACITY = 256;

function gitLabProviderFailure(
  error: GitLabPullRequestCli.GitLabPullRequestCliError,
): PullRequestProviderFailure {
  if (error._tag === "GitLabCliUnavailableError") return { reason: "missing-tool" };
  if (error._tag === "GitLabCliAuthenticationError") return { reason: "unauthenticated" };
  if (error._tag === "GitLabCliRateLimitError") return { reason: "rate-limited" };
  if (error._tag === "GitLabMergeRequestNotFoundError") return { reason: "not-found" };
  return { reason: "failed" };
}

export const make = Effect.gen(function* () {
  const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

  // Keyed on the checkout as well: `glab` picks the host and the account to answer as from the
  // checkout's remote and config, so two checkouts may read the same project as different people.
  const mergeRequestDetails = yield* Cache.makeWith(
    (key: string) => {
      const [cwd, repository, number, host] = JSON.parse(key) as [string, string, number, string];
      return cli.getMergeRequestDetail({ cwd, repository, number, host });
    },
    {
      capacity: READ_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? MERGE_REQUEST_DETAIL_TTL : Duration.zero),
    },
  );
  const projectMergeCapabilities = yield* Cache.makeWith(
    (key: string) => {
      const [cwd, repository, host] = JSON.parse(key) as [string, string, string];
      return cli.getProjectMergeCapabilities({ cwd, repository, host });
    },
    {
      capacity: READ_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? PROJECT_MERGE_CAPABILITIES_TTL : Duration.zero),
    },
  );

  const detailKey = (input: {
    readonly cwd: string;
    readonly host: string;
    readonly repository: string;
    readonly number: number;
  }) => JSON.stringify([input.cwd, input.repository, input.number, input.host]);
  const mergeRequestDetail = (input: {
    readonly cwd: string;
    readonly host: string;
    readonly repository: string;
    readonly number: number;
  }) => Cache.get(mergeRequestDetails, detailKey(input));

  // Dropped on both sides, as the service does with its own reads: a read that starts while the
  // write is in flight must not outlive it.
  const writing =
    <
      I extends {
        readonly cwd: string;
        readonly host: string;
        readonly repository: string;
        readonly number: number;
      },
      A,
      E,
    >(
      write: (input: I) => Effect.Effect<A, E>,
    ) =>
    (input: I): Effect.Effect<A, E> => {
      const invalidate = Cache.invalidate(mergeRequestDetails, detailKey(input));
      return invalidate.pipe(Effect.andThen(write(input)), Effect.ensuring(invalidate));
    };

  const fail = (operation: string) => (error: GitLabPullRequestCli.GitLabPullRequestCliError) =>
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("gitlab"),
      operation,
      ...gitLabProviderFailure(error),
      detail: error.detail,
      cause: error,
    });

  // Optional endpoints may lose part of the activity, but an unusable CLI or account must
  // reach the caller so it can report authentication failures and pause a throttled host.
  const recoverRead = <A>(
    read: Effect.Effect<A, GitLabPullRequestCli.GitLabPullRequestCliError>,
    fallback: A,
  ) =>
    read.pipe(
      Effect.catch((error) => {
        const { reason } = gitLabProviderFailure(error);
        return reason === "rate-limited" ||
          reason === "unauthenticated" ||
          reason === "missing-tool"
          ? Effect.fail(error)
          : Effect.succeed(fallback);
      }),
    );

  // The rows were already read, so even a rate limit only leaves their decision unknown.
  const reviewDecisions = (input: Parameters<typeof cli.getReviewDecisions>[0]) =>
    cli.getReviewDecisions(input).pipe(
      Effect.catch((error) =>
        Effect.logWarning("GitLab merge request approval read failed", {
          repository: input.repository,
          reason: error._tag,
        }).pipe(Effect.as<ReadonlyMap<number, PullRequestReviewDecision | null>>(new Map())),
      ),
    );

  // REST omits line counts; the CLI recovers optional stats failures per batch.
  const mergeRequestWithStats = (
    input: {
      readonly cwd: string;
      readonly host: string;
      readonly repository: string;
      readonly number: number;
    },
    detail = cli.getMergeRequestDetail(input),
  ) =>
    Effect.all(
      [
        detail,
        cli.listMergeRequestStats({ cwd: input.cwd, host: input.host, changeRequests: [input] }),
      ],
      {
        concurrency: 2,
      },
    ).pipe(
      Effect.map(([mergeRequest, [stat]]) =>
        stat === undefined
          ? mergeRequest
          : { ...mergeRequest, additions: stat.additions, deletions: stat.deletions },
      ),
    );

  const provider: PullRequestProviderApi = {
    kind: SourceControlProviderKind.make("gitlab"),
    capabilities: CAPABILITIES,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,

    getViewer: (input) => cli.getViewerUsername(input).pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      cli
        .listMergeRequests({
          cwd: input.cwd,
          host: input.host,
          repository: input.repository,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
          filters: input.filters,
        })
        .pipe(
          Effect.flatMap((batch) =>
            reviewDecisions({
              cwd: input.cwd,
              host: input.host,
              repository: input.repository,
              numbers: batch.items.map((item) => item.number),
            }).pipe(
              Effect.map((decisions) => ({
                ...batch,
                items: batch.items.map((item) => withReviewDecision(item, decisions)),
                continues: true,
              })),
            ),
          ),
          Effect.mapError(fail("listChangeRequests")),
        ),

    getFileStats: (input) =>
      cli.getMergeRequestFileStats(input).pipe(Effect.mapError(fail("getFileStats"))),

    listChangeRequestStats: (input) =>
      cli.listMergeRequestStats(input).pipe(Effect.mapError(fail("listChangeRequestStats"))),

    getChangeRequestChecks: (input) =>
      mergeRequestDetail(input).pipe(
        Effect.map(({ state, checks }) => ({ state, checks })),
        Effect.mapError(fail("getChangeRequestChecks")),
      ),

    // Merge settings only affect the detail panel's actions.
    getChangeRequestPreview: (input) =>
      cli.getMergeRequestDetail(input).pipe(Effect.mapError(fail("getChangeRequestPreview"))),

    getChangeRequestSummary: (input) =>
      Effect.all(
        [
          mergeRequestWithStats(input),
          reviewDecisions({
            cwd: input.cwd,
            host: input.host,
            repository: input.repository,
            numbers: [input.number],
          }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([mergeRequest, decisions]) => withReviewDecision(mergeRequest, decisions)),
        Effect.mapError(fail("getChangeRequestSummary")),
      ),

    getChangeRequest: (input) =>
      Effect.all(
        [
          mergeRequestWithStats(input, mergeRequestDetail(input)),
          Cache.get(
            projectMergeCapabilities,
            JSON.stringify([input.cwd, input.repository, input.host]),
          ),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(fail("getChangeRequest")),
        Effect.map(([mergeRequest, mergeCapabilities]): ProviderChangeRequestDetail => ({
          ...mergeRequest,
          mergeCapabilities,
          viewerPermissions: gitLabViewerPermissions(mergeRequest),
          // Missing divergence counts mean unknown, not up to date.
          baseComparison:
            mergeRequest.divergedCommits === undefined
              ? "unknown"
              : mergeRequest.divergedCommits > 0
                ? "behind"
                : "up-to-date",
          ...(mergeRequest.divergedCommits === undefined
            ? {}
            : { behindBy: mergeRequest.divergedCommits }),
        })),
      ),

    getChangeRequestActivity: (input) =>
      Effect.all(
        [
          recoverRead(cli.listNotes(input), { comments: [], truncated: true }),
          recoverRead(cli.listCommits(input), []),
          recoverRead(cli.listDiscussions(input), { threads: [], truncated: true }),
          recoverRead(cli.listReactions(input), {
            reactions: [] as ReadonlyArray<PullRequestReaction>,
            reactionsByNoteId: new Map<string, ReadonlyArray<PullRequestReaction>>(),
          }),
        ],
        { concurrency: 4 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(([notes, commits, discussions, awards]): ProviderChangeRequestActivity => ({
          reactions: awards.reactions,
          comments: notes.comments.map((comment) => ({
            ...comment,
            reactions: awards.reactionsByNoteId.get(comment.id) ?? [],
          })),
          commentCount: notes.comments.length,
          commentsTruncated: notes.truncated || discussions.truncated,
          reviewThreads: discussions.threads.map((thread) => ({
            ...thread,
            comments: thread.comments.map((comment) => ({
              ...comment,
              reactions: awards.reactionsByNoteId.get(comment.id) ?? [],
            })),
          })),
          commits,
        })),
      ),

    // Straight from the host, never the shared read: this is what a write is refused or let
    // through on, and access granted or withdrawn within the minute must count.
    getViewerPermissions: (input) =>
      cli
        .getMergeRequestDetail({ ...input, downstreamChecks: false })
        .pipe(Effect.mapError(fail("getViewerPermissions")), Effect.map(gitLabViewerPermissions)),

    forgetChangeRequestReads: (scope) =>
      Cache.keys(mergeRequestDetails).pipe(
        Effect.flatMap((keys) =>
          Effect.forEach(
            Array.from(keys).filter((key) => {
              if (scope === undefined) return true;
              const [, repository, number] = JSON.parse(key) as [string, string, number];
              return (
                repository.toLowerCase() === scope.repository.toLowerCase() &&
                (scope.number === undefined || number === scope.number)
              );
            }),
            (key) => Cache.invalidate(mergeRequestDetails, key),
            { discard: true },
          ),
        ),
      ),

    getDiff: (input) => cli.getMergeRequestDiff(input).pipe(Effect.mapError(fail("getDiff"))),

    getDiffFileContents: (input) =>
      cli.getMergeRequestDiffFileContents(input).pipe(Effect.mapError(fail("getDiffFileContents"))),

    getFileRevisions: (input) =>
      cli.getFileRevisions(input).pipe(
        Effect.mapError(fail("getFileRevisions")),
        Effect.map((revisions) => ({ revisions })),
      ),

    // MR reviewers are users; groups belong to approval rules.
    listReviewerCandidates: (input) =>
      cli
        .listReviewerCandidates({
          cwd: input.cwd,
          host: input.host,
          repository: input.repository,
          number: input.number,
        })
        .pipe(Effect.mapError(fail("listReviewerCandidates"))),

    listRepositoryLabels: (input) =>
      cli
        .listProjectLabels({
          cwd: input.cwd,
          host: input.host,
          repository: input.repository,
          search: input.query,
        })
        .pipe(Effect.mapError(fail("listRepositoryLabels"))),

    searchRepositoryAuthors: (input) =>
      cli
        .listProjectUsers({
          cwd: input.cwd,
          host: input.host,
          repository: input.repository,
          search: input.query,
        })
        .pipe(Effect.mapError(fail("searchRepositoryAuthors"))),

    setReviewerRequest: writing((input) =>
      cli
        .setReviewerRequest({
          cwd: input.cwd,
          host: input.host,
          repository: input.repository,
          number: input.number,
          reviewers: input.reviewers,
          requested: input.requested,
        })
        .pipe(Effect.mapError(fail("setReviewerRequest"))),
    ),

    runAction: writing((input) =>
      cli
        .runMergeRequestAction({
          cwd: input.cwd,
          host: input.host,
          repository: input.repository,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),
    ),

    updateChangeRequest: writing((input) =>
      cli
        .updateMergeRequest({
          cwd: input.cwd,
          host: input.host,
          repository: input.repository,
          number: input.number,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { description: input.body }),
        })
        .pipe(Effect.mapError(fail("updateChangeRequest"))),
    ),

    comment: writing((input) =>
      cli.commentOnMergeRequest(input).pipe(Effect.mapError(fail("comment"))),
    ),

    updateComment: writing((input) =>
      cli
        .updateNote({
          cwd: input.cwd,
          host: input.host,
          repository: input.repository,
          number: input.number,
          noteId: input.commentId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("updateComment"))),
    ),

    submitReview: writing((input) =>
      cli.submitReview(input).pipe(Effect.mapError(fail("submitReview"))),
    ),

    replyToThread: writing((input) =>
      cli
        .replyToDiscussion({
          cwd: input.cwd,
          host: input.host,
          repository: input.repository,
          number: input.number,
          discussionId: input.threadId,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("replyToThread"))),
    ),

    setReaction: writing((input) =>
      cli
        .setReaction({
          cwd: input.cwd,
          host: input.host,
          repository: input.repository,
          number: input.number,
          ...(input.subjectId === undefined ? {} : { noteId: input.subjectId }),
          content: input.content,
          reacted: input.reacted,
        })
        .pipe(Effect.mapError(fail("setReaction"))),
    ),

    setThreadResolution: writing((input) =>
      cli
        .setDiscussionResolution({
          cwd: input.cwd,
          host: input.host,
          repository: input.repository,
          number: input.number,
          discussionId: input.threadId,
          resolved: input.resolved,
        })
        .pipe(Effect.mapError(fail("setThreadResolution"))),
    ),
  };

  return provider;
});

function withReviewDecision<Item extends { readonly number: number }>(
  item: Item,
  decisions: ReadonlyMap<number, PullRequestReviewDecision | null>,
): Item & { readonly reviewDecision?: PullRequestReviewDecision | null } {
  const reviewDecision = decisions.get(item.number);
  return reviewDecision === undefined ? item : { ...item, reviewDecision };
}
