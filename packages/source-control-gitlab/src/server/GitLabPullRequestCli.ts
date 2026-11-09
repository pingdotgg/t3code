import { removeAgentCredits } from "@t3tools/source-control-core/server/mergeMessage";
import { isCommitSha } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { resolvePullRequestAuthorFilter, VcsProcessExitError } from "@t3tools/contracts";
import type {
  PullRequestAction,
  PullRequestActor,
  PullRequestReferenceCandidate,
  PullRequestReferenceSigil,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestLabelCandidateList,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewPosition,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
} from "@t3tools/contracts";

import * as GitLabCli from "./GitLabCli.ts";
import {
  AWARD_EMOJI_GRAPHQL_QUERY,
  PIPELINE_STAGES_GRAPHQL_QUERY,
  decodeAwardEmojiJson,
  decodeBranchJson,
  decodeCommitDiffRefsJson,
  decodeCommitsJson,
  decodeDiffRefsJson,
  decodeDiscussionsJson,
  decodeMaintainerEditsPermissionJson,
  decodeLabelNameJson,
  decodeLabelPermissionJson,
  decodeMergeMessagesJson,
  decodeMergeRequestDetailJson,
  decodeMergeRequestDiffsJson,
  decodeMergeRequestChangesJson,
  decodeGraphqlListSupportJson,
  decodeMergeRequestGraphqlListJson,
  decodeMergeRequestGraphqlProjectsListJson,
  decodeMergeRequestListJson,
  decodeMergeRequestFileStatsJson,
  decodeMergeRequestStatsJson,
  decodeMutationErrorsJson,
  decodeNotesJson,
  decodeOwnAwardIdJson,
  decodePipelineStageChecksJson,
  decodeProjectMergeCapabilitiesJson,
  decodeProjectLabelsJson,
  decodeProjectUsersJson,
  decodeReferenceCandidatesJson,
  decodeRepositoryBlobsJson,
  decodeListStatesJson,
  decodeSourceBranchJson,
  decodeTriggerJobChecksJson,
  decodeViewerJson,
  gitLabAwardName,
  MAINTAINER_EDITS_PERMISSION_GRAPHQL_QUERY,
  LABEL_PERMISSION_GRAPHQL_QUERY,
  MERGE_MESSAGES_GRAPHQL_QUERY,
  MERGE_REQUEST_FILE_STATS_GRAPHQL_QUERY,
  MERGE_REQUEST_STATS_GRAPHQL_QUERY,
  REPOSITORY_BLOBS_GRAPHQL_QUERY,
  LIST_ITEM_GRAPHQL_FIELDS,
  LIST_STATES_GRAPHQL_QUERY,
  SERVER_VERSION_GRAPHQL_QUERY,
  SOURCE_BRANCH_GRAPHQL_QUERY,
  type GitLabDiffRefs,
  type GitLabMergeRequestDetail,
  type GitLabMergeRequestListItem,
  type GitLabMergeRequestListState,
  type GitLabMergeRequestGraphqlPage,
  type GitLabProjectUsers,
} from "./gitLabMergeRequestJson.ts";
import type {
  ProviderChangeRequestSummary,
  ProviderFileStats,
  ProviderListCursor,
} from "@t3tools/source-control-core/server/PullRequestProvider";

export class GitLabMergeRequestReadError extends Schema.TaggedError<GitLabMergeRequestReadError>()(
  "GitLabMergeRequestReadError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `GitLab CLI returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitLabViewerUnavailableError extends Schema.TaggedError<GitLabViewerUnavailableError>()(
  "GitLabViewerUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "GitLab CLI returned no username for the authenticated account.";
  }

  override get message(): string {
    return `GitLab CLI failed in getViewerUsername: ${this.detail}`;
  }
}

export class GitLabDiffRefsUnavailableError extends Schema.TaggedError<GitLabDiffRefsUnavailableError>()(
  "GitLabDiffRefsUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  get detail(): string {
    return "The merge request reported no diff revisions.";
  }

  override get message(): string {
    return `GitLab CLI failed in getDiffRefs: ${this.detail}`;
  }
}

export class GitLabDiffCursorError extends Schema.TaggedError<GitLabDiffCursorError>()(
  "GitLabDiffCursorError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "The diff cursor was not one this merge request handed out.";
  }

  override get message(): string {
    return `GitLab CLI failed in getMergeRequestDiff: ${this.detail}`;
  }
}

export class GitLabDiffCommitError extends Schema.TaggedError<GitLabDiffCommitError>()(
  "GitLabDiffCommitError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "The named commit was not a commit sha.";
  }

  override get message(): string {
    return `GitLab CLI failed in getMergeRequestDiff: ${this.detail}`;
  }
}

export class GitLabDiffCommitParentUnavailableError extends Schema.TaggedError<GitLabDiffCommitParentUnavailableError>()(
  "GitLabDiffCommitParentUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    commit: Schema.String,
  },
) {
  get detail(): string {
    return `Commit ${this.commit} reported no parent revision.`;
  }

  override get message(): string {
    return `GitLab CLI failed in getMergeRequestDiffFileContents: ${this.detail}`;
  }
}

export class GitLabDiffFileContentsUnavailableError extends Schema.TaggedError<GitLabDiffFileContentsUnavailableError>()(
  "GitLabDiffFileContentsUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    path: Schema.String,
    reason: Schema.Literals(["oversized", "binary"]),
  },
) {
  get detail(): string {
    return this.reason === "oversized"
      ? `The diff file '${this.path}' exceeds the 1 MB expansion limit.`
      : `The diff file '${this.path}' is binary.`;
  }

  override get message(): string {
    return `GitLab CLI failed in getMergeRequestDiffFileContents: ${this.detail}`;
  }
}

export class GitLabMutationRefusedError extends Schema.TaggedError<GitLabMutationRefusedError>()(
  "GitLabMutationRefusedError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    operation: Schema.String,
    reasons: Schema.Array(Schema.String),
  },
) {
  get detail(): string {
    return `GitLab refused it: ${this.reasons.join("; ")}`;
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

const SET_SELF_AS_REVIEWER_MUTATION = `mutation($projectPath: ID!, $iid: String!, $reviewers: [String!]!) {
  mergeRequestSetReviewers(
    input: { projectPath: $projectPath, iid: $iid, reviewerUsernames: $reviewers, operationMode: APPEND }
  ) { errors }
}`;

const REQUEST_CHANGES_MUTATION = `mutation($projectPath: ID!, $iid: String!) {
  mergeRequestRequestChanges(input: { projectPath: $projectPath, iid: $iid }) { errors }
}`;

export class GitLabBranchDeletionRefusedError extends Schema.TaggedError<GitLabBranchDeletionRefusedError>()(
  "GitLabBranchDeletionRefusedError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    number: Schema.Int,
    reason: Schema.Literals([
      "open",
      "not-allowed",
      "source-unavailable",
      "default-branch",
      "head-changed",
    ]),
  },
) {
  get detail(): string {
    switch (this.reason) {
      case "open":
        return `Close or merge merge request !${this.number} before deleting its source branch.`;
      case "not-allowed":
        return "GitLab does not let you delete this source branch. It may be protected, or you may not be able to push to it.";
      case "source-unavailable":
        return `GitLab did not report a source project for merge request !${this.number}.`;
      case "default-branch":
        return "The source branch is its project's default branch and cannot be deleted here.";
      case "head-changed":
        return "The source branch has new commits and was not deleted.";
    }
  }

  override get message(): string {
    return `GitLab CLI failed in deleteSourceBranch: ${this.detail}`;
  }
}

export class GitLabUnknownLabelError extends Schema.TaggedError<GitLabUnknownLabelError>()(
  "GitLabUnknownLabelError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    labels: Schema.Array(Schema.String),
  },
) {
  get detail(): string {
    return `The project has no label named ${this.labels.map((label) => `"${label}"`).join(", ")}.`;
  }

  override get message(): string {
    return `GitLab CLI failed in setLabels: ${this.detail}`;
  }
}

export type GitLabPullRequestCliError =
  | GitLabCli.GitLabCliError
  | GitLabBranchDeletionRefusedError
  | GitLabMergeRequestReadError
  | GitLabUnknownLabelError
  | GitLabDiffCursorError
  | GitLabDiffCommitError
  | GitLabDiffCommitParentUnavailableError
  | GitLabDiffFileContentsUnavailableError
  | GitLabDiffRefsUnavailableError
  | GitLabViewerUnavailableError
  | GitLabMutationRefusedError;

/** GitLab's `per_page` limit. */
const MAX_PAGE_SIZE = 100;
const COMMIT_PAGE_SIZE = 100;
/**
 * GitLab 15.7 through 17.10 answer the merge request `/diffs` endpoint with a 500 for any
 * `per_page` above 30 (fixed in 17.11), so those pages stay at a size every version accepts.
 * A commit's own diff endpoint never had that bug and keeps the full page.
 */
const MERGE_REQUEST_DIFF_PAGE_SIZE = 30;
const diffPageSize = (commit: string | undefined) =>
  commit === undefined ? MERGE_REQUEST_DIFF_PAGE_SIZE : MAX_PAGE_SIZE;
const CONVERSATION_PAGES = 10;
const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 60_000;
const isVcsProcessExitError = Schema.is(VcsProcessExitError);
const DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface GitLabDiscussionThreads {
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
  readonly diffRefsByThreadId: ReadonlyMap<string, GitLabDiffRefs>;
  readonly overviewFindingIds: ReadonlyArray<string>;
  readonly truncated: boolean;
}

export interface GitLabMergeRequestListBatch {
  readonly items: ReadonlyArray<GitLabMergeRequestListItem>;
  readonly truncated: boolean;
  readonly cursorAdvance: number;
  /** GitLab's GraphQL cursor past the last row, when the page was read through GraphQL. */
  readonly resumeAfter?: string;
  /** Present when the read already carried each row's approval and pipeline state. */
  readonly listStates?: ReadonlyMap<number, GitLabMergeRequestListState>;
}

