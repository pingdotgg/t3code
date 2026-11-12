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
  PullRequestCheck,
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

const RawPolicyEvaluationSchema = Schema.Struct({
  status: Schema.String,
  context: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        buildId: Schema.optional(Schema.NullOr(Schema.Int)),
        buildDefinitionName: Schema.optional(Schema.NullOr(Schema.String)),
        isExpired: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
  configuration: Schema.Struct({
    url: Schema.optional(Schema.NullOr(Schema.String)),
    isBlocking: Schema.optional(Schema.NullOr(Schema.Boolean)),
    isEnabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
    isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
    type: Schema.Struct({
      id: Schema.String,
      displayName: Schema.optional(Schema.NullOr(Schema.String)),
    }),
    settings: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          displayName: Schema.optional(Schema.NullOr(Schema.String)),
          defaultDisplayName: Schema.optional(Schema.NullOr(Schema.String)),
          statusName: Schema.optional(Schema.NullOr(Schema.String)),
          manualQueueOnly: Schema.optional(Schema.NullOr(Schema.Boolean)),
        }),
      ),
    ),
  }),
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
const decodePolicyEvaluations = decodeJsonResult(Schema.Array(RawPolicyEvaluationSchema));

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
    const path = toRepositoryPath(thread.threadContext?.filePath);
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

type RawPolicyEvaluation = Schema.Schema.Type<typeof RawPolicyEvaluationSchema>;

const BUILD_POLICY_TYPE = "0609b952-1397-4640-95ec-e00a01b2c241";
const STATUS_POLICY_TYPE = "cbdc66da-9728-4af8-aada-9a5a32e4a226";
// Other policy types wait on people or restrict pushes, so they would read as checks that never end.
const CHECK_POLICY_TYPES = new Set([BUILD_POLICY_TYPE, STATUS_POLICY_TYPE]);

/** Azure reports `queued` for a build that will never start on its own, so name those apart. */
function toPolicyCheckProgress(
  raw: RawPolicyEvaluation,
): Pick<PullRequestCheck, "status" | "description"> {
  const settled = (status: PullRequestCheck["status"]) => ({ status, description: null });
  switch (raw.status.trim().toLowerCase()) {
    case "approved":
      return settled("success");
    case "rejected":
    case "broken":
      return settled("failure");
    case "running":
      return settled("pending");
    case "notapplicable":
      return settled("skipped");
    case "queued":
      break;
    default:
      // A watch counts anything settled as passed, so an unknown status cannot be.
      return settled("pending");
  }
  const expired = raw.context?.isExpired === true;
  if (!expired && raw.configuration.settings?.manualQueueOnly !== true) return settled("pending");
  // Only a blocking build holds the pull request; an optional one nobody queues never runs.
  return {
    status: raw.configuration.isBlocking === true ? "action-required" : "skipped",
    description: expired ? "Expired. Queue it again on Azure DevOps." : "Queue it on Azure DevOps.",
  };
}

/** The evaluation's configuration URL opens at the project the policy belongs to. */
function toPolicyCheckUrl(raw: RawPolicyEvaluation): string | null {
  const buildId = raw.context?.buildId;
  const [projectUrl, rest] = (raw.configuration.url ?? "").split("/_apis/", 2);
  return buildId == null || rest === undefined
    ? null
    : `${projectUrl}/_build/results?buildId=${buildId}`;
}

function toPolicyCheck(raw: RawPolicyEvaluation, isDraft: boolean): PullRequestCheck | null {
  const { configuration, context } = raw;
  if (
    !CHECK_POLICY_TYPES.has(configuration.type.id.toLowerCase()) ||
    configuration.isEnabled === false ||
    configuration.isDeleted === true
  ) {
    return null;
  }
  // A build Azure holds back on a draft stays out, as nothing would ever finish it.
  if (isDraft && raw.status.trim().toLowerCase() === "queued" && context?.buildId == null) {
    return null;
  }
  return {
    name:
      trimmed(configuration.settings?.displayName) ??
      trimmed(configuration.settings?.defaultDisplayName) ??
      trimmed(context?.buildDefinitionName) ??
      trimmed(configuration.settings?.statusName) ??
      trimmed(configuration.type.displayName) ??
      "Policy",
    ...toPolicyCheckProgress(raw),
    url: toPolicyCheckUrl(raw),
    required: configuration.isBlocking === true,
  };
}

export interface AzureDevOpsPolicyCheckPage {
  readonly checks: ReadonlyArray<PullRequestCheck>;
  /** Evaluations of every policy type, so filtered rows cannot hide a next page. */
  readonly rawCount: number;
}

/** Unlike the tolerant decoders above, one bad row fails the page: a lost required check reads as passed. */
export function decodePolicyChecksJson(
  raw: string,
  input: { readonly isDraft: boolean },
): Result.Result<AzureDevOpsPolicyCheckPage, DecodeFailure> {
  const decoded = decodePolicyEvaluations(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  return Result.succeed({
    checks: decoded.success.flatMap((evaluation) => {
      const check = toPolicyCheck(evaluation, input.isDraft);
      return check === null ? [] : [check];
    }),
    rawCount: decoded.success.length,
  });
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
