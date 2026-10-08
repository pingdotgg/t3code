import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { IssueComment, IssueState, IssueActor } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

/**
 * Bitbucket's enums are decoded as plain strings and normalized here, in the same tolerant style
 * as the other hosts: a new issue state must not fail a whole payload.
 */
const RawUserSchema = Schema.Struct({
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

const RawIssueSchema = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  content: Schema.optional(Schema.NullOr(Schema.Struct({ raw: Schema.optional(Schema.String) }))),
  reporter: Schema.optional(Schema.NullOr(RawUserSchema)),
  assignee: Schema.optional(Schema.NullOr(RawUserSchema)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  created_on: Schema.String,
  updated_on: Schema.String,
  milestone: Schema.optional(
    Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  links: Schema.Struct({ html: Schema.Struct({ href: Schema.String }) }),
});

const RawPageSchema = Schema.Struct({
  values: Schema.Array(Schema.Unknown),
  size: Schema.optional(Schema.NullOr(Schema.Int)),
  /** Present only while a further page exists. */
  next: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawCommentSchema = Schema.Struct({
  id: Schema.Int,
  content: Schema.optional(Schema.NullOr(Schema.Struct({ raw: Schema.optional(Schema.String) }))),
  user: Schema.optional(Schema.NullOr(RawUserSchema)),
  created_on: Schema.String,
  deleted: Schema.optional(Schema.Boolean),
  links: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        html: Schema.optional(
          Schema.NullOr(Schema.Struct({ href: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
});

const RawViewerSchema = Schema.Struct({
  nickname: Schema.optional(Schema.NullOr(Schema.String)),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * `/user/permissions/repositories` filtered to one repository, the only place Bitbucket states
 * what the credentials may do with it: nothing on the repository or the issue itself carries it.
 */
const RawRepositoryPermissionsSchema = Schema.Struct({
  values: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ permission: Schema.optional(Schema.NullOr(Schema.String)) })),
    ),
  ),
});

export interface BitbucketIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: IssueActor | null;
  readonly state: IssueState;
  /** Bitbucket records no reason for closing an issue, so there is never one to report. */
  readonly stateReason: null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Bitbucket keeps no separate closing timestamp; `updatedAt` is what a close last touched. */
  readonly closedAt: string | null;
  readonly assignee: IssueActor | null;
  readonly milestone: string | null;
  /**
   * Read cheaply from the listing rather than by reading every issue's comments; the true count
   * is only worth the extra request once the reader has opened the issue.
   */
  readonly commentCount: number;
}

export interface BitbucketIssueDetail extends BitbucketIssue {
  readonly body: string;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/**
 * Bitbucket stamps times as `+00:00` with microseconds. Entries from every host are ordered
 * against each other as plain strings, so this is normalized to the same `Z` form the others use.
 */
function toIsoUtc(value: string): string {
  return Option.match(DateTime.make(value), {
    onNone: () => value,
    onSome: DateTime.formatIso,
  });
}

/** An app account has no nickname, so the display name is the only handle it has. */
function toActor(raw: Schema.Schema.Type<typeof RawUserSchema> | null | undefined) {
  const login = trimmed(raw?.nickname) ?? trimmed(raw?.display_name);
  return login === null
    ? null
    : { login, name: trimmed(raw?.display_name), avatarUrl: trimmed(raw?.links?.avatar?.href) };
}

/**
 * Bitbucket's issue tracker has eight states, only two of which are open. Everything else —
 * resolved, on hold, invalid, duplicate, wontfix, and closed itself — reads as closed here, which
 * is the only place these many-valued workflows fit the port's binary one.
 */
function toState(raw: string | null | undefined): IssueState {
  const state = raw?.trim().toLowerCase();
  return state === "new" || state === "open" ? "open" : "closed";
}

function toIssue(raw: Schema.Schema.Type<typeof RawIssueSchema>): BitbucketIssue {
  const state = toState(raw.state);
  const updatedAt = toIsoUtc(raw.updated_on);
  return {
    number: raw.id,
    title: raw.title,
    url: raw.links.html.href,
    author: toActor(raw.reporter),
    state,
    stateReason: null,
    createdAt: toIsoUtc(raw.created_on),
    updatedAt,
    closedAt: state === "closed" ? updatedAt : null,
    assignee: toActor(raw.assignee),
    milestone: trimmed(raw.milestone?.name),
    commentCount: 0,
  };
}

const decodePage = decodeJsonResult(RawPageSchema);
const decodeIssueEntry = Schema.decodeUnknownExit(RawIssueSchema);
const decodeIssue = decodeJsonResult(RawIssueSchema);
const decodeCommentEntry = Schema.decodeUnknownExit(RawCommentSchema);
const decodeViewer = decodeJsonResult(RawViewerSchema);
const decodeRepositoryPermissions = decodeJsonResult(RawRepositoryPermissionsSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface BitbucketPage<A> {
  readonly items: ReadonlyArray<A>;
  /** The total Bitbucket reports for the whole listing, where it names one. */
  readonly size: number | null;
  /** The whole URL of the next page, which Bitbucket sends rather than an offset. */
  readonly next: string | null;
}

/** Malformed entries are skipped rather than failing the page, as on the other hosts. */
export function decodeIssuePageJson(
  raw: string,
): Result.Result<BitbucketPage<BitbucketIssue>, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: BitbucketIssue[] = [];
  for (const entry of decoded.success.values) {
    const item = decodeIssueEntry(entry);
    if (Exit.isSuccess(item)) {
      items.push(toIssue(item.value));
    }
  }
  return Result.succeed({
    items,
    size: decoded.success.size ?? null,
    next: trimmed(decoded.success.next),
  });
}

export function decodeIssueJson(raw: string): Result.Result<BitbucketIssueDetail, DecodeFailure> {
  const decoded = decodeIssue(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({ ...toIssue(decoded.success), body: decoded.success.content?.raw ?? "" })
    : Result.fail(decoded.failure);
}

/** What a create answered with, which is the only part of a new issue the caller needs back. */
export function decodeCreatedIssueJson(
  raw: string,
): Result.Result<{ readonly number: number; readonly url: string }, DecodeFailure> {
  const decoded = decodeIssue(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({ number: decoded.success.id, url: decoded.success.links.html.href })
    : Result.fail(decoded.failure);
}

export function decodeViewerJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeViewer(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.nickname) ?? trimmed(decoded.success.display_name))
    : Result.fail(decoded.failure);
}

/**
 * Whether the configured credentials can write to the repository. Bitbucket answers `admin`,
 * `write` or `read`, and an empty page means it named no permission at all for this account — an
 * unknown standing, which is granted rather than guessed away.
 */
export function decodeRepositoryPermissionJson(raw: string): Result.Result<boolean, DecodeFailure> {
  const decoded = decodeRepositoryPermissions(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const permission = trimmed(decoded.success.values?.[0]?.permission)?.toLowerCase() ?? null;
  return Result.succeed(permission === null || permission === "admin" || permission === "write");
}

export interface BitbucketIssueComments {
  readonly comments: ReadonlyArray<IssueComment>;
  readonly size: number | null;
  readonly next: string | null;
}

/** Deleted comments and ones with no text carry nothing to show. */
export function decodeIssueCommentsJson(
  raw: string,
): Result.Result<BitbucketIssueComments, DecodeFailure> {
  const decoded = decodePage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const comments: IssueComment[] = [];
  for (const entry of decoded.success.values) {
    const decodedComment = decodeCommentEntry(entry);
    if (Exit.isFailure(decodedComment)) continue;
    const comment = decodedComment.value;
    if (comment.deleted === true) continue;
    const body = comment.content?.raw ?? "";
    if (body.trim().length === 0) continue;
    comments.push({
      id: String(comment.id),
      author: toActor(comment.user),
      body,
      createdAt: toIsoUtc(comment.created_on),
      url: trimmed(comment.links?.html?.href),
    });
  }
  return Result.succeed({
    comments,
    size: decoded.success.size ?? null,
    next: trimmed(decoded.success.next),
  });
}
