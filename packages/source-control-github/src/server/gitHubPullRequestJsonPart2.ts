import { trimOptionalString as trimmed } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestStackMembership,
  PullRequestActor,
  PullRequestPreview,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestChecksState,
  PullRequestComment,
  PullRequestCommit,
  PullRequestLabel,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewDecision,
  PullRequestReviewPosition,
  PullRequestReviewVerdict,
  PullRequestState,
} from "@t3tools/contracts";
import { dedupeChecks } from "@t3tools/source-control-core/server/pullRequestChecks";
import type * as GitHubSchema from "../../schema/github.graphql.ts";
import type {
  PullRequestPreview as PullRequestPreviewQuery,
  PullRequestSubject,
} from "./pullRequestReads.graphql.ts";
import type { ReactionGroup } from "./pullRequestReviews.graphql.ts";

export interface ActorFields {
  readonly __typename?: string | undefined;
  readonly login?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly avatarUrl?: string | null | undefined;
}

export interface ListItemFields {
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

export interface ReviewRequestFields {
  readonly login?: string | null | undefined;
  readonly slug?: string | null | undefined;
  readonly name?: string | null | undefined;
}

interface LatestReviewFields {
  readonly state?: string | null | undefined;
}

/** Check runs use status/conclusion; commit statuses use a single state. */
export interface CheckFields {
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

export interface PageInfoFields {
  readonly hasNextPage?: boolean | undefined;
  readonly endCursor?: string | null | undefined;
}

export function nodesOf<A>(
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
export function toReactions(
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

export const RawWorkflowRunsSchema = Schema.Struct({
  workflow_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      name: Schema.optional(Schema.NullOr(Schema.String)),
      html_url: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

export const RawPullRequestFileSchema = Schema.Struct({
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

interface RequestedTeamFields {
  readonly combinedSlug?: string | null | undefined;
  readonly teamName?: string | null | undefined;
  readonly teamAvatarUrl?: string | null | undefined;
}

/** org/slug avoids collisions with user logins and verdicts. */
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
