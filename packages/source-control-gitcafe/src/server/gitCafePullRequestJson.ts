/**
 * GitCafe's REST bodies, and their conversion into the neutral `Provider*` shapes. Every
 * conversion takes the repository's host, so a staging repository's links stay on staging.
 *
 * @module source-control-gitcafe/server/gitCafePullRequestJson
 */
import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestReaction,
  type PullRequestReactionContent,
  type PullRequestReviewThread,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";
import type {
  ProviderChangeRequest,
  ProviderChangeRequestActivity,
  ProviderChangeRequestStack,
  ProviderDiffSlice,
} from "@t3tools/source-control-core/server/PullRequestProvider";

const Actor = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("local"),
    actorId: Schema.String,
    handle: TrimmedNonEmptyString,
    displayName: Schema.NullOr(Schema.String),
    avatarUrl: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("github"),
    actorId: Schema.String,
    login: TrimmedNonEmptyString,
    avatarUrl: Schema.NullOr(Schema.String),
    linkedProfile: Schema.optional(Schema.NullOr(Schema.Struct({ handle: TrimmedNonEmptyString }))),
  }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), actorId: Schema.String }),
]);
type Actor = typeof Actor.Type;

const PullState = Schema.Literals(["open", "closed", "merged"]);

export const GitCafePull = Schema.Struct({
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  state: PullState,
  draft: Schema.Boolean,
  sourceBranch: Schema.String,
  targetBranch: Schema.String,
  headOid: Schema.NullOr(Schema.String),
  author: Actor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  version: NonNegativeInt,
  reviewers: Schema.optional(Schema.Array(Schema.Struct({ actor: Actor }))),
  labels: Schema.optional(
    Schema.Array(
      Schema.Struct({ name: TrimmedNonEmptyString, color: Schema.NullOr(Schema.String) }),
    ),
  ),
});
export type GitCafePull = typeof GitCafePull.Type;

export const GitCafePulls = Schema.Struct({
  items: Schema.Array(GitCafePull),
  next: Schema.NullOr(Schema.String),
});

export const GitCafePullDetail = Schema.Struct({
  ...GitCafePull.fields,
  description: Schema.NullOr(Schema.String),
  closedAt: Schema.NullOr(IsoDateTime),
  mergedAt: Schema.NullOr(IsoDateTime),
  sourceRepo: Schema.NullOr(Schema.Struct({ owner: Schema.String, name: Schema.String })),
  /** The base GitCafe last compared the pull request against, which a provider merge fences on. */
  observedBaseOid: Schema.optional(Schema.NullOr(Schema.String)),
  mergeRoute: Schema.optional(Schema.Literals(["native", "provider", "unsupported"])),
  lockedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  capabilities: Schema.Struct({
    comment: Schema.Boolean,
    review: Schema.Boolean,
    merge: Schema.Boolean,
    edit: Schema.Boolean,
    moderate: Schema.Boolean,
  }),
});
export type GitCafePullDetail = typeof GitCafePullDetail.Type;

const CommentCapabilities = Schema.Struct({
  edit: Schema.Boolean,
  hide: Schema.Boolean,
  unhide: Schema.Boolean,
  delete: Schema.Boolean,
  resolve: Schema.Boolean,
  unresolve: Schema.Boolean,
});

const GitCafeComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  /** What a resolution or rewrite fences on; absent from older answers. */
  version: Schema.optional(NonNegativeInt),
  author: Actor,
  body: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  path: Schema.NullOr(Schema.String),
  // The API allows any integer here; only a positive line anchors a review thread.
  line: Schema.NullOr(Schema.Int),
  side: Schema.NullOr(Schema.Literals(["left", "right"])),
  commitOid: Schema.NullOr(Schema.String),
  resolvedAt: Schema.NullOr(IsoDateTime),
  capabilities: Schema.optional(CommentCapabilities),
});
type GitCafeComment = typeof GitCafeComment.Type;

