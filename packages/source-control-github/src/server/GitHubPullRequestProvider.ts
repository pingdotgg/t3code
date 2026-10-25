import { SourceControlProviderKind } from "@t3tools/contracts";
import { removeAgentCredits } from "@t3tools/source-control-core/server/mergeMessage";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Hash from "effect/Hash";
import * as Effect from "effect/Effect";
import type {
  PullRequestActor,
  PullRequestCapabilities,
  PullRequestCheck,
  PullRequestReaction,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";

import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
  type ProviderRepositoryRef,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import type { GitHubCredentialSource } from "./GitHubCredentials.ts";
import type {
  GitHubRepositoryAccess,
  GitHubViewerAccess,
  GitHubWorkflowRunApproval,
} from "./gitHubPullRequestJson.ts";
import { definition } from "../shared/definition.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  deleteBranch: true,
  updateMethods: ["merge", "rebase"],
  search: true,
  reactions: true,
  viewedFiles: "host",
  review: {
    inlineComment: true,
    rangeComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true, maintainerEdits: true },
  stacks: true,
  stackActions: true,
  labels: true,
  // Statuses and check runs land on the head commit itself and are read whole, so an empty list
  // after a push is CI that never started rather than a read that saw nothing.
  checksAlwaysReport: true,
};

const UNAVAILABLE_REQUIREMENT = {
  missing:
    "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI (https://cli.github.com/) and run `gh auth login`.",
  unauthenticated:
    "GitHub has no working credential for this host. Run `gh auth login`, or check the account and hosts in Settings → Source Control.",
};

/**
 * Asking somebody else for a review needs write access, which is the one thing here an author
 * cannot do on their own pull request: GitHub shows an outside contributor the reviewer control
 * and refuses the request behind it.
 */
export function gitHubViewerPermissions(
  access: GitHubViewerAccess & Pick<GitHubRepositoryAccess, "autoMergeAllowed">,
): PullRequestViewerPermissions {
  return {
    ...(access.canWrite ? { stackRebase: true } : {}),
    actions: [
      ...(access.canDeleteBranch === true ? (["delete-branch"] as const) : []),
      // Keep disabling available if the repository has since turned auto-merge off.
      ...(access.canWrite
        ? ([
            "merge",
            ...(access.autoMergeAllowed && access.canMergeNow !== true
              ? (["enable-auto-merge"] as const)
              : []),
            "disable-auto-merge",
            "revert",
            "approve-workflows",
          ] as const)
        : []),
      ...(access.canUpdate ? (["ready", "draft", "close", "reopen"] as const) : []),
      ...(access.canUpdateBranch === true ? (["update-branch"] as const) : []),
    ],
    comment: true,
    resolve: access.canWrite || access.didAuthor,
    // Authors may comment on their own PRs, but GitHub rejects their approvals and change requests.
    verdicts: access.didAuthor ? (["comment"] as const) : CAPABILITIES.review.verdicts,
    requestReviewers: access.canWrite,
    ...(access.canUpdateBranch === true ? { updateMethods: CAPABILITIES.updateMethods } : {}),
    labels: access.canTriage,
  };
}

function gitHubProviderFailure(
  error: GitHubPullRequestApi.GitHubPullRequestApiError,
): PullRequestProviderFailure {
  switch (error._tag) {
    case "GitHubCliMissingError":
      return { reason: "missing-tool" };
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
    case "GitHubApiAuthenticationError":
      return { reason: "unauthenticated" };
    case "GitHubApiRateLimitError":
      return {
        reason: "rate-limited",
        ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
      };
    case "SourceControlRateLimitPausedError":
      return { reason: "rate-limited", retryAt: error.retryAt };
    case "GitHubApiNotFoundError":
      return error.credential === undefined || error.credential === "app"
        ? { reason: "not-found" }
        : { reason: "not-found", accessHint: REPOSITORY_ACCESS_HINTS[error.credential] };
    default:
      return { reason: "failed" };
  }
}

