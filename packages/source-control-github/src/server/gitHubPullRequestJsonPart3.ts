import { trimOptionalString as trimmed } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { GraphQL } from "effect/graphql";
import type {
  PullRequestStackMembership,
  PullRequestActor,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestComment,
  PullRequestCommit,
  PullRequestMergeability,
  PullRequestReaction,
  PullRequestReviewDecision,
  PullRequestReviewThread,
  PullRequestState,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import type {
  PullRequestSummaryRepositoryPullRequestPullRequest as SummarizedPullRequest,
  PullRequestWatchFingerprintRepositoryPullRequestPullRequest as WatchedPullRequest,
} from "./pullRequestBatches.graphql.ts";
import {
  PageInfo as ListingPageInfo,
  PullRequestList,
  PullRequestRow,
  PullRequestSearch,
} from "./pullRequestListings.graphql.ts";
import type {
  CheckContext,
  PullRequestActivity,
  PullRequestCommitStats,
  PullRequestCheckContexts,
  PullRequestCore,
  PullRequestHeads,
} from "./pullRequestReads.graphql.ts";
import type { ActorFields, CheckFields, GitHubPullRequestDetail, GitHubPullRequestHead, GitHubPullRequestListItem, GitHubWorkflowRunApproval, ListItemFields, PageInfoFields, ReviewRequestFields } from "./gitHubPullRequestJsonPart2.ts";
import type { GitHubBaseComparison, GitHubRepositoryAccess, GitHubViewerAccess } from "./gitHubPullRequestJson.ts";
import { RawPullRequestFileSchema, RawWorkflowRunsSchema, hasTeamReviewRequest, isReviewVerdict, nextCursorOf, nodesOf, rollupChecksState, toActor, toChecks, toCommitActor, toLabels, toMergeMethod, toMergeability, toPullRequestViewerFields, toRequestedTeam, toReviewDecisionWithReviews, toReviewRequestLogins, toState } from "./gitHubPullRequestJsonPart2.ts";
import { IMMEDIATELY_MERGEABLE, toCanTriage, toCanWrite } from "./gitHubPullRequestJson.ts";

interface RemarkFields {
  readonly id: string;
  readonly lastEditedAt: string | null;
  readonly author: ActorFields | null;
  readonly body: string;
  readonly url: string | null;
}

function toComments(raw: {
  readonly comments: ReadonlyArray<RemarkFields & { readonly createdAt: string }>;
  readonly reviews: ReadonlyArray<
    RemarkFields & { readonly state: string; readonly submittedAt: string | null }
  >;
}): ReadonlyArray<PullRequestComment> {
  const issueComments = raw.comments.map((comment): PullRequestComment => ({
    id: comment.id,
    kind: "issue-comment",
    author: toActor(comment.author),
    body: comment.body ?? "",
    createdAt: comment.createdAt,
    editedAt: comment.lastEditedAt ?? null,
    url: trimmed(comment.url),
    path: null,
    reviewState: null,
  }));
  // Bodiless COMMENTED reviews only hold line comments read separately.
  const reviews = raw.reviews.flatMap((review): ReadonlyArray<PullRequestComment> => {
    const submittedAt = trimmed(review.submittedAt);
    const reviewState = trimmed(review.state);
    if (
      submittedAt === null ||
      ((review.body ?? "").trim().length === 0 && !isReviewVerdict(reviewState))
    ) {
      return [];
    }
    return [
      {
        id: review.id,
        kind: "review",
        author: toActor(review.author),
        body: review.body ?? "",
        createdAt: submittedAt,
        editedAt: review.lastEditedAt ?? null,
        url: trimmed(review.url),
        path: null,
        reviewState,
      },
    ];
  });
  return [...issueComments, ...reviews].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function toCommits(
  commits: ReadonlyArray<{
    readonly oid: string;
    readonly messageHeadline: string;
    readonly committedDate: string;
    readonly authors: ReadonlyArray<Parameters<typeof toCommitActor>[0]>;
  }>,
): ReadonlyArray<PullRequestCommit> {
  return commits.map((commit) => ({
    oid: commit.oid,
    messageHeadline: commit.messageHeadline,
    committedDate: commit.committedDate,
    authors: commit.authors.flatMap((author) => toCommitActor(author) ?? []),
  }));
}

function toListItem(raw: ListItemFields): GitHubPullRequestListItem {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: toActor(raw.author),
    headBranch: raw.headRefName,
    baseBranch: raw.baseRefName,
    state: toState(raw),
    isDraft: raw.isDraft ?? false,
    mergeability: toMergeability(raw.mergeable),
    reviewDecision: toReviewDecisionWithReviews(raw.reviewDecision, raw.latestReviews),
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    reviewRequestLogins: toReviewRequestLogins(raw.reviewRequests),
    hasTeamReviewRequest: hasTeamReviewRequest(raw.reviewRequests),
    labels: toLabels(raw.labels),
    checksState: rollupChecksState(raw.statusCheckRollup),
  };
}

interface DetailFields extends ListItemFields {
  readonly isCrossRepository?: boolean | undefined;
  readonly headRepositoryOwner?: { readonly login: string } | null | undefined;
  readonly headRefOid?: string | null | undefined;
  readonly body?: string | undefined;
  readonly changedFiles?: number | undefined;
  readonly closedAt?: string | null | undefined;
  readonly autoMergeRequest?:
    | { readonly mergeMethod?: string | null | undefined }
    | null
    | undefined;
}

function toDetail(raw: DetailFields): GitHubPullRequestDetail {
  const autoMergeMethod = toMergeMethod(raw.autoMergeRequest?.mergeMethod);
  return {
    ...toListItem(raw),
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    headRepositoryOwner: trimmed(raw.headRepositoryOwner?.login),
    headSha: trimmed(raw.headRefOid),
    body: raw.body ?? "",
    changedFiles: raw.changedFiles ?? 0,
    mergedAt: trimmed(raw.mergedAt),
    closedAt: trimmed(raw.closedAt),
    checks: toChecks(raw.statusCheckRollup),
    ...(raw.autoMergeRequest === undefined
      ? {}
      : { autoMergeEnabled: raw.autoMergeRequest !== null }),
    ...(autoMergeMethod === undefined ? {} : { autoMergeMethod }),
  };
}

export const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));

