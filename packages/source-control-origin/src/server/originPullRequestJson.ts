import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import {
  IsoDateTime,
  PositiveInt,
  TrimmedNonEmptyString,
  type PullRequestActor,
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
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { shortBranchName } from "./originHosts.ts";

/** Origin encodes pull and version numbers as JSON strings. */
export const OriginPullNumber = Schema.Union([
  PositiveInt,
  Schema.String.pipe(Schema.decodeTo(PositiveInt, SchemaTransformation.numberFromString)),
]);

const ActorUser = Schema.Struct({
  id: TrimmedNonEmptyString,
  email: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  handle: Schema.optional(Schema.String),
});

export const OriginActor = Schema.Struct({
  user: Schema.optional(ActorUser),
  app: Schema.optional(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      displayName: Schema.optional(Schema.String),
    }),
  ),
  serviceAccount: Schema.optional(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      type: Schema.optional(Schema.String),
      displayName: Schema.optional(Schema.String),
    }),
  ),
});
export type OriginActor = typeof OriginActor.Type;

const Label = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  color: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

const RefSide = Schema.Struct({
  ref: TrimmedNonEmptyString,
  sha: TrimmedNonEmptyString,
});

const StackParent = Schema.Struct({
  id: TrimmedNonEmptyString,
  number: OriginPullNumber,
});

export const OriginPull = Schema.Struct({
  id: TrimmedNonEmptyString,
  number: OriginPullNumber,
  state: Schema.Literals(["open", "closed"]),
  draft: Schema.Boolean,
  merged: Schema.Boolean,
  title: TrimmedNonEmptyString,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  head: RefSide,
  base: RefSide,
  author: Schema.optional(OriginActor),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  mergedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  additions: Schema.optional(Schema.Number),
  deletions: Schema.optional(Schema.Number),
  changedFiles: Schema.optional(Schema.Number),
  labels: Schema.optional(Schema.Array(Label)),
  webUrl: Schema.optional(Schema.String),
  stack: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        parentPullRequest: Schema.optional(StackParent),
      }),
    ),
  ),
  version: Schema.optional(
    Schema.Struct({
      number: Schema.optional(Schema.String),
      headSha: Schema.optional(Schema.String),
      baseSha: Schema.optional(Schema.String),
    }),
  ),
});
export type OriginPull = typeof OriginPull.Type;

export const OriginPulls = Schema.Struct({
  pullRequests: Schema.Array(OriginPull),
  nextPageToken: Schema.optional(Schema.String),
});

export const OriginRepo = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  fullName: Schema.optional(TrimmedNonEmptyString),
  defaultBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  cloneUrl: Schema.optional(Schema.String),
  webUrl: Schema.optional(Schema.String),
  allowMergeCommit: Schema.optional(Schema.Boolean),
  allowSquashMerge: Schema.optional(Schema.Boolean),
  mirror: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        source: Schema.optional(Schema.String),
        sourceId: Schema.optional(Schema.String),
        status: Schema.optional(Schema.String),
      }),
    ),
  ),
  owner: Schema.optional(
    Schema.Struct({
      slug: TrimmedNonEmptyString,
      id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
    }),
  ),
});
export type OriginRepo = typeof OriginRepo.Type;

export const OriginMergeability = Schema.Struct({
  verdict: Schema.optional(Schema.String),
  blockers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
      }),
    ),
  ),
});

export const OriginFile = Schema.Struct({
  filename: TrimmedNonEmptyString,
  status: Schema.optional(Schema.String),
  additions: Schema.optional(Schema.Number),
  deletions: Schema.optional(Schema.Number),
  patch: Schema.optional(Schema.String),
  previousFilename: Schema.optional(Schema.String),
});

export const OriginFiles = Schema.Struct({
  files: Schema.Array(OriginFile),
  nextPageToken: Schema.optional(Schema.String),
});

