import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import type { ProviderChangeRequest } from "./PullRequestProvider.ts";
import { dedupeChecks } from "./pullRequestChecks.ts";

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
  permissions: Schema.optional(Schema.Struct({ push: Schema.Boolean, admin: Schema.Boolean })),
  archived: Schema.optional(Schema.Boolean),
  allow_merge_commits: Schema.optional(Schema.Boolean),
  allow_squash_merge: Schema.optional(Schema.Boolean),
  allow_rebase: Schema.optional(Schema.Boolean),
  allow_rebase_update: Schema.optional(Schema.Boolean),
});
const Branch = Schema.Struct({
  ref: Schema.String,
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
  html_url: Schema.optional(Schema.String),
});
export const ForgejoReview = Schema.Struct({
  id: Schema.Int,
  body: Schema.String,
  user: Schema.NullOr(ForgejoUser),
  state: Schema.String,
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

function toIsoUtc(value: string): string {
  return Option.match(DateTime.make(value), { onNone: () => value, onSome: DateTime.formatIso });
}

export function forgejoChangeRequest(pr: typeof ForgejoPullRequest.Type) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: forgejoActor(pr.user),
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    headRepositoryNameWithOwner: pr.head.repo?.full_name ?? null,
    state: pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open",
    isDraft: pr.draft ?? /^(?:\[WIP\]|WIP:)/i.test(pr.title),
    mergeability:
      pr.mergeable === undefined ? "unknown" : pr.mergeable ? "mergeable" : "conflicting",
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    createdAt: toIsoUtc(pr.created_at),
    updatedAt: toIsoUtc(pr.updated_at),
    closedAt: pr.closed_at === null ? null : toIsoUtc(pr.closed_at),
    mergedAt: pr.merged_at === null ? null : toIsoUtc(pr.merged_at),
    reviewRequestLogins: (pr.requested_reviewers ?? []).map((user) => user.login),
    labels: (pr.labels ?? []).map((label) => ({ name: label.name, color: label.color ?? null })),
  } satisfies ProviderChangeRequest;
}

export function forgejoComment(comment: typeof ForgejoComment.Type): PullRequestComment {
  return {
    id: String(comment.id),
    kind: "issue-comment",
    author: forgejoActor(comment.user),
    body: comment.body,
    createdAt: toIsoUtc(comment.created_at),
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
      review.state === "REQUEST_CHANGES"
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

export function forgejoChecks(
  statuses: ReadonlyArray<typeof ForgejoStatus.Type>,
): ReadonlyArray<PullRequestCheck> {
  return dedupeChecks(
    statuses.map((status) => ({
      workflowName: null,
      at: status.updated_at,
      check: {
        name: status.context || "check",
        description: status.description || null,
        url: status.target_url || null,
        status:
          status.status === "success"
            ? "success"
            : status.status === "failure" || status.status === "error"
              ? "failure"
              : "pending",
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
