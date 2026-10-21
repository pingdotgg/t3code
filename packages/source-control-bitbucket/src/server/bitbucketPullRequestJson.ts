import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestComment,
  PullRequestCommit,
  PullRequestMergeability,
  PullRequestReviewThread,
  PullRequestReviewerCandidate,
  PullRequestState,
} from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import { dedupeChecks } from "@t3tools/source-control-core/server/pullRequestChecks";

/** Unknown enum values must not fail the whole payload. */
const RawUserSchema = Schema.Struct({
  /** Reviewer writes require UUIDs, not displayed handles. */
  uuid: Schema.optional(Schema.NullOr(Schema.String)),
  /** App accounts omit this; use `display_name`. */
  nickname: Schema.optional(Schema.NullOr(Schema.String)),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  links: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        avatar: Schema.optional(
          Schema.NullOr(Schema.Struct({ href: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
});

const RawBranchSchema = Schema.Struct({
  branch: Schema.Struct({ name: TrimmedNonEmptyString }),
  commit: Schema.optional(
    Schema.NullOr(Schema.Struct({ hash: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  repository: Schema.optional(Schema.NullOr(Schema.Struct({ full_name: TrimmedNonEmptyString }))),
});

const RawLinkSchema = Schema.Struct({ href: Schema.optional(Schema.String) });

const RawPullRequestSchema = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.Boolean),
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
  source: RawBranchSchema,
  destination: RawBranchSchema,
  created_on: Schema.String,
  updated_on: Schema.String,
  /** Only sent when asked for with `fields=+closed_on`; null while the request is open. */
  closed_on: Schema.optional(Schema.NullOr(Schema.String)),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(RawUserSchema))),
  participants: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          user: Schema.optional(Schema.NullOr(RawUserSchema)),
          role: Schema.optional(Schema.NullOr(Schema.String)),
          approved: Schema.optional(Schema.Boolean),
          state: Schema.optional(Schema.NullOr(Schema.String)),
          participated_on: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
  links: Schema.Struct({ html: Schema.Struct({ href: TrimmedNonEmptyString }) }),
});

const RawPageSchema = Schema.Struct({
  values: Schema.Array(Schema.Unknown),
  size: Schema.optional(Schema.NullOr(Schema.Int)),
  next: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawCommentSchema = Schema.Struct({
  id: Schema.Int,
  content: Schema.optional(Schema.NullOr(Schema.Struct({ raw: Schema.optional(Schema.String) }))),
  user: Schema.optional(Schema.NullOr(RawUserSchema)),
  created_on: Schema.String,
  deleted: Schema.optional(Schema.Boolean),
  pending: Schema.optional(Schema.Boolean),
  parent: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.Int }))),
  inline: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        path: Schema.optional(Schema.NullOr(Schema.String)),
        from: Schema.optional(Schema.NullOr(Schema.Int)),
        to: Schema.optional(Schema.NullOr(Schema.Int)),
        outdated: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
  resolution: Schema.optional(Schema.NullOr(Schema.Unknown)),
  links: Schema.optional(
    Schema.NullOr(Schema.Struct({ html: Schema.optional(Schema.NullOr(RawLinkSchema)) })),
  ),
});

const RawCommitSchema = Schema.Struct({
  hash: TrimmedNonEmptyString,
  message: Schema.optional(Schema.NullOr(Schema.String)),
  date: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        raw: Schema.optional(Schema.NullOr(Schema.String)),
        user: Schema.optional(Schema.NullOr(RawUserSchema)),
      }),
    ),
  ),
});

const RawStatusSchema = Schema.Struct({
  key: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawDiffstatSchema = Schema.Struct({
  lines_added: Schema.optional(Schema.NullOr(Schema.Int)),
  lines_removed: Schema.optional(Schema.NullOr(Schema.Int)),
});

const RawMemberSchema = Schema.Struct({
  user: Schema.optional(Schema.NullOr(RawUserSchema)),
});

const RawViewerSchema = Schema.Struct({
  nickname: Schema.optional(Schema.NullOr(Schema.String)),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawRepositoryPermissionsSchema = Schema.Struct({
  values: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ permission: Schema.optional(Schema.NullOr(Schema.String)) })),
    ),
  ),
});

