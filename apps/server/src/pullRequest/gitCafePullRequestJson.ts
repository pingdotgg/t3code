import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  type PullRequestActor,
  type PullRequestReviewThread,
} from "@t3tools/contracts";
import type {
  ProviderChangeRequest,
  ProviderChangeRequestActivity,
  ProviderChangeRequestStack,
  ProviderDiffSlice,
} from "./PullRequestProvider.ts";

const ActorSchema = Schema.Union([
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
export function toActor(
  author: typeof ActorSchema.Type,
  host = "git.cafe",
): PullRequestActor | null {
  if (author.kind === "unavailable") return null;
  return {
    login: author.kind === "local" ? author.handle : author.login,
    name: author.kind === "local" ? author.displayName : null,
    avatarUrl: author.avatarUrl === null ? null : new URL(author.avatarUrl, `https://${host}`).href,
  };
}
export const RawPullSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed", "merged"]),
  draft: Schema.Boolean,
  sourceBranch: Schema.String,
  targetBranch: Schema.String,
  headOid: Schema.NullOr(Schema.String),
  author: ActorSchema,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  version: NonNegativeInt,
  reviewers: Schema.optional(Schema.Array(Schema.Struct({ actor: ActorSchema }))),
  labels: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.NullOr(Schema.String) })),
  ),
});
export type RawPull = typeof RawPullSchema.Type;
export const PullListSchema = Schema.Struct({
  items: Schema.Array(RawPullSchema),
  nextAfter: Schema.NullOr(Schema.String),
});
export const PullDetailSchema = Schema.Struct({
  ...RawPullSchema.fields,
  description: Schema.NullOr(Schema.String),
  closedAt: Schema.NullOr(IsoDateTime),
  mergedAt: Schema.NullOr(IsoDateTime),
  sourceRepo: Schema.NullOr(Schema.Struct({ owner: Schema.String, name: Schema.String })),
  capabilities: Schema.Struct({
    comment: Schema.Boolean,
    review: Schema.Boolean,
    merge: Schema.Boolean,
    edit: Schema.Boolean,
    moderate: Schema.Boolean,
  }),
});
export function pullUrl(repository: string, number: number, host = "git.cafe"): string {
  return `https://${host}/${repository}/pulls/${number}`;
}
export function toChangeRequest(
  pull: RawPull,
  repository: string,
  host = "git.cafe",
): ProviderChangeRequest {
  return {
    number: pull.number,
    title: pull.title,
    url: pullUrl(repository, pull.number, host),
    author: toActor(pull.author, host),
    headBranch: pull.sourceBranch,
    baseBranch: pull.targetBranch,
    state: pull.state,
    isDraft: pull.draft,
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    reviewRequestLogins: (pull.reviewers ?? []).flatMap(({ actor }) => {
      const reviewer = toActor(actor, host);
      return reviewer === null
        ? []
        : actor.kind === "github" && actor.linkedProfile
          ? [reviewer.login, actor.linkedProfile.handle]
          : [reviewer.login];
    }),
    labels: pull.labels ?? [],
  };
}

const StackSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  revision: PositiveInt,
  landingBase: Schema.String,
  members: Schema.Array(
    Schema.Struct({
      pullRequestNumber: PositiveInt,
      title: Schema.String,
      state: Schema.Literals(["open", "closed", "merged"]),
      draft: Schema.Boolean,
      sourceBranch: Schema.String,
      position: PositiveInt,
    }),
  ),
});
export const StackEnvelopeSchema = Schema.Struct({ stack: Schema.NullOr(StackSchema) });
export function toStack(
  stack: typeof StackSchema.Type,
  repository: string,
  host = "git.cafe",
): ProviderChangeRequestStack {
  return {
    id: stack.id,
    number: stack.number,
    url: `https://${host}/${repository}/stacks/${stack.number}`,
    base: stack.landingBase,
    layers: [...stack.members]
      .sort((a, b) => a.position - b.position)
      .map((member) => ({
        number: member.pullRequestNumber,
        title: member.title,
        headBranch: member.sourceBranch,
        state: member.state,
        isDraft: member.draft,
      })),
  };
}

const CommentSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  author: ActorSchema,
  body: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  path: Schema.NullOr(Schema.String),
  line: Schema.NullOr(PositiveInt),
  side: Schema.NullOr(Schema.Literals(["left", "right"])),
  commitOid: Schema.NullOr(Schema.String),
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export const CommentsSchema = Schema.Struct({
  items: Schema.Array(CommentSchema),
  nextAfter: Schema.NullOr(Schema.String),
});
const ReviewSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: ActorSchema,
  body: Schema.NullOr(Schema.String),
  verdict: Schema.Literals(["approve", "request_changes", "comment"]),
  dismissedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export const ReviewsSchema = Schema.Struct({
  items: Schema.Array(ReviewSchema),
  nextAfter: Schema.NullOr(Schema.String),
});
export const ReviewersSchema = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, actor: ActorSchema })),
  nextAfter: Schema.NullOr(Schema.String),
});
export function toReviewers(
  data: typeof ReviewersSchema.Type,
  host = "git.cafe",
): ReadonlyArray<PullRequestActor> {
  return data.items.flatMap((reviewer) => {
    const actor = toActor(reviewer.actor, host);
    return actor === null ? [] : [actor];
  });
}
export const CommitListSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ oid: TrimmedNonEmptyString, summary: Schema.String, time: Schema.Finite }),
  ),
  truncated: Schema.Boolean,
  nextAfter: Schema.NullOr(Schema.String),
  headOid: Schema.String,
});
export function toCommits(data: typeof CommitListSchema.Type) {
  return data.items.map((commit) => ({
    oid: commit.oid,
    messageHeadline: commit.summary,
    committedDate: DateTime.formatIso(DateTime.makeUnsafe(commit.time * 1000)),
  }));
}

