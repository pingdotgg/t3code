import { hasTeamReviewRequest } from "./gitHubPullRequestJson-02-to.ts";
import { trimOptionalString as trimmed } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Cause from "effect/Cause";
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
import type * as GitHubSchema from "../../schema/github.graphql.ts";
import type {
  PullRequestSummaryRepositoryPullRequestPullRequest as SummarizedPullRequest,
  PullRequestWatchFingerprintRepositoryPullRequestPullRequest as WatchedPullRequest,
} from "./pullRequestBatches.graphql.ts";
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

export interface LabelFields {
  readonly name: string;
  readonly color?: string | null | undefined;
}

export interface ReviewRequestFields {
  readonly login?: string | null | undefined;
  readonly slug?: string | null | undefined;
  readonly name?: string | null | undefined;
}

export interface LatestReviewFields {
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

export const REACTION_CONTENT_BY_GITHUB: Readonly<Record<string, PullRequestReactionContent>> = {
  THUMBS_UP: "thumbs-up",
  THUMBS_DOWN: "thumbs-down",
  LAUGH: "laugh",
  HOORAY: "hooray",
  CONFUSED: "confused",
  HEART: "heart",
  ROCKET: "rocket",
  EYES: "eyes",
};

export const GITHUB_REACTION_BY_CONTENT: Readonly<
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
export interface RequestedTeamFields {
  readonly combinedSlug?: string | null | undefined;
  readonly teamName?: string | null | undefined;
  readonly teamAvatarUrl?: string | null | undefined;
}

/** org/slug avoids collisions with user logins and verdicts. */
export interface RemarkFields {
  readonly id: string;
  readonly lastEditedAt: string | null;
  readonly author: ActorFields | null;
  readonly body: string;
  readonly url: string | null;
}

export interface DetailFields extends ListItemFields {
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

export type DecodeFailure = Cause.Cause<Schema.SchemaError>;

/** Count skipped invalid rows in rawCount to avoid ending pagination early. */
export interface GitHubPullRequestSearchItem extends GitHubPullRequestListItem {
  readonly repository: string;
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

export interface GitHubPullRequestWatchFingerprint {
  readonly status: string;
  readonly remarks: string;
}

export type EditedConnection = WatchedPullRequest["comments"] | WatchedPullRequest["reviews"];
export type StateCounts = ReadonlyArray<{ readonly state: string; readonly count: number }> | null;

export interface GitHubPullRequestCore extends GitHubPullRequestDetail {
  readonly maintainerCanModify: boolean;
  readonly canEditMaintainerEdits: boolean;
  readonly reviewRequestTeams: ReadonlyArray<PullRequestActor>;
  readonly viewerAccess: GitHubViewerAccess & GitHubRepositoryAccess;
  readonly comparison: GitHubBaseComparison | null;
  readonly checksTruncated: boolean;
}

export type CoreRequestedReviewer = NonNullable<
  NonNullable<
    NonNullable<NonNullable<PullRequestCore.Result["repository"]>["pullRequest"]>["reviewRequests"]
  >["nodes"]
>[number];

export interface GitHubWorkflowRunPage {
  readonly runs: ReadonlyArray<GitHubWorkflowRunApproval>;
  readonly rawCount: number;
}

export interface GitHubPullRequestActivityPage {
  readonly nonMergeCommitIds: ReadonlyArray<string>;
  readonly author?: PullRequestActor | null;
  readonly commits?: ReadonlyArray<PullRequestCommit>;
  readonly remarks: ReadonlyArray<PullRequestComment>;
  readonly nextCommentsCursor: string | null;
  readonly nextReviewsCursor: string | null;
}

export type GitHubCheckContext = CheckFields;

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

export type ReviewThreadsPullRequest = NonNullable<
  NonNullable<ReviewThreads.Result["repository"]>["pullRequest"]
>;

export interface GitHubRepositoryAccess {
  readonly mergeCapabilities: PullRequestMergeCapabilities;
  readonly autoMergeAllowed: boolean;
  readonly canWrite: boolean;
}

/** States in which `gh pr merge --auto` merges at once instead of arming auto-merge. */
export interface GitHubBaseComparison {
  readonly behindBy: number | null;
  readonly viewerCanUpdate: boolean;
}

/** assignableUsers avoids push/read:org requirements. Keep requested outsiders/apps removable. */
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

export interface GitHubPullRequestFilesPatch {
  readonly patch: string;
  readonly truncated: boolean;
  readonly rawCount: number;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

/** The files API omits diff --git headers; assemble them for unified-patch viewers. */
export interface GitHubPullRequestFilesViewedPage {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly state: PullRequestFileViewedState;
  }>;
  readonly nextCursor: string | null;
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

