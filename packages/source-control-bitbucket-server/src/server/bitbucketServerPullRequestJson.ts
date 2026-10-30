import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestReviewCommentDraft,
  PullRequestReviewerCandidate,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestComment,
  PullRequestCommit,
  PullRequestMergeability,
  PullRequestReviewThread,
  PullRequestState,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { dedupeChecks } from "@t3tools/source-control-core/server/pullRequestChecks";

/**
 * Data Center's enums are decoded as plain strings and normalized here, in the same tolerant
 * style as the other hosts' decoders: a new state or build status must not fail a whole payload.
 */
const RawUserSchema = Schema.Struct({
  /** The account's username, which is also what `role.1`/`username.1` listing filters take. */
  name: Schema.optional(Schema.NullOr(Schema.String)),
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  emailAddress: Schema.optional(Schema.NullOr(Schema.String)),
  /** How the host spells the account in a URL path, which is not the name once it holds a slash. */
  slug: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawParticipantSchema = Schema.Struct({
  user: Schema.optional(Schema.NullOr(RawUserSchema)),
  role: Schema.optional(Schema.NullOr(Schema.String)),
  approved: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawRefSchema = Schema.Struct({
  displayId: TrimmedNonEmptyString,
  latestCommit: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        slug: TrimmedNonEmptyString,
        project: Schema.Struct({ key: TrimmedNonEmptyString }),
      }),
    ),
  ),
});

const RawPullRequestSchema = Schema.Struct({
  id: Schema.Int,
  version: Schema.Int,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.Boolean),
  createdDate: Schema.Number,
  updatedDate: Schema.Number,
  closedDate: Schema.optional(Schema.NullOr(Schema.Number)),
  author: Schema.optional(Schema.NullOr(RawParticipantSchema)),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(RawParticipantSchema))),
  fromRef: RawRefSchema,
  toRef: RawRefSchema,
  links: Schema.Struct({
    self: Schema.NonEmptyArray(Schema.Struct({ href: TrimmedNonEmptyString })),
  }),
});

/** One page of any Data Center collection: an offset cursor rather than a next URL. */
const RawPageSchema = Schema.Struct({
  values: Schema.Array(Schema.Unknown),
  isLastPage: Schema.optional(Schema.Boolean),
  nextPageStart: Schema.optional(Schema.NullOr(Schema.Int)),
});

const RawAnchorSchema = Schema.Struct({
  path: Schema.optional(Schema.NullOr(Schema.String)),
  /** The path before a rename, which is the one a comment on the removed side belongs to. */
  srcPath: Schema.optional(Schema.NullOr(Schema.String)),
  line: Schema.optional(Schema.NullOr(Schema.Int)),
  /** ADDED, REMOVED or CONTEXT: which kind of diff line the comment sits on. */
  lineType: Schema.optional(Schema.NullOr(Schema.String)),
  /** FROM or TO: which side of the diff the line number counts in. */
  fileType: Schema.optional(Schema.NullOr(Schema.String)),
  /** The line is no longer in the diff, after a rescope. */
  orphaned: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

interface RawComment {
  readonly id: number;
  readonly version?: number | null | undefined;
  readonly text?: string | null | undefined;
  readonly author?: typeof RawUserSchema.Type | null | undefined;
  readonly createdDate: number;
  /** OPEN or RESOLVED, which a task and a thread both use. */
  readonly state?: string | null | undefined;
  readonly threadResolved?: boolean | null | undefined;
  readonly anchor?: typeof RawAnchorSchema.Type | null | undefined;
  /** Replies, nested under the remark they answer, to any depth. */
  readonly comments?: ReadonlyArray<RawComment> | null | undefined;
}

const RawCommentSchema = Schema.Struct({
  id: Schema.Int,
  version: Schema.optional(Schema.NullOr(Schema.Int)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
  createdDate: Schema.Number,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  threadResolved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  anchor: Schema.optional(Schema.NullOr(RawAnchorSchema)),
  comments: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.suspend((): Schema.Codec<RawComment> => RawCommentSchema))),
  ),
});

/**
 * One row of the activities feed. Only a root comment arrives as `COMMENTED`/`ADDED` — its
 * replies travel nested inside it rather than as rows of their own — and a verdict is a row
 * with no comment at all.
 */
const RawActivitySchema = Schema.Struct({
  id: Schema.Int,
  createdDate: Schema.Number,
  user: Schema.optional(Schema.NullOr(RawUserSchema)),
  action: Schema.optional(Schema.NullOr(Schema.String)),
  commentAction: Schema.optional(Schema.NullOr(Schema.String)),
  comment: Schema.optional(Schema.NullOr(RawCommentSchema)),
});

const RawCommitSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  message: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
  authorTimestamp: Schema.optional(Schema.NullOr(Schema.Number)),
  committerTimestamp: Schema.optional(Schema.NullOr(Schema.Number)),
  parents: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ id: Schema.optional(Schema.NullOr(Schema.String)) })),
    ),
  ),
});

const RawBuildStatusSchema = Schema.Struct({
  key: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  dateAdded: Schema.optional(Schema.NullOr(Schema.Number)),
});

/** `/pull-requests/{id}/merge`: whether the host would merge this now, and what stands in the way. */
const RawMergeCheckSchema = Schema.Struct({
  canMerge: Schema.optional(Schema.Boolean),
  conflicted: Schema.optional(Schema.Boolean),
  vetoes: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({ summaryMessage: Schema.optional(Schema.NullOr(Schema.String)) }),
      ),
    ),
  ),
});

/** `/repos?permission=…` rows, each naming the repository it grants that permission on. */
const RawRepositorySchema = Schema.Struct({
  slug: TrimmedNonEmptyString,
  project: Schema.Struct({ key: TrimmedNonEmptyString }),
});

const RawCommitDetailSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  parents: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ id: Schema.optional(Schema.NullOr(Schema.String)) })),
    ),
  ),
});

export interface BitbucketServerPullRequest {
  readonly number: number;
  /** Optimistic-concurrency token every write sends back. */
  readonly version: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly headCommit: string | null;
  readonly headRepositoryNameWithOwner: string | null;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly body: string;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly reviewRequestLogins: ReadonlyArray<string>;
}

export interface BitbucketServerPage<A> {
  readonly items: ReadonlyArray<A>;
  /** The offset of the next page, or null on the last one. */
  readonly nextPageStart: number | null;
  /** Rows on the page before any were skipped, which an offset cursor has to count. */
  readonly rawCount: number;
}

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/** Data Center stamps every instant as epoch milliseconds. */
function toIso(millis: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(millis));
}

function toActor(raw: typeof RawUserSchema.Type | null | undefined): PullRequestActor | null {
  const login = trimmed(raw?.name) ?? trimmed(raw?.emailAddress);
  return login === null ? null : { login, name: trimmed(raw?.displayName), avatarUrl: null };
}

function toState(state: string | null | undefined): PullRequestState {
  switch (state?.trim().toUpperCase()) {
    case "MERGED":
      return "merged";
    case "DECLINED":
      return "closed";
    default:
      return "open";
  }
}

function toPullRequest(raw: typeof RawPullRequestSchema.Type): BitbucketServerPullRequest {
  const reviewers = (raw.reviewers ?? []).flatMap((reviewer) => {
    const actor = toActor(reviewer.user);
    return actor === null ? [] : [actor];
  });
  const headRepository = raw.fromRef.repository;
  return {
    number: raw.id,
    version: raw.version,
    title: raw.title,
    url: raw.links.self[0].href,
    author: toActor(raw.author?.user),
    headBranch: raw.fromRef.displayId,
    headCommit: trimmed(raw.fromRef.latestCommit),
    headRepositoryNameWithOwner: headRepository
      ? `${headRepository.project.key}/${headRepository.slug}`
      : null,
    baseBranch: raw.toRef.displayId,
    state: toState(raw.state),
    isDraft: raw.draft === true,
    createdAt: toIso(raw.createdDate),
    updatedAt: toIso(raw.updatedDate),
    closedAt:
      raw.closedDate === null || raw.closedDate === undefined ? null : toIso(raw.closedDate),
    body: raw.description ?? "",
    reviewers,
    reviewRequestLogins: reviewers.map((reviewer) => reviewer.login),
  };
}

const decodePage = decodeJsonResult(RawPageSchema);
const decodePullRequest = decodeJsonResult(RawPullRequestSchema);
const decodePullRequestEntry = Schema.decodeUnknownExit(RawPullRequestSchema);
const decodeActivityEntry = Schema.decodeUnknownExit(RawActivitySchema);
const decodeCommitEntry = Schema.decodeUnknownExit(RawCommitSchema);
const decodeBuildStatusEntry = Schema.decodeUnknownExit(RawBuildStatusSchema);
const decodeRepositoryEntry = Schema.decodeUnknownExit(RawRepositorySchema);
const decodeUserEntry = Schema.decodeUnknownExit(RawUserSchema);
const decodeParticipantEntry = Schema.decodeUnknownExit(RawParticipantSchema);
const decodeUser = decodeJsonResult(RawUserSchema);
const decodeComment = decodeJsonResult(RawCommentSchema);
const decodeMergeCheck = decodeJsonResult(RawMergeCheckSchema);
const decodeCommitDetail = decodeJsonResult(RawCommitDetailSchema);