export interface GitLabMergeRequestDiffSlice {
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export class GitLabPullRequestCli extends Context.Service<
  GitLabPullRequestCli,
  {
    readonly getViewerUsername: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
    }) => Effect.Effect<string, GitLabPullRequestCliError>;

    readonly listMergeRequests: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
      readonly filters?: PullRequestListFilters | undefined;
      /**
       * Read a first page through GraphQL, which narrows more filters; see `supportsGraphqlList`.
       * A cursor keeps the API that handed it out.
       */
      readonly graphql?: boolean;
    }) => Effect.Effect<GitLabMergeRequestListBatch, GitLabPullRequestCliError>;

    /**
     * One GraphQL read of each project's first page of `first` merge requests, as
     * `listMergeRequests` reads it. Projects the reader cannot see, or that do not exist, are
     * absent from the answer. Needs `supportsGraphqlList`.
     */
    readonly listMergeRequestsInProjects: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repositories: ReadonlyArray<string>;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly first: number;
      readonly query?: string | undefined;
      readonly filters?: PullRequestListFilters | undefined;
    }) => Effect.Effect<
      ReadonlyArray<{ readonly repository: string; readonly batch: GitLabMergeRequestListBatch }>,
      GitLabPullRequestCliError
    >;

    /** Whether this host's GraphQL list takes every filter the REST list does. */
    readonly supportsGraphqlList: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
    }) => Effect.Effect<boolean, GitLabPullRequestCliError>;

    readonly getMergeRequestDetail: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      /** `false` skips the stage and trigger job reads, as write permission checks do. */
      readonly downstreamChecks?: boolean;
      /** `false` skips a fork's maintainer edits permission read, for views that never show it. */
      readonly maintainerEdits?: boolean;
    }) => Effect.Effect<GitLabMergeRequestDetail, GitLabPullRequestCliError>;

    /** Approval and head pipeline state, read in one GraphQL request per 100 merge requests. */
    readonly getListStates: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly numbers: ReadonlyArray<number>;
    }) => Effect.Effect<
      ReadonlyMap<number, GitLabMergeRequestListState>,
      GitLabPullRequestCliError
    >;

    /** Line counts for the given merge requests; one with no answer is left out. */
    readonly listMergeRequestStats: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly changeRequests: ReadonlyArray<{
        readonly repository: string;
        readonly number: number;
      }>;
    }) => Effect.Effect<
      ReadonlyArray<{
        readonly repository: string;
        readonly number: number;
        readonly additions: number;
        readonly deletions: number;
      }>,
      GitLabPullRequestCliError
    >;

    readonly getMergeRequestFileStats: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ProviderFileStats, GitLabPullRequestCliError>;

    readonly listNotes: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly comments: ReadonlyArray<PullRequestComment>; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly listCommits: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCommit>, GitLabPullRequestCliError>;

    readonly getMergeRequestDiff: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly cursor?: string | undefined;
      readonly commit?: string | undefined;
    }) => Effect.Effect<GitLabMergeRequestDiffSlice, GitLabPullRequestCliError>;

    readonly getMergeRequestDiffFileContents: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly commit?: string | undefined;
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    }) => Effect.Effect<
      { readonly oldContents: string; readonly newContents: string },
      GitLabPullRequestCliError
    >;

    readonly getProjectMergeCapabilities: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
    }) => Effect.Effect<PullRequestMergeCapabilities, GitLabPullRequestCliError>;

    readonly getFileRevisions: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly paths: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyMap<string, string>, GitLabPullRequestCliError>;

    readonly listReviewerCandidates: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly query?: string | undefined;
    }) => Effect.Effect<PullRequestReviewerCandidateList, GitLabPullRequestCliError>;

    readonly listProjectLabels: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly search?: string | undefined;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<PullRequestLabel>; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly listLabelCandidates: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestLabelCandidateList, GitLabPullRequestCliError>;

    readonly setLabels: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly labels: ReadonlyArray<string>;
      readonly applied: boolean;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly listProjectUsers: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly search?: string | undefined;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<PullRequestActor>; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly searchProjectReferences: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly search?: string | undefined;
      readonly sigil?: PullRequestReferenceSigil | undefined;
    }) => Effect.Effect<
      {
        readonly items: ReadonlyArray<PullRequestReferenceCandidate>;
        readonly truncated: boolean;
      },
      GitLabPullRequestCliError
    >;

    readonly setReviewerRequest: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<{ readonly id: string }>;
      readonly requested: boolean;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly runMergeRequestAction: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
      readonly removeAgentCreditsOnMerge?: boolean;
    }) => Effect.Effect<ProviderChangeRequestSummary | void, GitLabPullRequestCliError>;

    readonly updateMergeRequest: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly description?: string | undefined;
      readonly allowCollaboration?: boolean | undefined;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly commentOnMergeRequest: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly updateNote: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly noteId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly listDiscussions: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<GitLabDiscussionThreads, GitLabPullRequestCliError>;

    readonly submitReview: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly replyToDiscussion: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly discussionId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly setDiscussionResolution: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly discussionId: string;
      readonly resolved: boolean;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly listReactions: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      {
        readonly reactions: ReadonlyArray<PullRequestReaction>;
        readonly reactionsByNoteId: ReadonlyMap<string, ReadonlyArray<PullRequestReaction>>;
        readonly editedAtByNoteId: ReadonlyMap<string, string>;
        readonly botLogins: ReadonlySet<string>;
      },
      GitLabPullRequestCliError
    >;

    readonly setReaction: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly noteId?: string | undefined;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;
  }
>()("@t3tools/source-control-gitlab/server/GitLabPullRequestCli") {}

function projectPath(repository: string): string {
  return encodeURIComponent(repository.trim());
}

function gitLabReviewPositionLines(
  position: PullRequestReviewPosition,
):
  | { readonly new_line: number }
  | { readonly old_line: number }
  | { readonly old_line: number; readonly new_line: number } {
  switch (position.kind) {
    case "added":
      return { new_line: position.newLine };
    case "deleted":
      return { old_line: position.oldLine };
    case "context":
      return { old_line: position.oldLine, new_line: position.newLine };
  }
}

function stateParam(state: PullRequestListState): string {
  return state === "open" ? "opened" : state;
}

function involvementParams(input: {
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
}): ReadonlyArray<readonly [string, string]> {
  switch (input.involvement) {
    case "authored":
      return [["author_username", input.viewer]];
    case "reviewing":
      return [["reviewer_username", input.viewer]];
    case "all":
      return [];
  }
}

/**
 * GitLab's `labels` asks for every label it names, so only groups of one go to it; a group of
 * alternatives is left for the service to narrow. A comma would split a name in two, and `None`
 * and `Any` mean "unlabeled" and "labeled" to GitLab rather than labels of those names.
 * Review filters go only where GitLab returns every row the service's exact filter keeps.
 */
function listableLabels(filters: PullRequestListFilters) {
  const listable = (names: ReadonlyArray<string>) =>
    names.filter((name) => !name.includes(",") && !/^(?:none|any)$/iu.test(name.trim()));
  return {
    required: listable(
      (filters.labels ?? []).flatMap((group) => (group.length === 1 ? group : [])),
    ),
    excluded: listable(filters.excludedLabels ?? []),
  };
}

function filterParams(input: {
  readonly filters?: PullRequestListFilters | undefined;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
}): ReadonlyArray<readonly [string, string]> {
  const filters = input.filters;
  if (filters === undefined) return [];
  const { required, excluded } = listableLabels(filters);
  return [
    ...(required.length === 0 ? [] : [["labels", required.join(",")] as const]),
    ...(excluded.length === 0 ? [] : [["not[labels]", excluded.join(",")] as const]),
    ...(filters.author === undefined || input.involvement === "authored"
      ? []
      : [
          [
            "author_username",
            resolvePullRequestAuthorFilter(filters.author, input.viewer),
          ] as const,
        ]),
    ...(filters.draft === undefined
      ? []
      : [["wip", filters.draft === "only" ? "yes" : "no"] as const]),
    ...(filters.review === "approved"
      ? [["approved_by_usernames[]", "Any"] as const]
      : filters.review === "none"
        ? [["approved_by_ids[]", "None"] as const]
        : []),
  ];
}

interface GraphqlListFilters {
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
  readonly query?: string | undefined;
  readonly filters?: PullRequestListFilters | undefined;
}

/**
 * The GraphQL list takes the REST filters and narrows two review filters exactly: `approvedBy`
 * Any for approved, and reviewer states for changes requested. Only arguments in use are
 * declared, since GraphQL rejects a declared variable the query never reads.
 */