export const GitCafeComments = Schema.Struct({
  items: Schema.Array(GitCafeComment),
  next: Schema.NullOr(Schema.String),
});

export const GitCafeReviews = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      author: Actor,
      body: Schema.NullOr(Schema.String),
      verdict: Schema.Literals(["approve", "request_changes", "comment"]),
      dismissedAt: Schema.NullOr(IsoDateTime),
      createdAt: IsoDateTime,
    }),
  ),
  next: Schema.NullOr(Schema.String),
});

export const GitCafeCommits = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ oid: TrimmedNonEmptyString, summary: Schema.String, time: Schema.Finite }),
  ),
  truncated: Schema.Boolean,
  next: Schema.NullOr(Schema.String),
  headOid: Schema.String,
});

export const GitCafeReactions = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      subject: Schema.Struct({
        kind: Schema.Literals(["issue", "issue_comment", "pull_request", "pull_request_comment"]),
        id: TrimmedNonEmptyString,
      }),
      emoji: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("unicode"), value: TrimmedNonEmptyString }),
        Schema.Struct({ kind: Schema.Literal("custom"), id: TrimmedNonEmptyString }),
      ]),
      count: PositiveInt,
      viewerReactionId: Schema.NullOr(Schema.String),
      reactors: Schema.Array(Actor),
    }),
  ),
  next: Schema.NullOr(Schema.String),
});

const GitCafeStack = Schema.Struct({
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  /** What a land or restack fences on. */
  revision: PositiveInt,
  landingBase: Schema.String,
  members: Schema.Array(
    Schema.Struct({
      pullRequestNumber: PositiveInt,
      title: Schema.String,
      state: PullState,
      draft: Schema.Boolean,
      sourceBranch: Schema.String,
      headOid: Schema.optional(Schema.String),
      position: PositiveInt,
    }),
  ),
});
export type GitCafeStack = typeof GitCafeStack.Type;

export const GitCafeStackEnvelope = Schema.Struct({ stack: Schema.NullOr(GitCafeStack) });

const GitCafeDiffFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  oldPath: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(
    Schema.Literals([
      "added",
      "deleted",
      "modified",
      "typeChanged",
      "conflicted",
      "renamed",
      "copied",
    ]),
  ),
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  binary: Schema.optional(Schema.Boolean),
  tooLarge: Schema.optional(Schema.Boolean),
  hunksOmitted: Schema.optional(Schema.Boolean),
  isSubmodule: Schema.optional(Schema.Boolean),
  oldOid: Schema.optional(Schema.String),
  newOid: Schema.optional(Schema.String),
  // Structural pages (`/changes`, `/compare`) list files without hunks; the batched reads fill them.
  hunks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        oldStart: NonNegativeInt,
        oldLines: NonNegativeInt,
        newStart: NonNegativeInt,
        newLines: NonNegativeInt,
        lines: Schema.Array(Schema.Struct({ origin: Schema.String, content: Schema.String })),
      }),
    ),
  ),
});
export type GitCafeDiffFile = typeof GitCafeDiffFile.Type;
export const GitCafeDiffFiles = Schema.Array(GitCafeDiffFile);

export const GitCafeDiff = Schema.Struct({
  items: GitCafeDiffFiles,
  truncated: Schema.optional(Schema.Boolean),
});

export const GitCafeChecks = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      status: Schema.Literals(["queued", "in_progress", "completed"]),
      conclusion: Schema.NullOr(Schema.String),
      summary: Schema.NullOr(Schema.String),
      detailsUrl: Schema.NullOr(Schema.String),
    }),
  ),
  next: Schema.NullOr(Schema.String),
});

interface RepositoryOnHost {
  readonly repository: string;
  readonly host: string;
}

function toActor(actor: Actor, host: string): PullRequestActor | null {
  if (actor.kind === "unavailable") return null;
  return {
    login: actor.kind === "local" ? actor.handle : actor.login,
    name: actor.kind === "local" ? actor.displayName : null,
    // GitCafe serves its own avatars by path, so a relative one is read against the host.
    avatarUrl: actor.avatarUrl === null ? null : new URL(actor.avatarUrl, `https://${host}`).href,
  };
}

