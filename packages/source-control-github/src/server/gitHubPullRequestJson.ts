import { trimOptionalString as trimmed } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Cause from "effect/Cause";
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
import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { dedupeChecks } from "@t3tools/source-control-core/server/pullRequestChecks";

import type * as GitHubSchema from "../../schema/github.graphql.ts";
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
import type {
  ReactionGroup,
  ReviewDismissals,
  ReviewThreadComments,
  ReviewThreads,
  ThreadComment,
} from "./pullRequestReviews.graphql.ts";

interface ActorFields {
  readonly __typename?: string | undefined;
  readonly login?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly avatarUrl?: string | null | undefined;
}

interface ListItemFields {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author?: ActorFields | null | undefined;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly state?: string | null | undefined;
  readonly isDraft?: boolean | undefined;
  readonly mergeable?: string | null | undefined;
  readonly reviewDecision?: string | null | undefined;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergedAt?: string | null | undefined;
  readonly reviewRequests?: ReadonlyArray<ReviewRequestFields> | undefined;
  readonly latestReviews?: ReadonlyArray<LatestReviewFields> | undefined;
  readonly labels?: ReadonlyArray<LabelFields> | undefined;
  readonly statusCheckRollup?: ReadonlyArray<CheckFields> | null | undefined;
}

interface LabelFields {
  readonly name: string;
  readonly color?: string | null | undefined;
}

interface ReviewRequestFields {
  readonly login?: string | null | undefined;
  readonly slug?: string | null | undefined;
  readonly name?: string | null | undefined;
}

interface LatestReviewFields {
  readonly state?: string | null | undefined;
}

/** Check runs use status/conclusion; commit statuses use a single state. */
interface CheckFields {
  readonly name?: string | null | undefined;
  readonly context?: string | null | undefined;
  readonly status?: string | null | undefined;
  readonly conclusion?: string | null | undefined;
  readonly state?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly detailsUrl?: string | null | undefined;
  readonly targetUrl?: string | null | undefined;
  /** Empty for app-owned runs; absent for commit statuses. */
  readonly workflowName?: string | null | undefined;
  readonly startedAt?: string | null | undefined;
  readonly completedAt?: string | null | undefined;
  /** Branch protection requires this check; asked for on github.com only. */
  readonly isRequired?: boolean | null | undefined;
}

interface PageInfoFields {
  readonly hasNextPage?: boolean | undefined;
  readonly endCursor?: string | null | undefined;
}

function nodesOf<A>(
  connection: { readonly nodes?: ReadonlyArray<A | null> | null | undefined } | null | undefined,
): ReadonlyArray<A> {
  return (connection?.nodes ?? []).flatMap((node) => (node === null ? [] : [node]));
}

const REACTION_CONTENT_BY_GITHUB: Readonly<Record<string, PullRequestReactionContent>> = {
  THUMBS_UP: "thumbs-up",
  THUMBS_DOWN: "thumbs-down",
  LAUGH: "laugh",
  HOORAY: "hooray",
  CONFUSED: "confused",
  HEART: "heart",
  ROCKET: "rocket",
  EYES: "eyes",
};

const GITHUB_REACTION_BY_CONTENT: Readonly<
  Record<PullRequestReactionContent, GitHubSchema.ReactionContent>
> = {
  "thumbs-up": "THUMBS_UP",
  "thumbs-down": "THUMBS_DOWN",
  laugh: "LAUGH",
  hooray: "HOORAY",
  confused: "CONFUSED",
  heart: "HEART",
  rocket: "ROCKET",
  eyes: "EYES",
};

export function gitHubReactionContent(
  content: PullRequestReactionContent,
): GitHubSchema.ReactionContent {
  return GITHUB_REACTION_BY_CONTENT[content];
}