export interface BitbucketPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly headSha: string | null;
  readonly headRepositoryNameWithOwner: string | null;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  /** Listings omit conflict state; detail reads use the conflicts endpoint. */
  readonly mergeability: PullRequestMergeability;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Merge/decline time; later comments move `updatedAt`. */
  readonly closedAt: string | null;
  readonly body: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly reviewerIds: ReadonlyArray<string>;
  readonly reviews: ReadonlyArray<PullRequestComment>;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/** Normalize Bitbucket's microsecond `+00:00` timestamps to `Z` for cross-host string sorting. */
function toIsoUtc(value: string): string {
  return Option.match(DateTime.make(value), {
    onNone: () => value,
    onSome: DateTime.formatIso,
  });
}

function toActor(raw: Schema.Schema.Type<typeof RawUserSchema> | null | undefined) {
  const login = trimmed(raw?.nickname) ?? trimmed(raw?.display_name);
  return login === null
    ? null
    : {
        login,
        name: trimmed(raw?.display_name),
        avatarUrl: trimmed(raw?.links?.avatar?.href),
      };
}

function toState(raw: Schema.Schema.Type<typeof RawPullRequestSchema>): PullRequestState {
  switch (raw.state?.trim().toUpperCase()) {
    case "MERGED":
      return "merged";
    case "DECLINED":
    case "SUPERSEDED":
      return "closed";
    default:
      return "open";
  }
}

function toBuildStatus(value: string | null | undefined): PullRequestCheckStatus {
  switch (value?.trim().toUpperCase()) {
    case "SUCCESSFUL":
      return "success";
    case "FAILED":
      return "failure";
    case "STOPPED":
      return "cancelled";
    case "INPROGRESS":
      return "pending";
    default:
      return "neutral";
  }
}

function toReviews(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): ReadonlyArray<PullRequestComment> {
  return (raw.participants ?? []).flatMap((participant): ReadonlyArray<PullRequestComment> => {
    const author = toActor(participant.user);
    const votedAt = trimmed(participant.participated_on);
    const reviewState =
      trimmed(participant.state) ?? (participant.approved === true ? "approved" : null);
    if (author === null || votedAt === null || reviewState === null) return [];
    return [
      {
        id: `${raw.id}:${author.login}`,
        kind: "review",
        author,
        body: "",
        createdAt: toIsoUtc(votedAt),
        url: null,
        path: null,
        reviewState,
      },
    ];
  });
}

function toPullRequest(raw: Schema.Schema.Type<typeof RawPullRequestSchema>): BitbucketPullRequest {
  const reviewers = (raw.reviewers ?? []).flatMap((reviewer) => {
    const actor = toActor(reviewer);
    return actor === null ? [] : [actor];
  });
  return {
    number: raw.id,
    title: raw.title,
    url: raw.links.html.href,
    author: toActor(raw.author),
    headBranch: raw.source.branch.name,
    headSha: trimmed(raw.source.commit?.hash),
    headRepositoryNameWithOwner: raw.source.repository?.full_name ?? null,
    baseBranch: raw.destination.branch.name,
    state: toState(raw),
    isDraft: raw.draft ?? false,
    mergeability: "unknown",
    createdAt: toIsoUtc(raw.created_on),
    updatedAt: toIsoUtc(raw.updated_on),
    closedAt: raw.closed_on == null ? null : toIsoUtc(raw.closed_on),
    body: raw.description ?? "",
    reviewRequestLogins: reviewers.map((reviewer) => reviewer.login),
    reviewers,
    reviewerIds: (raw.reviewers ?? []).flatMap((reviewer) => trimmed(reviewer.uuid) ?? []),
    reviews: toReviews(raw),
  };
}