export const OriginComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  author: Schema.optional(OriginActor),
  reactions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(Schema.String),
        emoji: Schema.optional(Schema.String),
        reactor: Schema.optional(OriginActor),
      }),
    ),
  ),
  thread: Schema.Struct({
    id: TrimmedNonEmptyString,
    path: Schema.optional(Schema.String),
    side: Schema.optional(Schema.Literals(["left", "right"])),
    startLine: Schema.optional(Schema.Number),
    endLine: Schema.optional(Schema.Number),
    resolvedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
    version: Schema.optional(
      Schema.Struct({
        headSha: Schema.optional(Schema.String),
        baseSha: Schema.optional(Schema.String),
      }),
    ),
  }),
});

export const OriginComments = Schema.Struct({
  comments: Schema.Array(OriginComment),
  nextPageToken: Schema.optional(Schema.String),
});

export const OriginReview = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.optional(OriginActor),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  verdict: Schema.optional(Schema.String),
  submittedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  dismissal: Schema.optional(
    Schema.NullOr(Schema.Struct({ dismissedAt: Schema.optional(IsoDateTime) })),
  ),
});

export const OriginReviews = Schema.Struct({
  reviews: Schema.Array(OriginReview),
  nextPageToken: Schema.optional(Schema.String),
});

export const OriginCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  commit: Schema.Struct({
    message: Schema.optional(Schema.String),
    author: Schema.optional(
      Schema.Struct({
        date: Schema.optional(Schema.String),
      }),
    ),
    committer: Schema.optional(
      Schema.Struct({
        date: Schema.optional(Schema.String),
      }),
    ),
  }),
});

export const OriginCommits = Schema.Struct({
  commits: Schema.Array(OriginCommit),
  nextPageToken: Schema.optional(Schema.String),
});