const decodeWorkflowRuns = decodeJsonResult(RawWorkflowRunsSchema);

export const decodeFileEntry = Schema.decodeUnknownExit(RawPullRequestFileSchema);

const decodeRow = Schema.decodeUnknownExit(PullRequestRow);

/** Decode rows individually so one invalid node cannot blank the entire listing. */
const LenientRows = Schema.Struct({
  pageInfo: ListingPageInfo,
  nodes: Schema.NullOr(Schema.Array(Schema.Unknown)),
});

export const LenientPullRequestSearch = GraphQL.query(PullRequestSearch.name, {
  document: PullRequestSearch.document,
  variables: PullRequestSearch.variables,
  result: Schema.Struct({ search: LenientRows }),
});

export const LenientPullRequestList = GraphQL.query(PullRequestList.name, {
  document: PullRequestList.document,
  variables: PullRequestList.variables,
  result: Schema.Struct({
    repository: Schema.NullOr(Schema.Struct({ pullRequests: LenientRows })),
  }),
});

export type DecodeFailure = Cause.Cause<Schema.SchemaError>;

/** Count skipped invalid rows in rawCount to avoid ending pagination early. */
export function toPullRequestRows(
  connection:
    | { readonly pageInfo: PageInfoFields; readonly nodes: ReadonlyArray<unknown> | null }
    | null
    | undefined,
): {
  readonly rows: ReadonlyArray<{
    readonly item: GitHubPullRequestListItem;
    readonly repository: string | null;
  }>;
  readonly rawCount: number;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
} {
  const nodes = connection?.nodes ?? [];
  return {
    rows: nodes.flatMap((entry) => toRow(entry) ?? []),
    rawCount: nodes.length,
    hasNextPage: connection?.pageInfo.hasNextPage === true,
    endCursor: nextCursorOf(connection?.pageInfo),
  };
}

function toRow(
  entry: unknown,
): { readonly item: GitHubPullRequestListItem; readonly repository: string | null } | null {
  const decodedNode = decodeRow(entry);
  if (!Exit.isSuccess(decodedNode)) return null;
  const node = decodedNode.value;
  const stack = toStackMembership(node);
  const reviewRequests = nodesOf(node.reviewRequests).flatMap(
    (request): ReadonlyArray<ReviewRequestFields> => {
      const reviewer = request.requestedReviewer;
      if (reviewer === null) return [];
      const login = "login" in reviewer ? trimmed(reviewer.login) : null;
      if (login !== null) return [{ login }];
      const slug = "slug" in reviewer ? trimmed(reviewer.slug) : null;
      return slug === null ? [] : [{ slug }];
    },
  );
  return {
    item: {
      ...toListItem({
        ...node,
        latestReviews: nodesOf(node.latestReviews),
        reviewRequests,
        labels: nodesOf(node.labels),
        statusCheckRollup: rollupStates(node.commits),
      }),
      ...(stack === undefined ? {} : { stack }),
    },
    repository: trimmed(node.repository.nameWithOwner),
  };
}