const decodePage = decodeJsonResult(RawPageSchema);
const decodePullRequestEntry = Schema.decodeUnknownExit(RawPullRequestSchema);
const decodePullRequest = decodeJsonResult(RawPullRequestSchema);
const decodeCommentEntry = Schema.decodeUnknownExit(RawCommentSchema);
const decodeCommitEntry = Schema.decodeUnknownExit(RawCommitSchema);
const decodeStatusEntry = Schema.decodeUnknownExit(RawStatusSchema);
const decodeDiffstatEntry = Schema.decodeUnknownExit(RawDiffstatSchema);
const decodeMemberEntry = Schema.decodeUnknownExit(RawMemberSchema);
const decodeViewer = decodeJsonResult(RawViewerSchema);
const decodeConflicts = decodeJsonResult(RawPageSchema);
const decodeRepositoryPermissions = decodeJsonResult(RawRepositoryPermissionsSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface BitbucketPage<A> {
  readonly items: ReadonlyArray<A>;
  readonly next: string | null;
}

export function decodePullRequestPageJson(
  raw: string,
): Result.Result<BitbucketPage<BitbucketPullRequest>, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: BitbucketPullRequest[] = [];
  for (const entry of decoded.success.values) {
    const item = decodePullRequestEntry(entry);
    if (Exit.isSuccess(item)) {
      items.push(toPullRequest(item.value));
    }
  }
  return Result.succeed({ items, next: trimmed(decoded.success.next) });
}

export function decodePullRequestJson(
  raw: string,
): Result.Result<BitbucketPullRequest, DecodeFailure> {
  const decoded = decodePullRequest(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toPullRequest(decoded.success))
    : Result.fail(decoded.failure);
}

export function decodeViewerJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeViewer(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.nickname) ?? trimmed(decoded.success.display_name))
    : Result.fail(decoded.failure);
}

export function decodeRepositoryPermissionJson(raw: string): Result.Result<boolean, DecodeFailure> {
  const decoded = decodeRepositoryPermissions(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const permission = trimmed(decoded.success.values?.[0]?.permission)?.toLowerCase() ?? null;
  return Result.succeed(permission === null || permission === "admin" || permission === "write");
}

/** Repository membership requires admin access; reviews can target any workspace member. */
export function decodeWorkspaceMembersJson(
  raw: string,
): Result.Result<BitbucketPage<PullRequestReviewerCandidate>, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: PullRequestReviewerCandidate[] = [];
  for (const entry of decoded.success.values) {
    const member = decodeMemberEntry(entry);
    if (Exit.isFailure(member)) continue;
    const uuid = trimmed(member.value.user?.uuid);
    const actor = toActor(member.value.user);
    if (uuid === null || actor === null) continue;
    items.push({ ...actor, id: uuid, kind: "user", isRequested: false });
  }
  return Result.succeed({ items, next: trimmed(decoded.success.next) });
}

export type BitbucketRawComment = Schema.Schema.Type<typeof RawCommentSchema>;

export interface BitbucketComments {
  readonly comments: ReadonlyArray<PullRequestComment>;
  /** Raw entries for thread assembly across page boundaries. */
  readonly entries: ReadonlyArray<BitbucketRawComment>;
  readonly next: string | null;
}

export function buildReviewThreads(
  comments: ReadonlyArray<BitbucketRawComment>,
): ReadonlyArray<PullRequestReviewThread> {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootOf = (comment: Schema.Schema.Type<typeof RawCommentSchema>) => {
    let current = comment;
    for (let step = 0; step < byId.size; step += 1) {
      const parent = current.parent === null ? undefined : byId.get(current.parent?.id ?? -1);
      if (parent === undefined) return current;
      current = parent;
    }
    return current;
  };

  const threads = new Map<number, PullRequestReviewThread>();
  const replies = new Map<number, Array<Schema.Schema.Type<typeof RawCommentSchema>>>();
  for (const comment of comments) {
    const root = rootOf(comment);
    const inline = root.inline;
    const path = trimmed(inline?.path);
    if (path === null) continue;
    if (root.id === comment.id) {
      const side = inline?.to === null || inline?.to === undefined ? "left" : "right";
      const line = side === "left" ? inline?.from : inline?.to;
      threads.set(root.id, {
        id: String(root.id),
        path,
        line: typeof line === "number" && line > 0 ? line : null,
        side,
        isResolved: root.resolution !== null && root.resolution !== undefined,
        isOutdated: inline?.outdated === true,
        comments: [],
      });
    }
    const bucket = replies.get(root.id);
    if (bucket === undefined) replies.set(root.id, [comment]);
    else bucket.push(comment);
  }

  return [...threads.values()].flatMap((thread) => {
    const entries = (replies.get(Number(thread.id)) ?? [])
      .toSorted((left, right) => left.created_on.localeCompare(right.created_on))
      .map((comment) => ({
        id: String(comment.id),
        author: toActor(comment.user),
        body: comment.content?.raw ?? "",
        createdAt: toIsoUtc(comment.created_on),
        url: trimmed(comment.links?.html?.href),
      }));
    return entries.length === 0 ? [] : [{ ...thread, comments: entries }];
  });
}

