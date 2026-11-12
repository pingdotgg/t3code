import { RawPullRequestFileSchema, RawWorkflowRunsSchema, nodesOf } from "./gitHubPullRequestJson-03-actor.ts";
import type { ActorFields, CheckFields, DetailFields, EditedConnection, GitHubCheckContext, GitHubPullRequestDetail, GitHubPullRequestListItem, GitHubPullRequestSummary, GitHubPullRequestWatchFingerprint, LabelFields, LatestReviewFields, ListItemFields, PageInfoFields, RemarkFields, RequestedTeamFields, ReviewRequestFields, StateCounts } from "./gitHubPullRequestJson-03-actor.ts";
import { trimOptionalString as trimmed } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { GraphQL } from "effect/graphql";
import type {
  PullRequestStackMembership,
  PullRequestActor,
  PullRequestPreview,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestChecksState,
  PullRequestComment,
  PullRequestCommit,
  PullRequestFileViewedState,
  PullRequestLabel,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestOmittedFileStat,
  PullRequestMergeability,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewDecision,
  PullRequestReviewPosition,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidate,
  PullRequestReviewerCandidateList,
  PullRequestReviewerKind,
  PullRequestLabelCandidate,
  PullRequestLabelCandidateList,
  PullRequestState,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { dedupeChecks } from "@t3tools/source-control-core/server/pullRequestChecks";
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
  LabelCandidates,
  PullRequestActivity,
  PullRequestCommitStats,
  PullRequestCheckContexts,
  PullRequestCore,
  PullRequestFilesViewed,
  PullRequestFileStats,
  PullRequestHeads,
  PullRequestPreview as PullRequestPreviewQuery,
  PullRequestSubject,
  RepositoryAuthors,
  RepositoryLabels,
  ReviewerCandidates,
  ViewerPermissions,
} from "./pullRequestReads.graphql.ts";

export function toPullRequestPreview(
  result: PullRequestPreviewQuery.Result,
): Omit<PullRequestPreview, "projectId" | "repository"> | null {
  const pullRequest = result.repository?.pullRequest;
  if (pullRequest == null) return null;
  return {
    ...pullRequest,
    author: toActor(pullRequest.author),
    state: toState(pullRequest),
  };
}

/** Search rejects first > 100 with EXCESSIVE_PAGINATION. */
export const PULL_REQUEST_SEARCH_MAX_ROWS = 100;

export function pageRows(rows: number): number {
  return Math.min(Math.max(Math.trunc(rows), 1), PULL_REQUEST_SEARCH_MAX_ROWS);
}

export function toPullRequestNodeId(result: {
  readonly repository: { readonly pullRequest: { readonly id: string } | null } | null;
}): string | null {
  return result.repository?.pullRequest?.id ?? null;
}

export function isSubjectOfPullRequest(result: PullRequestSubject.Result): boolean {
  const expected = result.repository?.pullRequest?.id ?? null;
  const node = result.node;
  const actual =
    node === null
      ? null
      : node.__typename === "IssueComment"
        ? (node.pullRequest?.id ?? null)
        : node.__typename === "PullRequestReviewComment"
          ? node.reviewCommentPullRequest.id
          : node.__typename === "PullRequestReview"
            ? node.reviewPullRequest.id
            : node.id;
  return expected !== null && actual !== null && expected === actual;
}

export const ReviewSubmissionSchema = Schema.Struct({
  event: Schema.Literals(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
  body: Schema.String,
  comments: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      start_line: Schema.optional(Schema.Int),
      start_side: Schema.optional(Schema.Literals(["LEFT", "RIGHT"])),
      line: Schema.Int,
      side: Schema.Literals(["LEFT", "RIGHT"]),
      body: Schema.String,
    }),
  ),
});

export const REVIEW_EVENTS: Record<PullRequestReviewVerdict, "COMMENT" | "APPROVE" | "REQUEST_CHANGES"> = {
  comment: "COMMENT",
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
};

export function gitHubReviewPosition(position: PullRequestReviewPosition): {
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
} {
  switch (position.kind) {
    case "added":
      return { line: position.newLine, side: "RIGHT" };
    case "deleted":
      return { line: position.oldLine, side: "LEFT" };
    case "context":
      return position.side === "left"
        ? { line: position.oldLine, side: "LEFT" }
        : { line: position.newLine, side: "RIGHT" };
  }
}

export function buildReviewSubmission(input: {
  readonly verdict: PullRequestReviewVerdict;
  readonly body: string;
  readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
}): typeof ReviewSubmissionSchema.Type {
  return {
    event: REVIEW_EVENTS[input.verdict],
    body: input.body,
    comments: input.comments.map((comment) => {
      const end = gitHubReviewPosition(comment.position);
      const start =
        comment.startPosition === undefined ? null : gitHubReviewPosition(comment.startPosition);
      // GitHub refuses a start that is the end itself, so a one-line range is sent as one line.
      const ranged = start !== null && (start.line !== end.line || start.side !== end.side);
      return {
        path: comment.path,
        ...(ranged ? { start_line: start.line, start_side: start.side } : {}),
        ...end,
        body: comment.body,
      };
    }),
  };
}