/** Walks one page, skipping rows that do not decode, as the other hosts' decoders do. */
function decodeItems<Raw, A>(
  raw: string,
  decodeEntry: (entry: unknown) => Exit.Exit<Raw, Schema.SchemaError>,
  convert: (entry: Raw) => A | null,
): Result.Result<BitbucketServerPage<A>, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const items: A[] = [];
  for (const entry of decoded.success.values) {
    const item = decodeEntry(entry);
    if (Exit.isFailure(item)) continue;
    const converted = convert(item.value);
    if (converted !== null) items.push(converted);
  }
  const next = decoded.success.nextPageStart;
  return Result.succeed({
    items,
    nextPageStart:
      decoded.success.isLastPage === true || next === null || next === undefined ? null : next,
    rawCount: decoded.success.values.length,
  });
}

export function decodePullRequestPageJson(
  raw: string,
): Result.Result<BitbucketServerPage<BitbucketServerPullRequest>, DecodeFailure> {
  return decodeItems(raw, decodePullRequestEntry, toPullRequest);
}

export function decodePullRequestJson(
  raw: string,
): Result.Result<BitbucketServerPullRequest, DecodeFailure> {
  const decoded = decodePullRequest(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toPullRequest(decoded.success))
    : Result.fail(decoded.failure);
}

/**
 * Whether `/repos?permission=REPO_WRITE&name=…` named this repository. The name filter is a
 * substring match across every project, so the row has to be checked against both halves of
 * the locator rather than trusted for being on the page.
 */
export function decodeRepositoryPermissionJson(
  raw: string,
  repository: { readonly projectKey: string; readonly repoSlug: string },
): Result.Result<
  { readonly granted: boolean; readonly nextPageStart: number | null },
  DecodeFailure
> {
  const decoded = decodeItems(raw, decodeRepositoryEntry, (entry) => entry);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const granted = decoded.success.items.some(
    (entry) =>
      entry.project.key.toLowerCase() === repository.projectKey.toLowerCase() &&
      entry.slug.toLowerCase() === repository.repoSlug.toLowerCase(),
  );
  return Result.succeed({ granted, nextPageStart: decoded.success.nextPageStart });
}

/**
 * A conflict is the one veto the page has a word for. Anything else the host would refuse the
 * merge over — approvals, builds, tasks — leaves the branch itself mergeable, and is reported by
 * the host's own refusal when the merge is asked for.
 */
export function decodeMergeCheckJson(
  raw: string,
): Result.Result<PullRequestMergeability, DecodeFailure> {
  const decoded = decodeMergeCheck(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  if (decoded.success.conflicted === true) return Result.succeed("conflicting");
  return Result.succeed(decoded.success.canMerge === undefined ? "unknown" : "mergeable");
}

/** The commit's first parent, which is the old side of its own diff. Null on a root commit. */
export function decodeCommitParentJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeCommitDetail(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.parents?.[0]?.id))
    : Result.fail(decoded.failure);
}

/** A commit resource's own sha, which is what `/merge-base` answers with. */
export function decodeCommitIdJson(raw: string): Result.Result<string, DecodeFailure> {
  const decoded = decodeCommitDetail(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success.id)
    : Result.fail(decoded.failure);
}

export interface BitbucketServerActivity {
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
}

function toReviewState(action: string | null | undefined): string | null {
  switch (action?.trim().toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "REVIEWED":
      return "changes_requested";
    case "UNAPPROVED":
      return "dismissed";
    default:
      return null;
  }
}

/** A root and every reply under it, however deep, oldest first. */
function flattenComment(comment: RawComment): ReadonlyArray<RawComment> {
  return [comment, ...(comment.comments ?? []).flatMap(flattenComment)].toSorted(
    (left, right) => left.createdDate - right.createdDate,
  );
}

function commentUrl(pullRequestUrl: string, id: number): string {
  return `${pullRequestUrl}/overview?commentId=${id}`;
}

