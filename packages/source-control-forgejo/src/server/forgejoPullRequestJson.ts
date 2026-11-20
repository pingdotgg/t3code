/**
 * Forgejo's JSON, and the neutral shapes the pull request service reads.
 *
 * Everything Forgejo-specific about a change request stops here: the provider above works in
 * contract types only. Gitea shares this API surface, so the same schemas serve both.
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { toIsoUtc } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestComment,
  PullRequestCommit,
  PullRequestLabel,
  PullRequestMergeCapabilities,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewThread,
  PullRequestState,
  PullRequestThreadComment,
} from "@t3tools/contracts";

import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import { dedupeChecks } from "@t3tools/source-control-core/server/pullRequestChecks";
import type { ProviderChangeRequest } from "@t3tools/source-control-core/server/PullRequestProvider";
import { forgejoHeadBranch } from "./forgejoPullRequests.ts";

/**
 * Forgejo answers with a full user record; only these three are read. Optional throughout
 * because a remark written before an account was removed carries a null user.
 */
export const ForgejoUserSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  full_name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});
export type ForgejoUser = typeof ForgejoUserSchema.Type;

export const ForgejoLabelSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const ForgejoRepositoryRefSchema = Schema.Struct({
  full_name: Schema.optional(Schema.NullOr(Schema.String)),
});

const ForgejoBranchInfoSchema = Schema.Struct({
  ref: Schema.optional(Schema.NullOr(Schema.String)),
  sha: Schema.optional(Schema.NullOr(Schema.String)),
  repo: Schema.optional(Schema.NullOr(ForgejoRepositoryRefSchema)),
});

export const ForgejoPullRequestSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  additions: Schema.optional(Schema.NullOr(Schema.Number)),
  deletions: Schema.optional(Schema.NullOr(Schema.Number)),
  changed_files: Schema.optional(Schema.NullOr(Schema.Number)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
  labels: Schema.optional(Schema.NullOr(Schema.Array(ForgejoLabelSchema))),
  requested_reviewers: Schema.optional(Schema.NullOr(Schema.Array(ForgejoUserSchema))),
  head: Schema.optional(Schema.NullOr(ForgejoBranchInfoSchema)),
  base: Schema.optional(Schema.NullOr(ForgejoBranchInfoSchema)),
});
export type ForgejoPullRequest = typeof ForgejoPullRequestSchema.Type;

export const ForgejoPullRequestListSchema = Schema.Array(ForgejoPullRequestSchema);

export const ForgejoCommentSchema = Schema.Struct({
  id: Schema.Number,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
});
export const ForgejoCommentListSchema = Schema.Array(ForgejoCommentSchema);

export const ForgejoReviewSchema = Schema.Struct({
  id: Schema.Number,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  comments_count: Schema.optional(Schema.NullOr(Schema.Number)),
  dismissed: Schema.optional(Schema.NullOr(Schema.Boolean)),
  user: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
});
export const ForgejoReviewListSchema = Schema.Array(ForgejoReviewSchema);

export const ForgejoReviewCommentSchema = Schema.Struct({
  id: Schema.Number,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  position: Schema.optional(Schema.NullOr(Schema.Number)),
  original_position: Schema.optional(Schema.NullOr(Schema.Number)),
  diff_hunk: Schema.optional(Schema.NullOr(Schema.String)),
  pull_request_review_id: Schema.optional(Schema.NullOr(Schema.Number)),
  resolver: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
  user: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
});
export const ForgejoReviewCommentListSchema = Schema.Array(ForgejoReviewCommentSchema);

export const ForgejoCommitSchema = Schema.Struct({
  sha: Schema.optional(Schema.NullOr(Schema.String)),
  created: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
  committer: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
  commit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        message: Schema.optional(Schema.NullOr(Schema.String)),
        committer: Schema.optional(
          Schema.NullOr(Schema.Struct({ date: Schema.optional(Schema.NullOr(Schema.String)) })),
        ),
      }),
    ),
  ),
  stats: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        additions: Schema.optional(Schema.NullOr(Schema.Number)),
        deletions: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
});
export const ForgejoCommitListSchema = Schema.Array(ForgejoCommitSchema);

