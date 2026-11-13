import { trimOptionalString as trimmed } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestComment,
  PullRequestCommit,
  PullRequestFileViewedState,
  PullRequestLabel,
  PullRequestMergeCapabilities,
  PullRequestOmittedFileStat,
  PullRequestReaction,
  PullRequestReviewThread,
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
import type {
  LabelCandidates,
  PullRequestFilesViewed,
  PullRequestFileStats,
  RepositoryAuthors,
  RepositoryLabels,
  ReviewerCandidates,
  ViewerPermissions,
} from "./pullRequestReads.graphql.ts";
import type {
  ReviewDismissals,
  ReviewThreadComments,
  ReviewThreads,
  ThreadComment,
} from "./pullRequestReviews.graphql.ts";
import type { ActorFields } from "./gitHubPullRequestJsonPart2.ts";
import type { DecodeFailure } from "./gitHubPullRequestJsonPart3.ts";
import { nextCursorOf, nodesOf, toActor, toGraphqlCommitActor, toPullRequestViewerFields, toReactions, toRequestedTeam, toState } from "./gitHubPullRequestJsonPart2.ts";
import { decodeFileEntry, decodeUnknownList } from "./gitHubPullRequestJsonPart3.ts";
export type {
  GitHubPullRequestActivity,
  GitHubPullRequestDetail,
  GitHubPullRequestHead,
  GitHubPullRequestListItem,
  GitHubWorkflowRunApproval,
} from "./gitHubPullRequestJsonPart2.ts";
export type {
  GitHubCheckContext,
  GitHubPullRequestActivityPage,
  GitHubPullRequestCore,
  GitHubPullRequestSearchItem,
  GitHubPullRequestSummary,
  GitHubPullRequestWatchFingerprint,
  GitHubReviewThreadComments,
  GitHubWorkflowRunPage,
} from "./gitHubPullRequestJsonPart3.ts";
export {
  PULL_REQUEST_SEARCH_MAX_ROWS,
  buildReviewSubmission,
  gitHubReactionContent,
  isSubjectOfPullRequest,
  pageRows,
  toPullRequestNodeId,
  toPullRequestPreview,
} from "./gitHubPullRequestJsonPart2.ts";
export {
  LenientPullRequestList,
  LenientPullRequestSearch,
  decodeWorkflowRunsJson,
  pullRequestChecksFromContexts,
  pullRequestLookup,
  toPullRequestActivityPage,
  toPullRequestCheckContextsPage,
  toPullRequestCommitStats,
  toPullRequestCore,
  toPullRequestHeads,
  toPullRequestRows,
  toPullRequestSummary,
  toPullRequestWatchFingerprint,
  toStackMembership,
} from "./gitHubPullRequestJsonPart3.ts";

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

export function toCanTriage(viewerPermission: string | null | undefined): boolean {
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
            // The files API has no similarity score; Pierre needs this header to keep the rename.
            `similarity index ${hunks.length > 0 || (value.additions ?? 0) + (value.deletions ?? 0) > 0 ? 0 : 100}%`,
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
