import { removeAgentCredits } from "@t3tools/source-control-core/server/mergeMessage";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type {
  PullRequestActor,
  PullRequestCapabilities,
  PullRequestReaction,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";

import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import type { GitLabDiffRefs, GitLabMergeRequestListState } from "./gitLabMergeRequestJson.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderBatchedChangeRequest,
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
  deleteBranch: true,
  // GitLab has no merge-target-into-source operation.
  updateMethods: ["rebase"],
  search: true,
  reactions: true,
  mentions: true,
  referenceSigils: ["#", "!"],
  // GitLab's viewed marks live in browser-local storage.
  viewedFiles: "environment",
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true, searchCandidates: true },
  labels: true,
  edit: { changeRequest: true, comment: true, maintainerEdits: true },
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
  readonly viewerCanEditMaintainerEdits?: boolean | undefined;
  readonly viewerCanDeleteBranch?: boolean;
  readonly viewerCanEditLabels?: boolean | undefined;
}): PullRequestViewerPermissions {
  return {
    actions: CAPABILITIES.actions.filter((action) =>
      action === "delete-branch"
        ? input.viewerCanDeleteBranch === true
        : !MERGE_ACTIONS.has(action) || input.viewerCanMerge,
    ),
    comment: true,
    resolve: true,
    verdicts: CAPABILITIES.review.verdicts,
    requestReviewers: true,
    maintainerEdits: input.viewerCanEditMaintainerEdits === true,
    labels: input.viewerCanEditLabels === true,
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
/** A host's GitLab version only changes on upgrade. */
const GRAPHQL_LIST_SUPPORT_TTL = Duration.hours(1);
/**
 * gitlab.com cuts GraphQL requests off at about 20 s: 25 projects of 20 rows took 8.5-15 s and
 * sometimes timed out, while 10 took about 6 s and 5 about 2-4 s.
 */
const PROJECTS_PER_READ = 10;
const ROWS_PER_PROJECT = 20;
/** A whole chunk of the service's projects at once. */
const PROJECT_READ_CONCURRENCY = 4;

/** The checkout whose `glab` reads a host's version; any checkout of a project on it answers. */
class VersionReadCheckout extends Context.Service<VersionReadCheckout, { readonly cwd: string }>()(
  "@t3tools/source-control-gitlab/server/GitLabPullRequestProvider/VersionReadCheckout",
) {}

function gitLabProviderFailure(
  error: GitLabPullRequestCli.GitLabPullRequestCliError,
): PullRequestProviderFailure {
  if (error._tag === "GitLabCliUnavailableError") return { reason: "missing-tool" };
  if (error._tag === "GitLabCliAuthenticationError") return { reason: "unauthenticated" };
  if (error._tag === "GitLabCliRateLimitError") return { reason: "rate-limited" };
  if (error._tag === "GitLabMergeRequestNotFoundError") return { reason: "not-found" };
  return { reason: "failed" };
}

// GitLab keeps a thread on the latest diff while its line survives, so older refs mean the code moved.
const isOutdated = (
  thread: GitLabDiffRefs | undefined,
  current: GitLabDiffRefs | undefined,
): boolean =>
  thread !== undefined &&
  current !== undefined &&
  (thread.baseSha !== current.baseSha ||
    thread.startSha !== current.startSha ||
    thread.headSha !== current.headSha);

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
  const graphqlListSupport = yield* Cache.makeWith(
    (host: string) =>
      VersionReadCheckout.use(({ cwd }) =>
        // A host whose version read fails keeps failing it; remember REST rather than ask each poll.
        cli.supportsGraphqlList({ cwd, host }).pipe(
          Effect.catchIf(
            (cause) =>
              cause._tag !== "GitLabCliUnavailableError" &&
              cause._tag !== "GitLabCliAuthenticationError" &&
              cause._tag !== "GitLabCliRateLimitError",
            () => Effect.succeed(false),
          ),
        ),
      ),
    {
      capacity: READ_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? GRAPHQL_LIST_SUPPORT_TTL : Duration.zero),
      requireServicesAt: "lookup",
    },
  );
  const supportsGraphqlList = (input: { readonly cwd: string; readonly host: string }) =>
    Cache.get(graphqlListSupport, input.host).pipe(
      Effect.provideService(VersionReadCheckout, { cwd: input.cwd }),
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

  // The rows were already read, so even a rate limit only leaves their states unknown.
  const listStates = (input: Parameters<typeof cli.getListStates>[0]) =>
    cli.getListStates(input).pipe(
      Effect.catch((error) =>
        Effect.logWarning("GitLab merge request approval and pipeline read failed", {
          repository: input.repository,
          reason: error._tag,
        }).pipe(Effect.as<ReadonlyMap<number, GitLabMergeRequestListState>>(new Map())),
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
    mergeMessageRewrite: removeAgentCredits,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,

    getViewer: (input) => cli.getViewerUsername(input).pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      supportsGraphqlList(input).pipe(
        // Without a known version the REST list still answers, only with fewer filters.
        Effect.orElseSucceed(() => false),
        Effect.flatMap((graphql) =>
          cli.listMergeRequests({
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
            graphql,
          }),
        ),
        Effect.flatMap(({ listStates: carried, ...batch }) =>
          (carried === undefined
            ? listStates({
                cwd: input.cwd,
                host: input.host,
                repository: input.repository,
                numbers: batch.items.map((item) => item.number),
              })
            : Effect.succeed(carried)
          ).pipe(
            Effect.map((states) => ({
              ...batch,
              items: batch.items.map((item) => withListState(item, states)),
              continues: true,
            })),
          ),
        ),
        Effect.mapError(fail("listChangeRequests")),
      ),

    listChangeRequestsAcross: Effect.fn("GitLabPullRequestProvider.listChangeRequestsAcross")(
      function* (input) {
        const failed = fail("listChangeRequestsAcross");
        const graphql = yield* supportsGraphqlList(input).pipe(Effect.mapError(failed));
        if (!graphql) {
          return yield* new PullRequestProviderError({
            provider: SourceControlProviderKind.make("gitlab"),
            operation: "listChangeRequestsAcross",
            reason: "failed",
            detail: "This GitLab version lists one project at a time.",
          });
        }
        const boundarySecond =
          input.cursor === undefined ? undefined : wholeSecond(input.cursor.updatedBefore);
        const updatedBefore =
          boundarySecond === undefined
            ? undefined
            : DateTime.formatIso(DateTime.add(boundarySecond, { seconds: 1 }));
        const chunks: Array<ReadonlyArray<string>> = [];
        for (let start = 0; start < input.repositories.length; start += PROJECTS_PER_READ) {
          chunks.push(input.repositories.slice(start, start + PROJECTS_PER_READ));
        }
        const pages = (yield* Effect.forEach(
          chunks,
          (repositories) =>
            cli
              .listMergeRequestsInProjects({
                cwd: input.cwd,
                host: input.host,
                repositories,
                state: input.state,
                involvement: input.involvement,
                viewer: input.viewer,
                first: Math.min(input.limit, ROWS_PER_PROJECT),
                updatedBefore,
                query: input.query,
                filters: input.filters,
              })
              .pipe(
                // The caller reads a project left out on its own, so one slow read loses no rows.
                Effect.catchIf(
                  (cause) =>
                    cause._tag !== "GitLabCliUnavailableError" &&
                    cause._tag !== "GitLabCliAuthenticationError",
                  (cause) =>
                    Effect.logWarning("GitLab merge request list across projects failed", {
                      projects: repositories.length,
                      reason: cause._tag,
                    }).pipe(Effect.as([])),
                ),
              ),
          { concurrency: PROJECT_READ_CONCURRENCY },
        ).pipe(Effect.mapError(failed)))
          .flat()
          // A project whose whole read sits in the boundary second would hand the same rows back
          // on every continuation; leaving it out sends it to the caller's offset-paged read.
          .filter(({ page }) => {
            const oldest = page.items.at(-1)?.updatedAt;
            return (
              boundarySecond === undefined ||
              !page.hasNextPage ||
              (oldest !== undefined &&
                Option.exists(DateTime.make(oldest), (time) =>
                  DateTime.isLessThan(time, boundarySecond),
                ))
            );
          });

        // A project with more rows than it sent may have some newer than another project's
        // oldest, so rows older than the newest such cut are left to the next page.
        let cut: string | null = null;
        for (const { page } of pages) {
          if (!page.hasNextPage) continue;
          const oldest = page.items.at(-1)?.updatedAt;
          if (oldest !== undefined && (cut === null || oldest > cut)) cut = oldest;
        }
        const complete = pages
          .flatMap(({ repository, page }) =>
            page.items.map((item): ProviderBatchedChangeRequest => ({
              ...withListState(item, page.states),
              repository,
            })),
          )
          .filter((item) => cut === null || item.updatedAt >= cut)
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        const answered = new Set(pages.map(({ repository }) => repository.trim().toLowerCase()));
        return {
          items: complete.slice(0, input.limit),
          truncated: complete.length > input.limit || pages.some(({ page }) => page.hasNextPage),
          unresolved: input.repositories.filter(
            (repository) => !answered.has(repository.trim().toLowerCase()),
          ),
        };
      },
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
      cli
        .getMergeRequestDetail({ ...input, maintainerEdits: false })
        .pipe(Effect.mapError(fail("getChangeRequestPreview"))),

    getChangeRequestSummary: (input) =>
      Effect.all(
        [
          mergeRequestWithStats(
            input,
            cli.getMergeRequestDetail({ ...input, maintainerEdits: false }),
          ),
          listStates({
            cwd: input.cwd,
            host: input.host,
            repository: input.repository,
            numbers: [input.number],
          }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([mergeRequest, states]) => withListState(mergeRequest, states)),
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
          recoverRead(cli.listDiscussions(input), {
            threads: [],
            diffRefsByThreadId: new Map(),
            overviewFindingIds: [],
            truncated: true,
          }),
          recoverRead(cli.listReactions(input), {
            reactions: [] as ReadonlyArray<PullRequestReaction>,
            reactionsByNoteId: new Map<string, ReadonlyArray<PullRequestReaction>>(),
            editedAtByNoteId: new Map<string, string>(),
            botLogins: new Set<string>(),
          }),
          // Fresh, not the cached detail: refs from before a push would mark every thread outdated.
          recoverRead(
            cli.getMergeRequestDetail({ ...input, downstreamChecks: false }).pipe(
              Effect.map((mergeRequest) => ({
                url: mergeRequest.url,
                diffRefs: mergeRequest.diffRefs,
              })),
            ),
            null,
          ),
        ],
        { concurrency: 5 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(
          ([notes, commits, discussions, awards, detail]): ProviderChangeRequestActivity => {
            const noteUrl = (id: string) => (detail === null ? null : `${detail.url}#note_${id}`);
            const findingIds = new Set(discussions.overviewFindingIds);
            const edited = (id: string) => {
              const editedAt = awards.editedAtByNoteId.get(id);
              return editedAt === undefined ? {} : { editedAt };
            };
            const botLogins = new Set([...awards.botLogins].map((login) => login.toLowerCase()));
            const withBotFlag = (author: PullRequestActor | null) =>
              author !== null && botLogins.has(author.login.toLowerCase())
                ? { ...author, isBot: true }
                : author;
            return {
              reactions: awards.reactions,
              comments: notes.comments.map((comment) => ({
                ...comment,
                ...(findingIds.has(comment.id) ? { kind: "review-comment" as const } : {}),
                ...edited(comment.id),
                author: withBotFlag(comment.author),
                url: noteUrl(comment.id),
                reactions: awards.reactionsByNoteId.get(comment.id) ?? [],
              })),
              commentCount: notes.comments.length,
              commentsTruncated: notes.truncated || discussions.truncated,
              reviewThreads: discussions.threads.map((thread) => ({
                ...thread,
                isOutdated: isOutdated(
                  discussions.diffRefsByThreadId.get(thread.id),
                  detail?.diffRefs,
                ),
                comments: thread.comments.map((comment) => ({
                  ...comment,
                  ...edited(comment.id),
                  author: withBotFlag(comment.author),
                  url: noteUrl(comment.id),
                  reactions: awards.reactionsByNoteId.get(comment.id) ?? [],
                })),
              })),
              commits,
            };
          },
        ),
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
          query: input.query,
        })
        .pipe(Effect.mapError(fail("listReviewerCandidates"))),

    listLabelCandidates: (input) =>
      cli
        .listLabelCandidates({
          cwd: input.cwd,
          host: input.host,
          repository: input.repository,
          number: input.number,
        })
        .pipe(Effect.mapError(fail("listLabelCandidates"))),

    setLabels: writing((input) =>
      cli
        .setLabels({
          cwd: input.cwd,
          host: input.host,
          repository: input.repository,
          number: input.number,
          labels: input.labels,
          applied: input.applied,
        })
        .pipe(Effect.mapError(fail("setLabels"))),
    ),

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

    searchRepositoryReferences: (input) =>
      cli
        .searchProjectReferences({
          cwd: input.cwd,
          host: input.host,
          repository: input.repository,
          search: input.query,
          sigil: input.sigil,
        })
        .pipe(Effect.mapError(fail("searchRepositoryReferences"))),

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
          ...(input.removeAgentCreditsOnMerge === true ? { removeAgentCreditsOnMerge: true } : {}),
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
          ...(input.maintainerCanModify === undefined
            ? {}
            : { allowCollaboration: input.maintainerCanModify }),
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

/**
 * GitLab reports `updatedAt` to the second but compares its stored fraction, so a continuation
 * reads up to the end of the boundary second. The caller drops rows it already has there.
 */
function wholeSecond(updatedAt: string): DateTime.Utc | undefined {
  return Option.getOrUndefined(
    Option.map(DateTime.make(updatedAt), (time) => DateTime.startOf(time, "second")),
  );
}

function withListState<Item extends { readonly number: number }>(
  item: Item,
  states: ReadonlyMap<number, GitLabMergeRequestListState>,
): Item & Partial<GitLabMergeRequestListState> {
  const state = states.get(item.number);
  return state === undefined ? item : { ...item, ...state };
}