function rollupStates(commits: {
  readonly nodes: ReadonlyArray<{
    readonly commit: { readonly statusCheckRollup: { readonly state: string } | null };
  } | null> | null;
}): ReadonlyArray<CheckFields> {
  return nodesOf(commits).flatMap((commitNode) => {
    const state = trimmed(commitNode.commit.statusCheckRollup?.state);
    return state === null ? [] : [{ state }];
  });
}

export interface GitHubPullRequestSearchItem extends GitHubPullRequestListItem {
  readonly repository: string;
}

export function toStackMembership(raw: {
  readonly stack?: {
    readonly number: number;
    readonly size: number;
    readonly baseRefName: string;
  } | null;
  readonly stackEntry?: { readonly position: number } | null;
}): PullRequestStackMembership | undefined {
  return raw.stack && raw.stackEntry
    ? {
        number: raw.stack.number,
        size: raw.stack.size,
        base: raw.stack.baseRefName,
        position: raw.stackEntry.position,
      }
    : undefined;
}

const REPOSITORY_PART = /^[A-Za-z0-9._-]+$/;

/** Invalid selectors can fail an entire aliased request, not just their own lookup. */
export function pullRequestLookup(changeRequest: {
  readonly repository: string;
  readonly number: number;
}): { readonly owner: string; readonly name: string; readonly number: number } | null {
  const [owner, name, ...rest] = changeRequest.repository.trim().split("/");
  if (rest.length > 0 || owner === undefined || name === undefined) return null;
  if (!REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(name)) return null;
  const { number } = changeRequest;
  return Number.isSafeInteger(number) && number > 0 && number <= 2_147_483_647
    ? { owner, name, number }
    : null;
}

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly closedAt: string | null;
  readonly mergedAt: string | null;
  readonly updatedAt: string;
  readonly author: PullRequestActor | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly reviewDecision: PullRequestReviewDecision | null;
  readonly checksState: PullRequestChecksState | null;
  readonly mergeability: PullRequestMergeability;
  /** Null means no stack; absent means not requested. */
  readonly stack?: PullRequestStackMembership | null;
}

export function toPullRequestSummary(pr: SummarizedPullRequest): GitHubPullRequestSummary {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headBranch: pr.headRefName,
    baseBranch: pr.baseRefName,
    state: toState(pr),
    isDraft: pr.isDraft,
    closedAt: trimmed(pr.closedAt),
    mergedAt: trimmed(pr.mergedAt),
    updatedAt: pr.updatedAt,
    author: toActor(pr.author),
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    reviewDecision: toReviewDecisionWithReviews(pr.reviewDecision, nodesOf(pr.latestReviews)),
    checksState: rollupChecksState(rollupStates(pr.commits)),
    mergeability: toMergeability(pr.mergeable),
    ...(pr.stack === undefined ? {} : { stack: toStackMembership(pr) ?? null }),
  };
}

export interface GitHubPullRequestWatchFingerprint {
  readonly status: string;
  readonly remarks: string;
}

type EditedConnection = WatchedPullRequest["comments"] | WatchedPullRequest["reviews"];

type StateCounts = ReadonlyArray<{ readonly state: string; readonly count: number }> | null;

const newestEdit = (connection: EditedConnection) =>
  (connection?.nodes ?? []).reduce(
    (newest, node) =>
      node?.lastEditedAt != null && node.lastEditedAt > newest ? node.lastEditedAt : newest,
    "",
  );

const stateCounts = (counts: StateCounts) =>
  (counts ?? [])
    .filter(({ count }) => count > 0)
    .map(({ state, count }) => `${state}:${count}`)
    .toSorted()
    .join(",");

export function toPullRequestWatchFingerprint(
  pr: WatchedPullRequest,
): GitHubPullRequestWatchFingerprint {
  const contexts = pr.commits.nodes?.[0]?.commit.statusCheckRollup?.contexts;
  return {
    status: [
      pr.state,
      pr.mergeable,
      pr.headRefOid,
      stateCounts(contexts?.checkRunCountsByState ?? null),
      stateCounts(contexts?.statusContextCountsByState ?? null),
    ].join(" "),
    remarks: [
      pr.comments.totalCount,
      newestEdit(pr.comments),
      pr.reviews?.totalCount ?? 0,
      newestEdit(pr.reviews),
      pr.reviewThreads.totalCount,
    ].join(" "),
  };
}