export function decodeCommentsJson(raw: string): Result.Result<BitbucketComments, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const comments: PullRequestComment[] = [];
  const kept: Array<BitbucketRawComment> = [];
  for (const entry of decoded.success.values) {
    const decodedComment = decodeCommentEntry(entry);
    if (Exit.isFailure(decodedComment)) continue;
    const comment = decodedComment.value;
    if (comment.deleted === true || comment.pending === true) continue;
    const body = comment.content?.raw ?? "";
    if (body.trim().length === 0) continue;
    kept.push(comment);
    const path = trimmed(comment.inline?.path);
    comments.push({
      id: String(comment.id),
      kind: path === null ? "issue-comment" : "review-comment",
      author: toActor(comment.user),
      body,
      createdAt: toIsoUtc(comment.created_on),
      url: trimmed(comment.links?.html?.href),
      path,
      reviewState: null,
    });
  }
  return Result.succeed({ comments, entries: kept, next: trimmed(decoded.success.next) });
}

export function decodeCommitsJson(
  raw: string,
): Result.Result<BitbucketPage<PullRequestCommit>, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const commits: PullRequestCommit[] = [];
  for (const entry of decoded.success.values) {
    const decodedCommit = decodeCommitEntry(entry);
    if (Exit.isFailure(decodedCommit)) continue;
    const commit = decodedCommit.value;
    const committedDate = trimmed(commit.date);
    if (committedDate === null) continue;
    const linkedAuthor = toActor(commit.author?.user);
    const rawAuthor = trimmed(commit.author?.raw);
    commits.push({
      oid: commit.hash,
      messageHeadline: (commit.message ?? "").split("\n")[0] ?? "",
      committedDate: toIsoUtc(committedDate),
      authors:
        linkedAuthor !== null
          ? [linkedAuthor]
          : rawAuthor === null
            ? []
            : [{ login: rawAuthor, name: rawAuthor, avatarUrl: null }],
    });
  }
  // Bitbucket lists a pull request's commits newest first; the timeline reads oldest first.
  return Result.succeed({ items: commits.toReversed(), next: trimmed(decoded.success.next) });
}

export function decodeStatusesJson(
  raw: string,
): Result.Result<BitbucketPage<PullRequestCheck>, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const checks: Array<{
    readonly check: PullRequestCheck;
    readonly workflowName: string | null;
    readonly at: string | null;
  }> = [];
  for (const entry of decoded.success.values) {
    const decodedStatus = decodeStatusEntry(entry);
    if (Exit.isFailure(decodedStatus)) continue;
    const status = decodedStatus.value;
    const name = trimmed(status.name) ?? trimmed(status.key);
    if (name === null) continue;
    // Reruns reuse keys; later entries win. Keys distinguish same-named pipelines.
    checks.push({
      check: {
        name,
        status: toBuildStatus(status.state),
        description: trimmed(status.description),
        url: trimmed(status.url),
      },
      workflowName: trimmed(status.key),
      at: null,
    });
  }
  return Result.succeed({ items: dedupeChecks(checks), next: trimmed(decoded.success.next) });
}

export interface BitbucketDiffStat {
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

export interface BitbucketDiffStatPage extends BitbucketDiffStat {
  readonly next: string | null;
}

export function decodeDiffstatJson(
  raw: string,
): Result.Result<BitbucketDiffStatPage, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  for (const entry of decoded.success.values) {
    const decodedStat = decodeDiffstatEntry(entry);
    if (Exit.isFailure(decodedStat)) continue;
    additions += decodedStat.value.lines_added ?? 0;
    deletions += decodedStat.value.lines_removed ?? 0;
    changedFiles += 1;
  }
  return Result.succeed({
    additions,
    deletions,
    changedFiles,
    next: trimmed(decoded.success.next),
  });
}

export function decodeConflictsJson(
  raw: string,
): Result.Result<PullRequestMergeability, DecodeFailure> {
  const decoded = decodeConflicts(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success.values.length === 0 ? "mergeable" : "conflicting")
    : Result.fail(decoded.failure);
}