export const ForgejoCommitStatusSchema = Schema.Struct({
  context: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  target_url: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
});
export const ForgejoCommitStatusListSchema = Schema.Array(ForgejoCommitStatusSchema);

export const ForgejoReactionSchema = Schema.Struct({
  content: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
});
export const ForgejoReactionListSchema = Schema.Array(ForgejoReactionSchema);

export const ForgejoRepositorySchema = Schema.Struct({
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
  allow_merge_commits: Schema.optional(Schema.NullOr(Schema.Boolean)),
  allow_squash_merge: Schema.optional(Schema.NullOr(Schema.Boolean)),
  allow_rebase: Schema.optional(Schema.NullOr(Schema.Boolean)),
  allow_rebase_explicit: Schema.optional(Schema.NullOr(Schema.Boolean)),
  allow_rebase_update: Schema.optional(Schema.NullOr(Schema.Boolean)),
  permissions: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        admin: Schema.optional(Schema.NullOr(Schema.Boolean)),
        push: Schema.optional(Schema.NullOr(Schema.Boolean)),
        pull: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
});

export const ForgejoUserListSchema = Schema.Array(ForgejoUserSchema);

const ISO_FALLBACK = "1970-01-01T00:00:00Z";

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * A timestamp the contract will accept, since `IsoDateTime` refuses an empty string. Normalized
 * to the same `Z` form the other hosts produce, because the page sorts change requests from
 * several hosts against each other as plain strings.
 */
export function isoOrEpoch(value: string | null | undefined): string {
  const trimmed = text(value).trim();
  if (trimmed.length === 0) return ISO_FALLBACK;
  return Option.match(DateTime.make(trimmed), {
    onNone: () => ISO_FALLBACK,
    onSome: DateTime.formatIso,
  });
}

export function normalizeActor(user: ForgejoUser | null | undefined): PullRequestActor | null {
  const login = text(user?.login).trim();
  if (login.length === 0) return null;
  const name = text(user?.full_name).trim();
  const avatarUrl = text(user?.avatar_url).trim();
  return {
    login,
    name: name.length > 0 ? name : null,
    avatarUrl: avatarUrl.length > 0 ? avatarUrl : null,
  };
}

