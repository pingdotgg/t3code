import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestComment,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import {
  azureDevOpsOrganizationBaseFromRestApiUrl,
  azureDevOpsPullRequestWebUrl,
} from "../sourceControl/azureDevOpsPullRequests.ts";

/**
 * Azure's enums are decoded as plain strings and normalized here, in the same tolerant style as
 * the other hosts: a new merge status must not fail a whole payload. Every field beyond the
 * identity is optional, because `az repos pr` returns rather more or less of the REST object
 * depending on the command.
 */
const RawIdentitySchema = Schema.Struct({
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  /** An email or UPN, which is what `az account show` reports for the signed-in user. */
  uniqueName: Schema.optional(Schema.NullOr(Schema.String)),
  imageUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawPullRequestSchema = Schema.Struct({
  pullRequestId: Schema.Int,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /**
   * Who armed auto-complete, which is the only thing Azure says about it: the field carries an
   * identity while the pull request is set to complete on its own, and Azure leaves it out
   * entirely once nobody has. So its presence is the answer, and there is no third state.
   */
  autoCompleteSetBy: Schema.optional(Schema.NullOr(RawIdentitySchema)),
  mergeStatus: Schema.optional(Schema.NullOr(Schema.String)),
  createdBy: Schema.optional(Schema.NullOr(RawIdentitySchema)),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(RawIdentitySchema))),
  // Required, and required to be non-empty: the wire contract will not carry a change request
  // without a branch or a created time, so a row missing one is skipped rather than breaking the
  // response it travels in.
  sourceRefName: TrimmedNonEmptyString,
  targetRefName: TrimmedNonEmptyString,
  creationDate: TrimmedNonEmptyString,
  closedDate: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optional(Schema.NullOr(Schema.String)),
        webUrl: Schema.optional(Schema.NullOr(Schema.String)),
        project: Schema.optional(
          Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
        ),
      }),
    ),
  ),
  _links: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        web: Schema.optional(
          Schema.NullOr(Schema.Struct({ href: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
});

/** A pull request thread, which is how Azure keeps its conversation. */
const RawThreadSchema = Schema.Struct({
  id: Schema.Int,
  isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
  threadContext: Schema.optional(
    Schema.NullOr(Schema.Struct({ filePath: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  comments: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          id: Schema.optional(Schema.NullOr(Schema.Int)),
          content: Schema.optional(Schema.NullOr(Schema.String)),
          author: Schema.optional(Schema.NullOr(RawIdentitySchema)),
          publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
          isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
          /** `system` marks the notes Azure writes itself, which are events, not comments. */
          commentType: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});

const RawThreadPageSchema = Schema.Struct({
  value: Schema.Array(Schema.Unknown),
});

const RawViewerSchema = Schema.Struct({
  user: Schema.optional(
    Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

export interface AzureDevOpsPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly createdAt: string;
  /**
   * Azure records no last-touched time on a pull request, so the closing time stands in where
   * there is one and the creation time otherwise. The same fallback the rest of the app uses.
   */
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly body: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  /** Where this pull request's threads live, when Azure said enough to work it out. */
  readonly threadsUrl: string | null;
  /** Whether Azure is set to complete this on its own once its policies pass. */
  readonly autoMergeEnabled: boolean;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function normalizeRefName(refName: string): string {
  return refName.trim().replace(/^refs\/heads\//, "");
}

/** A login has to compare against `az account show`, which reports an email. */
function toActor(raw: Schema.Schema.Type<typeof RawIdentitySchema> | null | undefined) {
  const login = trimmed(raw?.uniqueName) ?? trimmed(raw?.displayName);
  return login === null
    ? null
    : { login, name: trimmed(raw?.displayName), avatarUrl: trimmed(raw?.imageUrl) };
}

function toState(raw: Schema.Schema.Type<typeof RawPullRequestSchema>): PullRequestState {
  switch (raw.status?.trim().toLowerCase()) {
    case "completed":
      return "merged";
    case "abandoned":
      return "closed";
    default:
      return "open";
  }
}

function toMergeability(value: string | null | undefined): PullRequestMergeability {
  switch (value?.trim().toLowerCase()) {
    case "succeeded":
      return "mergeable";
    case "conflicts":
    case "failure":
    case "rejectedbypolicy":
      return "conflicting";
    default:
      // `queued` and `notSet` mean Azure has not finished checking.
      return "unknown";
  }
}

/**
 * The REST collection a pull request's threads hang from. Built from what Azure returned rather
 * than from the local remote, whose shape differs between the modern, legacy and SSH forms.
 */
function toThreadsUrl(raw: Schema.Schema.Type<typeof RawPullRequestSchema>): string | null {
  const base = azureDevOpsOrganizationBaseFromRestApiUrl(raw.url);
  const project = trimmed(raw.repository?.project?.name);
  const repository = trimmed(raw.repository?.name);
  if (base === null || project === null || repository === null) return null;
  return `${base}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}/pullRequests/${raw.pullRequestId}/threads`;
}

/**
 * Null when Azure said too little to place the pull request: a row with no browser url and no
 * branch left after its prefix is dropped cannot be rendered or opened, and the wire contract
 * refuses to carry it either.
 */
function toPullRequest(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): AzureDevOpsPullRequest | null {
  const reviewers = (raw.reviewers ?? []).flatMap((reviewer) => {
    const actor = toActor(reviewer);
    return actor === null ? [] : [actor];
  });
  const closedAt = trimmed(raw.closedDate);
  const url = trimmed(
    azureDevOpsPullRequestWebUrl({
      pullRequestId: raw.pullRequestId,
      webLink: raw._links?.web?.href,
      repositoryWebUrl: raw.repository?.webUrl,
      restApiUrl: raw.url,
      projectName: raw.repository?.project?.name,
      repositoryName: raw.repository?.name,
    }),
  );
  const headBranch = trimmed(normalizeRefName(raw.sourceRefName));
  const baseBranch = trimmed(normalizeRefName(raw.targetRefName));
  if (url === null || headBranch === null || baseBranch === null) return null;
  return {
    number: raw.pullRequestId,
    title: raw.title,
    url,
    author: toActor(raw.createdBy),
    headBranch,
    baseBranch,
    state: toState(raw),
    isDraft: raw.isDraft ?? false,
    mergeability: toMergeability(raw.mergeStatus),
    createdAt: raw.creationDate,
    updatedAt: closedAt ?? raw.creationDate,
    closedAt,
    body: raw.description ?? "",
    reviewRequestLogins: reviewers.map((reviewer) => reviewer.login),
    reviewers,
    threadsUrl: toThreadsUrl(raw),
    autoMergeEnabled: (raw.autoCompleteSetBy ?? null) !== null,
  };
}

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodePullRequestEntry = Schema.decodeUnknownExit(RawPullRequestSchema);
const decodePullRequest = decodeJsonResult(RawPullRequestSchema);
const decodeThreadPage = decodeJsonResult(RawThreadPageSchema);
const decodeThreadEntry = Schema.decodeUnknownExit(RawThreadSchema);
const decodeViewer = decodeJsonResult(RawViewerSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface AzureDevOpsPullRequestBatch {
  readonly items: ReadonlyArray<AzureDevOpsPullRequest>;
  /** Zero-based positions of the decoded items in Azure's raw page. */
  readonly rawIndexes: ReadonlyArray<number>;
  /** Rows Azure returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
}

/** Malformed entries are skipped rather than failing the batch, as on the other hosts. */
export function decodePullRequestListJson(
  raw: string,
): Result.Result<AzureDevOpsPullRequestBatch, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: AzureDevOpsPullRequest[] = [];
  const rawIndexes: number[] = [];
  for (const [rawIndex, entry] of decoded.success.entries()) {
    const item = decodePullRequestEntry(entry);
    if (Exit.isFailure(item)) continue;
    const pullRequest = toPullRequest(item.value);
    if (pullRequest !== null) {
      items.push(pullRequest);
      rawIndexes.push(rawIndex);
    }
  }
  return Result.succeed({ items, rawIndexes, rawCount: decoded.success.length });
}

/** Null carries "Azure answered, but with too little to use", which the caller reports. */
export function decodePullRequestJson(
  raw: string,
): Result.Result<AzureDevOpsPullRequest | null, DecodeFailure> {
  const decoded = decodePullRequest(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toPullRequest(decoded.success))
    : Result.fail(decoded.failure);
}

/** `az account show --query user` reports the signed-in account, whose name is an email. */
export function decodeViewerJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeViewer(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.user?.name))
    : Result.fail(decoded.failure);
}

/**
 * Azure keeps its conversation as threads of comments, and every one of them is a remark
 * somebody wrote: a reply under a thread is as much of the conversation as the line that opened
 * it. A thread pinned to a file is a line-level review comment.
 *
 * Azure answers the whole thread collection in one response, with no cursor and no page to
 * follow, so what this returns is everything the host has.
 */
export function decodeThreadsJson(
  raw: string,
): Result.Result<ReadonlyArray<PullRequestComment>, DecodeFailure> {
  const decoded = decodeThreadPage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const comments: PullRequestComment[] = [];
  for (const entry of decoded.success.value) {
    const decodedThread = decodeThreadEntry(entry);
    if (Exit.isFailure(decodedThread)) continue;
    const thread = decodedThread.value;
    if (thread.isDeleted === true) continue;
    const path = trimmed(thread.threadContext?.filePath);
    for (const comment of thread.comments ?? []) {
      const publishedDate = trimmed(comment.publishedDate);
      if (
        comment.isDeleted === true ||
        comment.commentType?.trim().toLowerCase() === "system" ||
        (comment.content ?? "").trim().length === 0 ||
        publishedDate === null
      ) {
        continue;
      }
      comments.push({
        id: `${thread.id}:${comment.id ?? 0}`,
        kind: path === null ? "issue-comment" : "review-comment",
        author: toActor(comment.author),
        body: comment.content ?? "",
        createdAt: publishedDate,
        url: null,
        path,
        reviewState: null,
      });
    }
  }
  return Result.succeed(
    comments.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
  );
}