/**
 * The conversation out of the activities feed. A root comment opens a thread when it is anchored
 * to a line; its replies belong to the same thread whatever they say. A task is a comment with a
 * severity, and reads as an ordinary one here. A verdict — approve, needs work, approval
 * withdrawn — is an activity of its own with nothing said, and reads as a review.
 */
export function decodeActivitiesJson(
  raw: string,
  pullRequestUrl: string,
): Result.Result<BitbucketServerPage<BitbucketServerActivity>, DecodeFailure> {
  return decodeItems(raw, decodeActivityEntry, (activity): BitbucketServerActivity | null => {
    const reviewState = toReviewState(activity.action);
    if (reviewState !== null) {
      const author = toActor(activity.user);
      if (author === null) return null;
      return {
        comments: [
          {
            id: `activity:${activity.id}`,
            kind: "review",
            author,
            body: "",
            createdAt: toIso(activity.createdDate),
            url: null,
            path: null,
            reviewState,
          },
        ],
        threads: [],
      };
    }
    if (
      activity.action?.toUpperCase() !== "COMMENTED" ||
      activity.commentAction?.toUpperCase() !== "ADDED" ||
      activity.comment === null ||
      activity.comment === undefined
    ) {
      return null;
    }
    const root = activity.comment;
    const anchor = root.anchor;
    // `TO` counts lines in the file as it is now, `FROM` as it was. An anchor that names no
    // side sits on the removed side only when it is on a removed line.
    const fileType = anchor?.fileType?.trim().toUpperCase();
    const side =
      fileType === "FROM" || (fileType !== "TO" && anchor?.lineType?.toUpperCase() === "REMOVED")
        ? "left"
        : "right";
    const path = (side === "left" ? trimmed(anchor?.srcPath) : null) ?? trimmed(anchor?.path);
    const entries = flattenComment(root);
    const comments = entries.map((comment): PullRequestComment => ({
      id: String(comment.id),
      kind: path === null ? "issue-comment" : "review-comment",
      author: toActor(comment.author),
      body: comment.text ?? "",
      createdAt: toIso(comment.createdDate),
      url: commentUrl(pullRequestUrl, comment.id),
      path,
      reviewState: null,
    }));
    if (path === null) return { comments, threads: [] };
    const line = anchor?.line;
    return {
      comments,
      threads: [
        {
          id: String(root.id),
          path,
          line: typeof line === "number" && line > 0 ? line : null,
          side,
          isResolved: root.threadResolved === true || root.state?.toUpperCase() === "RESOLVED",
          isOutdated: anchor?.orphaned === true,
          comments: entries.map((comment): PullRequestThreadComment => ({
            id: String(comment.id),
            author: toActor(comment.author),
            body: comment.text ?? "",
            createdAt: toIso(comment.createdDate),
            url: commentUrl(pullRequestUrl, comment.id),
          })),
        },
      ],
    };
  });
}

export function decodeCommitsJson(
  raw: string,
): Result.Result<BitbucketServerPage<PullRequestCommit>, DecodeFailure> {
  return decodeItems(raw, decodeCommitEntry, (commit): PullRequestCommit | null => {
    const committedAt = commit.committerTimestamp ?? commit.authorTimestamp;
    if (committedAt === null || committedAt === undefined) return null;
    const author = toActor(commit.author);
    return {
      oid: commit.id,
      messageHeadline: (commit.message ?? "").split("\n")[0] ?? "",
      committedDate: toIso(committedAt),
      authors: author === null ? [] : [author],
    };
  });
}

function toBuildStatus(value: string | null | undefined): PullRequestCheckStatus {
  switch (value?.trim().toUpperCase()) {
    case "SUCCESSFUL":
      return "success";
    case "FAILED":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "INPROGRESS":
      return "pending";
    default:
      return "neutral";
  }
}

/**
 * Build statuses on one commit. A key is reused when a build is run again, so the newest run
 * under each key is the one kept, as the shared de-duplication does for every host.
 */
export function decodeBuildStatusesJson(
  raw: string,
): Result.Result<BitbucketServerPage<PullRequestCheck>, DecodeFailure> {
  const decoded = decodeItems(raw, decodeBuildStatusEntry, (status) => {
    const name = trimmed(status.name) ?? trimmed(status.key);
    if (name === null) return null;
    return {
      check: {
        name,
        status: toBuildStatus(status.state),
        description: trimmed(status.description),
        url: trimmed(status.url),
      },
      workflowName: trimmed(status.key),
      at:
        status.dateAdded === null || status.dateAdded === undefined
          ? null
          : toIso(status.dateAdded),
    };
  });
  return Result.map(decoded, (page) => ({ ...page, items: dedupeChecks(page.items) }));
}