const REPOSITORY_ACCESS_HINTS: Record<Exclude<GitHubCredentialSource, "app">, string> = {
  settings:
    "GitHub did not return it to the token saved in Settings, which overrides the server's environment token (such as GH_TOKEN) and the gh login. Give that token access to this repository, or change it in Settings → Source Control.",
  env: "GitHub did not return it to the token in the server's environment, which overrides the gh login. Give that token access to this repository, or unset it.",
  gh: "GitHub did not return it to the gh login. Check that its account can see this repository, or save a token that can in Settings → Source Control.",
};

function withAvatar(
  actor: PullRequestActor | null,
  avatarsByLogin: ReadonlyMap<string, string>,
  host: string,
  botLogins?: ReadonlySet<string>,
): PullRequestActor | null {
  if (actor === null) return actor;
  if (botLogins?.has(actor.login)) actor = { ...actor, isBot: true };
  if (actor.avatarUrl !== null) return actor;
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
    .map((run): PullRequestCheck => ({
      name: run.name,
      status: "action-required",
      description: "A maintainer must approve this workflow before it can run.",
      url: run.url,
    }));
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

/** App logins have no profile page; guessed avatar URLs 404. */
export function loginAvatarUrl(login: string, host: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,38}$/iu.test(login) ? `https://${host}/${login}.png?size=80` : null;
}

// Whether search covers a repository changes only when the repository is renamed or moved.
const SEARCH_COVERAGE_TTL = Duration.hours(1);
const SEARCH_COVERAGE_CAPACITY = 4096;
const SEARCH_COVERAGE_CONCURRENCY = 4;

/**
 * Whether GitHub search covers a repository. `cwd` only says where to ask, so equality ignores
 * it and `lookup`, and every checkout of a repository shares one answer.
 */
class SearchCoverage {
  readonly key: string;
  readonly lookup: Effect.Effect<boolean, GitHubPullRequestApi.GitHubPullRequestApiError>;

  constructor(
    host: string,
    repository: string,
    lookup: Effect.Effect<boolean, GitHubPullRequestApi.GitHubPullRequestApiError>,
  ) {
    this.key = `${host.toLowerCase()}\n${repository.trim().toLowerCase()}`;
    this.lookup = lookup;
  }