export function nextCursorOf(pageInfo: PageInfoFields | null | undefined): string | null {
  return pageInfo?.hasNextPage === true ? trimmed(pageInfo.endCursor) : null;
}

/** Defer unknown update access to the host; unknown authorship grants no author actions. */
export function toPullRequestViewerFields(
  raw:
    | {
        readonly viewerCanUpdate?: boolean | undefined;
        readonly viewerDidAuthor?: boolean | undefined;
      }
    | null
    | undefined,
): { readonly canUpdate: boolean; readonly didAuthor: boolean } {
  return { canUpdate: raw?.viewerCanUpdate !== false, didAuthor: raw?.viewerDidAuthor === true };
}

export function toActor(raw: ActorFields | null | undefined): PullRequestActor | null {
  const login = trimmed(raw?.login);
  return login === null
    ? null
    : {
        login,
        name: trimmed(raw?.name),
        avatarUrl: trimmed(raw?.avatarUrl),
        ...(raw?.__typename === "Bot" ? { isBot: true } : {}),
      };
}

export function toRequestedTeam(raw: object | null | undefined): PullRequestActor | null {
  if (raw == null || !("combinedSlug" in raw)) return null;
  const team = raw as RequestedTeamFields;
  const login = trimmed(team.combinedSlug);
  return login === null
    ? null
    : { login, name: trimmed(team.teamName), avatarUrl: trimmed(team.teamAvatarUrl) };
}

export function toCommitActor(raw: {
  readonly email?: string | null | undefined;
  readonly login?: string | null | undefined;
  readonly name?: string | null | undefined;
}): PullRequestActor | null {
  // Unlinked commit signatures have no login; preserve name/email so co-authors remain visible.
  const login = trimmed(raw.login) ?? trimmed(raw.name) ?? trimmed(raw.email);
  return login === null ? null : { login, name: trimmed(raw.name), avatarUrl: null };
}

export function toGraphqlCommitActor(raw: {
  readonly name?: string | null | undefined;
  readonly avatarUrl?: string | null | undefined;
  readonly user?: { readonly login?: string | null | undefined } | null | undefined;
}): PullRequestActor | null {
  const login = trimmed(raw.user?.login) ?? trimmed(raw.name);
  return login === null
    ? null
    : { login, name: trimmed(raw.name), avatarUrl: trimmed(raw.avatarUrl) };
}

export function toState(raw: {
  readonly state?: string | null | undefined;
  readonly mergedAt?: string | null | undefined;
}): PullRequestState {
  if (trimmed(raw.mergedAt) !== null) return "merged";
  const state = raw.state?.trim().toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "open";
}

export function toMergeability(value: string | null | undefined): PullRequestMergeability {
  switch (value?.trim().toUpperCase()) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

export function toMergeMethod(value: string | null | undefined): PullRequestMergeMethod | undefined {
  switch (value?.trim().toUpperCase()) {
    case "MERGE":
      return "merge";
    case "SQUASH":
      return "squash";
    case "REBASE":
      return "rebase";
    default:
      return undefined;
  }
}

/** GitHub's reviewDecision ignores reviews outside branch rules, including app approvals. */
export function toReviewDecisionWithReviews(
  value: string | null | undefined,
  reviews: ReadonlyArray<LatestReviewFields> | undefined,
): PullRequestReviewDecision | null {
  const summarized = toReviewDecision(value);
  if (summarized === "approved" || summarized === "changes-requested") return summarized;
  const states = new Set((reviews ?? []).map((review) => review.state?.trim().toUpperCase() ?? ""));
  if (states.has("CHANGES_REQUESTED")) return "changes-requested";
  if (states.has("APPROVED")) return "approved";
  return summarized;
}

export function toReviewDecision(value: string | null | undefined): PullRequestReviewDecision | null {
  switch (value?.trim().toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "REVIEW_REQUIRED":
      return "review-required";
    default:
      return null;
  }
}

export function toLabels(raw: ReadonlyArray<LabelFields> | undefined): ReadonlyArray<PullRequestLabel> {
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label.name);
    return name === null ? [] : [{ name, color: trimmed(label.color) }];
  });
}

export function toReviewRequestLogins(
  raw: ReadonlyArray<ReviewRequestFields> | undefined,
): ReadonlyArray<string> {
  return (raw ?? []).flatMap((request) => {
    const login = trimmed(request.login);
    return login === null ? [] : [login];
  });
}

export function hasTeamReviewRequest(raw: ReadonlyArray<ReviewRequestFields> | undefined): boolean {
  return (raw ?? []).some(
    (request) =>
      trimmed(request.login) === null &&
      (trimmed(request.slug) !== null || trimmed(request.name) !== null),
  );
}