/** The reviewers GitCafe has asked, as the detail's reviewer list shows them. */
export function toReviewers(
  pull: Pick<GitCafePull, "reviewers">,
  host: string,
): ReadonlyArray<PullRequestActor> {
  return (pull.reviewers ?? []).flatMap(({ actor }) => {
    const reviewer = toActor(actor, host);
    return reviewer === null ? [] : [reviewer];
  });
}

/** A linked GitHub reviewer answers to both logins, so either one finds the review request. */
function reviewerLogins(actor: Actor, host: string): ReadonlyArray<string> {
  const reviewer = toActor(actor, host);
  if (reviewer === null) return [];
  return actor.kind === "github" && actor.linkedProfile
    ? [reviewer.login, actor.linkedProfile.handle]
    : [reviewer.login];
}

export function toChangeRequest(
  pull: GitCafePull,
  target: RepositoryOnHost,
): ProviderChangeRequest {
  return {
    number: pull.number,
    title: pull.title,
    url: `https://${target.host}/${target.repository}/pulls/${pull.number}`,
    author: toActor(pull.author, target.host),
    headBranch: pull.sourceBranch,
    baseBranch: pull.targetBranch,
    state: pull.state,
    isDraft: pull.draft,
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    reviewRequestLogins: (pull.reviewers ?? []).flatMap(({ actor }) =>
      reviewerLogins(actor, target.host),
    ),
    labels: pull.labels ?? [],
  };
}

/** What GitCafe's own capabilities let this viewer do with the pull request. */
export function toViewerPermissions(detail: GitCafePullDetail): PullRequestViewerPermissions {
  const { comment, edit, review, merge, moderate } = detail.capabilities;
  // A locked conversation keeps its composer for moderators only.
  const open = comment && (detail.lockedAt == null || moderate);
  return {
    actions: [
      // A merged pull request is settled; a closed one can only be reopened.
      ...(edit && detail.state === "open"
        ? ([detail.draft ? "ready" : "draft", "close"] as const)
        : edit && detail.state === "closed"
          ? (["reopen"] as const)
          : []),
      ...(merge && detail.state === "open" && !detail.draft ? (["merge"] as const) : []),
    ],
    stackRebase: merge,
    comment: open,
    // Each thread's root narrows this further with its own `canResolve`.
    resolve: open,
    verdicts: review ? ["approve", "request-changes", "comment"] : [],
    requestReviewers: false,
    editChangeRequest: edit,
    // GitCafe's only branch update moves a whole stack.
    updateMethods: [],
  };
}

const REACTIONS: Readonly<Record<string, PullRequestReactionContent>> = {
  "👍": "thumbs-up",
  "👎": "thumbs-down",
  "😄": "laugh",
  "🎉": "hooray",
  "😕": "confused",
  "❤": "heart",
  "🚀": "rocket",
  "👀": "eyes",
};

/** The emoji GitCafe takes for one of the shared reactions. */
export const REACTION_EMOJI: Readonly<Record<PullRequestReactionContent, string>> = {
  "thumbs-up": "👍",
  "thumbs-down": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};

/** The shared reaction an emoji stands for; custom and unlisted ones stand for none. */
export function reactionContent(emoji: string): PullRequestReactionContent | undefined {
  return REACTIONS[emoji.replaceAll("\uFE0F", "")];
}