function graphqlListArguments(input: GraphqlListFilters & { readonly first: number }): {
  readonly declarations: string;
  readonly usages: string;
  readonly variables: Record<string, unknown>;
} {
  const filters = input.filters ?? {};
  const { required, excluded } = listableLabels(filters);
  const search = input.query?.trim() ?? "";
  const author =
    input.involvement === "authored"
      ? input.viewer
      : filters.author === undefined
        ? undefined
        : resolvePullRequestAuthorFilter(filters.author, input.viewer);
  const args: ReadonlyArray<readonly [name: string, type: string, value: unknown]> = [
    ["first", "Int!", input.first],
    ["state", "MergeRequestState", stateParam(input.state)],
    ...(author === undefined ? [] : [["authorUsername", "String", author] as const]),
    ...(input.involvement === "reviewing"
      ? [["reviewerUsername", "String", input.viewer] as const]
      : []),
    ...(search.length === 0 ? [] : [["search", "String", search] as const]),
    ...(required.length === 0 ? [] : [["labels", "[String!]", required] as const]),
    ...(filters.draft === undefined
      ? []
      : [["draft", "Boolean", filters.draft === "only"] as const]),
    ...(filters.review === "approved" ? [["approvedBy", "[String!]", ["Any"]] as const] : []),
    // Beside `reviewerUsername`, GitLab matches review states on that reviewer alone.
    ...(filters.review === "changes-requested" && input.involvement !== "reviewing"
      ? [["reviewStates", "[MergeRequestReviewState!]", ["REQUESTED_CHANGES"]] as const]
      : []),
  ];
  return {
    declarations: [
      ...args.map(([name, type]) => `$${name}: ${type}`),
      ...(excluded.length === 0 ? [] : ["$notLabels: [String!]"]),
    ].join(", "),
    usages: [
      "sort: UPDATED_DESC",
      ...args.map(([name]) => `${name}: $${name}`),
      ...(excluded.length === 0 ? [] : ["not: { labels: $notLabels }"]),
    ].join(", "),
    variables: {
      ...Object.fromEntries(args.map(([name, , value]) => [name, value])),
      ...(excluded.length === 0 ? {} : { notLabels: excluded }),
    },
  };
}

function graphqlListQuery(
  input: GraphqlListFilters & {
    readonly repository: string;
    readonly first: number;
    readonly after: string | undefined;
  },
): { readonly query: string; readonly variables: Record<string, unknown> } {
  const { declarations, usages, variables } = graphqlListArguments(input);
  return {
    query: `query($fullPath: ID!, $after: String, ${declarations}) {
  metadata { enterprise }
  project(fullPath: $fullPath) {
    mergeRequests(after: $after, ${usages}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${LIST_ITEM_GRAPHQL_FIELDS} }
    }
  }
}`,
    variables: { fullPath: input.repository.trim(), after: input.after ?? null, ...variables },
  };
}

/** The same list's newest `first` rows in each of several projects. */
function graphqlProjectsListQuery(
  input: GraphqlListFilters & {
    readonly repositories: ReadonlyArray<string>;
    readonly first: number;
  },
): { readonly query: string; readonly variables: Record<string, unknown> } {
  const { declarations, usages, variables } = graphqlListArguments(input);
  return {
    query: `query($fullPaths: [String!], $projectCount: Int!, ${declarations}) {
  metadata { enterprise }
  projects(fullPaths: $fullPaths, first: $projectCount) {
    nodes {
      fullPath
      mergeRequests(${usages}) {
        pageInfo { hasNextPage endCursor }
        nodes { ${LIST_ITEM_GRAPHQL_FIELDS} }
      }
    }
  }
}`,
    variables: {
      fullPaths: input.repositories.map((repository) => repository.trim()),
      projectCount: input.repositories.length,
      ...variables,
    },
  };
}

/** The list cursor carries GitLab's own position only when it fits the cursor's alphabet. */
const RESUME_AFTER_PATTERN = /^[\w.:~+-]{1,128}$/u;

function resumeAfterOf(endCursor: string | null): string | undefined {
  return endCursor !== null && RESUME_AFTER_PATTERN.test(endCursor) ? endCursor : undefined;
}

function graphqlListBatch(input: {
  readonly items: ReadonlyArray<GitLabMergeRequestListItem>;
  readonly states: ReadonlyMap<number, GitLabMergeRequestListState>;
  readonly cursorAdvance: number;
  readonly page: GitLabMergeRequestGraphqlPage;
}): GitLabMergeRequestListBatch {
  const resumeAfter = resumeAfterOf(input.page.endCursor);
  return {
    items: input.items,
    truncated: input.page.hasNextPage,
    cursorAdvance: input.cursorAdvance,
    ...(resumeAfter === undefined ? {} : { resumeAfter }),
    listStates: input.states,
  };
}

function diffCursorPage(cursor: string): number | null {
  return /^[1-9][0-9]{0,6}$/.test(cursor) ? Number(cursor) : null;
}

function searchParams(search: string | undefined): ReadonlyArray<readonly [string, string]> {
  const trimmed = search?.trim() ?? "";
  return trimmed.length === 0 ? [] : [["search", trimmed]];
}

// GitLab's user, issue and merge request searches answer nothing under three characters, so
// shorter text reads the unsearched page, which the server narrows.
function hostSearchParams(search: string | undefined): ReadonlyArray<readonly [string, string]> {
  return (search?.trim().length ?? 0) >= 3 ? searchParams(search) : [];
}

const REFERENCE_PAGE_SIZE = 20;

/**
 * Recently updated issues and merge requests, by title for text. Issue and MR search cannot match
 * a number, so a numeric query also asks for that iid of each.
 */
export function referenceSearches(
  search: string | undefined,
  sigil?: PullRequestReferenceSigil | undefined,
): ReadonlyArray<{
  readonly kind: PullRequestReferenceCandidate["kind"];
  readonly params: ReadonlyArray<readonly [string, string]>;
}> {
  const text = search?.trim() ?? "";
  const numeric = /^\d+$/.test(text);
  const recent: ReadonlyArray<readonly [string, string]> = [
    ["order_by", "updated_at"],
    ["sort", "desc"],
    ...(numeric || hostSearchParams(text).length === 0
      ? []
      : ([...hostSearchParams(text), ["in", "title"]] as const)),
  ];
  const kinds =
    sigil === "#"
      ? (["issue"] as const)
      : sigil === "!"
        ? (["change-request"] as const)
        : (["issue", "change-request"] as const);
  return [
    ...(numeric ? kinds.map((kind) => ({ kind, params: [["iids[]", text]] as const })) : []),
    ...kinds.map((kind) => ({ kind, params: recent })),
  ];
}

function mergeReferencePages(
  pages: ReadonlyArray<{
    readonly items: ReadonlyArray<PullRequestReferenceCandidate>;
    readonly rawCount: number;
  }>,
) {
  return {
    items: pages.flatMap((page) => page.items),
    truncated: pages.some((page) => page.rawCount >= REFERENCE_PAGE_SIZE),
  };
}

function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