function normalizeLabels(
  labels:
    | ReadonlyArray<{
        readonly name?: string | null | undefined;
        readonly color?: string | null | undefined;
      }>
    | null
    | undefined,
): ReadonlyArray<PullRequestLabel> {
  const result: Array<PullRequestLabel> = [];
  for (const label of labels ?? []) {
    const name = text(label.name).trim();
    if (name.length === 0) continue;
    const color = text(label.color).trim();
    // Forgejo reports a bare hex triplet; the page expects one it can put behind a `#`.
    result.push({ name, color: color.length > 0 ? color.replace(/^#/u, "") : null });
  }
  return result;
}

function normalizeState(input: {
  readonly state?: string | null | undefined;
  readonly merged?: boolean | null | undefined;
}): PullRequestState {
  if (input.merged === true) return "merged";
  return text(input.state).trim().toLowerCase() === "closed" ? "closed" : "open";
}

/**
 * Forgejo reports `mergeable` only once it has worked the answer out, and says nothing while a
 * merge check is still running or on a change request that is already closed.
 */
function normalizeMergeability(
  pullRequest: Pick<ForgejoPullRequest, "mergeable" | "state" | "merged">,
): ProviderChangeRequest["mergeability"] {
  if (normalizeState(pullRequest) !== "open") return "unknown";
  if (pullRequest.mergeable === true) return "mergeable";
  if (pullRequest.mergeable === false) return "conflicting";
  return "unknown";
}

export function normalizeChangeRequest(
  pullRequest: ForgejoPullRequest,
  options?: { readonly draft?: boolean | null | undefined },
): ProviderChangeRequest {
  const title = text(pullRequest.title).trim();
  const htmlUrl = text(pullRequest.html_url).trim();
  return {
    number: pullRequest.number,
    title: title.length > 0 ? title : `#${pullRequest.number}`,
    url: htmlUrl,
    author: normalizeActor(pullRequest.user),
    headBranch: text(pullRequest.head?.ref),
    baseBranch: text(pullRequest.base?.ref),
    state: normalizeState(pullRequest),
    isDraft: (options?.draft ?? pullRequest.draft) === true,
    mergeability: normalizeMergeability(pullRequest),
    additions: count(pullRequest.additions),
    deletions: count(pullRequest.deletions),
    createdAt: isoOrEpoch(pullRequest.created_at),
    updatedAt: isoOrEpoch(pullRequest.updated_at),
    reviewRequestLogins: (pullRequest.requested_reviewers ?? [])
      .map((reviewer) => text(reviewer?.login).trim())
      .filter((login) => login.length > 0),
    labels: normalizeLabels(pullRequest.labels),
  };
}

const REACTION_BY_FORGEJO_NAME: Record<string, PullRequestReactionContent> = {
  "+1": "thumbs-up",
  "-1": "thumbs-down",
  laugh: "laugh",
  hooray: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

const FORGEJO_NAME_BY_REACTION: Record<PullRequestReactionContent, string> = {
  "thumbs-up": "+1",
  "thumbs-down": "-1",
  laugh: "laugh",
  hooray: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

export function forgejoReactionName(content: PullRequestReactionContent): string {
  return FORGEJO_NAME_BY_REACTION[content];
}

/**
 * Forgejo lists one row per person per reaction rather than a tally, so they are counted here.
 * A custom emoji the contract has no name for is dropped: the page can only draw the eight it
 * knows, and a pill it cannot label is worse than one fewer pill.
 */
export function normalizeReactions(
  rows: ReadonlyArray<typeof ForgejoReactionSchema.Type>,
  viewer: string | null,
): ReadonlyArray<PullRequestReaction> {
  const byContent = new Map<PullRequestReactionContent, Array<string>>();
  for (const row of rows) {
    const content = REACTION_BY_FORGEJO_NAME[text(row.content).trim().toLowerCase()];
    if (content === undefined) continue;
    const login = text(row.user?.login).trim();
    const actors = byContent.get(content) ?? [];
    if (login.length > 0) actors.push(login);
    byContent.set(content, actors);
  }

  const result: Array<PullRequestReaction> = [];
  const viewerLogin = viewer?.trim().toLowerCase();
  for (const [content, actors] of byContent) {
    if (actors.length === 0) continue;
    const viewerHasReacted =
      viewerLogin !== undefined &&
      viewerLogin.length > 0 &&
      actors.some((actor) => actor.toLowerCase() === viewerLogin);
    result.push({
      content,
      count: actors.length,
      // The page names the viewer itself, so their login is left out of the others.
      actors: viewerHasReacted
        ? actors.filter((actor) => actor.toLowerCase() !== viewerLogin)
        : actors,
      viewerHasReacted,
    });
  }
  return result;
}

export function normalizeIssueComment(
  comment: typeof ForgejoCommentSchema.Type,
  reactions?: ReadonlyArray<PullRequestReaction>,
): PullRequestComment {
  return {
    id: `issue-comment:${comment.id}`,
    kind: "issue-comment",
    author: normalizeActor(comment.user),
    body: text(comment.body),
    createdAt: isoOrEpoch(comment.created_at),
    url: text(comment.html_url).trim() || null,
    path: null,
    reviewState: null,
    ...(reactions === undefined ? {} : { reactions }),
  };
}

/** Forgejo's review states, as the page spells a verdict. */
function normalizeReviewState(state: string | null | undefined): string | null {
  const normalized = text(state).trim().toUpperCase();
  switch (normalized) {
    case "APPROVED":
      return "approved";
    case "REQUEST_CHANGES":
      return "changes_requested";
    case "COMMENT":
      return "commented";
    case "PENDING":
      return "pending";
    default:
      return normalized.length > 0 ? normalized.toLowerCase() : null;
  }
}

/**
 * A review's own summary, which is a remark only when it carries words or a verdict. Forgejo
 * writes an empty `COMMENT` review as the parent of every batch of line notes, and showing those
 * would put a blank entry in the conversation for each one.
 */
export function normalizeReview(
  review: typeof ForgejoReviewSchema.Type,
): PullRequestComment | null {
  const body = text(review.body);
  const state = normalizeReviewState(review.state);
  const isVerdict = state === "approved" || state === "changes_requested";
  if (body.trim().length === 0 && !isVerdict) return null;
  return {
    id: `review:${review.id}`,
    kind: "review",
    author: normalizeActor(review.user),
    body,
    createdAt: isoOrEpoch(review.submitted_at),
    url: text(review.html_url).trim() || null,
    path: null,
    reviewState: state,
  };
}

function normalizeThreadComment(
  comment: typeof ForgejoReviewCommentSchema.Type,
  reactions?: ReadonlyArray<PullRequestReaction>,
): PullRequestThreadComment {
  return {
    id: `review-comment:${comment.id}`,
    author: normalizeActor(comment.user),
    body: text(comment.body),
    createdAt: isoOrEpoch(comment.created_at),
    url: text(comment.html_url).trim() || null,
    ...(reactions === undefined ? {} : { reactions }),
  };
}

/**
 * Forgejo has no review threads: notes on the same line of the same file are one conversation,
 * as on Forgejo's own page. A note whose `position` is gone has drifted off the diff and is
 * marked outdated rather than pinned to a line it no longer belongs on.
 */
export function normalizeReviewThreads(
  comments: ReadonlyArray<typeof ForgejoReviewCommentSchema.Type>,
  reactionsByCommentId?: ReadonlyMap<number, ReadonlyArray<PullRequestReaction>>,
): ReadonlyArray<PullRequestReviewThread> {
  const byAnchor = new Map<string, Array<typeof ForgejoReviewCommentSchema.Type>>();
  const order: Array<string> = [];
  for (const comment of comments) {
    const path = text(comment.path).trim();
    if (path.length === 0) continue;
    const line = comment.position ?? comment.original_position ?? null;
    const anchor = `${path}#${line ?? "file"}`;
    const bucket = byAnchor.get(anchor);
    if (bucket === undefined) {
      byAnchor.set(anchor, [comment]);
      order.push(anchor);
    } else {
      bucket.push(comment);
    }
  }

  const threads: Array<PullRequestReviewThread> = [];
  for (const anchor of order) {
    const bucket = byAnchor.get(anchor) ?? [];
    const first = bucket[0];
    if (first === undefined) continue;
    const path = text(first.path).trim();
    const position = first.position ?? null;
    const line = typeof position === "number" && position > 0 ? position : null;
    threads.push({
      // The first note's id addresses the conversation, which is what a reply is hung off.
      id: `${first.id}`,
      path,
      line,
      // Forgejo positions a note against the diff's right-hand side.
      side: "right",
      // `resolver` is the account that marked it resolved, so its presence is the state.
      isResolved: bucket.some((comment) => normalizeActor(comment.resolver) !== null),
      isOutdated: line === null,
      comments: bucket.map((comment) =>
        normalizeThreadComment(comment, reactionsByCommentId?.get(comment.id)),
      ),
    });
  }
  return threads;
}

export function normalizeCommit(commit: typeof ForgejoCommitSchema.Type): PullRequestCommit | null {
  const oid = text(commit.sha).trim();
  if (oid.length === 0) return null;
  const message = text(commit.commit?.message);
  const authors = [normalizeActor(commit.author), normalizeActor(commit.committer)].filter(
    (actor): actor is PullRequestActor => actor !== null,
  );
  const unique = new Map(authors.map((actor) => [actor.login, actor]));
  const stats = commit.stats;
  return {
    oid,
    messageHeadline: message.split("\n")[0] ?? "",
    committedDate: isoOrEpoch(commit.commit?.committer?.date ?? commit.created),
    ...(typeof stats?.additions === "number" ? { additions: count(stats.additions) } : {}),
    ...(typeof stats?.deletions === "number" ? { deletions: count(stats.deletions) } : {}),
    ...(unique.size > 0 ? { authors: [...unique.values()] } : {}),
  };
}

const CHECK_STATUS_BY_FORGEJO_STATE: Record<string, PullRequestCheckStatus> = {
  pending: "pending",
  running: "pending",
  success: "success",
  failure: "failure",
  error: "failure",
  warning: "neutral",
};

function normalizeCheck(status: typeof ForgejoCommitStatusSchema.Type): PullRequestCheck | null {
  const name = text(status.context).trim();
  if (name.length === 0) return null;
  const state = text(status.status).trim().toLowerCase();
  const description = text(status.description).trim();
  const url = text(status.target_url).trim();
  return {
    name,
    status: CHECK_STATUS_BY_FORGEJO_STATE[state] ?? "neutral",
    description: description.length > 0 ? description : null,
    url: url.length > 0 ? url : null,
  };
}

/**
 * Forgejo returns one status row per push per context, so a check that has been re-run arrives
 * more than once. The shared de-duplication keeps the newest of each, as on the other hosts.
 */
export function normalizeChecks(
  rows: ReadonlyArray<typeof ForgejoCommitStatusSchema.Type>,
): ReadonlyArray<PullRequestCheck> {
  const entries: Array<{
    readonly check: PullRequestCheck;
    readonly workflowName: string | null;
    readonly at: string | null;
  }> = [];
  for (const row of rows) {
    const check = normalizeCheck(row);
    if (check === null) continue;
    entries.push({ check, workflowName: null, at: isoOrEpoch(row.updated_at) });
  }
  return dedupeChecks(entries);
}

/** The overall state a listing shows, from the checks a detail read already has. */
export function rollupChecksState(
  checks: ReadonlyArray<PullRequestCheck>,
): "passing" | "failing" | "pending" | null {
  if (checks.length === 0) return null;
  if (checks.some((check) => check.status === "failure")) return "failing";
  if (checks.some((check) => check.status === "pending")) return "pending";
  return "passing";
}

export function normalizeMergeCapabilities(
  repository: typeof ForgejoRepositorySchema.Type,
): PullRequestMergeCapabilities {
  // A repository that says nothing about a strategy is one this cannot rule out, and offering a
  // button the host then refuses is better than hiding one it would have taken.
  return {
    merge: repository.allow_merge_commits !== false,
    squash: repository.allow_squash_merge !== false,
    rebase: repository.allow_rebase !== false || repository.allow_rebase_explicit === true,
  };
}

/** Whether this account may write to the repository, which is what every mutation needs. */
export function canWrite(repository: typeof ForgejoRepositorySchema.Type): boolean {
  const permissions = repository.permissions;
  if (permissions === null || permissions === undefined) return true;
  return permissions.push === true || permissions.admin === true;
}

export const decodeForgejoPullRequest = decodeJsonResult(ForgejoPullRequestSchema);
export const decodeForgejoPullRequestList = decodeJsonResult(ForgejoPullRequestListSchema);
export const decodeForgejoCommentList = decodeJsonResult(ForgejoCommentListSchema);
export const decodeForgejoReviewList = decodeJsonResult(ForgejoReviewListSchema);
export const decodeForgejoReviewCommentList = decodeJsonResult(ForgejoReviewCommentListSchema);
export const decodeForgejoCommitList = decodeJsonResult(ForgejoCommitListSchema);
export const decodeForgejoCommitStatusList = decodeJsonResult(ForgejoCommitStatusListSchema);
export const decodeForgejoReactionList = decodeJsonResult(ForgejoReactionListSchema);
export const decodeForgejoRepository = decodeJsonResult(ForgejoRepositorySchema);
export const decodeForgejoUser = decodeJsonResult(ForgejoUserSchema);
export const decodeForgejoUserList = decodeJsonResult(ForgejoUserListSchema);
export const decodeForgejoContents = decodeJsonResult(
  Schema.Struct({
    content: Schema.optional(Schema.NullOr(Schema.String)),
    encoding: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

export const ForgejoUser = Schema.Struct({
  login: Schema.String,
  full_name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});
export const ForgejoLabel = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});
export const ForgejoRepository = Schema.Struct({
  full_name: Schema.String,
  default_branch: Schema.optional(Schema.String),
  permissions: Schema.optional(Schema.Struct({ push: Schema.Boolean, admin: Schema.Boolean })),
  archived: Schema.optional(Schema.Boolean),
  allow_merge_commits: Schema.optional(Schema.Boolean),
  allow_squash_merge: Schema.optional(Schema.Boolean),
  allow_rebase: Schema.optional(Schema.Boolean),
  allow_fast_forward_only_merge: Schema.optional(Schema.Boolean),
  allow_rebase_update: Schema.optional(Schema.Boolean),
  default_delete_branch_after_merge: Schema.optional(Schema.Boolean),
});
const Branch = Schema.Struct({
  ref: Schema.String,
  label: Schema.optional(Schema.String),
  sha: Schema.String,
  repo: Schema.NullOr(ForgejoRepository),
});
export const ForgejoPullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  user: Schema.NullOr(ForgejoUser),
  state: Schema.String,
  draft: Schema.optional(Schema.Boolean),
  flow: Schema.optional(Schema.Int),
  merged: Schema.Boolean,
  mergeable: Schema.optional(Schema.Boolean),
  is_locked: Schema.optional(Schema.Boolean),
  head: Branch,
  base: Branch,
  merge_base: Schema.optional(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String),
  merged_at: Schema.NullOr(Schema.String),
  merge_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
  merged_by: Schema.optional(Schema.NullOr(ForgejoUser)),
  additions: Schema.optional(Schema.NullOr(Schema.Int)),
  deletions: Schema.optional(Schema.NullOr(Schema.Int)),
  changed_files: Schema.optional(Schema.NullOr(Schema.Int)),
  comments: Schema.optional(Schema.Int),
  labels: Schema.NullOr(Schema.Array(ForgejoLabel)),
  requested_reviewers: Schema.optional(Schema.NullOr(Schema.Array(ForgejoUser))),
});
export const ForgejoComment = Schema.Struct({
  id: Schema.Int,
  body: Schema.String,
  user: Schema.NullOr(ForgejoUser),
  created_at: Schema.String,
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.String),
});
export const ForgejoReview = Schema.Struct({
  id: Schema.Int,
  body: Schema.String,
  user: Schema.NullOr(ForgejoUser),
  state: Schema.String,
  dismissed: Schema.optional(Schema.Boolean),
  submitted_at: Schema.String,
  html_url: Schema.optional(Schema.String),
  comments_count: Schema.Int,
});
export const ForgejoReviewComment = Schema.Struct({
  ...ForgejoComment.fields,
  path: Schema.String,
  position: Schema.Int,
  original_position: Schema.Int,
  commit_id: Schema.String,
  original_commit_id: Schema.String,
  resolver: Schema.NullOr(ForgejoUser),
});
export const ForgejoCommit = Schema.Struct({
  sha: Schema.String,
  author: Schema.NullOr(ForgejoUser),
  commit: Schema.Struct({
    message: Schema.String,
    committer: Schema.Struct({ date: Schema.String }),
  }),
  parents: Schema.Array(Schema.Struct({ sha: Schema.String })),
  stats: Schema.optional(
    Schema.NullOr(Schema.Struct({ additions: Schema.Int, deletions: Schema.Int })),
  ),
});
export const ForgejoStatus = Schema.Struct({
  id: Schema.optional(Schema.Int),
  context: Schema.String,
  status: Schema.String,
  description: Schema.NullOr(Schema.String),
  target_url: Schema.NullOr(Schema.String),
  updated_at: Schema.String,
});
export const ForgejoReaction = Schema.Struct({
  content: Schema.String,
  user: Schema.NullOr(ForgejoUser),
});

export function forgejoActor(
  user: typeof ForgejoUser.Type | null | undefined,
): PullRequestActor | null {
  return user?.login
    ? { login: user.login, name: user.full_name || null, avatarUrl: user.avatar_url || null }
    : null;
}

export function forgejoChangeRequest(pr: typeof ForgejoPullRequest.Type) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: forgejoActor(pr.user),
    headBranch: forgejoHeadBranch(pr),
    baseBranch: pr.base.ref,
    headRepositoryNameWithOwner: pr.head.repo?.full_name ?? null,
    state: pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open",
    isDraft: pr.draft ?? /^(?:\[WIP\]|WIP:)/i.test(pr.title),
    // A false value also covers drafts and unfinished or failed conflict checks.
    mergeability: pr.mergeable === true ? "mergeable" : "unknown",
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    createdAt: toIsoUtc(pr.created_at),
    updatedAt: toIsoUtc(pr.updated_at),
    closedAt: pr.closed_at === null ? null : toIsoUtc(pr.closed_at),
    mergedAt: pr.merged_at === null ? null : toIsoUtc(pr.merged_at),
    reviewRequestLogins: (pr.requested_reviewers ?? []).map((user) => user.login),
    labels: (pr.labels ?? []).map((label) => ({
      name: label.name,
      color: label.color ?? null,
      description: label.description || null,
    })),
  } satisfies ProviderChangeRequest;
}

export function forgejoComment(comment: typeof ForgejoComment.Type): PullRequestComment {
  const createdAt = toIsoUtc(comment.created_at);
  const editedAt = comment.updated_at == null ? undefined : toIsoUtc(comment.updated_at);
  return {
    id: String(comment.id),
    kind: "issue-comment",
    author: forgejoActor(comment.user),
    body: comment.body,
    createdAt,
    ...(editedAt === undefined || editedAt === createdAt ? {} : { editedAt }),
    url: comment.html_url || null,
    path: null,
    reviewState: null,
  };
}

export function forgejoReview(review: typeof ForgejoReview.Type): PullRequestComment {
  return {
    id: `review:${review.id}`,
    kind: "review",
    author: forgejoActor(review.user),
    body: review.body,
    createdAt: toIsoUtc(review.submitted_at),
    url: review.html_url || null,
    path: null,
    reviewState:
      review.dismissed === true
        ? "DISMISSED"
        : review.state === "REQUEST_CHANGES"
          ? "CHANGES_REQUESTED"
          : review.state === "COMMENT"
            ? "COMMENTED"
            : review.state,
  };
}

export function forgejoReviewThread(
  comment: typeof ForgejoReviewComment.Type,
): PullRequestReviewThread {
  const oldSide = comment.position === 0 && comment.original_position > 0;
  const line = oldSide ? comment.original_position : comment.position;
  return {
    id: String(comment.id),
    path: comment.path,
    line: line > 0 ? line : null,
    side: oldSide ? "left" : "right",
    isResolved: comment.resolver !== null,
    isOutdated: false,
    comments: [forgejoComment(comment)],
  };
}

export function forgejoCommit(commit: typeof ForgejoCommit.Type): PullRequestCommit {
  const author = forgejoActor(commit.author);
  return {
    oid: commit.sha,
    messageHeadline: commit.commit.message.split("\n")[0] ?? "",
    committedDate: toIsoUtc(commit.commit.committer.date),
    authors: author ? [author] : [],
    ...(commit.stats
      ? { additions: commit.stats.additions, deletions: commit.stats.deletions }
      : {}),
  };
}

// Forgejo Actions reports a job that did not run as `skipped` and a cancelled one as `failure`,
// and `warning` is finished without being a pass. Only `pending` and states we do not know may
// hold a watch open.
function forgejoCheckStatus(state: string): PullRequestCheckStatus {
  switch (state) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "skipped":
      return "skipped";
    case "warning":
      return "neutral";
    default:
      return "pending";
  }
}