/**
 * Data Center writes its own `src://` and `dst://` prefixes where git writes `a/` and `b/`. The
 * diff viewer reads the git spelling, so the headers are rewritten to it before the patch leaves
 * the server; hunk lines are left alone.
 */
export function normalizeUnifiedDiff(patch: string): string {
  let inHunk = false;
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        inHunk = false;
        return line.replaceAll(" src://", " a/").replaceAll(" dst://", " b/");
      }
      if (line.startsWith("@@ ")) inHunk = true;
      if (inHunk) return line;
      if (line.startsWith("--- src://")) return `--- a/${line.slice("--- src://".length)}`;
      if (line.startsWith("+++ dst://")) return `+++ b/${line.slice("+++ dst://".length)}`;
      if (line.startsWith("rename from src://")) {
        return `rename from ${line.slice("rename from src://".length)}`;
      }
      if (line.startsWith("rename to dst://"))
        return `rename to ${line.slice("rename to dst://".length)}`;
      return line;
    })
    .join("\n");
}

/**
 * One page of `/pull-requests/{id}/changes`: only how many files it names matters here, since
 * the host states no line counts anywhere.
 */
export function decodeChangesPageJson(
  raw: string,
): Result.Result<{ readonly count: number; readonly nextPageStart: number | null }, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const next = decoded.success.nextPageStart;
  return Result.succeed({
    count: decoded.success.values.length,
    nextPageStart:
      decoded.success.isLastPage === true || next === null || next === undefined ? null : next,
  });
}

/**
 * One page of `/users?permission.1=REPO_READ&…`: everyone who may be asked to review. The
 * account name is both the handle shown and what the reviewer list is written with.
 */
export function decodeUsersPageJson(
  raw: string,
): Result.Result<
  BitbucketServerPage<Omit<PullRequestReviewerCandidate, "isRequested">>,
  DecodeFailure
> {
  return decodeItems(raw, decodeUserEntry, (user) => {
    const name = trimmed(user.name);
    return name === null
      ? null
      : { id: name, kind: "user", login: name, name: trimmed(user.displayName), avatarUrl: null };
  });
}

/** `/users/{slug}`: the slug the host addresses this account by in a path. */
export function decodeUserSlugJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeUser(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.slug))
    : Result.fail(decoded.failure);
}

/** One page of a pull request's participants, reduced to the slug of the named account. */
export function decodeParticipantSlugJson(
  raw: string,
  name: string,
): Result.Result<
  { readonly slug: string | null; readonly nextPageStart: number | null },
  DecodeFailure
> {
  const decoded = decodeItems(raw, decodeParticipantEntry, (participant) =>
    trimmed(participant.user?.name) === name ? trimmed(participant.user?.slug) : null,
  );
  return Result.map(decoded, (page) => ({
    slug: page.items[0] ?? null,
    nextPageStart: page.nextPageStart,
  }));
}

/** A comment resource's own version, which a rewrite of it has to send back. */
export function decodeCommentVersionJson(raw: string): Result.Result<number, DecodeFailure> {
  const decoded = decodeComment(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success.version ?? 0)
    : Result.fail(decoded.failure);
}

/**
 * Where a draft remark sits, in the host's words: the line number counted on the side it was
 * written against, which kind of diff line that is, and the file's names either side of a rename.
 */
export function bitbucketServerCommentAnchor(comment: PullRequestReviewCommentDraft): {
  readonly line: number;
  readonly lineType: "ADDED" | "REMOVED" | "CONTEXT";
  readonly fileType: "FROM" | "TO";
  readonly path: string;
  readonly srcPath?: string;
  readonly diffType: "EFFECTIVE";
} {
  const position = comment.position;
  const at =
    position.kind === "added"
      ? { line: position.newLine, lineType: "ADDED" as const, fileType: "TO" as const }
      : position.kind === "deleted"
        ? { line: position.oldLine, lineType: "REMOVED" as const, fileType: "FROM" as const }
        : position.side === "left"
          ? { line: position.oldLine, lineType: "CONTEXT" as const, fileType: "FROM" as const }
          : { line: position.newLine, lineType: "CONTEXT" as const, fileType: "TO" as const };
  return {
    ...at,
    path: comment.path,
    ...(comment.oldPath === undefined ? {} : { srcPath: comment.oldPath }),
    diffType: "EFFECTIVE",
  };
}