/** GitCafe persists thread identity separately from its line anchor. */
export function toActivity(
  comments: typeof CommentsSchema.Type,
  reviews: typeof ReviewsSchema.Type,
  commits: typeof CommitListSchema.Type,
  headOid?: string,
  host = "git.cafe",
): ProviderChangeRequestActivity {
  const ordered = [...comments.items].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const groups = new Map<string, Array<typeof CommentSchema.Type>>();
  for (const comment of ordered) {
    if (!comment.path || comment.line === null || comment.side === null) continue;
    const key = comment.threadId;
    const group = groups.get(key) ?? [];
    group.push(comment);
    groups.set(key, group);
  }
  const reviewThreads: PullRequestReviewThread[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const root = group.find((comment) => comment.id === comment.threadId);
    const latest = group.at(-1)!;
    reviewThreads.push({
      id: first.threadId,
      path: first.path!,
      line: first.line,
      side: first.side!,
      isResolved: root?.resolvedAt != null,
      isOutdated:
        headOid !== undefined && latest.commitOid !== null && latest.commitOid !== headOid,
      comments: group.map((comment) => ({
        id: comment.id,
        author: toActor(comment.author, host),
        body: comment.body ?? "",
        createdAt: comment.createdAt,
        url: null,
      })),
    });
  }
  return {
    comments: [
      ...ordered.map((comment) => ({
        id: comment.id,
        kind: comment.path === null ? ("issue-comment" as const) : ("review-comment" as const),
        author: toActor(comment.author, host),
        body: comment.body ?? "",
        createdAt: comment.createdAt,
        url: null,
        path: comment.path,
        reviewState: null,
      })),
      ...reviews.items.map((review) => ({
        id: review.id,
        kind: "review" as const,
        author: toActor(review.author, host),
        body: review.body ?? "",
        createdAt: review.createdAt,
        url: null,
        path: null,
        reviewState:
          review.dismissedAt !== null
            ? "dismissed"
            : review.verdict === "approve"
              ? "approved"
              : review.verdict === "request_changes"
                ? "changes_requested"
                : "commented",
      })),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    commentCount: comments.items.length + reviews.items.length,
    commentsTruncated: comments.nextAfter !== null || reviews.nextAfter !== null,
    reviewThreads,
    commits: toCommits(commits),
  };
}

const DiffFileSchema = Schema.Struct({
  path: TrimmedNonEmptyString,
  oldPath: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.Literals([
    "added",
    "deleted",
    "modified",
    "typeChanged",
    "conflicted",
    "renamed",
    "copied",
  ]),
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  binary: Schema.optional(Schema.Boolean),
  tooLarge: Schema.optional(Schema.Boolean),
  hunksOmitted: Schema.optional(Schema.Boolean),
  isSubmodule: Schema.optional(Schema.Boolean),
  oldOid: Schema.optional(Schema.String),
  newOid: Schema.optional(Schema.String),
  hunks: Schema.Array(
    Schema.Struct({
      oldStart: NonNegativeInt,
      oldLines: NonNegativeInt,
      newStart: NonNegativeInt,
      newLines: NonNegativeInt,
      lines: Schema.Array(Schema.Struct({ origin: Schema.String, content: Schema.String })),
    }),
  ),
});
export const DiffSchema = Schema.Struct({
  items: Schema.Array(DiffFileSchema),
  truncated: Schema.Boolean,
});

function quotePath(path: string): string {
  return /[\s"\\]/u.test(path) ? JSON.stringify(path) : path;
}

/** Convert the host's structured hunks without silently losing omitted-file statistics. */
export function toDiff(diff: typeof DiffSchema.Type): ProviderDiffSlice {
  const chunks: string[] = [];
  const omittedFileStats: NonNullable<ProviderDiffSlice["omittedFileStats"]>[number][] = [];
  for (const file of diff.items) {
    const oldPath = file.oldPath ?? file.path;
    const a = quotePath(`a/${oldPath}`);
    const b = quotePath(`b/${file.path}`);
    const lines = [`diff --git ${a} ${b}`];
    if (file.status === "added")
      lines.push(`new file mode ${file.isSubmodule ? "160000" : "100644"}`);
    if (file.status === "deleted")
      lines.push(`deleted file mode ${file.isSubmodule ? "160000" : "100644"}`);
    if (file.status === "renamed" || file.status === "copied") {
      const action = file.status === "renamed" ? "rename" : "copy";
      lines.push(`${action} from ${quotePath(oldPath)}`, `${action} to ${quotePath(file.path)}`);
    }
    if (file.binary) {
      lines.push(
        `Binary files ${file.status === "added" ? "/dev/null" : a} and ${file.status === "deleted" ? "/dev/null" : b} differ`,
      );
    } else if (file.tooLarge || file.hunksOmitted) {
      omittedFileStats.push({
        path: file.path,
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      });
    } else if (file.isSubmodule) {
      lines.push(
        `--- ${file.status === "added" ? "/dev/null" : a}`,
        `+++ ${file.status === "deleted" ? "/dev/null" : b}`,
      );
      const hasOld = file.status !== "added" && file.oldOid !== undefined;
      const hasNew = file.status !== "deleted" && file.newOid !== undefined;
      lines.push(`@@ -${hasOld ? "1" : "0,0"} +${hasNew ? "1" : "0,0"} @@`);
      if (hasOld) lines.push(`-Subproject commit ${file.oldOid}`);
      if (hasNew) lines.push(`+Subproject commit ${file.newOid}`);
    } else {
      if (file.hunks.length > 0)
        lines.push(
          `--- ${file.status === "added" ? "/dev/null" : a}`,
          `+++ ${file.status === "deleted" ? "/dev/null" : b}`,
        );
      for (const hunk of file.hunks) {
        lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
        for (const line of hunk.lines) {
          if (["=", ">", "<"].includes(line.origin)) lines.push("\\ No newline at end of file");
          else lines.push(`${line.origin}${line.content.replace(/\n$/u, "")}`);
        }
      }
    }
    chunks.push(lines.join("\n"));
  }
  return {
    patch: chunks.length === 0 ? "" : `${chunks.join("\n")}\n`,
    truncated: diff.truncated || omittedFileStats.length > 0,
    nextCursor: null,
    ...(omittedFileStats.length === 0 ? {} : { omittedFileStats }),
  };
}