export function forgejoChecks(
  statuses: ReadonlyArray<typeof ForgejoStatus.Type>,
  pullRequestUrl: string,
): ReadonlyArray<PullRequestCheck> {
  return dedupeChecks(
    statuses.map((status) => ({
      workflowName: null,
      at: status.updated_at,
      ...(status.id === undefined ? {} : { sequence: status.id }),
      check: {
        name: status.context || "check",
        description: status.description || null,
        url: status.target_url
          ? (URL.parse(status.target_url, pullRequestUrl)?.href ?? null)
          : null,
        status: forgejoCheckStatus(status.status),
      },
    })),
  );
}

export const FORGEJO_REACTIONS: Record<PullRequestReactionContent, string> = {
  "thumbs-up": "+1",
  "thumbs-down": "-1",
  laugh: "laugh",
  hooray: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};
export function forgejoReactions(
  reactions: ReadonlyArray<typeof ForgejoReaction.Type>,
  viewer: string,
): ReadonlyArray<PullRequestReaction> {
  return Object.entries(FORGEJO_REACTIONS).flatMap(([content, emoji]) => {
    const matching = reactions.filter((reaction) => reaction.content === emoji);
    return matching.length === 0
      ? []
      : [
          {
            content: content as PullRequestReactionContent,
            count: matching.length,
            actors: matching.flatMap((reaction) =>
              reaction.user?.login && reaction.user.login !== viewer ? [reaction.user.login] : [],
            ),
            viewerHasReacted: matching.some((reaction) => reaction.user?.login === viewer),
          },
        ];
  });
}