export function toCheckStatus(raw: CheckFields): PullRequestCheckStatus {
  const status = raw.status?.trim().toUpperCase();
  if (status !== undefined && status !== "COMPLETED" && status !== "") {
    return "pending";
  }
  switch ((raw.conclusion ?? raw.state)?.trim().toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "ACTION_REQUIRED":
      return "action-required";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
      return "skipped";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "neutral";
  }
}

/** GitHub's sentinel for timestamps not reached yet. */
export const UNSET_TIMESTAMP = "0001-01-01T00:00:00Z";

export const STILL_RUNNING = "9999-12-31T23:59:59Z";

export function realTimestamp(value: string | null | undefined): string | null {
  const at = trimmed(value);
  return at === null || at === UNSET_TIMESTAMP ? null : at;
}

export function isNamelessCheck(raw: CheckFields): boolean {
  return trimmed(raw.name) === null && trimmed(raw.context) === null;
}

/** Unfinished runs outrank finished runs of the same check across push/PR workflows. */
export function toCheckEntries(raw: ReadonlyArray<CheckFields> | null | undefined): ReadonlyArray<{
  readonly check: PullRequestCheck;
  readonly workflowName: string | null;
  readonly at: string | null;
}> {
  return (raw ?? []).flatMap((check) => {
    const name = trimmed(check.name) ?? trimmed(check.context);
    if (name === null) return [];
    const status = toCheckStatus(check);
    return [
      {
        check: {
          name,
          status,
          description: trimmed(check.description),
          url: trimmed(check.detailsUrl) ?? trimmed(check.targetUrl),
          ...(typeof check.isRequired === "boolean" ? { required: check.isRequired } : {}),
        },
        workflowName: trimmed(check.workflowName),
        at:
          status === "pending"
            ? STILL_RUNNING
            : (realTimestamp(check.completedAt) ?? realTimestamp(check.startedAt)),
      },
    ];
  });
}

export function rollupChecksState(
  raw: ReadonlyArray<CheckFields> | null | undefined,
): PullRequestChecksState | null {
  const statuses = [
    ...toChecks(raw).map((check) => check.status),
    ...(raw ?? []).filter(isNamelessCheck).map((check) => toCheckStatus(check)),
  ];
  if (statuses.length === 0) return null;
  if (statuses.includes("failure") || statuses.includes("cancelled")) return "failing";
  if (statuses.includes("pending") || statuses.includes("action-required")) return "pending";
  return statuses.includes("success") ? "passing" : null;
}

export function toChecks(
  raw: ReadonlyArray<CheckFields> | null | undefined,
): ReadonlyArray<PullRequestCheck> {
  return dedupeChecks(toCheckEntries(raw));
}

export function isReviewVerdict(reviewState: string | null): boolean {
  switch (reviewState?.toUpperCase()) {
    case "APPROVED":
    case "CHANGES_REQUESTED":
    case "DISMISSED":
      return true;
    default:
      return false;
  }
}

export function toComments(raw: {
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

export function toCommits(
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

export function toListItem(raw: ListItemFields): GitHubPullRequestListItem {
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

export function toDetail(raw: DetailFields): GitHubPullRequestDetail {
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
export const decodeWorkflowRuns = decodeJsonResult(RawWorkflowRunsSchema);
export const decodeFileEntry = Schema.decodeUnknownExit(RawPullRequestFileSchema);
export const decodeRow = Schema.decodeUnknownExit(PullRequestRow);

/** Decode rows individually so one invalid node cannot blank the entire listing. */
export const LenientRows = Schema.Struct({
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

export function toRow(
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

export function rollupStates(commits: {
  readonly nodes: ReadonlyArray<{
    readonly commit: { readonly statusCheckRollup: { readonly state: string } | null };
  } | null> | null;
}): ReadonlyArray<CheckFields> {
  return nodesOf(commits).flatMap((commitNode) => {
    const state = trimmed(commitNode.commit.statusCheckRollup?.state);
    return state === null ? [] : [{ state }];
  });
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

export const REPOSITORY_PART = /^[A-Za-z0-9._-]+$/;

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

export const newestEdit = (connection: EditedConnection) =>
  (connection?.nodes ?? []).reduce(
    (newest, node) =>
      node?.lastEditedAt != null && node.lastEditedAt > newest ? node.lastEditedAt : newest,
    "",
  );

export const stateCounts = (counts: StateCounts) =>
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

export function toCheckContexts(nodes: ReadonlyArray<CheckContext>): ReadonlyArray<GitHubCheckContext> {
  return nodes.map((check) =>
    check.__typename === "CheckRun"
      ? { ...check, workflowName: check.checkSuite.workflowRun?.workflow.name ?? null }
      : check,
  );
}