export interface GitHubPullRequestCore extends GitHubPullRequestDetail {
  readonly maintainerCanModify: boolean;
  readonly canEditMaintainerEdits: boolean;
  readonly reviewRequestTeams: ReadonlyArray<PullRequestActor>;
  readonly viewerAccess: GitHubViewerAccess & GitHubRepositoryAccess;
  readonly comparison: GitHubBaseComparison | null;
  readonly checksTruncated: boolean;
}

type CoreRequestedReviewer = NonNullable<
  NonNullable<
    NonNullable<NonNullable<PullRequestCore.Result["repository"]>["pullRequest"]>["reviewRequests"]
  >["nodes"]
>[number];

export function toPullRequestCore(result: PullRequestCore.Result): GitHubPullRequestCore | null {
  const repository = result.repository;
  const pr = repository?.pullRequest;
  if (repository == null || pr == null) return null;
  const contexts = nodesOf(pr.commits)[0]?.commit.statusCheckRollup?.contexts;
  return {
    reviewRequestTeams: nodesOf(pr.reviewRequests).flatMap(
      ({ requestedReviewer }) => toRequestedTeam(requestedReviewer) ?? [],
    ),
    ...toDetail({
      ...pr,
      latestReviews: [],
      reviewRequests: nodesOf(pr.reviewRequests).flatMap(
        ({ requestedReviewer }: NonNullable<CoreRequestedReviewer>) =>
          requestedReviewer === null
            ? []
            : [
                {
                  login: "login" in requestedReviewer ? requestedReviewer.login : null,
                  slug: "slug" in requestedReviewer ? requestedReviewer.slug : null,
                  name:
                    "teamName" in requestedReviewer
                      ? requestedReviewer.teamName
                      : "name" in requestedReviewer
                        ? requestedReviewer.name
                        : null,
                },
              ],
      ),
      labels: nodesOf(pr.labels),
      statusCheckRollup: toCheckContexts(nodesOf(contexts)),
    }),
    headRepositoryNameWithOwner: trimmed(pr.headRepository?.nameWithOwner),
    maintainerCanModify: pr.maintainerCanModify,
    canEditMaintainerEdits:
      pr.state === "OPEN" &&
      pr.isCrossRepository &&
      pr.viewerDidAuthor &&
      pr.headRepositoryOwner?.__typename === "User" &&
      pr.headRepository !== null &&
      pr.headRef !== null,
    viewerAccess: {
      canWrite: toCanWrite(repository.viewerPermission),
      canDeleteBranch: toCanWrite(pr.headRepository?.viewerPermission) && pr.headRef !== null,
      canTriage: toCanTriage(repository.viewerPermission),
      ...toPullRequestViewerFields(pr),
      canMergeNow: IMMEDIATELY_MERGEABLE.has(pr.mergeStateStatus),
      mergeCapabilities: {
        merge: repository.mergeCommitAllowed,
        squash: repository.squashMergeAllowed,
        rebase: repository.rebaseMergeAllowed,
      },
      autoMergeAllowed: repository.autoMergeAllowed,
    },
    comparison:
      pr.state !== "OPEN" || pr.baseRef?.compare == null
        ? null
        : {
            behindBy: pr.baseRef.compare.behindBy,
            viewerCanUpdate: pr.viewerCanUpdateBranch,
          },
    checksTruncated: contexts?.pageInfo.hasNextPage === true,
  };
}

export interface GitHubWorkflowRunPage {
  readonly runs: ReadonlyArray<GitHubWorkflowRunApproval>;
  readonly rawCount: number;
}