function toReactions(data: typeof GitCafeReactions.Type, host: string) {
  const reactions: Array<PullRequestReaction> = [];
  const byComment = new Map<string, Array<PullRequestReaction>>();
  for (const item of data.items) {
    const content = item.emoji.kind === "unicode" ? reactionContent(item.emoji.value) : undefined;
    if (content === undefined) continue;
    const reaction: PullRequestReaction = {
      content,
      count: item.count,
      actors: item.reactors.flatMap((actor) => {
        const reactor = toActor(actor, host);
        return reactor === null ? [] : [reactor.login];
      }),
      viewerHasReacted: item.viewerReactionId !== null,
    };
    if (item.subject.kind === "pull_request") reactions.push(reaction);
    else if (item.subject.kind === "pull_request_comment")
      byComment.set(item.subject.id, [...(byComment.get(item.subject.id) ?? []), reaction]);
  }
  return { reactions, byComment };
}

const REVIEW_STATES = {
  approve: "approved",
  request_changes: "changes_requested",
  comment: "commented",
} as const;

/** GitCafe persists a thread's identity apart from its line, so threads group by `threadId`. */
export function toActivity(input: {
  readonly comments: typeof GitCafeComments.Type;
  readonly reviews: typeof GitCafeReviews.Type;
  readonly commits: typeof GitCafeCommits.Type;
  readonly reactions?: typeof GitCafeReactions.Type;
  readonly headOid?: string;
  readonly host: string;
}): ProviderChangeRequestActivity {
  const { host } = input;
  const reactions = input.reactions === undefined ? undefined : toReactions(input.reactions, host);
  const remark = (comment: GitCafeComment) => ({
    id: comment.id,
    author: toActor(comment.author, host),
    body: comment.body ?? "",
    createdAt: comment.createdAt,
    url: null,
    ...(comment.capabilities === undefined ? {} : { canEdit: comment.capabilities.edit }),
    ...(reactions === undefined ? {} : { reactions: reactions.byComment.get(comment.id) ?? [] }),
  });
  // Stable, so remarks written in the same instant keep GitCafe's own order.
  const ordered = input.comments.items.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const groups = new Map<string, Array<GitCafeComment>>();
  for (const comment of ordered) {
    if (!comment.path || comment.line === null || comment.line < 1 || comment.side === null)
      continue;
    groups.set(comment.threadId, [...(groups.get(comment.threadId) ?? []), comment]);
  }
  const reviewThreads = [...groups.values()].map((group): PullRequestReviewThread => {
    const first = group[0]!;
    const latest = group.at(-1)!;
    const root = group.find((comment) => comment.id === comment.threadId);
    return {
      id: first.threadId,
      path: first.path!,
      line: first.line,
      side: first.side!,
      isResolved: root?.resolvedAt != null,
      isOutdated:
        input.headOid !== undefined &&
        latest.commitOid !== null &&
        latest.commitOid !== input.headOid,
      comments: group.map(remark),
      ...(root?.capabilities === undefined
        ? {}
        : {
            canResolve:
              root.resolvedAt === null ? root.capabilities.resolve : root.capabilities.unresolve,
          }),
    };
  });
  const comments: Array<PullRequestComment> = [
    ...ordered.map((comment) => ({
      ...remark(comment),
      kind: comment.path === null ? ("issue-comment" as const) : ("review-comment" as const),
      path: comment.path,
      reviewState: null,
    })),
    ...input.reviews.items.map((review) => ({
      id: review.id,
      kind: "review" as const,
      author: toActor(review.author, host),
      body: review.body ?? "",
      createdAt: review.createdAt,
      url: null,
      path: null,
      reviewState: review.dismissedAt !== null ? "dismissed" : REVIEW_STATES[review.verdict],
    })),
  ];
  return {
    comments: comments.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    commentCount: input.comments.items.length + input.reviews.items.length,
    commentsTruncated: input.comments.next !== null || input.reviews.next !== null,
    reviewThreads,
    commits: input.commits.items.map((commit) => ({
      oid: commit.oid,
      messageHeadline: commit.summary,
      committedDate: DateTime.formatIso(DateTime.makeUnsafe(commit.time * 1_000)),
    })),
    ...(reactions === undefined ? {} : { reactions: reactions.reactions }),
  };
}