  [Equal.symbol](that: unknown): boolean {
    return that instanceof SearchCoverage && that.key === this.key;
  }
  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

const rendersEmpty = (body: string): boolean =>
  body.replace(/<!--[\s\S]*?-->/g, "").trim().length === 0;

export const make = Effect.gen(function* () {
  const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

  // GitHub does not index every repository for search: a renamed one answers for its old name
  // with silence rather than with an error. Where search has any pull request for a repository it
  // covers it, so its silence on a page is a real empty answer; any other the caller reads on its
  // own. A failed check is not kept.
  const searchCoverage = yield* Cache.makeWith((request: SearchCoverage) => request.lookup, {
    capacity: SEARCH_COVERAGE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? SEARCH_COVERAGE_TTL : Duration.zero),
  });
  const coverageOf = (
    input: Parameters<NonNullable<PullRequestProviderApi["listChangeRequestsAcross"]>>[0],
    repository: string,
  ) =>
    new SearchCoverage(
      input.host,
      repository,
      Effect.suspend(() =>
        cli.searchPullRequests({
          cwd: input.cwd,
          host: input.host,
          repositories: [repository],
          state: "all",
          involvement: "all",
          viewer: input.viewer,
          limit: 1,
        }),
      ).pipe(Effect.map((batch) => batch.items.length > 0)),
    );
  const unresolvedBySearch = Effect.fn("GitHubPullRequestProvider.unresolvedBySearch")(function* (
    input: Parameters<NonNullable<PullRequestProviderApi["listChangeRequestsAcross"]>>[0],
    batch: GitHubPullRequestApi.GitHubPullRequestSearchBatch,
  ) {
    // A repository a page has rows for is covered without asking.
    yield* Effect.forEach(
      batch.items,
      (item) => Cache.set(searchCoverage, coverageOf(input, item.repository), true),
      { discard: true },
    );
    const answered = new Set(batch.items.map((item) => item.repository.trim().toLowerCase()));
    const silent = input.repositories.filter(
      (repository) => !answered.has(repository.trim().toLowerCase()),
    );
    // A truncated first slice can be silent about a covered repository whose rows are just
    // older than the cut, so it vouches for none. Past the first slice silence from a covered
    // repository means its rows are older rather than absent.
    if (input.cursor === undefined && batch.truncated) return silent;
    return yield* Effect.filter(
      silent,
      (repository) =>
        Cache.get(searchCoverage, coverageOf(input, repository)).pipe(
          Effect.map((covered) => !covered),
          Effect.orElseSucceed(() => true),
        ),
      { concurrency: SEARCH_COVERAGE_CONCURRENCY },
    );
  });

  const fail = (operation: string) => (error: GitHubPullRequestApi.GitHubPullRequestApiError) =>
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("github"),
      operation,
      ...gitHubProviderFailure(error),
      detail: error.message,
      cause: error,
    });

  const readChecks = (input: ProviderRepositoryRef & { readonly number: number }) =>
    cli.getPullRequestDetail(input).pipe(
      Effect.flatMap((pullRequest) =>
        (pullRequest.state !== "open" || pullRequest.isCrossRepository !== true
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
                      error._tag === "GitHubApiRateLimitError" ||
                      error._tag === "SourceControlRateLimitPausedError"
                        ? Effect.fail(error)
                        : Effect.succeed({
                            runs: [] as ReadonlyArray<GitHubWorkflowRunApproval>,
                            unavailable: true,
                          }),
                    onSuccess: (runs) => Effect.succeed({ runs, unavailable: false }),
                  }),
                )
        ).pipe(
          Effect.map((workflowApprovals) => ({
            ...pullRequest,
            author: withAvatar(pullRequest.author, new Map(), input.host),
            checks: withWorkflowApprovals(
              pullRequest.checks,
              workflowApprovals.runs,
              workflowApprovals.unavailable,
            ),
            ...(workflowApprovals.unavailable
              ? {}
              : { workflowApprovalsRequired: workflowApprovals.runs.length }),
          })),
        ),
      ),
    );

  const provider: PullRequestProviderApi = {
    kind: SourceControlProviderKind.make("github"),
    capabilities: CAPABILITIES,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,
    readsPublicHostWithoutCheckout: true,
    mergeMessageRewrite: removeAgentCredits,
    getRoutingIdentity: (input) =>
      cli.getRoutingIdentity(input).pipe(Effect.mapError(fail("routeIdentity"))),
    withVerifiedCredential: (input, use) =>
      cli
        .withVerifiedCredential(input, (identity) => use(identity).pipe(Effect.result))
        .pipe(Effect.mapError(fail("routeIdentity")), Effect.flatMap(Effect.fromResult)),

    getViewer: (input) =>
      cli
        .getViewerLogin({ cwd: input.cwd, host: input.host ?? "github.com" })
        .pipe(Effect.mapError(fail("getViewer"))),

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
          Effect.map((page) => ({
            ...page,
            items: page.items.map((item) => ({
              ...item,
              author: withAvatar(item.author, new Map<string, string>(), input.host),
            })),
          })),
        ),

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
          Effect.flatMap((batch) =>
            Effect.map(unresolvedBySearch(input, batch), (unresolved) => ({
              truncated: batch.truncated,
              items: batch.items.map((item) => ({
                ...item,
                author: withAvatar(item.author, new Map<string, string>(), input.host),
              })),
              unresolved,
            })),
          ),
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
      cli.getPullRequestSummary(input).pipe(
        Effect.map((summary) => ({
          ...summary,
          ...(summary.author === undefined
            ? {}
            : { author: withAvatar(summary.author, new Map(), input.host) }),
        })),
        Effect.mapError(fail("getChangeRequestSummary")),
      ),

    getChangeRequestStack: (input) =>
      cli.getPullRequestStack(input).pipe(Effect.mapError(fail("getChangeRequestStack"))),

    getChangeRequestWatchFingerprint: (input) =>
      cli
        .getPullRequestWatchFingerprint(input)
        .pipe(Effect.mapError(fail("getChangeRequestWatchFingerprint"))),

    getChangeRequestPreview: (input) =>
      cli.getPullRequestPreview(input).pipe(Effect.mapError(fail("getChangeRequestPreview"))),

    getChangeRequestChecks: (input) =>
      cli.revalidateChecks(input, readChecks(input)).pipe(
        Effect.map(({ state, checks }) => ({ state, checks })),
        Effect.mapError(fail("getChangeRequestChecks")),
      ),

    getChangeRequest: (input) =>
      readChecks(input).pipe(
        Effect.map((pullRequest): ProviderChangeRequestDetail => ({
          ...pullRequest,
          author: withAvatar(pullRequest.author, new Map<string, string>(), input.host),
          reviewers: [
            ...pullRequest.reviewRequestLogins.map((login) => ({
              login,
              name: null,
              avatarUrl: null,
            })),
            ...pullRequest.reviewRequestTeams,
          ],
          mergeCapabilities: pullRequest.viewerAccess.mergeCapabilities,
          viewerPermissions: {
            ...gitHubViewerPermissions({
              ...pullRequest.viewerAccess,
              canUpdateBranch: pullRequest.comparison?.viewerCanUpdate === true,
            }),
            maintainerEdits: pullRequest.canEditMaintainerEdits,
          },
          baseComparison:
            pullRequest.comparison === null || pullRequest.comparison.behindBy === null
              ? "unknown"
              : pullRequest.comparison.behindBy > 0
                ? "behind"
                : "up-to-date",
          ...(pullRequest.comparison?.behindBy == null
            ? {}
            : { behindBy: pullRequest.comparison.behindBy }),
        })),
        Effect.mapError(fail("getChangeRequest")),
      ),

    getChangeRequestActivity: (input) =>
      Effect.all(
        [
          cli.getPullRequestActivity(input),
          cli.listReviewThreadComments(input).pipe(
            Effect.orElseSucceed(() => ({
              comments: [],
              dismissalsByReviewId: new Map<string, string>(),
              reactions: [],
              reactionsById: new Map<string, ReadonlyArray<PullRequestReaction>>(),
              editedAtById: new Map<string, string>(),
              reviewThreads: [],
              commentCount: 0,
              truncated: true,
              reviewThreadsTruncated: true,
              reviewers: [],
              avatarsByLogin: new Map<string, string>(),
              botLogins: new Set<string>(),
              commits: [],
              viewer: { canUpdate: true, didAuthor: false },
            })),
          ),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(([pullRequest, reviewThreads]): ProviderChangeRequestActivity => {
          const commitStats = new Map(
            pullRequest.commits.map(({ oid, additions, deletions }) => [
              oid,
              additions === undefined ? {} : { additions, deletions },
            ]),
          );
          return {
            author: withAvatar(
              pullRequest.author,
              reviewThreads.avatarsByLogin,
              input.host,
              reviewThreads.botLogins,
            ),
            reviewers: reviewThreads.reviewers,
            reactions: reviewThreads.reactions,
            commits: (reviewThreads.commits.length > 0
              ? reviewThreads.commits
              : pullRequest.commits
            ).map((commit) => ({
              ...commit,
              ...commitStats.get(commit.oid),
              authors: commit.authors?.map(
                (author) =>
                  withAvatar(
                    author,
                    reviewThreads.avatarsByLogin,
                    input.host,
                    reviewThreads.botLogins,
                  ) ?? author,
              ),
            })),
            comments: [...pullRequest.comments, ...reviewThreads.comments]
              .map((comment) => ({
                ...comment,
                // Dismissal reasons live on timeline events; HTML-only bot reviews need that fallback too.
                body:
                  comment.kind === "review" &&
                  comment.reviewState?.toUpperCase() === "DISMISSED" &&
                  rendersEmpty(comment.body)
                    ? (reviewThreads.dismissalsByReviewId.get(comment.id) ?? comment.body)
                    : comment.body,
                author: withAvatar(
                  comment.author,
                  reviewThreads.avatarsByLogin,
                  input.host,
                  reviewThreads.botLogins,
                ),
                reactions: comment.reactions ?? reviewThreads.reactionsById.get(comment.id) ?? [],
                editedAt: reviewThreads.editedAtById.get(comment.id) ?? comment.editedAt ?? null,
              }))
              .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
            commentCount: pullRequest.comments.length + reviewThreads.commentCount,
            commentsTruncated: reviewThreads.truncated,
            reviewThreadsTruncated: reviewThreads.reviewThreadsTruncated,
            reviewThreads: reviewThreads.reviewThreads.map((thread) => ({
              ...thread,
              comments: thread.comments.map((comment) => ({
                ...comment,
                author: withAvatar(
                  comment.author,
                  reviewThreads.avatarsByLogin,
                  input.host,
                  reviewThreads.botLogins,
                ),
              })),
            })),
          };
        }),
      ),

    getReviewThreadComments: (input) =>
      cli.getReviewThreadComments(input).pipe(Effect.mapError(fail("getReviewThreadComments"))),

    getViewerPermissions: (input) => {
      const lightAccess = cli
        .getViewerAccess({ ...input, allowReserve: true })
        .pipe(Effect.map((access) => gitHubViewerPermissions(access)));
      if (input.includeUpdateBranch === false) {
        return lightAccess.pipe(Effect.mapError(fail("getViewerPermissions")));
      }
      return cli.getPullRequestDetail(input).pipe(
        Effect.provideService(SourceControlRateLimit.Interactive, true),
        Effect.map((pullRequest) =>
          gitHubViewerPermissions({
            ...pullRequest.viewerAccess,
            canUpdateBranch:
              pullRequest.state === "open" && pullRequest.comparison?.viewerCanUpdate === true,
          }),
        ),
        Effect.catchIf(
          (error) =>
            error._tag !== "GitHubApiRateLimitError" &&
            error._tag !== "SourceControlRateLimitPausedError",
          () => lightAccess,
        ),
        Effect.mapError(fail("getViewerPermissions")),
      );
    },

    getDiff: (input) => cli.getPullRequestDiff(input).pipe(Effect.mapError(fail("getDiff"))),

    getDiffFileContents: (input) =>
      cli.getPullRequestDiffFileContents(input).pipe(Effect.mapError(fail("getDiffFileContents"))),

    getFilesViewed: (input) =>
      cli.getPullRequestFilesViewed(input).pipe(Effect.mapError(fail("getFilesViewed"))),

    getFileStats: (input) =>
      cli.getPullRequestFileStats(input).pipe(Effect.mapError(fail("getFileStats"))),
    setFilesViewed: (input) =>
      cli.setPullRequestFilesViewed(input).pipe(Effect.mapError(fail("setFilesViewed"))),

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

    listRepositoryLabels: (input) =>
      cli.listRepositoryLabels(input).pipe(Effect.mapError(fail("listRepositoryLabels"))),

    searchRepositoryAuthors: (input) =>
      cli.searchRepositoryAuthors(input).pipe(Effect.mapError(fail("searchRepositoryAuthors"))),

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
          ...(input.removeAgentCreditsOnMerge === true ? { removeAgentCreditsOnMerge: true } : {}),
          ...(input.stackNumber === undefined ? {} : { stackNumber: input.stackNumber }),
          ...(input.expectedStackHeads === undefined
            ? {}
            : { expectedStackHeads: input.expectedStackHeads }),
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
          ...(input.updateMethod === undefined ? {} : { updateMethod: input.updateMethod }),
        })
        .pipe(Effect.mapError(fail("runAction"))),

    updateChangeRequest: (input) =>
      cli
        .updatePullRequest({
          ...(input.maintainerCanModify === undefined
            ? {}
            : { maintainerCanModify: input.maintainerCanModify }),
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