export function decodeWorkflowRunsJson(
  raw: string,
): Result.Result<GitHubWorkflowRunPage, DecodeFailure> {
  const decoded = decodeWorkflowRuns(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  return Result.succeed({
    runs: decoded.success.workflow_runs.map((run) => ({
      id: run.id,
      name: trimmed(run.name) ?? `Workflow run ${run.id}`,
      url: trimmed(run.html_url),
    })),
    rawCount: decoded.success.workflow_runs.length,
  });
}

export function toPullRequestHeads(result: PullRequestHeads.Result): {
  readonly heads: ReadonlyArray<GitHubPullRequestHead>;
  readonly nextCursor: string | null;
} {
  const connection = result.repository?.pullRequests;
  return {
    heads: nodesOf(connection).map((pullRequest) => ({
      number: pullRequest.number,
      headSha: pullRequest.headRefOid,
      isCrossRepository: pullRequest.isCrossRepository,
      headRepositoryOwner: trimmed(pullRequest.headRepositoryOwner?.login),
    })),
    nextCursor: nextCursorOf(connection?.pageInfo),
  };
}

export interface GitHubPullRequestActivityPage {
  readonly nonMergeCommitIds: ReadonlyArray<string>;
  readonly author?: PullRequestActor | null;
  readonly commits?: ReadonlyArray<PullRequestCommit>;
  readonly remarks: ReadonlyArray<PullRequestComment>;
  readonly nextCommentsCursor: string | null;
  readonly nextReviewsCursor: string | null;
}

export function toPullRequestActivityPage(
  result: PullRequestActivity.Result,
): GitHubPullRequestActivityPage | null {
  const pr = result.repository?.pullRequest;
  if (pr == null) return null;
  return {
    nonMergeCommitIds: nodesOf(pr.commits).flatMap(({ commit }) =>
      commit.parents.totalCount > 1 ? [] : [commit.id],
    ),
    ...(pr.author === undefined ? {} : { author: toActor(pr.author) }),
    ...(pr.commits === undefined
      ? {}
      : {
          commits: toCommits(
            nodesOf(pr.commits).map(({ commit }) => ({
              ...commit,
              authors: nodesOf(commit.authors).map((author) => ({
                ...author,
                login: author.user?.login ?? null,
              })),
            })),
          ),
        }),
    remarks: toComments({ comments: nodesOf(pr.comments), reviews: nodesOf(pr.reviews) }),
    nextCommentsCursor: nextCursorOf(pr.comments?.pageInfo),
    nextReviewsCursor: nextCursorOf(pr.reviews?.pageInfo),
  };
}

export function toPullRequestCommitStats(result: PullRequestCommitStats.Result) {
  return new Map(
    (result.nodes ?? []).flatMap((commit) =>
      commit?.__typename === "Commit"
        ? [
            [
              commit.oid,
              {
                additions: Math.max(0, commit.additions),
                deletions: Math.max(0, commit.deletions),
              },
            ] as const,
          ]
        : [],
    ),
  );
}

/** A check context as the rollup reports it; opaque outside this module. */
export type GitHubCheckContext = CheckFields;

function toCheckContexts(nodes: ReadonlyArray<CheckContext>): ReadonlyArray<GitHubCheckContext> {
  return nodes.map((check) =>
    check.__typename === "CheckRun"
      ? { ...check, workflowName: check.checkSuite.workflowRun?.workflow.name ?? null }
      : check,
  );
}

export function toPullRequestCheckContextsPage(result: PullRequestCheckContexts.Result): {
  readonly headSha: string;
  readonly contexts: ReadonlyArray<GitHubCheckContext>;
  readonly nextCursor: string | null;
} | null {
  const pr = result.repository?.pullRequest;
  if (pr == null) return null;
  const contexts = nodesOf(pr.commits)[0]?.commit.statusCheckRollup?.contexts;
  return {
    headSha: pr.headRefOid,
    contexts: toCheckContexts(nodesOf(contexts)),
    nextCursor: nextCursorOf(contexts?.pageInfo),
  };
}

export function pullRequestChecksFromContexts(contexts: ReadonlyArray<GitHubCheckContext>): {
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly checksState: PullRequestChecksState | null;
} {
  return { checks: toChecks(contexts), checksState: rollupChecksState(contexts) };
}

export interface GitHubReviewThreadComments {
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly dismissalsByReviewId: ReadonlyMap<string, string>;
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>;
  readonly commentCount: number;
  readonly truncated: boolean;
  readonly reviewThreadsTruncated: boolean;
  readonly reactions: ReadonlyArray<PullRequestReaction>;
  readonly reactionsById: ReadonlyMap<string, ReadonlyArray<PullRequestReaction>>;
  readonly editedAtById: ReadonlyMap<string, string>;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly avatarsByLogin: ReadonlyMap<string, string>;
  readonly botLogins: ReadonlySet<string>;
  /**
   * Empty wherever the read never happened (an install too old for the field, a degraded page),
   * which the caller reads as "keep the `gh pr view` list" rather than as "this pull request has
   * no commits".
   */
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly viewer: { readonly canUpdate: boolean; readonly didAuthor: boolean };
}
