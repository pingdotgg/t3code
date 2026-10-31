import {
  trimOptionalString as trimmed,
  normalizeRefName,
} from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestComment,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import { azureDevOpsPullRequestWebUrl } from "./azureDevOpsPullRequests.ts";

// CLI fields vary by command; unknown enum values must not fail the payload.
const RawIdentitySchema = Schema.Struct({
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  uniqueName: Schema.optional(Schema.NullOr(Schema.String)),
  imageUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawPullRequestSchema = Schema.Struct({
  pullRequestId: Schema.Int,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /** This identity's presence indicates auto-complete. */
  autoCompleteSetBy: Schema.optional(Schema.NullOr(RawIdentitySchema)),
  completionOptions: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        mergeStrategy: Schema.optional(Schema.NullOr(Schema.String)),
        squashMerge: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
  mergeStatus: Schema.optional(Schema.NullOr(Schema.String)),
  createdBy: Schema.optional(Schema.NullOr(RawIdentitySchema)),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(RawIdentitySchema))),
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

export interface AzureDevOpsRepositoryLocation {
  readonly project: string;
  readonly repository: string;
}

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
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly body: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly location: AzureDevOpsRepositoryLocation | null;
  readonly autoMergeEnabled: boolean;
  readonly autoMergeMethod?: PullRequestMergeMethod;
}

/** Logins must match the email from `az account show`. */
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
      return "unknown";
  }
}

function toLocation(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): AzureDevOpsRepositoryLocation | null {
  const project = trimmed(raw.repository?.project?.name);
  const repository = trimmed(raw.repository?.name);
  if (project === null || repository === null) return null;
  return { project, repository };
}

function toAutoMergeMethod(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): PullRequestMergeMethod | undefined {
  if (raw.autoCompleteSetBy == null) return undefined;
  switch (raw.completionOptions?.mergeStrategy?.trim().toLowerCase()) {
    case "squash":
      return "squash";
    case "rebase":
    case "rebasemerge":
      return "rebase";
    case "nofastforward":
      return "merge";
    default:
      return raw.completionOptions?.squashMerge === true ? "squash" : undefined;
  }
}

function toPullRequest(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): AzureDevOpsPullRequest | null {
  const autoMergeMethod = toAutoMergeMethod(raw);
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
    location: toLocation(raw),
    autoMergeEnabled: (raw.autoCompleteSetBy ?? null) !== null,
    ...(autoMergeMethod === undefined ? {} : { autoMergeMethod }),
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
  readonly rawIndexes: ReadonlyArray<number>;
  /** Count before decoding to avoid ending pagination on skipped rows. */
  readonly rawCount: number;
}

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

/** Null means Azure returned insufficient data. */
export function decodePullRequestJson(
  raw: string,
): Result.Result<AzureDevOpsPullRequest | null, DecodeFailure> {
  const decoded = decodePullRequest(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toPullRequest(decoded.success))
    : Result.fail(decoded.failure);
}

export function decodeViewerJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeViewer(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.user?.name))
    : Result.fail(decoded.failure);
}

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