function actionArgs(
  action: PullRequestAction,
  mergeMethod: PullRequestMergeMethod | undefined,
): ReadonlyArray<string> {
  switch (action) {
    case "merge":
      return [
        "merge",
        // glab defaults to auto-merge during a running pipeline.
        "--auto-merge=false",
        "--yes",
        ...(mergeMethod === "squash" ? ["--squash"] : []),
      ];
    case "enable-auto-merge":
      return [
        "merge",
        "--auto-merge=true",
        "--yes",
        ...(mergeMethod === "squash" ? ["--squash"] : []),
      ];
    case "disable-auto-merge":
      return [];
    case "ready":
      return ["update", "--ready"];
    case "draft":
      return ["update", "--draft"];
    case "close":
      return ["close"];
    case "update-branch":
      return ["rebase"];
    case "reopen":
      return ["reopen"];
    case "revert":
    case "approve-workflows":
    case "delete-branch":
      throw new Error(`GitLab merge request action ${action} is unsupported`);
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const gitlab = yield* GitLabCli.GitLabCli;

  const api = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly path: string;
    readonly method?: string;
    readonly stdin?: string;
    readonly headers?: ReadonlyArray<string>;
    readonly maxOutputBytes?: number;
    readonly timeoutMs?: number;
  }) =>
    gitlab.execute({
      cwd: input.cwd,
      host: input.host,
      args: [
        "api",
        input.path,
        ...(input.method === undefined ? [] : ["--method", input.method]),
        // glab --input keeps payloads out of argv/logs but omits GitLab's required Content-Type.
        ...(input.stdin === undefined
          ? []
          : ["--input", "-", "--header", "Content-Type: application/json"]),
        ...(input.headers ?? []).flatMap((header) => ["--header", header]),
      ],
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });

  const listPage = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly limit: number;
    readonly query?: string | undefined;
    readonly cursor?: ProviderListCursor | undefined;
    readonly filters?: PullRequestListFilters | undefined;
    readonly page: number;
    readonly collected: ReadonlyArray<GitLabMergeRequestListItem>;
    readonly cursorAdvance: number;
  }): Effect.Effect<GitLabMergeRequestListBatch, GitLabPullRequestCliError> => {
    // GitLab's timestamp filter can repeat equal-time pages forever; use offsets.
    const delivered = input.cursor?.delivered ?? 0;
    const perPage = Math.min(input.limit + 1, MAX_PAGE_SIZE);
    const firstPage = Math.floor(delivered / perPage) + 1;
    const skipOnFirstPage = input.page === firstPage ? delivered % perPage : 0;
    // Bound raw pages to stop recursion on entirely malformed results.
    const lastPage = Math.floor((delivered + input.limit) / perPage) + 1;
    return api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/merge_requests?${query([
        ["state", stateParam(input.state)],
        ...involvementParams(input),
        ...searchParams(input.query),
        ...filterParams(input),
        ["order_by", "updated_at"],
        ["sort", "desc"],
        ["per_page", String(perPage)],
        ["page", String(input.page)],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const raw = result.stdout.trim();
        if (raw.length === 0) {
          return Effect.succeed({
            items: input.collected,
            truncated: false,
            cursorAdvance: input.cursorAdvance,
          });
        }
        const decoded = decodeMergeRequestListJson(raw);
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "listMergeRequests",
              cause: decoded.failure,
            }),
          );
        }
        const pageItems: GitLabMergeRequestListItem[] = [];
        const pageRawIndexes: number[] = [];
        for (const [index, item] of decoded.success.items.entries()) {
          const rawIndex = decoded.success.rawIndexes[index]!;
          if (rawIndex < skipOnFirstPage) continue;
          pageItems.push(item);
          pageRawIndexes.push(rawIndex);
        }
        const remaining = input.limit - input.collected.length;
        const lastItemRawIndex = pageRawIndexes[remaining - 1];
        if (lastItemRawIndex !== undefined) {
          const consumed = lastItemRawIndex + 1 - skipOnFirstPage;
          return Effect.succeed({
            items: [...input.collected, ...pageItems.slice(0, remaining)],
            truncated:
              lastItemRawIndex + 1 < decoded.success.rawCount ||
              decoded.success.rawCount === perPage,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }
        const collected = [...input.collected, ...pageItems];
        const consumed = Math.max(0, decoded.success.rawCount - skipOnFirstPage);
        // Count malformed rows to avoid ending pagination early.
        const exhausted = decoded.success.rawCount < perPage;
        if (exhausted) {
          return Effect.succeed({
            items: collected,
            truncated: false,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }
        if (input.page >= lastPage) {
          return Effect.succeed({
            items: collected,
            truncated: true,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }
        return listPage({
          ...input,
          page: input.page + 1,
          collected,
          cursorAdvance: input.cursorAdvance + consumed,
        });
      }),
    );
  };

  const diffPage = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
    readonly page: number;
    readonly commit?: string | undefined;
  }): Effect.Effect<GitLabMergeRequestDiffSlice, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/${
        input.commit === undefined
          ? `merge_requests/${input.number}/diffs`
          : `repository/commits/${input.commit}/diff`
      }?${query([
        ["per_page", String(diffPageSize(input.commit))],
        ["page", String(input.page)],
      ])}`,
      maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
      timeoutMs: DIFF_TIMEOUT_MS,
    }).pipe(
      Effect.map((result) => ({ result, legacy: false })),
      Effect.catchTags({
        GitLabCliCommandError: (error) => {
          if (
            input.commit !== undefined ||
            input.page !== 1 ||
            !isVcsProcessExitError(error.cause) ||
            error.cause.failureKind !== "not-found"
          ) {
            return Effect.fail(error);
          }
          // GitLab before 15.7 has no /diffs endpoint. /changes returns one complete slice.
          return api({
            cwd: input.cwd,
            host: input.host,
            path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/changes?access_raw_diffs=true`,
            maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
            timeoutMs: DIFF_TIMEOUT_MS,
          }).pipe(Effect.map((result) => ({ result, legacy: true })));
        },
      }),
      Effect.flatMap(({ result, legacy }) => {
        // Returning no cursor for byte-truncated JSON would lose subsequent pages.
        if (result.stdoutTruncated) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "getMergeRequestDiff",
              cause: new Error(
                `Page ${input.page} of the merge request diff was too large to read.`,
              ),
            }),
          );
        }
        const decoded = (legacy ? decodeMergeRequestChangesJson : decodeMergeRequestDiffsJson)(
          result.stdout.trim(),
        );
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "getMergeRequestDiff",
              cause: decoded.failure,
            }),
          );
        }
        const patch = decoded.success.patch;
        // Counted before decoding, so a page whose files all failed to decode still moves on
        // rather than pointing the reader back at the page it just read.
        const morePages = !legacy && decoded.success.rawCount >= diffPageSize(input.commit);
        return Effect.succeed({
          // Terminate slices so a hunkless header cannot run into the next slice.
          patch: patch.length === 0 ? patch : patch.replace(/\n?$/, "\n"),
          truncated: decoded.success.truncated,
          nextCursor: morePages ? String(input.page + 1) : null,
        });
      }),
    );

  const notesPage = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
    readonly page: number;
    readonly collected: ReadonlyArray<PullRequestComment>;
  }): Effect.Effect<
    { readonly comments: ReadonlyArray<PullRequestComment>; readonly truncated: boolean },
    GitLabPullRequestCliError
  > =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/notes?${query(
        [
          ["per_page", String(MAX_PAGE_SIZE)],
          ["page", String(input.page)],
          ["order_by", "created_at"],
          ["sort", "asc"],
        ],
      )}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeNotesJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "listNotes",
              cause: decoded.failure,
            }),
          );
        }
        const collected = [...input.collected, ...decoded.success.comments];
        if (decoded.success.rawCount < MAX_PAGE_SIZE) {
          return Effect.succeed({ comments: collected, truncated: false });
        }
        return input.page >= CONVERSATION_PAGES
          ? Effect.succeed({ comments: collected, truncated: true })
          : notesPage({ ...input, page: input.page + 1, collected });
      }),
    );

  const discussionsPage = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
    readonly page: number;
    readonly collected: ReadonlyArray<PullRequestReviewThread>;
    readonly collectedDiffRefs: ReadonlyMap<string, GitLabDiffRefs>;
    readonly collectedFindingIds: ReadonlyArray<string>;
  }): Effect.Effect<GitLabDiscussionThreads, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/discussions?${query(
        [
          ["per_page", String(MAX_PAGE_SIZE)],
          ["page", String(input.page)],
        ],
      )}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeDiscussionsJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "listDiscussions",
              cause: decoded.failure,
            }),
          );
        }
        const collected = [...input.collected, ...decoded.success.threads];
        const collectedDiffRefs = new Map([
          ...input.collectedDiffRefs,
          ...decoded.success.diffRefsByThreadId,
        ]);
        const collectedFindingIds = [
          ...input.collectedFindingIds,
          ...decoded.success.overviewFindingIds,
        ];
        const read = (truncated: boolean) => ({
          threads: collected,
          diffRefsByThreadId: collectedDiffRefs,
          overviewFindingIds: collectedFindingIds,
          truncated,
        });
        // Plain notes count toward the page size even when no positioned threads survive decoding.
        if (decoded.success.rawCount < MAX_PAGE_SIZE) return Effect.succeed(read(false));
        return input.page >= CONVERSATION_PAGES
          ? Effect.succeed(read(true))
          : discussionsPage({
              ...input,
              page: input.page + 1,
              collected,
              collectedDiffRefs,
              collectedFindingIds,
            });
      }),
    );

  const getDiffRefs = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
  }): Effect.Effect<GitLabDiffRefs, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}`,
    }).pipe(
      Effect.flatMap((result): Effect.Effect<GitLabDiffRefs, GitLabPullRequestCliError> => {
        const decoded = decodeDiffRefsJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "getDiffRefs",
              cause: decoded.failure,
            }),
          );
        }
        return decoded.success === null
          ? Effect.fail(
              new GitLabDiffRefsUnavailableError({
                command: "glab",
                cwd: input.cwd,
                number: input.number,
              }),
            )
          : Effect.succeed(decoded.success);
      }),
    );

  const getCommitDiffRefs = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly commit: string;
    readonly allowRoot: boolean;
  }): Effect.Effect<GitLabDiffRefs, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/repository/commits/${input.commit}`,
    }).pipe(
      Effect.flatMap((result): Effect.Effect<GitLabDiffRefs, GitLabPullRequestCliError> => {
        const decoded = decodeCommitDiffRefsJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "getMergeRequestDiffFileContents",
              cause: decoded.failure,
            }),
          );
        }
        return decoded.success === null
          ? input.allowRoot
            ? Effect.succeed({
                baseSha: "",
                headSha: input.commit,
                startSha: "",
              })
            : Effect.fail(
                new GitLabDiffCommitParentUnavailableError({
                  command: "glab",
                  cwd: input.cwd,
                  commit: input.commit,
                }),
              )
          : Effect.succeed(decoded.success);
      }),
    );

  const mergeRequestDetail = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
  }): Effect.Effect<GitLabMergeRequestDetail, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}?${query([
        ["include_diverged_commits_count", "true"],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeMergeRequestDetailJson(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new GitLabMergeRequestReadError({
                command: "glab",
                cwd: input.cwd,
                operation: "getMergeRequestDetail",
                cause: decoded.failure,
              }),
            );
      }),
    );

  // Best-effort: a trigger job read that fails, or a full page that may have left out the one
  // whose pipeline failed, adds no rows and leaves the detail as it was.
  const triggerJobChecks = (input: {
    readonly cwd: string;
    readonly pipeline: { readonly id: number; readonly projectId: number };
  }): Effect.Effect<ReadonlyArray<PullRequestCheck>> =>
    api({
      cwd: input.cwd,
      // `bridges` rather than `trigger_jobs`: GitLab 19.2 deprecates it but still serves it, and
      // older self-managed installs know no other name.
      path: `projects/${input.pipeline.projectId}/pipelines/${input.pipeline.id}/bridges?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
      ])}`,
    }).pipe(
      Effect.map((result) => {
        const decoded = decodeTriggerJobChecksJson(result.stdout.trim());
        return Result.isSuccess(decoded) && decoded.success.rawCount < MAX_PAGE_SIZE
          ? decoded.success.checks
          : [];
      }),
      Effect.orElseSucceed((): ReadonlyArray<PullRequestCheck> => []),
    );

  // Best-effort: stages that can't be read keep the merge request's single pipeline check.
  const pipelineStageChecks = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
    readonly url: string;
  }): Effect.Effect<ReadonlyArray<PullRequestCheck> | null> =>
    URL.canParse(input.url)
      ? graphqlRead({
          cwd: input.cwd,
          host: input.host,
          operation: "getPipelineStageChecks",
          query: PIPELINE_STAGES_GRAPHQL_QUERY,
          variables: { fullPath: input.repository, iid: String(input.number) },
          decode: (raw) => decodePipelineStageChecksJson(raw, new URL(input.url).origin),
        }).pipe(Effect.orElseSucceed(() => null))
      : Effect.succeed(null);

  const projectUsers = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly search?: string | undefined;
  }): Effect.Effect<GitLabProjectUsers, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/users?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
        ...hostSearchParams(input.search),
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeProjectUsersJson(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new GitLabMergeRequestReadError({
                command: "glab",
                cwd: input.cwd,
                operation: "listReviewerCandidates",
                cause: decoded.failure,
              }),
            );
      }),
    );

  const projectReferences = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly kind: PullRequestReferenceCandidate["kind"];
    readonly params: ReadonlyArray<readonly [string, string]>;
  }) =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/${
        input.kind === "issue" ? "issues" : "merge_requests"
      }?${query([...input.params, ["per_page", String(REFERENCE_PAGE_SIZE)]])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeReferenceCandidatesJson(result.stdout.trim(), input.kind);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new GitLabMergeRequestReadError({
                command: "glab",
                cwd: input.cwd,
                operation: "searchProjectReferences",
                cause: decoded.failure,
              }),
            );
      }),
    );

  const awardSubjectPath = (input: {
    readonly repository: string;
    readonly number: number;
    readonly noteId?: string | undefined;
  }) => {
    const mergeRequest = `projects/${projectPath(input.repository)}/merge_requests/${input.number}`;
    return input.noteId === undefined
      ? `${mergeRequest}/award_emoji`
      : `${mergeRequest}/notes/${encodeURIComponent(input.noteId)}/award_emoji`;
  };

  const awardsPage = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
    readonly cursor: string | null;
    readonly page: number;
    readonly collected: {
      readonly reactions: ReadonlyArray<PullRequestReaction>;
      readonly reactionsByNoteId: Map<string, ReadonlyArray<PullRequestReaction>>;
      readonly editedAtByNoteId: Map<string, string>;
      readonly botLogins: Set<string>;
    } | null;
  }): Effect.Effect<
    {
      readonly reactions: ReadonlyArray<PullRequestReaction>;
      readonly reactionsByNoteId: ReadonlyMap<string, ReadonlyArray<PullRequestReaction>>;
      readonly editedAtByNoteId: ReadonlyMap<string, string>;
      readonly botLogins: ReadonlySet<string>;
    },
    GitLabPullRequestCliError
  > =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: "graphql",
      method: "POST",
      stdin: JSON.stringify({
        query: AWARD_EMOJI_GRAPHQL_QUERY,
        variables: {
          fullPath: input.repository,
          iid: String(input.number),
          cursor: input.cursor,
        },
      }),
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeAwardEmojiJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "listReactions",
              cause: decoded.failure,
            }),
          );
        }
        const collected = input.collected ?? {
          reactions: decoded.success.reactions,
          reactionsByNoteId: new Map<string, ReadonlyArray<PullRequestReaction>>(),
          editedAtByNoteId: new Map<string, string>(),
          botLogins: new Set<string>(),
        };
        for (const [id, reactions] of decoded.success.reactionsByNoteId)
          collected.reactionsByNoteId.set(id, reactions);
        for (const [id, editedAt] of decoded.success.editedAtByNoteId)
          collected.editedAtByNoteId.set(id, editedAt);
        for (const login of decoded.success.botLogins) collected.botLogins.add(login);
        return decoded.success.nextCursor === null || input.page >= CONVERSATION_PAGES
          ? Effect.succeed(collected)
          : awardsPage({
              ...input,
              cursor: decoded.success.nextCursor,
              page: input.page + 1,
              collected,
            });
      }),
    );

  /** The stats connection hands back one page, so a repository's rows are asked for 100 at a time. */
  const STAT_IIDS_PER_REQUEST = 100;

  const projectLabels = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly search?: string | undefined;
  }) =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/labels?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
        ["include_ancestor_groups", "true"],
        ...searchParams(input.search),
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeProjectLabelsJson(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed({
              labels: decoded.success.labels,
              truncated: decoded.success.rawCount >= MAX_PAGE_SIZE,
            })
          : Effect.fail(
              new GitLabMergeRequestReadError({
                command: "glab",
                cwd: input.cwd,
                operation: "listProjectLabels",
                cause: decoded.failure,
              }),
            );
      }),
    );

  const graphqlRead = <A>(input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly operation: string;
    readonly query: string;
    readonly variables: Record<string, unknown>;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }) =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: "graphql",
      method: "POST",
      stdin: JSON.stringify({ query: input.query, variables: input.variables }),
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = input.decode(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new GitLabMergeRequestReadError({
                command: "glab",
                cwd: input.cwd,
                operation: input.operation,
                cause: decoded.failure,
              }),
            );
      }),
    );

  // A read GitLab could not answer (an older host, a field it rejects) is not worth failing the
  // surrounding operation for. An unusable CLI or account still reaches the caller.
  const isOptionalReadFailure = (cause: GitLabPullRequestCliError) =>
    cause._tag !== "GitLabCliUnavailableError" &&
    cause._tag !== "GitLabCliAuthenticationError" &&
    cause._tag !== "GitLabCliRateLimitError";

  const orWhenUnanswered = <A>(
    read: Effect.Effect<A, GitLabPullRequestCliError>,
    fallback: A,
  ): Effect.Effect<A, GitLabPullRequestCliError> =>
    read.pipe(Effect.catchIf(isOptionalReadFailure, () => Effect.succeed(fallback)));

  const graphqlMutation = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly operation: string;
    readonly query: string;
    readonly variables: Record<string, unknown>;
  }) =>
    graphqlRead({ ...input, decode: decodeMutationErrorsJson }).pipe(
      Effect.flatMap((reasons) =>
        reasons.length === 0
          ? Effect.void
          : Effect.fail(
              new GitLabMutationRefusedError({
                command: "glab",
                cwd: input.cwd,
                operation: input.operation,
                reasons,
              }),
            ),
      ),
    );

  const graphqlListPage = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly limit: number;
    readonly query?: string | undefined;
    readonly filters?: PullRequestListFilters | undefined;
    readonly after: string | undefined;
    readonly collected: ReadonlyArray<GitLabMergeRequestListItem>;
    readonly states: ReadonlyMap<number, GitLabMergeRequestListState>;
    readonly cursorAdvance: number;
    /** Bounds the walk when whole pages fail to decode. */
    readonly reads: number;
  }): Effect.Effect<GitLabMergeRequestListBatch, GitLabPullRequestCliError> =>
    graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "listMergeRequests",
      ...graphqlListQuery({
        ...input,
        first: Math.max(1, Math.min(input.limit - input.collected.length, MAX_PAGE_SIZE)),
      }),
      decode: decodeMergeRequestGraphqlListJson,
    }).pipe(
      Effect.flatMap((page) => {
        const collected = [...input.collected, ...page.items];
        const states = new Map([...input.states, ...page.states]);
        const cursorAdvance = input.cursorAdvance + page.rawCount;
        const resumeAfter = resumeAfterOf(page.endCursor);
        if (
          page.hasNextPage &&
          resumeAfter !== undefined &&
          collected.length < input.limit &&
          input.reads > 1
        ) {
          return graphqlListPage({
            ...input,
            after: resumeAfter,
            collected,
            states,
            cursorAdvance,
            reads: input.reads - 1,
          });
        }
        return Effect.succeed(graphqlListBatch({ items: collected, states, cursorAdvance, page }));
      }),
    );

  const labelPermission = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
  }) =>
    graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "getLabelPermission",
      query: LABEL_PERMISSION_GRAPHQL_QUERY,
      variables: { fullPath: input.repository, iid: String(input.number) },
      decode: decodeLabelPermissionJson,
    }).pipe(Effect.catchIf(isOptionalReadFailure, () => Effect.succeed(false)));

  const sourceBranch = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
  }) =>
    graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "getSourceBranch",
      query: SOURCE_BRANCH_GRAPHQL_QUERY,
      variables: { fullPath: input.repository, iid: String(input.number) },
      decode: decodeSourceBranchJson,
    });

  const deleteSourceBranch = Effect.fn("GitLabPullRequestCli.deleteSourceBranch")(
    function* (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) {
      const refuse = (reason: GitLabBranchDeletionRefusedError["reason"]) =>
        new GitLabBranchDeletionRefusedError({
          command: "glab",
          cwd: input.cwd,
          number: input.number,
          reason,
        });
      const source = yield* sourceBranch(input);
      if (source === null) {
        return yield* new GitLabMergeRequestReadError({
          command: "glab",
          cwd: input.cwd,
          operation: "getSourceBranch",
          cause: new Error("GitLab reported no merge request."),
        });
      }
      if (source.open) return yield* refuse("open");
      if (!source.canDelete) return yield* refuse("not-allowed");
      if (source.sourceProject === null || source.headSha === null) {
        return yield* refuse("source-unavailable");
      }
      const path = `projects/${projectPath(source.sourceProject)}/repository/branches/${encodeURIComponent(source.branch)}`;
      const branch = yield* api({ cwd: input.cwd, host: input.host, path }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeBranchJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: input.cwd,
                  operation: "getSourceBranch",
                  cause: decoded.failure,
                }),
              );
        }),
      );
      if (branch.isDefault) return yield* refuse("default-branch");
      if (branch.headSha !== source.headSha) return yield* refuse("head-changed");
      // GitLab's branch delete takes no expected SHA. It answers 412 when the head's authored
      // date is newer than If-Unmodified-Since, which catches a commit pushed after this read but
      // not a force-push of an older-dated commit (a rebase keeps author dates).
      const authoredAt =
        branch.headAuthoredDate === null ? Option.none() : DateTime.make(branch.headAuthoredDate);
      yield* api({
        cwd: input.cwd,
        host: input.host,
        path,
        method: "DELETE",
        ...(Option.isNone(authoredAt)
          ? {}
          : {
              headers: [
                `If-Unmodified-Since: ${DateTime.toDateUtc(authoredAt.value).toUTCString()}`,
              ],
            }),
      });
    },
  );

  const mergeRequestStats = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly numbers: ReadonlyArray<number>;
  }) =>
    graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "listMergeRequestStats",
      query: MERGE_REQUEST_STATS_GRAPHQL_QUERY,
      variables: { fullPath: input.repository, iids: input.numbers.map(String) },
      decode: decodeMergeRequestStatsJson,
    });

  const STAT_REQUEST_CONCURRENCY = 4;

  const listMergeRequestStats: GitLabPullRequestCli["Service"]["listMergeRequestStats"] = (
    input,
  ) => {
    const byRepository = new Map<string, Set<number>>();
    for (const { repository, number } of input.changeRequests) {
      const numbers = byRepository.get(repository) ?? new Set<number>();
      numbers.add(number);
      byRepository.set(repository, numbers);
    }
    const reads: Array<{ readonly repository: string; readonly numbers: ReadonlyArray<number> }> =
      [];
    for (const [repository, numberSet] of byRepository) {
      const numbers = [...numberSet];
      for (let start = 0; start < numbers.length; start += STAT_IIDS_PER_REQUEST) {
        reads.push({ repository, numbers: numbers.slice(start, start + STAT_IIDS_PER_REQUEST) });
      }
    }
    return Effect.forEach(
      reads,
      (read) =>
        mergeRequestStats({ cwd: input.cwd, host: input.host, ...read }).pipe(
          Effect.map((stats) =>
            read.numbers.flatMap((number) => {
              const stat = stats.get(number);
              return stat === undefined ? [] : [{ repository: read.repository, number, ...stat }];
            }),
          ),
          // One failed read costs its own rows their counts, not every other read's on the page.
          Effect.catchIf(isOptionalReadFailure, (cause) =>
            Effect.logWarning("GitLab merge request line count read failed", {
              repository: read.repository,
              reason: cause._tag,
            }).pipe(Effect.as([])),
          ),
        ),
      { concurrency: STAT_REQUEST_CONCURRENCY },
    ).pipe(Effect.map((results) => results.flat()));
  };

  // GitLab charges by path count and returns one connection page; respect both limits.
  const BLOB_PATHS_PER_REQUEST = 100;

  const blobsAt = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly ref: string;
    readonly paths: ReadonlyArray<string>;
  }): Effect.Effect<ReadonlyMap<string, string> | null, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: "graphql",
      method: "POST",
      stdin: JSON.stringify({
        query: REPOSITORY_BLOBS_GRAPHQL_QUERY,
        variables: { fullPath: input.repository, ref: input.ref, paths: input.paths },
      }),
    }).pipe(
      Effect.flatMap(
        (result): Effect.Effect<ReadonlyMap<string, string> | null, GitLabPullRequestCliError> => {
          const decoded = decodeRepositoryBlobsJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: input.cwd,
                  operation: "getFileRevisions",
                  cause: decoded.failure,
                }),
              );
        },
      ),
    );

  const fileRevisions = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
    readonly paths: ReadonlyArray<string>;
  }): Effect.Effect<ReadonlyMap<string, string>, GitLabPullRequestCliError> =>
    input.paths.length === 0
      ? Effect.succeed(new Map())
      : getDiffRefs(input).pipe(
          Effect.flatMap((refs) => {
            const batches: Array<ReadonlyArray<string>> = [];
            for (let at = 0; at < input.paths.length; at += BLOB_PATHS_PER_REQUEST) {
              batches.push(input.paths.slice(at, at + BLOB_PATHS_PER_REQUEST));
            }
            return Effect.forEach(
              batches,
              (paths) =>
                blobsAt({ ...input, ref: refs.headSha, paths }).pipe(
                  Effect.map((page) => ({ paths, page })),
                ),
              { concurrency: 2 },
            ).pipe(
              Effect.map((pages) => {
                const revisions = new Map<string, string>();
                for (const { paths, page } of pages) {
                  // Unanswered paths are unknown; omit them to preserve viewed marks.
                  if (page === null) continue;
                  for (const [path, oid] of page) revisions.set(path, oid);
                  for (const path of paths) {
                    if (!revisions.has(path)) revisions.set(path, "");
                  }
                }
                return revisions as ReadonlyMap<string, string>;
              }),
            );
          }),
        );

  const listStatesOf = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly numbers: ReadonlyArray<number>;
  }): Effect.Effect<ReadonlyMap<number, GitLabMergeRequestListState>, GitLabPullRequestCliError> =>
    graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "getListStates",
      query: LIST_STATES_GRAPHQL_QUERY,
      variables: { fullPath: input.repository, iids: input.numbers.map(String) },
      decode: decodeListStatesJson,
    });

  const viewerUsername = (input: { readonly cwd: string; readonly host?: string | undefined }) =>
    api({ cwd: input.cwd, host: input.host, path: "user" }).pipe(
      Effect.flatMap((result): Effect.Effect<string, GitLabPullRequestCliError> => {
        const decoded = decodeViewerJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "getViewerUsername",
              cause: decoded.failure,
            }),
          );
        }
        return decoded.success === null
          ? Effect.fail(new GitLabViewerUnavailableError({ command: "glab", cwd: input.cwd }))
          : Effect.succeed(decoded.success);
      }),
    );

  return GitLabPullRequestCli.of({
    getViewerUsername: viewerUsername,

    listMergeRequests: Effect.fn("GitLabPullRequestCli.listMergeRequests")(function (input) {
      const perPage = Math.min(input.limit + 1, MAX_PAGE_SIZE);
      const page = Math.floor((input.cursor?.delivered ?? 0) / perPage) + 1;
      const rest = Effect.suspend(() =>
        listPage({ ...input, page, collected: [], cursorAdvance: 0 }),
      );
      // A cursor's offset means something only to the API that handed it out.
      const viaGraphql =
        input.cursor === undefined
          ? input.graphql === true
          : input.cursor.resumeAfter !== undefined;
      if (!viaGraphql) return rest;
      const graphql = graphqlListPage({
        ...input,
        after: input.cursor?.resumeAfter,
        collected: [],
        states: new Map(),
        cursorAdvance: 0,
        reads: Math.ceil(input.limit / MAX_PAGE_SIZE) + 1,
      });
      // GraphQL counts only filtered rows, so its `delivered` is no REST offset once resumed.
      if (input.cursor !== undefined) return graphql;
      return graphql.pipe(
        Effect.catchIf(
          (cause) =>
            cause._tag !== "GitLabCliUnavailableError" &&
            cause._tag !== "GitLabCliAuthenticationError" &&
            cause._tag !== "GitLabCliRateLimitError",
          (cause) =>
            Effect.logWarning("GitLab GraphQL merge request list failed; reading REST instead", {
              repository: input.repository,
              reason: cause._tag,
            }).pipe(Effect.andThen(rest)),
        ),
      );
    }),

    listMergeRequestsInProjects: Effect.fn("GitLabPullRequestCli.listMergeRequestsInProjects")(
      (input) =>
        graphqlRead({
          cwd: input.cwd,
          host: input.host,
          operation: "listMergeRequestsInProjects",
          ...graphqlProjectsListQuery({
            ...input,
            first: Math.max(1, Math.min(input.first, MAX_PAGE_SIZE)),
          }),
          decode: decodeMergeRequestGraphqlProjectsListJson,
        }).pipe(
          Effect.map((projects) =>
            projects.map(({ repository, page }) => ({
              repository,
              batch: graphqlListBatch({
                items: page.items,
                states: page.states,
                cursorAdvance: page.rawCount,
                page,
              }),
            })),
          ),
        ),
    ),

    supportsGraphqlList: Effect.fn("GitLabPullRequestCli.supportsGraphqlList")((input) =>
      graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "supportsGraphqlList",
        query: SERVER_VERSION_GRAPHQL_QUERY,
        variables: {},
        decode: decodeGraphqlListSupportJson,
      }),
    ),

    getMergeRequestDetail: Effect.fn("GitLabPullRequestCli.getMergeRequestDetail")(
      function* (input) {
        const [read, viewerCanEditLabels] = yield* Effect.all(
          [mergeRequestDetail(input), labelPermission(input)],
          { concurrency: 2 },
        );
        // Only a closed or merged merge request offers its branch for deletion, and only an open
        // fork's has maintainer edits to change, so each extra read is skipped elsewhere.
        const detail =
          read.state === "open"
            ? input.maintainerEdits === false || read.maintainerCanModify === undefined
              ? { ...read, viewerCanEditLabels }
              : {
                  ...read,
                  viewerCanEditLabels,
                  viewerCanEditMaintainerEdits: yield* orWhenUnanswered(
                    graphqlRead({
                      cwd: input.cwd,
                      host: input.host,
                      operation: "getMaintainerEditsPermission",
                      query: MAINTAINER_EDITS_PERMISSION_GRAPHQL_QUERY,
                      variables: { fullPath: input.repository, iid: String(input.number) },
                      decode: decodeMaintainerEditsPermissionJson,
                    }),
                    false,
                  ),
                }
            : {
                ...read,
                viewerCanEditLabels,
                viewerCanDeleteBranch: yield* orWhenUnanswered(
                  sourceBranch(input).pipe(Effect.map((source) => source?.canDelete === true)),
                  false,
                ),
              };
        if (input.downstreamChecks === false || detail.headPipeline === undefined) return detail;
        // The stages already carry each trigger job's downstream pipeline.
        const stages = yield* pipelineStageChecks({ ...input, url: detail.url });
        if (stages !== null) return { ...detail, checks: stages };
        const downstream = yield* triggerJobChecks({
          cwd: input.cwd,
          pipeline: detail.headPipeline,
        });
        return downstream.length === 0
          ? detail
          : { ...detail, checks: [...detail.checks, ...downstream] };
      },
    ),

    getListStates: Effect.fn("GitLabPullRequestCli.getListStates")(function (input) {
      const batches: Array<ReadonlyArray<number>> = [];
      for (let at = 0; at < input.numbers.length; at += MAX_PAGE_SIZE) {
        batches.push(input.numbers.slice(at, at + MAX_PAGE_SIZE));
      }
      return Effect.forEach(batches, (numbers) => listStatesOf({ ...input, numbers }), {
        concurrency: 2,
      }).pipe(Effect.map((pages) => new Map(pages.flatMap((page) => [...page]))));
    }),

    listMergeRequestStats,

    getMergeRequestFileStats: Effect.fn("GitLabPullRequestCli.getMergeRequestFileStats")((input) =>
      graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getMergeRequestFileStats",
        query: MERGE_REQUEST_FILE_STATS_GRAPHQL_QUERY,
        variables: { fullPath: input.repository, iid: String(input.number) },
        decode: decodeMergeRequestFileStatsJson,
      }),
    ),

    listNotes: Effect.fn("GitLabPullRequestCli.listNotes")(function (input) {
      return notesPage({ ...input, page: 1, collected: [] });
    }),

    listReactions: Effect.fn("GitLabPullRequestCli.listReactions")(function (input) {
      return awardsPage({ ...input, cursor: null, page: 1, collected: null });
    }),

    getFileRevisions: fileRevisions,

    setReaction: Effect.fn("GitLabPullRequestCli.setReaction")(function* (input) {
      const subject = awardSubjectPath(input);
      if (input.reacted) {
        yield* api({
          cwd: input.cwd,
          host: input.host,
          path: `${subject}?${query([["name", gitLabAwardName(input.content)]])}`,
          method: "POST",
        });
        return;
      }
      // GitLab deletes an award by its id and takes no emoji name there, so the reader's own
      // award of that name is looked up first.
      const viewer = yield* viewerUsername(input);
      const listed = yield* api({ cwd: input.cwd, host: input.host, path: subject });
      const own = decodeOwnAwardIdJson(listed.stdout.trim(), {
        content: input.content,
        viewer,
      });
      if (!Result.isSuccess(own)) {
        return yield* new GitLabMergeRequestReadError({
          command: "glab",
          cwd: input.cwd,
          operation: "setReaction",
          cause: own.failure,
        });
      }
      if (own.success === null) return;
      yield* api({
        cwd: input.cwd,
        host: input.host,
        path: `${subject}/${own.success}`,
        method: "DELETE",
      });
    }),

    listCommits: Effect.fn("GitLabPullRequestCli.listCommits")(function (input) {
      return api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/commits?${query(
          [
            ["per_page", String(COMMIT_PAGE_SIZE)],
            ["with_stats", "true"],
          ],
        )}`,
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeCommitsJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: input.cwd,
                  operation: "listCommits",
                  cause: decoded.failure,
                }),
              );
        }),
      );
    }),

    getMergeRequestDiff: Effect.fn("GitLabPullRequestCli.getMergeRequestDiff")(function* (input) {
      if (input.commit !== undefined && !isCommitSha(input.commit)) {
        return yield* new GitLabDiffCommitError({ command: "glab", cwd: input.cwd });
      }
      const target = {
        cwd: input.cwd,
        host: input.host,
        repository: input.repository,
        number: input.number,
        ...(input.commit === undefined ? {} : { commit: input.commit }),
      };
      if (input.cursor === undefined) {
        return yield* diffPage({ ...target, page: 1 });
      }
      const page = diffCursorPage(input.cursor);
      if (page === null)
        return yield* new GitLabDiffCursorError({ command: "glab", cwd: input.cwd });
      return yield* diffPage({ ...target, page });
    }),

    getMergeRequestDiffFileContents: Effect.fn(
      "GitLabPullRequestCli.getMergeRequestDiffFileContents",
    )(function* (input) {
      if (input.commit !== undefined && !isCommitSha(input.commit)) {
        return yield* new GitLabDiffCommitError({ command: "glab", cwd: input.cwd });
      }
      const refs = yield* input.commit === undefined
        ? getDiffRefs(input)
        : getCommitDiffRefs({
            cwd: input.cwd,
            host: input.host,
            repository: input.repository,
            commit: input.commit,
            allowRoot: input.changeType === "new",
          });

      const readFile = (revision: string, filePath: string) =>
        api({
          cwd: input.cwd,
          host: input.host,
          path: `projects/${projectPath(input.repository)}/repository/files/${encodeURIComponent(
            filePath,
          )}/raw?ref=${encodeURIComponent(revision)}`,
          maxOutputBytes: DIFF_FILE_MAX_OUTPUT_BYTES,
          timeoutMs: DIFF_TIMEOUT_MS,
        }).pipe(
          Effect.flatMap((result) =>
            result.stdoutTruncated ||
            result.stdout.includes("\0") ||
            result.stdoutInvalidUtf8 === true
              ? Effect.fail(
                  new GitLabDiffFileContentsUnavailableError({
                    command: "glab",
                    cwd: input.cwd,
                    path: filePath,
                    reason: result.stdoutTruncated ? "oversized" : "binary",
                  }),
                )
              : Effect.succeed(result.stdout),
          ),
        );

      const [oldContents, newContents] = yield* Effect.all(
        [
          input.changeType === "new" ? Effect.succeed("") : readFile(refs.baseSha, input.oldPath),
          input.changeType === "deleted"
            ? Effect.succeed("")
            : readFile(refs.headSha, input.newPath),
        ],
        { concurrency: 2 },
      );
      return { oldContents, newContents };
    }),

    getProjectMergeCapabilities: Effect.fn("GitLabPullRequestCli.getProjectMergeCapabilities")(
      function (input) {
        return api({
          cwd: input.cwd,
          host: input.host,
          path: `projects/${projectPath(input.repository)}?license=false`,
        }).pipe(
          Effect.flatMap((result) => {
            const decoded = decodeProjectMergeCapabilitiesJson(result.stdout.trim());
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(
                  new GitLabMergeRequestReadError({
                    command: "glab",
                    cwd: input.cwd,
                    operation: "getProjectMergeCapabilities",
                    cause: decoded.failure,
                  }),
                );
          }),
        );
      },
    ),

    listProjectLabels: Effect.fn("GitLabPullRequestCli.listProjectLabels")(function (input) {
      return projectLabels(input).pipe(
        Effect.map(({ labels, truncated }) => ({
          items: labels.map(({ name, color }) => ({ name, color })),
          truncated,
        })),
      );
    }),

    listLabelCandidates: Effect.fn("GitLabPullRequestCli.listLabelCandidates")(function* (input) {
      const [mergeRequest, project] = yield* Effect.all(
        [mergeRequestDetail(input), projectLabels(input)],
        { concurrency: 2 },
      );
      const applied = new Set(mergeRequest.labels.map((label) => label.name));
      const listed = new Set(project.labels.map((label) => label.name));
      return {
        // GitLab's own picker hides archived labels. Applied ones stay so they can be removed,
        // as do applied labels past the project's first page.
        candidates: [
          ...mergeRequest.labels
            .filter((label) => !listed.has(label.name))
            .map((label) => ({ ...label, description: null, isApplied: true })),
          ...project.labels
            .filter((label) => !label.archived || applied.has(label.name))
            .map(({ archived: _archived, ...label }) => ({
              ...label,
              isApplied: applied.has(label.name),
            })),
        ],
        truncated: project.truncated,
      };
    }),

    setLabels: Effect.fn("GitLabPullRequestCli.setLabels")(function* (input) {
      if (input.applied) {
        // GitLab creates any label it is asked to add that the project does not have yet.
        const found = yield* Effect.forEach(
          input.labels,
          (label) =>
            api({
              cwd: input.cwd,
              host: input.host,
              path: `projects/${projectPath(input.repository)}/labels/${encodeURIComponent(label)}?${query(
                [["include_ancestor_groups", "true"]],
              )}`,
            }).pipe(
              // The lookup also matches a numeric id, so the returned name must be the one asked for.
              Effect.map((result) => {
                const decoded = decodeLabelNameJson(result.stdout.trim());
                return Result.isSuccess(decoded) && decoded.success === label;
              }),
              Effect.catchTags({
                GitLabCliCommandError: (error) =>
                  isVcsProcessExitError(error.cause) && error.cause.failureKind === "not-found"
                    ? Effect.succeed(false)
                    : Effect.fail(error),
              }),
            ),
          { concurrency: 4 },
        );
        const unknown = input.labels.filter((_, index) => !found[index]);
        if (unknown.length > 0) {
          return yield* new GitLabUnknownLabelError({
            command: "glab",
            cwd: input.cwd,
            labels: unknown,
          });
        }
      }
      yield* api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}`,
        method: "PUT",
        // GitLab label names cannot contain a comma.
        // @effect-diagnostics-next-line globalJsonInEffect:off
        stdin: JSON.stringify({
          [input.applied ? "add_labels" : "remove_labels"]: input.labels.join(","),
        }),
      });
    }),

    listProjectUsers: Effect.fn("GitLabPullRequestCli.listProjectUsers")(function (input) {
      return projectUsers(input).pipe(
        Effect.map(({ candidates, rawCount }) => ({
          items: candidates.map(({ login, name, avatarUrl }) => ({ login, name, avatarUrl })),
          truncated: rawCount >= MAX_PAGE_SIZE,
        })),
      );
    }),

    searchProjectReferences: Effect.fn("GitLabPullRequestCli.searchProjectReferences")(
      function (input) {
        return Effect.forEach(
          referenceSearches(input.search, input.sigil),
          ({ kind, params }) =>
            projectReferences({ ...input, kind, params }).pipe(
              // A project with issues turned off answers 403 for issues; its merge requests still
              // complete. An unusable CLI or account still reaches the caller.
              Effect.catchIf(
                (cause) =>
                  cause._tag !== "GitLabCliUnavailableError" &&
                  cause._tag !== "GitLabCliAuthenticationError" &&
                  cause._tag !== "GitLabCliRateLimitError",
                (cause) =>
                  Effect.logWarning("GitLab reference search failed", {
                    repository: input.repository,
                    kind,
                    reason: cause._tag,
                  }).pipe(Effect.as({ items: [], rawCount: 0 })),
              ),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.map(mergeReferencePages));
      },
    ),

    listReviewerCandidates: Effect.fn("GitLabPullRequestCli.listReviewerCandidates")(
      function (input) {
        return Effect.all(
          [mergeRequestDetail(input), projectUsers({ ...input, search: input.query })],
          {
            concurrency: 2,
          },
        ).pipe(
          Effect.map(([mergeRequest, users]) => {
            const author = mergeRequest.author?.login;
            const requested = (input.query?.trim() ? [] : mergeRequest.reviewerUsers).map(
              ({ id, ...actor }) => ({
                ...actor,
                id: String(id),
                kind: "user" as const,
                isRequested: true,
              }),
            );
            const listed = new Set(requested.map((reviewer) => reviewer.id));
            // Every reviewer id, not just the ones shown above: a reviewer GitLab sent without a
            // username can still turn up on the users page, and must read as requested there or
            // choosing them would ask again instead of taking the request back.
            const requestedIds = new Set(mergeRequest.reviewerIds.map(String));
            return {
              // The reviewers lead, and come from the merge request rather than the users page:
              // that page stops at a hundred, and somebody missing from it could not be taken off.
              // The author is dropped rather than shown unusable: GitLab refuses to make the person
              // who opened a merge request its reviewer.
              candidates: [
                ...requested,
                ...users.candidates
                  .filter((candidate) => candidate.login !== author && !listed.has(candidate.id))
                  .map((candidate) =>
                    requestedIds.has(candidate.id)
                      ? { ...candidate, isRequested: true }
                      : candidate,
                  ),
              ],
              truncated: users.rawCount >= MAX_PAGE_SIZE,
            };
          }),
        );
      },
    ),

    setReviewerRequest: Effect.fn("GitLabPullRequestCli.setReviewerRequest")(function (input) {
      return mergeRequestDetail(input).pipe(
        Effect.flatMap((mergeRequest) => {
          // GitLab replaces reviewer_ids wholesale.
          const ids = new Set(mergeRequest.reviewerIds);
          for (const reviewer of input.reviewers) {
            const id = Number(reviewer.id);
            if (!Number.isSafeInteger(id) || id <= 0) continue;
            if (input.requested) ids.add(id);
            else ids.delete(id);
          }
          return api({
            cwd: input.cwd,
            host: input.host,
            path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}`,
            method: "PUT",
            stdin: JSON.stringify({ reviewer_ids: [...ids] }),
          });
        }),
        Effect.asVoid,
      );
    }),

    runMergeRequestAction: Effect.fn("GitLabPullRequestCli.runMergeRequestAction")(
      function* (input) {
        // `glab mr merge` arms auto-merge and never disarms it, so the one direction the CLI has
        // no flag for is asked of GitLab directly through the same `api` passthrough the rest of
        // this module writes with.
        if (input.action === "delete-branch") return yield* deleteSourceBranch(input);
        if (input.action === "disable-auto-merge") {
          const result = yield* api({
            cwd: input.cwd,
            host: input.host,
            path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/cancel_merge_when_pipeline_succeeds`,
            method: "POST",
          });
          // The other actions run `glab mr`, which prints prose rather than the merge request.
          const decoded = decodeMergeRequestDetailJson(result.stdout.trim());
          if (Result.isFailure(decoded)) return;
          // The decoder fills absent counts with zeros, which would be guesses here.
          const {
            additions: _additions,
            deletions: _deletions,
            changedFiles: _changedFiles,
            ...summary
          } = decoded.success;
          return summary;
        }
        const executeMr = (subcommand: string, ...flags: ReadonlyArray<string>) =>
          gitlab.execute({
            cwd: input.cwd,
            host: input.host,
            args: ["mr", subcommand, String(input.number), "--repo", input.repository, ...flags],
          });
        const [subcommand, ...flags] = actionArgs(input.action, input.mergeMethod);
        if (input.action === "merge" || input.action === "enable-auto-merge") {
          if (input.mergeMethod === "rebase") {
            // A rebase changes the source SHA, so wait for it before reading the merge guard.
            yield* executeMr("rebase");
          }
          const refs = yield* getDiffRefs(input);
          flags.push("--sha", refs.headSha);
          if (input.removeAgentCreditsOnMerge === true) {
            // Read after the SHA guard, so a push since then fails the merge instead of
            // merging commits whose credits these messages don't cover.
            const messages = yield* graphqlRead({
              cwd: input.cwd,
              host: input.host,
              operation: "getMergeMessages",
              query: MERGE_MESSAGES_GRAPHQL_QUERY,
              variables: { fullPath: input.repository, iid: String(input.number) },
              decode: decodeMergeMessagesJson,
            });
            // glab drops an empty message, which would bring the credits back.
            const clean = (message: string) => {
              const cleaned = removeAgentCredits(message);
              return cleaned.trim() === "" ? (messages.title ?? message) : cleaned;
            };
            const merge = messages.merge === null ? null : clean(messages.merge);
            if (merge !== null && merge !== messages.merge) flags.push("--message", merge);
            const squashes = input.mergeMethod === "squash" || messages.squashOnMerge;
            const squash = messages.squash === null || !squashes ? null : clean(messages.squash);
            if (squash !== null && squash !== messages.squash) {
              // glab takes a squash message only alongside --squash, which changes nothing here.
              if (!flags.includes("--squash")) flags.push("--squash");
              flags.push("--squash-message", squash);
            }
          }
        }
        yield* executeMr(subcommand!, ...flags);
      },
    ),

    updateMergeRequest: Effect.fn("GitLabPullRequestCli.updateMergeRequest")(function (input) {
      return api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}`,
        method: "PUT",
        // Omitted fields remain unchanged; empty values clear them.
        stdin: JSON.stringify({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.allowCollaboration === undefined
            ? {}
            : { allow_collaboration: input.allowCollaboration }),
        }),
      }).pipe(Effect.asVoid);
    }),

    commentOnMergeRequest: Effect.fn("GitLabPullRequestCli.commentOnMergeRequest")(
      function (input) {
        return api({
          cwd: input.cwd,
          host: input.host,
          path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/notes`,
          method: "POST",
          // JSON avoids glab's coercion of numeric/boolean comment bodies.
          stdin: JSON.stringify({ body: input.body }),
        }).pipe(Effect.asVoid);
      },
    ),

    updateNote: Effect.fn("GitLabPullRequestCli.updateNote")(function (input) {
      return api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/notes/${encodeURIComponent(
          input.noteId,
        )}`,
        method: "PUT",
        stdin: JSON.stringify({ body: input.body }),
      }).pipe(Effect.asVoid);
    }),

    listDiscussions: Effect.fn("GitLabPullRequestCli.listDiscussions")(function (input) {
      return discussionsPage({
        ...input,
        page: 1,
        collected: [],
        collectedDiffRefs: new Map(),
        collectedFindingIds: [],
      });
    }),

    submitReview: Effect.fn("GitLabPullRequestCli.submitReview")(function* (input) {
      const project = projectPath(input.repository);
      const mergeRequest = `projects/${project}/merge_requests/${input.number}`;
      // GitLab has no pending review, so a review is replayed as separate requests and a failure
      // leaves earlier ones posted. Requesting changes (GitLab 18.9+) goes first so an older
      // server fails before any comment lands; approval goes last so a half-sent review never
      // approves.
      if (input.verdict === "request-changes") {
        // GitLab keeps the verdict on the reviewer, so the viewer joins the reviewers first.
        const viewer = yield* viewerUsername(input);
        const target = { projectPath: input.repository, iid: String(input.number) };
        yield* graphqlMutation({
          cwd: input.cwd,
          host: input.host,
          operation: "submitReview",
          query: SET_SELF_AS_REVIEWER_MUTATION,
          variables: { ...target, reviewers: [viewer] },
        });
        yield* graphqlMutation({
          cwd: input.cwd,
          host: input.host,
          operation: "submitReview",
          query: REQUEST_CHANGES_MUTATION,
          variables: target,
        });
      }
      if (input.comments.length > 0) {
        const refs = yield* getDiffRefs(input);
        yield* Effect.forEach(
          input.comments,
          (comment) =>
            api({
              cwd: input.cwd,
              host: input.host,
              path: `${mergeRequest}/discussions`,
              method: "POST",
              stdin: JSON.stringify({
                body: comment.body,
                position: {
                  base_sha: refs.baseSha,
                  head_sha: refs.headSha,
                  start_sha: refs.startSha,
                  position_type: "text",
                  // Both paths are sent because GitLab resolves a position against both
                  // sides of the diff. They differ only for a renamed file, which is why the
                  // draft carries the name the file had before the change.
                  old_path: comment.oldPath ?? comment.path,
                  new_path: comment.path,
                  ...gitLabReviewPositionLines(comment.position),
                },
              }),
            }),
          { discard: true },
        );
      }
      if (input.body.trim().length > 0) {
        yield* api({
          cwd: input.cwd,
          host: input.host,
          path: `${mergeRequest}/notes`,
          method: "POST",
          // @effect-diagnostics-next-line globalJsonInEffect:off
          stdin: JSON.stringify({ body: input.body }),
        });
      }
      if (input.verdict === "approve") {
        yield* api({
          cwd: input.cwd,
          host: input.host,
          path: `${mergeRequest}/approve`,
          method: "POST",
        });
      }
    }),

    replyToDiscussion: Effect.fn("GitLabPullRequestCli.replyToDiscussion")(function (input) {
      return api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/discussions/${encodeURIComponent(
          input.discussionId,
        )}/notes`,
        method: "POST",
        stdin: JSON.stringify({ body: input.body }),
      }).pipe(Effect.asVoid);
    }),

    setDiscussionResolution: Effect.fn("GitLabPullRequestCli.setDiscussionResolution")(
      function (input) {
        return api({
          cwd: input.cwd,
          host: input.host,
          path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/discussions/${encodeURIComponent(
            input.discussionId,
          )}`,
          method: "PUT",
          stdin: JSON.stringify({ resolved: input.resolved }),
        }).pipe(Effect.asVoid);
      },
    ),
  });
});

export const layer = Layer.effect(GitLabPullRequestCli, make);