/** Keep the viewer in counts, not actors, to avoid duplicating 'You'. */
function toReactions(
  groups: ReadonlyArray<ReactionGroup> | null | undefined,
  viewer: string | null,
): ReadonlyArray<PullRequestReaction> {
  const normalizedViewer = viewer?.toLowerCase() ?? null;
  const reactions: PullRequestReaction[] = [];
  for (const group of groups ?? []) {
    const content = REACTION_CONTENT_BY_GITHUB[trimmed(group.content)?.toUpperCase() ?? ""];
    if (content === undefined) continue;
    const logins = nodesOf(group.reactors).flatMap((node) =>
      "login" in node ? (trimmed(node.login) ?? []) : [],
    );
    const count = Math.max(group.reactors.totalCount, logins.length);
    if (count <= 0) continue;
    const actors =
      normalizedViewer === null
        ? logins
        : logins.filter((login) => login.toLowerCase() !== normalizedViewer);
    reactions.push({ content, count, actors, viewerHasReacted: group.viewerHasReacted });
  }
  return reactions;
}

const RawWorkflowRunsSchema = Schema.Struct({
  workflow_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      name: Schema.optional(Schema.NullOr(Schema.String)),
      html_url: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

const RawPullRequestFileSchema = Schema.Struct({
  filename: Schema.String,
  status: Schema.optional(Schema.NullOr(Schema.String)),
  previous_filename: Schema.optional(Schema.NullOr(Schema.String)),
  patch: Schema.optional(Schema.NullOr(Schema.String)),
  additions: Schema.optional(Schema.NullOr(Schema.Int)),
  deletions: Schema.optional(Schema.NullOr(Schema.Int)),
});

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

const ReviewSubmissionSchema = Schema.Struct({
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

const REVIEW_EVENTS: Record<PullRequestReviewVerdict, "COMMENT" | "APPROVE" | "REQUEST_CHANGES"> = {
  comment: "COMMENT",
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
};

function gitHubReviewPosition(position: PullRequestReviewPosition): {
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

export interface GitHubPullRequestListItem {
  readonly stack?: PullRequestStackMembership;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly reviewDecision: PullRequestReviewDecision | null;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly hasTeamReviewRequest: boolean;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly checksState: PullRequestChecksState | null;
}

export interface GitHubPullRequestDetail extends GitHubPullRequestListItem {
  readonly isCrossRepository?: boolean;
  readonly headRepositoryOwner: string | null;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headSha?: string | null;
  readonly body: string;
  readonly changedFiles: number;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly autoMergeEnabled?: boolean;
  readonly autoMergeMethod?: PullRequestMergeMethod;
}

export interface GitHubWorkflowRunApproval {
  readonly id: number;
  readonly name: string;
  readonly url: string | null;
}

export interface GitHubPullRequestHead {
  readonly number: number;
  readonly headSha: string;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryOwner: string | null;
}

export interface GitHubPullRequestActivity {
  readonly author: PullRequestActor | null;
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly commits: ReadonlyArray<PullRequestCommit>;
}

/** GitHub returns endCursor even on the last page; hasNextPage is authoritative. */
function nextCursorOf(pageInfo: PageInfoFields | null | undefined): string | null {
  return pageInfo?.hasNextPage === true ? trimmed(pageInfo.endCursor) : null;
}

/** Defer unknown update access to the host; unknown authorship grants no author actions. */
function toPullRequestViewerFields(
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

function toActor(raw: ActorFields | null | undefined): PullRequestActor | null {
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

interface RequestedTeamFields {
  readonly combinedSlug?: string | null | undefined;
  readonly teamName?: string | null | undefined;
  readonly teamAvatarUrl?: string | null | undefined;
}

/** org/slug avoids collisions with user logins and verdicts. */
function toRequestedTeam(raw: object | null | undefined): PullRequestActor | null {
  if (raw == null || !("combinedSlug" in raw)) return null;
  const team = raw as RequestedTeamFields;
  const login = trimmed(team.combinedSlug);
  return login === null
    ? null
    : { login, name: trimmed(team.teamName), avatarUrl: trimmed(team.teamAvatarUrl) };
}

function toCommitActor(raw: {
  readonly email?: string | null | undefined;
  readonly login?: string | null | undefined;
  readonly name?: string | null | undefined;
}): PullRequestActor | null {
  // Unlinked commit signatures have no login; preserve name/email so co-authors remain visible.
  const login = trimmed(raw.login) ?? trimmed(raw.name) ?? trimmed(raw.email);
  return login === null ? null : { login, name: trimmed(raw.name), avatarUrl: null };
}

function toGraphqlCommitActor(raw: {
  readonly name?: string | null | undefined;
  readonly avatarUrl?: string | null | undefined;
  readonly user?: { readonly login?: string | null | undefined } | null | undefined;
}): PullRequestActor | null {
  const login = trimmed(raw.user?.login) ?? trimmed(raw.name);
  return login === null
    ? null
    : { login, name: trimmed(raw.name), avatarUrl: trimmed(raw.avatarUrl) };
}

function toState(raw: {
  readonly state?: string | null | undefined;
  readonly mergedAt?: string | null | undefined;
}): PullRequestState {
  if (trimmed(raw.mergedAt) !== null) return "merged";
  const state = raw.state?.trim().toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "open";
}

function toMergeability(value: string | null | undefined): PullRequestMergeability {
  switch (value?.trim().toUpperCase()) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

function toMergeMethod(value: string | null | undefined): PullRequestMergeMethod | undefined {
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
function toReviewDecisionWithReviews(
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

function toReviewDecision(value: string | null | undefined): PullRequestReviewDecision | null {
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

function toLabels(raw: ReadonlyArray<LabelFields> | undefined): ReadonlyArray<PullRequestLabel> {
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label.name);
    return name === null ? [] : [{ name, color: trimmed(label.color) }];
  });
}

function toReviewRequestLogins(
  raw: ReadonlyArray<ReviewRequestFields> | undefined,
): ReadonlyArray<string> {
  return (raw ?? []).flatMap((request) => {
    const login = trimmed(request.login);
    return login === null ? [] : [login];
  });
}

function hasTeamReviewRequest(raw: ReadonlyArray<ReviewRequestFields> | undefined): boolean {
  return (raw ?? []).some(
    (request) =>
      trimmed(request.login) === null &&
      (trimmed(request.slug) !== null || trimmed(request.name) !== null),
  );
}

function toCheckStatus(raw: CheckFields): PullRequestCheckStatus {
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
const UNSET_TIMESTAMP = "0001-01-01T00:00:00Z";

const STILL_RUNNING = "9999-12-31T23:59:59Z";

function realTimestamp(value: string | null | undefined): string | null {
  const at = trimmed(value);
  return at === null || at === UNSET_TIMESTAMP ? null : at;
}

function isNamelessCheck(raw: CheckFields): boolean {
  return trimmed(raw.name) === null && trimmed(raw.context) === null;
}

/** Unfinished runs outrank finished runs of the same check across push/PR workflows. */
function toCheckEntries(raw: ReadonlyArray<CheckFields> | null | undefined): ReadonlyArray<{
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

function rollupChecksState(
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

function toChecks(
  raw: ReadonlyArray<CheckFields> | null | undefined,
): ReadonlyArray<PullRequestCheck> {
  return dedupeChecks(toCheckEntries(raw));
}

function isReviewVerdict(reviewState: string | null): boolean {
  switch (reviewState?.toUpperCase()) {
    case "APPROVED":
    case "CHANGES_REQUESTED":
    case "DISMISSED":
      return true;
    default:
      return false;
  }
}

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

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeWorkflowRuns = decodeJsonResult(RawWorkflowRunsSchema);
const decodeFileEntry = Schema.decodeUnknownExit(RawPullRequestFileSchema);
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

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

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

export interface GitHubReviewThreadEntry {
  readonly thread: PullRequestReviewThread;
  readonly commentCount: number;
  readonly nextCommentCursor: string | null;
}

export interface GitHubReviewThreadPage {
  readonly threads: ReadonlyArray<GitHubReviewThreadEntry>;
  readonly nextCursor: string | null;
  readonly reactions: ReadonlyArray<PullRequestReaction>;
  readonly reactionsById: ReadonlyMap<string, ReadonlyArray<PullRequestReaction>>;
  readonly editedAtById: ReadonlyMap<string, string>;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly avatarsByLogin: ReadonlyMap<string, string>;
  readonly botLogins: ReadonlySet<string>;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly viewer: { readonly canUpdate: boolean; readonly didAuthor: boolean };
  readonly dismissalsByReviewId: ReadonlyMap<string, string>;
  readonly nextDismissalCursor: string | null;
}

export function reviewThreadConversation(
  threads: ReadonlyArray<PullRequestReviewThread>,
): ReadonlyArray<PullRequestComment> {
  return threads.flatMap((thread) =>
    thread.comments.map((comment): PullRequestComment => ({
      id: comment.id,
      kind: "review-comment",
      author: comment.author,
      body: comment.body,
      createdAt: comment.createdAt,
      editedAt: comment.editedAt ?? null,
      url: comment.url,
      path: thread.path,
      reviewState: null,
      reactions: comment.reactions ?? [],
    })),
  );
}

function toDismissalEntries(
  connection: ReviewThreadsPullRequest["reviewDismissals"],
): Map<string, string> {
  const entries = new Map<string, string>();
  for (const node of nodesOf(connection)) {
    if (!("dismissalMessage" in node)) continue;
    const reviewId = trimmed(node.review?.id);
    const message = trimmed(node.dismissalMessage);
    if (reviewId !== null && message !== null) entries.set(reviewId, message);
  }
  return entries;
}

export function toReviewDismissalsPage(result: ReviewDismissals.Result): {
  readonly dismissalsByReviewId: ReadonlyMap<string, string>;
  readonly nextCursor: string | null;
} | null {
  const items = result.repository?.pullRequest?.timelineItems;
  if (items === undefined) return null;
  return {
    dismissalsByReviewId: toDismissalEntries(items),
    nextCursor: nextCursorOf(items.pageInfo),
  };
}

function toThreadComment(comment: ThreadComment, viewer: string | null): PullRequestThreadComment {
  return {
    id: comment.id,
    author: toActor(comment.author),
    body: comment.body,
    createdAt: comment.createdAt,
    editedAt: comment.lastEditedAt,
    url: trimmed(comment.url),
    reactions: toReactions(comment.reactionGroups, viewer),
  };
}

type ReviewThreadsPullRequest = NonNullable<
  NonNullable<ReviewThreads.Result["repository"]>["pullRequest"]
>;

export function toReviewThreadPage(result: ReviewThreads.Result): GitHubReviewThreadPage | null {
  const pullRequest = result.repository?.pullRequest;
  if (pullRequest == null) return null;
  const viewer = trimmed(result.viewer.login);
  const threads = pullRequest.reviewThreads;
  const threadNodes = nodesOf(threads);
  const entries = threadNodes.flatMap((thread): ReadonlyArray<GitHubReviewThreadEntry> => {
    const path = trimmed(thread.path);
    const id = trimmed(thread.id);
    const comments = nodesOf(thread.comments);
    if (path === null || id === null || comments.length === 0) return [];
    return [
      {
        thread: {
          id,
          path,
          // Outdated threads lose their diff line; list them without a line anchor.
          line: thread.line !== null && thread.line > 0 ? thread.line : null,
          side: thread.diffSide.toUpperCase() === "LEFT" ? "left" : "right",
          isResolved: thread.isResolved,
          isOutdated: thread.isOutdated,
          comments: comments.map((comment) => toThreadComment(comment, viewer)),
        },
        commentCount: thread.comments.totalCount,
        nextCommentCursor: nextCursorOf(thread.comments.pageInfo),
      },
    ];
  });
  const requestedReviewers = nodesOf(pullRequest.reviewRequests).map(
    (node): ActorFields | null => node.requestedReviewer,
  );
  const latestReviews = nodesOf(pullRequest.latestReviews);
  const comments = nodesOf(pullRequest.comments);
  const reviews = nodesOf(pullRequest.reviews);
  const avatarsByLogin = new Map<string, string>();
  const botLogins = new Set<string>();
  for (const raw of [
    pullRequest.author,
    ...comments.map((node) => node.author),
    ...reviews.map((node) => node.author),
    ...requestedReviewers,
    ...latestReviews.map((node) => node.author),
    ...threadNodes.flatMap((thread) => nodesOf(thread.comments).map((comment) => comment.author)),
  ]) {
    const login = trimmed(raw?.login);
    const avatarUrl = trimmed(raw?.avatarUrl);
    if (login !== null && avatarUrl !== null) avatarsByLogin.set(login, avatarUrl);
    if (login !== null && toActor(raw)?.isBot) botLogins.add(login);
  }
  const reviewers = new Map<string, PullRequestActor>();
  for (const raw of [...requestedReviewers, ...latestReviews.map((node) => node.author)]) {
    const actor = toActor(raw) ?? toRequestedTeam(raw);
    if (actor !== null && !reviewers.has(actor.login)) reviewers.set(actor.login, actor);
  }
  const commits: PullRequestCommit[] = [];
  for (const { commit } of nodesOf(pullRequest.commits)) {
    const oid = trimmed(commit.oid);
    if (oid === null) continue;
    const committedDate = trimmed(commit.committedDate);
    if (committedDate === null) continue;
    commits.push({
      oid,
      messageHeadline: commit.messageHeadline,
      committedDate,
      authors: nodesOf(commit.authors).flatMap((author) => toGraphqlCommitActor(author) ?? []),
    });
  }
  const reactionsById = new Map<string, ReadonlyArray<PullRequestReaction>>();
  const editedAtById = new Map<string, string>();
  for (const node of [...comments, ...reviews]) {
    const id = trimmed(node.id);
    if (id === null) continue;
    const editedAt = trimmed(node.lastEditedAt);
    if (editedAt !== null) editedAtById.set(id, editedAt);
    const reactions = toReactions(node.reactionGroups, viewer);
    if (reactions.length > 0) reactionsById.set(id, reactions);
  }
  return {
    threads: entries,
    nextCursor: nextCursorOf(threads.pageInfo),
    reactions: toReactions(pullRequest.reactionGroups, viewer),
    reactionsById,
    editedAtById,
    reviewers: [...reviewers.values()],
    avatarsByLogin,
    botLogins,
    commits,
    viewer: toPullRequestViewerFields(pullRequest),
    dismissalsByReviewId: toDismissalEntries(pullRequest.reviewDismissals),
    nextDismissalCursor: nextCursorOf(pullRequest.reviewDismissals.pageInfo),
  };
}

export function toReviewThreadCommentsPage(result: ReviewThreadComments.Result): {
  readonly belongsToPullRequest: boolean;
  readonly comments: ReadonlyArray<PullRequestThreadComment>;
  readonly nextCursor: string | null;
} {
  const viewer = trimmed(result.viewer.login);
  const thread = result.node?.__typename === "PullRequestReviewThread" ? result.node : null;
  const pullRequestId = result.repository?.pullRequest?.id;
  return {
    belongsToPullRequest: pullRequestId !== undefined && pullRequestId === thread?.pullRequest.id,
    comments: nodesOf(thread?.comments).map((comment) => toThreadComment(comment, viewer)),
    nextCursor: nextCursorOf(thread?.comments.pageInfo),
  };
}

export interface GitHubRepositoryAccess {
  readonly mergeCapabilities: PullRequestMergeCapabilities;
  readonly autoMergeAllowed: boolean;
  readonly canWrite: boolean;
}

/** States in which `gh pr merge --auto` merges at once instead of arming auto-merge. */
export const IMMEDIATELY_MERGEABLE: ReadonlySet<string> = new Set([
  "CLEAN",
  "HAS_HOOKS",
  "UNSTABLE",
]);

/**
 * GitHub answers null only to a GitHub App installation, and no API says what an installation
 * may do, so null is granted and GitHub refuses whatever the app was not given.
 */
export function toCanWrite(viewerPermission: string | null | undefined): boolean {
  if (viewerPermission === null) return true;
  switch (viewerPermission?.trim().toUpperCase()) {
    case "ADMIN":
    case "MAINTAIN":
    case "WRITE":
      return true;
    default:
      return false;
  }
}

function toCanTriage(viewerPermission: string | null | undefined): boolean {
  return viewerPermission?.trim().toUpperCase() === "TRIAGE" || toCanWrite(viewerPermission);
}

export interface GitHubBaseComparison {
  readonly behindBy: number | null;
  readonly viewerCanUpdate: boolean;
}

/** assignableUsers avoids push/read:org requirements. Keep requested outsiders/apps removable. */
export function toReviewerCandidates(
  result: ReviewerCandidates.Result,
): PullRequestReviewerCandidateList | null {
  const repository = result.repository;
  if (repository == null) return null;
  const pullRequest = repository.pullRequest;
  const author = trimmed(pullRequest?.author?.login);
  const candidates = new Map<string, PullRequestReviewerCandidate>();
  for (const { requestedReviewer: raw } of nodesOf(pullRequest?.reviewRequests)) {
    if (raw === null) continue;
    const slug = "slug" in raw ? trimmed(raw.slug) : null;
    const id = slug ?? ("login" in raw ? trimmed(raw.login) : null);
    if (id === null) continue;
    candidates.set(`${slug === null ? "user" : "team"} ${id}`, {
      id,
      kind: slug === null ? "user" : "team",
      // Match reviewer rows' org/slug so requests can be withdrawn.
      login: slug === null ? id : (trimmed("combinedSlug" in raw ? raw.combinedSlug : null) ?? id),
      name: trimmed("teamName" in raw ? raw.teamName : "name" in raw ? raw.name : null),
      avatarUrl: trimmed(
        "teamAvatarUrl" in raw ? raw.teamAvatarUrl : "avatarUrl" in raw ? raw.avatarUrl : null,
      ),
      isRequested: true,
    });
  }
  for (const node of nodesOf(repository.assignableUsers)) {
    const login = trimmed(node.login);
    if (login === null || login === author || candidates.has(`user ${login}`)) continue;
    candidates.set(`user ${login}`, {
      id: login,
      kind: "user",
      login,
      name: trimmed(node.name),
      avatarUrl: trimmed(node.avatarUrl),
      isRequested: false,
    });
  }
  return {
    candidates: [...candidates.values()],
    truncated: repository.assignableUsers.pageInfo.hasNextPage,
  };
}

const ReviewerRequestSchema = Schema.Struct({
  reviewers: Schema.Array(Schema.String),
  team_reviewers: Schema.Array(Schema.String),
});

export function buildReviewerRequest(
  reviewers: ReadonlyArray<{ readonly id: string; readonly kind: PullRequestReviewerKind }>,
): typeof ReviewerRequestSchema.Type {
  return {
    reviewers: reviewers.flatMap((reviewer) => (reviewer.kind === "user" ? [reviewer.id] : [])),
    team_reviewers: reviewers.flatMap((reviewer) =>
      reviewer.kind === "team" ? [reviewer.id] : [],
    ),
  };
}

/** Keep applied labels removable even when absent from the repository page. */
export function toLabelCandidates(
  result: LabelCandidates.Result,
): PullRequestLabelCandidateList | null {
  const repository = result.repository;
  if (repository == null) return null;
  const applied = new Set(
    nodesOf(repository.pullRequest?.labels).flatMap((label) => trimmed(label.name) ?? []),
  );
  const candidates = new Map<string, PullRequestLabelCandidate>();
  for (const node of nodesOf(repository.labels)) {
    const name = trimmed(node.name);
    if (name === null) continue;
    candidates.set(name, {
      name,
      color: trimmed(node.color),
      description: trimmed(node.description),
      isApplied: applied.has(name),
    });
  }
  const missing = [...applied].filter((name) => !candidates.has(name));
  return {
    candidates: [
      ...missing.map((name) => ({ name, color: null, description: null, isApplied: true })),
      ...candidates.values(),
    ],
    truncated: repository.labels?.pageInfo.hasNextPage === true,
  };
}

export function toRepositoryLabels(
  result: RepositoryLabels.Result,
): { readonly items: ReadonlyArray<PullRequestLabel>; readonly truncated: boolean } | null {
  const repository = result.repository;
  if (repository == null) return null;
  return {
    items: nodesOf(repository.labels).flatMap((node) => {
      const name = trimmed(node.name);
      return name === null ? [] : [{ name, color: trimmed(node.color) }];
    }),
    truncated: repository.labels?.pageInfo.hasNextPage === true,
  };
}

export function toRepositoryAuthors(
  result: RepositoryAuthors.Result,
): { readonly items: ReadonlyArray<PullRequestActor>; readonly truncated: boolean } | null {
  const repository = result.repository;
  if (repository == null) return null;
  return {
    items: nodesOf(repository.mentionableUsers).flatMap((node) => {
      const login = trimmed(node.login);
      return login === null
        ? []
        : [{ login, name: trimmed(node.name), avatarUrl: trimmed(node.avatarUrl) }];
    }),
    truncated: repository.mentionableUsers.pageInfo.hasNextPage,
  };
}

export function buildLabelRequest(labels: ReadonlyArray<string>): {
  readonly labels: ReadonlyArray<string>;
} {
  return { labels };
}

export interface GitHubViewerAccess {
  readonly canWrite: boolean;
  readonly canDeleteBranch?: boolean;
  readonly canTriage: boolean;
  readonly canUpdate: boolean;
  readonly didAuthor: boolean;
  /** Permitted and update needed; false also covers current branches. Absent if unread. */
  readonly canUpdateBranch?: boolean;
  /** Detail-only readiness; omitted by the lightweight action permission read. */
  readonly canMergeNow?: boolean;
}

export function toViewerPermissions(
  result: ViewerPermissions.Result,
): (GitHubViewerAccess & GitHubRepositoryAccess) | null {
  const repository = result.repository;
  if (repository == null) return null;
  return {
    mergeCapabilities: {
      merge: repository.mergeCommitAllowed,
      squash: repository.squashMergeAllowed,
      rebase: repository.rebaseMergeAllowed,
    },
    autoMergeAllowed: repository.autoMergeAllowed,
    canWrite: toCanWrite(repository.viewerPermission),
    canDeleteBranch: toCanWrite(repository.pullRequest?.headRepository?.viewerPermission),
    canTriage: toCanTriage(repository.viewerPermission),
    ...toPullRequestViewerFields(repository.pullRequest),
  };
}

export interface GitHubPullRequestFilesPatch {
  readonly patch: string;
  readonly truncated: boolean;
  readonly rawCount: number;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

/** The files API omits diff --git headers; assemble them for unified-patch viewers. */
export function decodePullRequestFilesJson(
  raw: string,
): Result.Result<GitHubPullRequestFilesPatch, DecodeFailure> {
  return Result.map(decodeUnknownList(raw), toFilesPatch);
}

export function decodeCommitFilesJson(
  raw: string,
): Result.Result<GitHubPullRequestFilesPatch, DecodeFailure> {
  return Result.map(decodeCommitFiles(raw), (commit) => toFilesPatch(commit.files ?? []));
}

const decodeCommitFiles = decodeJsonResult(
  Schema.Struct({ files: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))) }),
);

function toFilesPatch(entries: ReadonlyArray<unknown>): GitHubPullRequestFilesPatch {
  const sections: string[] = [];
  const omittedFileStats: PullRequestOmittedFileStat[] = [];
  let truncated = false;
  for (const entry of entries) {
    const file = decodeFileEntry(entry);
    if (Exit.isFailure(file)) continue;
    const value = file.value;
    const hunks = value.patch ?? "";
    const status = value.status?.trim().toLowerCase();
    if (hunks.length === 0) {
      // Hunkless renames are complete; omitted binary changes leave a patch gap.
      const additions = value.additions ?? 0;
      const deletions = value.deletions ?? 0;
      if (additions + deletions > 0) {
        truncated = true;
        omittedFileStats.push({ path: value.filename, additions, deletions });
      }
    }
    const oldPath =
      status === "renamed" ? value.previous_filename || value.filename : value.filename;
    const header = [
      `diff --git ${quoteGitPatchPath(`a/${oldPath}`)} ${quoteGitPatchPath(`b/${value.filename}`)}`,
      ...(status === "added" ? ["new file mode 100644"] : []),
      ...(status === "removed" ? ["deleted file mode 100644"] : []),
      ...(status === "renamed"
        ? [
            `rename from ${quoteGitPatchPath(oldPath)}`,
            `rename to ${quoteGitPatchPath(value.filename)}`,
          ]
        : []),
      `--- ${status === "added" ? "/dev/null" : quoteGitPatchPath(`a/${oldPath}`)}`,
      `+++ ${status === "removed" ? "/dev/null" : quoteGitPatchPath(`b/${value.filename}`)}`,
    ].join("\n");
    sections.push(hunks.length === 0 ? `${header}\n` : `${header}\n${hunks.replace(/\n?$/, "\n")}`);
  }
  return {
    patch: sections.join(""),
    truncated,
    rawCount: entries.length,
    omittedFileStats,
  };
}

export interface GitHubPullRequestFilesViewedPage {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly state: PullRequestFileViewedState;
  }>;
  readonly nextCursor: string | null;
}

function toFileViewedState(raw: string): PullRequestFileViewedState {
  switch (raw.trim().toUpperCase()) {
    case "VIEWED":
      return "viewed";
    case "DISMISSED":
      return "dismissed";
    default:
      return "unviewed";
  }
}

export function toPullRequestFilesViewedPage(
  result: PullRequestFilesViewed.Result,
): GitHubPullRequestFilesViewedPage {
  const files = result.repository?.pullRequest?.files;
  return {
    files: nodesOf(files).flatMap((node) =>
      node.path.length === 0
        ? []
        : [{ path: node.path, state: toFileViewedState(node.viewerViewedState) }],
    ),
    nextCursor: nextCursorOf(files?.pageInfo),
  };
}

export interface GitHubPullRequestFileStat {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface GitHubPullRequestFileStatsPage {
  readonly files: ReadonlyArray<GitHubPullRequestFileStat>;
  readonly nextCursor: string | null;
}

export function toPullRequestFileStatsPage(
  result: PullRequestFileStats.Result,
): GitHubPullRequestFileStatsPage {
  const files = result.repository?.pullRequest?.files;
  return {
    files: nodesOf(files).flatMap(({ path, additions, deletions }) =>
      path.length === 0 ? [] : [{ path, additions, deletions }],
    ),
    nextCursor: nextCursorOf(files?.pageInfo),
  };
}

const RawStackPullRequestSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  draft: Schema.optional(Schema.Boolean),
  number: Schema.Int,
  head: Schema.Struct({ ref: Schema.String, sha: Schema.optional(Schema.String) }),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawStackSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.Int, Schema.String]))),
  number: Schema.Int,
  node_id: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.String,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  base: Schema.Union([Schema.String, Schema.Struct({ ref: Schema.String })]),
  pull_requests: Schema.Array(RawStackPullRequestSchema),
});

const decodeStacks = decodeJsonResult(Schema.Array(RawStackSchema));

export interface GitHubPullRequestStackLayer {
  readonly title?: string;
  readonly isDraft?: boolean;
  readonly headSha?: string;
  readonly number: number;
  readonly headBranch: string;
  readonly state: PullRequestState;
}

export interface GitHubPullRequestStack {
  readonly id: string;
  readonly number: number;
  readonly url: string;
  readonly base: string;
  readonly layers: ReadonlyArray<GitHubPullRequestStackLayer>;
}

export function decodePullRequestStacksJson(
  raw: string,
): Result.Result<GitHubPullRequestStack | null, DecodeFailure> {
  const decoded = decodeStacks(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const stack = decoded.success[0];
  if (stack === undefined) return Result.succeed(null);
  return Result.succeed({
    id: stack.id == null ? (trimmed(stack.node_id) ?? String(stack.number)) : String(stack.id),
    number: stack.number,
    url: trimmed(stack.html_url) ?? stack.url,
    base: typeof stack.base === "string" ? stack.base : stack.base.ref,
    layers: stack.pull_requests.map((pullRequest) => ({
      ...(pullRequest.title === undefined ? {} : { title: pullRequest.title }),
      ...(pullRequest.draft === undefined ? {} : { isDraft: pullRequest.draft }),
      ...(pullRequest.head.sha === undefined ? {} : { headSha: pullRequest.head.sha }),
      number: pullRequest.number,
      headBranch: pullRequest.head.ref,
      state: toState({ state: pullRequest.state, mergedAt: pullRequest.merged_at }),
    })),
  });
}