export const OriginRequestedReviewers = Schema.Struct({
  reviewers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        user: Schema.optional(ActorUser),
        group: Schema.optional(Schema.Struct({ id: TrimmedNonEmptyString })),
        serviceAccount: Schema.optional(
          Schema.Struct({
            id: TrimmedNonEmptyString,
            displayName: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  ),
  users: Schema.optional(Schema.Array(ActorUser)),
});

export const OriginGrants = Schema.Struct({
  grants: Schema.Array(
    Schema.Struct({
      user: Schema.optional(ActorUser),
      group: Schema.optional(Schema.Struct({ id: TrimmedNonEmptyString })),
      permission: Schema.optional(Schema.String),
    }),
  ),
  nextPageToken: Schema.optional(Schema.String),
});

export const OriginNamespaces = Schema.Struct({
  namespaces: Schema.Array(
    Schema.Struct({
      namespace: Schema.Struct({
        slug: TrimmedNonEmptyString,
        id: Schema.optional(Schema.String),
        type: Schema.optional(Schema.String),
      }),
    }),
  ),
});

export const OriginPermission = Schema.Struct({
  permission: Schema.Literals(["read", "write", "admin", "custom"]),
});

export function pullState(
  pull: Pick<OriginPull, "state" | "merged">,
): "open" | "closed" | "merged" {
  if (pull.merged) return "merged";
  return pull.state === "open" ? "open" : "closed";
}

export function toActor(actor: OriginActor | undefined): PullRequestActor | null {
  if (actor?.user) {
    return {
      login: actor.user.handle || actor.user.email || actor.user.id,
      name: actor.user.displayName ?? null,
      avatarUrl: null,
    };
  }
  if (actor?.app) {
    return {
      login: actor.app.displayName || actor.app.id,
      name: actor.app.displayName ?? null,
      avatarUrl: null,
      isBot: true,
    };
  }
  if (actor?.serviceAccount) {
    return {
      login: actor.serviceAccount.displayName || actor.serviceAccount.id,
      name: actor.serviceAccount.displayName ?? null,
      avatarUrl: null,
      isBot: true,
    };
  }
  return null;
}

export function changeRequestUrl(repository: string, number: number, webUrl?: string) {
  return webUrl ?? `https://cursor.com/codebase/${repository}/pull/${number}`;
}

export function toChangeRequest(pull: OriginPull, repository: string): ProviderChangeRequest {
  return {
    number: pull.number,
    title: pull.title,
    url: changeRequestUrl(repository, pull.number, pull.webUrl),
    author: toActor(pull.author),
    headBranch: shortBranchName(pull.head.ref),
    baseBranch: shortBranchName(pull.base.ref),
    state: pullState(pull),
    isDraft: pull.draft,
    mergeability: "unknown",
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    reviewRequestLogins: [],
    labels: (pull.labels ?? []).map(({ name, color }) => ({
      name,
      color: color ? `#${color.replace(/^#/u, "")}` : null,
    })),
  };
}

export function toViewerPermissions(input: {
  readonly pull: OriginPull;
  readonly canWrite: boolean;
}): PullRequestViewerPermissions {
  const state = pullState(input.pull);
  return {
    actions: [
      ...(state === "open"
        ? ([input.pull.draft ? "ready" : "draft", "close"] as const)
        : state === "closed"
          ? (["reopen"] as const)
          : []),
      ...(input.canWrite && state === "open" && !input.pull.draft ? (["merge"] as const) : []),
    ],
    comment: true,
    resolve: true,
    verdicts: ["approve", "request-changes", "comment"],
    requestReviewers: state === "open",
    labels: state === "open",
    editChangeRequest: state === "open" || state === "closed",
    updateMethods: [],
  };
}

const REACTION_CONTENT: Readonly<Record<string, PullRequestReactionContent>> = {
  thumbs_up: "thumbs-up",
  thumbs_down: "thumbs-down",
  laugh: "laugh",
  hooray: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

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

function toCommentReactions(
  reactions: NonNullable<typeof OriginComment.Type.reactions>,
): Array<PullRequestReaction> {
  const byContent = new Map<PullRequestReactionContent, PullRequestReaction>();
  for (const reaction of reactions) {
    const content = reaction.content === undefined ? undefined : REACTION_CONTENT[reaction.content];
    if (content === undefined) continue;
    const login = toActor(reaction.reactor)?.login;
    const existing = byContent.get(content);
    byContent.set(content, {
      content,
      count: (existing?.count ?? 0) + 1,
      actors: [...(existing?.actors ?? []), ...(login ? [login] : [])],
      viewerHasReacted: existing?.viewerHasReacted ?? false,
    });
  }
  return [...byContent.values()];
}

const REVIEW_STATES = {
  approve: "approved",
  request_changes: "changes_requested",
  comment: "commented",
} as const;

export function toActivity(input: {
  readonly comments: typeof OriginComments.Type;
  readonly reviews: typeof OriginReviews.Type;
  readonly commits: typeof OriginCommits.Type;
  readonly headSha?: string;
}): ProviderChangeRequestActivity {
  const remark = (comment: typeof OriginComment.Type) => ({
    id: comment.id,
    author: toActor(comment.author),
    body: comment.body ?? "",
    createdAt: comment.createdAt,
    url: null,
    reactions: toCommentReactions(comment.reactions ?? []),
  });
  const groups = new Map<string, Array<typeof OriginComment.Type>>();
  for (const comment of input.comments.comments) {
    const path = comment.thread.path?.trim();
    const line = comment.thread.startLine;
    if (!path || line === undefined || line < 1 || comment.thread.side === undefined) continue;
    groups.set(comment.thread.id, [...(groups.get(comment.thread.id) ?? []), comment]);
  }
  const reviewThreads = [...groups.entries()].map(([id, group]): PullRequestReviewThread => {
    const first = group[0]!;
    const latest = group.at(-1)!;
    return {
      id,
      path: first.thread.path!,
      line: first.thread.startLine ?? null,
      side: first.thread.side!,
      isResolved: first.thread.resolvedAt != null,
      isOutdated:
        input.headSha !== undefined &&
        latest.thread.version?.headSha !== undefined &&
        latest.thread.version.headSha !== input.headSha,
      comments: group.map(remark),
    };
  });
  const comments = [
    ...input.comments.comments.map((comment) => ({
      ...remark(comment),
      kind:
        comment.thread.path && (comment.thread.startLine ?? 0) > 0
          ? ("review-comment" as const)
          : ("issue-comment" as const),
      path: comment.thread.path || null,
      reviewState: null,
    })),
    ...input.reviews.reviews.map((review) => ({
      id: review.id,
      kind: "review" as const,
      author: toActor(review.author),
      body: review.body ?? "",
      createdAt:
        review.submittedAt ?? input.comments.comments[0]?.createdAt ?? "1970-01-01T00:00:00.000Z",
      url: null,
      path: null,
      reviewState:
        review.dismissal != null
          ? ("dismissed" as const)
          : (REVIEW_STATES[(review.verdict ?? "comment") as keyof typeof REVIEW_STATES] ??
            ("commented" as const)),
    })),
  ];
  return {
    comments: comments.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    commentCount: input.comments.comments.length + input.reviews.reviews.length,
    commentsTruncated:
      Boolean(input.comments.nextPageToken) || Boolean(input.reviews.nextPageToken),
    reviewThreads,
    commits: input.commits.commits.map((commit) => ({
      oid: commit.sha,
      messageHeadline: (commit.commit.message ?? "").split("\n")[0] ?? "",
      committedDate:
        commit.commit.committer?.date ?? commit.commit.author?.date ?? "1970-01-01T00:00:00.000Z",
    })),
  };
}

export function toDiff(files: typeof OriginFiles.Type): ProviderDiffSlice {
  const chunks: Array<string> = [];
  for (const file of files.files) {
    const oldPath = file.previousFilename ?? file.filename;
    const a = quoteGitPatchPath(`a/${oldPath}`);
    const b = quoteGitPatchPath(`b/${file.filename}`);
    const lines = [`diff --git ${a} ${b}`];
    if (file.status === "added") lines.push("new file mode 100644");
    if (file.status === "removed") lines.push("deleted file mode 100644");
    if ((file.status === "renamed" || file.status === "copied") && file.previousFilename) {
      lines.push(
        `similarity index 50%`,
        `${file.status === "renamed" ? "rename" : "copy"} from ${quoteGitPatchPath(file.previousFilename)}`,
        `${file.status === "renamed" ? "rename" : "copy"} to ${quoteGitPatchPath(file.filename)}`,
      );
    }
    if (file.patch) {
      const before = file.status === "added" ? "/dev/null" : a;
      const after = file.status === "removed" ? "/dev/null" : b;
      if (!file.patch.includes("\n--- ") && !file.patch.startsWith("--- ")) {
        lines.push(`--- ${before}`, `+++ ${after}`);
      }
      lines.push(file.patch.replace(/\n$/u, ""));
    }
    chunks.push(lines.join("\n"));
  }
  return {
    patch: chunks.length === 0 ? "" : `${chunks.join("\n")}\n`,
    truncated: false,
    nextCursor: files.nextPageToken || null,
  };
}

export function toStack(
  pull: OriginPull,
  members: ReadonlyArray<OriginPull>,
  repository: string,
): ProviderChangeRequestStack | null {
  if (!pull.stack) return null;
  const byNumber = new Map(members.map((member) => [member.number, member]));
  const ordered: Array<OriginPull> = [];
  const seen = new Set<number>();
  let current: OriginPull | undefined = pull;
  while (current && !seen.has(current.number)) {
    seen.add(current.number);
    ordered.unshift(current);
    const parentNumber: number | undefined = current.stack?.parentPullRequest?.number;
    current = parentNumber === undefined ? undefined : byNumber.get(parentNumber);
  }
  for (const member of members) {
    if (!seen.has(member.number)) ordered.push(member);
  }
  return {
    id: pull.stack.id,
    number: pull.number,
    url: `https://cursor.com/codebase/${repository}/pull/${pull.number}`,
    base: shortBranchName(ordered[0]?.base.ref ?? pull.base.ref),
    layers: ordered.map((member) => ({
      number: member.number,
      title: member.title,
      headBranch: shortBranchName(member.head.ref),
      state: pullState(member),
      isDraft: member.draft,
      headSha: member.head.sha,
    })),
  };
}

export function mergeabilityOf(
  data: typeof OriginMergeability.Type,
): "mergeable" | "conflicting" | "unknown" {
  if (data.verdict === "mergeable") return "mergeable";
  if ((data.blockers ?? []).some((blocker) => blocker.kind === "merge_conflict"))
    return "conflicting";
  if (data.verdict === "blocked") return "unknown";
  return "unknown";
}