const RawIterationSchema = Schema.Struct({
  id: Schema.Int,
  sourceRefCommit: Schema.optional(
    Schema.NullOr(Schema.Struct({ commitId: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  commonRefCommit: Schema.optional(
    Schema.NullOr(Schema.Struct({ commitId: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

const RawIterationPageSchema = Schema.Struct({ value: Schema.Array(Schema.Unknown) });

const RawChangeEntrySchema = Schema.Struct({
  changeType: Schema.optional(Schema.NullOr(Schema.String)),
  sourceServerItem: Schema.optional(Schema.NullOr(Schema.String)),
  originalPath: Schema.optional(Schema.NullOr(Schema.String)),
  item: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        path: Schema.optional(Schema.NullOr(Schema.String)),
        objectId: Schema.optional(Schema.NullOr(Schema.String)),
        originalObjectId: Schema.optional(Schema.NullOr(Schema.String)),
        isFolder: Schema.optional(Schema.NullOr(Schema.Boolean)),
        gitObjectType: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const RawChangePageSchema = Schema.Struct({
  changeEntries: Schema.Array(Schema.Unknown),
  nextSkip: Schema.optional(Schema.NullOr(Schema.Number)),
});

const RawItemContentSchema = Schema.Struct({
  content: Schema.optional(Schema.NullOr(Schema.String)),
  contentMetadata: Schema.optional(
    Schema.NullOr(Schema.Struct({ isBinary: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
  ),
});

export interface AzureDevOpsIteration {
  readonly id: number;
  readonly headCommit: string;
  readonly mergeBaseCommit: string;
}

export interface AzureDevOpsChangeEntry {
  readonly path: string;
  readonly oldPath: string;
  readonly changeKind: "new" | "deleted" | "change" | "rename-pure" | "rename-changed";
  readonly objectId: string | null;
  readonly originalObjectId: string | null;
}

export interface AzureDevOpsChangePage {
  readonly changes: ReadonlyArray<AzureDevOpsChangeEntry>;
  readonly nextSkip: number | null;
}

export interface AzureDevOpsItemContent {
  readonly contents: string;
  readonly isBinary: boolean;
}

const decodeIterationPage = decodeJsonResult(RawIterationPageSchema);
const decodeIterationEntry = Schema.decodeUnknownExit(RawIterationSchema);
const decodeChangePage = decodeJsonResult(RawChangePageSchema);
const decodeChangeEntry = Schema.decodeUnknownExit(RawChangeEntrySchema);
const decodeItemContent = decodeJsonResult(RawItemContentSchema);

/** Preserve whitespace to match patch paths and viewed marks. */
function toRepositoryPath(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const path = value.replace(/^\/+/, "");
  return path.length === 0 ? null : path;
}

function toChangeKind(
  raw: string | null | undefined,
  renamed: boolean,
): AzureDevOpsChangeEntry["changeKind"] {
  const parts = new Set(
    (raw ?? "")
      .toLowerCase()
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
  if (parts.has("delete")) return "deleted";
  if (renamed || parts.has("rename")) return parts.has("edit") ? "rename-changed" : "rename-pure";
  if (parts.has("add")) return "new";
  return "change";
}

export function decodeIterationsJson(
  raw: string,
): Result.Result<ReadonlyArray<AzureDevOpsIteration>, DecodeFailure> {
  const decoded = decodeIterationPage(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const iterations: AzureDevOpsIteration[] = [];
  for (const entry of decoded.success.value) {
    const decodedIteration = decodeIterationEntry(entry);
    if (Exit.isFailure(decodedIteration)) continue;
    const iteration = decodedIteration.value;
    const headCommit = trimmed(iteration.sourceRefCommit?.commitId);
    const mergeBaseCommit = trimmed(iteration.commonRefCommit?.commitId);
    if (headCommit === null || mergeBaseCommit === null) continue;
    iterations.push({ id: iteration.id, headCommit, mergeBaseCommit });
  }
  return Result.succeed(iterations.toSorted((left, right) => left.id - right.id));
}

export function decodeIterationChangesJson(
  raw: string,
): Result.Result<AzureDevOpsChangePage, DecodeFailure> {
  const decoded = decodeChangePage(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const changes: AzureDevOpsChangeEntry[] = [];
  for (const entry of decoded.success.changeEntries) {
    const decodedChange = decodeChangeEntry(entry);
    if (Exit.isFailure(decodedChange)) continue;
    const change = decodedChange.value;
    const path = toRepositoryPath(change.item?.path);
    if (path === null) continue;
    if (change.item?.isFolder === true) continue;
    if ((change.item?.gitObjectType ?? "blob").toLowerCase() !== "blob") continue;
    // Azure uses either field for renames, depending on route/version.
    const oldPath =
      toRepositoryPath(change.sourceServerItem) ?? toRepositoryPath(change.originalPath) ?? path;
    changes.push({
      path,
      oldPath,
      changeKind: toChangeKind(change.changeType, oldPath !== path),
      objectId: trimmed(change.item?.objectId),
      originalObjectId: trimmed(change.item?.originalObjectId),
    });
  }
  const nextSkip = decoded.success.nextSkip ?? null;
  return Result.succeed({
    changes,
    nextSkip: nextSkip !== null && Number.isSafeInteger(nextSkip) && nextSkip > 0 ? nextSkip : null,
  });
}

/** Azure returns an empty body for absent files. Binary status comes from its metadata. */
export function decodeItemContentJson(
  raw: string,
): Result.Result<AzureDevOpsItemContent, DecodeFailure> {
  const decoded = decodeItemContent(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({
        contents: decoded.success.content ?? "",
        isBinary: decoded.success.contentMetadata?.isBinary === true,
      })
    : Result.fail(decoded.failure);
}