export function toStack(stack: GitCafeStack, target: RepositoryOnHost): ProviderChangeRequestStack {
  return {
    id: stack.id,
    number: stack.number,
    url: `https://${target.host}/${target.repository}/stacks/${stack.number}`,
    base: stack.landingBase,
    layers: stack.members
      .toSorted((a, b) => a.position - b.position)
      .map((member) => ({
        number: member.pullRequestNumber,
        title: member.title,
        headBranch: member.sourceBranch,
        state: member.state,
        isDraft: member.draft,
        ...(member.headOid === undefined ? {} : { headSha: member.headOid }),
      })),
  };
}

/** Converts GitCafe's structured hunks into a unified patch, keeping omitted files' counts. */
export function toDiff(diff: typeof GitCafeDiff.Type): ProviderDiffSlice {
  const chunks: Array<string> = [];
  const omittedFileStats: Array<{ path: string; additions: number; deletions: number }> = [];
  for (const file of diff.items) {
    const oldPath = file.oldPath ?? file.path;
    const a = quoteGitPatchPath(`a/${oldPath}`);
    const b = quoteGitPatchPath(`b/${file.path}`);
    const before = file.status === "added" ? "/dev/null" : a;
    const after = file.status === "deleted" ? "/dev/null" : b;
    const mode = file.isSubmodule ? "160000" : "100644";
    const lines = [`diff --git ${a} ${b}`];
    if (file.status === "added") lines.push(`new file mode ${mode}`);
    if (file.status === "deleted") lines.push(`deleted file mode ${mode}`);
    if (file.status === "renamed" || file.status === "copied") {
      const action = file.status === "renamed" ? "rename" : "copy";
      lines.push(
        `${action} from ${quoteGitPatchPath(oldPath)}`,
        `${action} to ${quoteGitPatchPath(file.path)}`,
      );
    }
    if (file.binary) {
      lines.push(`Binary files ${before} and ${after} differ`);
    } else if (file.tooLarge || file.hunksOmitted) {
      omittedFileStats.push({
        path: file.path,
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      });
    } else if (file.isSubmodule) {
      const hasOld = file.status !== "added" && file.oldOid !== undefined;
      const hasNew = file.status !== "deleted" && file.newOid !== undefined;
      lines.push(`--- ${before}`, `+++ ${after}`);
      lines.push(`@@ -${hasOld ? "1" : "0,0"} +${hasNew ? "1" : "0,0"} @@`);
      if (hasOld) lines.push(`-Subproject commit ${file.oldOid}`);
      if (hasNew) lines.push(`+Subproject commit ${file.newOid}`);
    } else {
      const hunks = file.hunks ?? [];
      if (hunks.length > 0) lines.push(`--- ${before}`, `+++ ${after}`);
      for (const hunk of hunks) {
        lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
        for (const line of hunk.lines) {
          // GitCafe marks a missing final newline with libgit2's own origins.
          if (["=", ">", "<"].includes(line.origin)) lines.push("\\ No newline at end of file");
          else lines.push(`${line.origin}${line.content.replace(/\n$/u, "")}`);
        }
      }
    }
    chunks.push(lines.join("\n"));
  }
  return {
    patch: chunks.length === 0 ? "" : `${chunks.join("\n")}\n`,
    truncated: diff.truncated === true || omittedFileStats.length > 0,
    nextCursor: null,
    ...(omittedFileStats.length === 0 ? {} : { omittedFileStats }),
  };
}

function checkStatus(check: (typeof GitCafeChecks.Type.items)[number]): PullRequestCheck["status"] {
  if (check.status !== "completed") return "pending";
  switch (check.conclusion) {
    case "success":
      return "success";
    case "neutral":
      return "neutral";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    case "action_required":
      return "action-required";
    default:
      return "failure";
  }
}

export function toChecks(checks: typeof GitCafeChecks.Type): ReadonlyArray<PullRequestCheck> {
  return checks.items.map((check) => ({
    name: check.name,
    status: checkStatus(check),
    description: check.summary,
    url: check.detailsUrl,
  }));
}
