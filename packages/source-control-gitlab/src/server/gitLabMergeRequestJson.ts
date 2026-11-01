import { trimOptionalString as trimmed } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestComment,
  PullRequestCommit,
  PullRequestLabel,
  PullRequestMergeability,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewThread,
  PullRequestReviewerCandidate,
  PullRequestState,
} from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

/** Unknown pipeline or merge status values must not fail the whole payload. */
const RawUserSchema = Schema.Struct({
  id: Schema.optional(Schema.Int),
  username: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawPipelineSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Int)),
  project_id: Schema.optional(Schema.NullOr(Schema.Int)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  web_url: Schema.optional(Schema.NullOr(Schema.String)),
  source: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawTriggerJobSchema = Schema.Struct({
  name: Schema.String,
  allow_failure: Schema.optional(Schema.NullOr(Schema.Boolean)),
  downstream_pipeline: Schema.optional(Schema.NullOr(RawPipelineSchema)),
});

const RawMergeRequestSchema = Schema.Struct({
  iid: Schema.Int,
  title: Schema.String,
  web_url: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
  source_branch: Schema.String,
  target_branch: Schema.String,
  sha: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.Boolean),
  work_in_progress: Schema.optional(Schema.Boolean),
  merge_status: Schema.optional(Schema.NullOr(Schema.String)),
  has_conflicts: Schema.optional(Schema.NullOr(Schema.Boolean)),
  created_at: Schema.String,
  updated_at: Schema.String,
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(RawUserSchema))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  // GitLab reports "1000+" past its counting limit.
  changes_count: Schema.optional(Schema.NullOr(Schema.String)),
  head_pipeline: Schema.optional(Schema.NullOr(RawPipelineSchema)),
  user: Schema.optional(
    Schema.NullOr(Schema.Struct({ can_merge: Schema.optional(Schema.Boolean) })),
  ),
  merge_when_pipeline_succeeds: Schema.optional(Schema.NullOr(Schema.Boolean)),
  auto_merge_enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  squash_on_merge: Schema.optional(Schema.NullOr(Schema.Boolean)),
  squash: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /** Only detail reads with include_diverged_commits_count return this expensive count. */
  diverged_commits_count: Schema.optional(Schema.NullOr(Schema.Int)),
});

const RawNoteSchema = Schema.Struct({
  id: Schema.Int,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
  created_at: Schema.String,
  system: Schema.optional(Schema.Boolean),
  type: Schema.optional(Schema.NullOr(Schema.String)),
  position: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        new_path: Schema.optional(Schema.NullOr(Schema.String)),
        old_path: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const RawDiscussionNoteSchema = Schema.Struct({
  id: Schema.Int,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
  created_at: Schema.String,
  system: Schema.optional(Schema.Boolean),
  resolvable: Schema.optional(Schema.Boolean),
  resolved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  position: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        position_type: Schema.optional(Schema.NullOr(Schema.String)),
        new_path: Schema.optional(Schema.NullOr(Schema.String)),
        old_path: Schema.optional(Schema.NullOr(Schema.String)),
        new_line: Schema.optional(Schema.NullOr(Schema.Int)),
        old_line: Schema.optional(Schema.NullOr(Schema.Int)),
      }),
    ),
  ),
});

const RawDiscussionSchema = Schema.Struct({
  id: Schema.String,
  notes: Schema.optional(Schema.NullOr(Schema.Array(RawDiscussionNoteSchema))),
});

const RawDiffRefsSchema = Schema.Struct({
  diff_refs: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        base_sha: Schema.String,
        head_sha: Schema.String,
        start_sha: Schema.String,
      }),
    ),
  ),
});

const RawCommitSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  committed_date: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  parent_ids: Schema.optional(Schema.Array(Schema.String)),
  author_name: Schema.optional(Schema.NullOr(Schema.String)),
  author_email: Schema.optional(Schema.NullOr(Schema.String)),
  stats: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        additions: Schema.optional(Schema.Int),
        deletions: Schema.optional(Schema.Int),
      }),
    ),
  ),
});

const RawDiffSchema = Schema.Struct({
  old_path: Schema.String,
  new_path: Schema.String,
  a_mode: Schema.optional(Schema.NullOr(Schema.String)),
  b_mode: Schema.optional(Schema.NullOr(Schema.String)),
  new_file: Schema.optional(Schema.Boolean),
  renamed_file: Schema.optional(Schema.Boolean),
  deleted_file: Schema.optional(Schema.Boolean),
  diff: Schema.optional(Schema.NullOr(Schema.String)),
  too_large: Schema.optional(Schema.NullOr(Schema.Boolean)),
  collapsed: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const RawViewerSchema = Schema.Struct({
  username: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawProjectMergeSettingsSchema = Schema.Struct({
  merge_method: Schema.optional(Schema.NullOr(Schema.String)),
  squash_option: Schema.optional(Schema.NullOr(Schema.String)),
});

export interface GitLabMergeRequestListItem {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
}

export interface GitLabMergeRequestDetail extends GitLabMergeRequestListItem {
  readonly body: string;
  readonly changedFiles: number;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly viewerCanMerge: boolean;
  readonly reviewerIds: ReadonlyArray<number>;
  readonly autoMergeEnabled?: boolean;
  readonly autoMergeMethod?: PullRequestMergeMethod;
  /** Absent means not counted, not up to date. */
  readonly divergedCommits?: number;
  readonly headSha?: string;
  /** On a fork the pipeline often belongs to the source project, not the target. */
  readonly headPipeline?: { readonly id: number; readonly projectId: number };
}

function toActor(raw: Schema.Schema.Type<typeof RawUserSchema> | null | undefined) {
  const login = trimmed(raw?.username);
  return login === null
    ? null
    : { login, name: trimmed(raw?.name), avatarUrl: trimmed(raw?.avatar_url) };
}

function toState(raw: Schema.Schema.Type<typeof RawMergeRequestSchema>): PullRequestState {
  if (trimmed(raw.merged_at) !== null) return "merged";
  switch (raw.state?.trim().toLowerCase()) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      return "open";
  }
}

function toMergeability(
  raw: Schema.Schema.Type<typeof RawMergeRequestSchema>,
): PullRequestMergeability {
  if (raw.has_conflicts === true) return "conflicting";
  switch (raw.merge_status?.trim().toLowerCase()) {
    case "can_be_merged":
      return "mergeable";
    case "cannot_be_merged":
      return "conflicting";
    default:
      return "unknown";
  }
}

function toLabels(raw: ReadonlyArray<string> | null | undefined): ReadonlyArray<PullRequestLabel> {
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label);
    return name === null ? [] : [{ name, color: null }];
  });
}

function toChangedFiles(value: string | null | undefined): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function toPipelineStatus(value: string | null | undefined): PullRequestCheckStatus {
  switch (value?.trim().toLowerCase()) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "canceled":
    case "canceling":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "manual":
      return "neutral";
    default:
      return "pending";
  }
}

function toChecks(
  raw: Schema.Schema.Type<typeof RawMergeRequestSchema>,
): ReadonlyArray<PullRequestCheck> {
  const pipeline = raw.head_pipeline;
  if (!pipeline) return [];
  return [
    {
      name: "Pipeline",
      status: toPipelineStatus(pipeline.status),
      description: trimmed(pipeline.source),
      url: trimmed(pipeline.web_url),
    },
  ];
}

function toListItem(
  raw: Schema.Schema.Type<typeof RawMergeRequestSchema>,
): GitLabMergeRequestListItem {
  return {
    number: raw.iid,
    title: raw.title,
    url: raw.web_url,
    author: toActor(raw.author),
    headBranch: raw.source_branch,
    baseBranch: raw.target_branch,
    state: toState(raw),
    isDraft: raw.draft ?? raw.work_in_progress ?? false,
    mergeability: toMergeability(raw),
    additions: 0,
    deletions: 0,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    reviewRequestLogins: (raw.reviewers ?? []).flatMap((reviewer) => {
      const login = trimmed(reviewer.username);
      return login === null ? [] : [login];
    }),
    labels: toLabels(raw.labels),
  };
}

function toDetail(raw: Schema.Schema.Type<typeof RawMergeRequestSchema>): GitLabMergeRequestDetail {
  const listItem = toListItem(raw);
  const headSha = trimmed(raw.sha);
  const autoMerge =
    raw.merge_when_pipeline_succeeds == null && raw.auto_merge_enabled == null
      ? undefined
      : raw.merge_when_pipeline_succeeds === true || raw.auto_merge_enabled === true;
  return {
    ...listItem,
    body: raw.description ?? "",
    changedFiles: toChangedFiles(raw.changes_count),
    mergedAt: trimmed(raw.merged_at),
    closedAt: trimmed(raw.closed_at),
    reviewers: (raw.reviewers ?? []).flatMap((reviewer) => {
      const actor = toActor(reviewer);
      return actor === null ? [] : [actor];
    }),
    checks: toChecks(raw),
    viewerCanMerge: raw.user?.can_merge !== false,
    reviewerIds: (raw.reviewers ?? []).flatMap((reviewer) =>
      reviewer.id === undefined ? [] : [reviewer.id],
    ),
    ...(autoMerge === undefined ? {} : { autoMergeEnabled: autoMerge }),
    ...(autoMerge === true && raw.squash_on_merge === true
      ? { autoMergeMethod: "squash" as const }
      : {}),
    ...(raw.diverged_commits_count == null ? {} : { divergedCommits: raw.diverged_commits_count }),
    ...(headSha === null ? {} : { headSha }),
    ...(raw.head_pipeline?.id == null || raw.head_pipeline.project_id == null
      ? {}
      : { headPipeline: { id: raw.head_pipeline.id, projectId: raw.head_pipeline.project_id } }),
  };
}

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeMergeRequestEntry = Schema.decodeUnknownExit(RawMergeRequestSchema);
const decodeMergeRequest = decodeJsonResult(RawMergeRequestSchema);
const decodeTriggerJobEntry = Schema.decodeUnknownExit(RawTriggerJobSchema);
const decodeNoteEntry = Schema.decodeUnknownExit(RawNoteSchema);
const decodeUserEntry = Schema.decodeUnknownExit(RawUserSchema);
const decodeCommitEntry = Schema.decodeUnknownExit(RawCommitSchema);
const decodeCommit = decodeJsonResult(RawCommitSchema);
const decodeMergeRequestChanges = decodeJsonResult(
  Schema.Struct({
    changes: Schema.Array(Schema.Unknown),
    overflow: Schema.optional(Schema.Boolean),
    changes_count: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeDiffEntry = Schema.decodeUnknownExit(RawDiffSchema);
const decodeDiscussionEntry = Schema.decodeUnknownExit(RawDiscussionSchema);
const decodeDiffRefs = decodeJsonResult(RawDiffRefsSchema);
const decodeViewer = decodeJsonResult(RawViewerSchema);
const decodeProjectMergeSettings = decodeJsonResult(RawProjectMergeSettingsSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface GitLabProjectUsers {
  readonly candidates: ReadonlyArray<PullRequestReviewerCandidate>;
  /** Count before decoding to avoid ending pagination on skipped rows. */
  readonly rawCount: number;
}

export interface GitLabMergeRequestListBatch {
  readonly items: ReadonlyArray<GitLabMergeRequestListItem>;
  readonly rawIndexes: ReadonlyArray<number>;
  readonly rawCount: number;
}

export function decodeMergeRequestListJson(
  raw: string,
): Result.Result<GitLabMergeRequestListBatch, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: GitLabMergeRequestListItem[] = [];
  const rawIndexes: number[] = [];
  for (const [rawIndex, entry] of decoded.success.entries()) {
    const item = decodeMergeRequestEntry(entry);
    if (Exit.isSuccess(item)) {
      items.push(toListItem(item.value));
      rawIndexes.push(rawIndex);
    }
  }
  return Result.succeed({ items, rawIndexes, rawCount: decoded.success.length });
}

export function decodeMergeRequestDetailJson(
  raw: string,
): Result.Result<GitLabMergeRequestDetail, DecodeFailure> {
  const decoded = decodeMergeRequest(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toDetail(decoded.success))
    : Result.fail(decoded.failure);
}

export interface GitLabTriggerJobChecks {
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly rawCount: number;
}

/**
 * Without `strategy: depend` a trigger job succeeds as soon as it starts its downstream
 * pipeline, so the head pipeline stays green when that pipeline fails. Each row carries the
 * downstream pipeline's own status instead of the trigger job's.
 */
export function decodeTriggerJobChecksJson(
  raw: string,
): Result.Result<GitLabTriggerJobChecks, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const checks: PullRequestCheck[] = [];
  for (const entry of decoded.success) {
    const job = decodeTriggerJobEntry(entry);
    if (Exit.isFailure(job)) continue;
    const name = trimmed(job.value.name);
    const downstream = job.value.downstream_pipeline;
    if (name === null || !downstream) continue;
    const status = toPipelineStatus(downstream.status);
    checks.push({
      name,
      // The same reading as `manual`: GitLab was told this failure does not fail the pipeline.
      status: status === "failure" && job.value.allow_failure === true ? "neutral" : status,
      description: "Downstream pipeline",
      url: trimmed(downstream.web_url),
    });
  }
  return Result.succeed({ checks, rawCount: decoded.success.length });
}

export function decodeViewerJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeViewer(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.username))
    : Result.fail(decoded.failure);
}

export function decodeProjectUsersJson(
  raw: string,
): Result.Result<GitLabProjectUsers, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const candidates: PullRequestReviewerCandidate[] = [];
  for (const entry of decoded.success) {
    const user = decodeUserEntry(entry);
    if (Exit.isFailure(user) || user.value.id === undefined) continue;
    const actor = toActor(user.value);
    if (actor === null) continue;
    candidates.push({
      ...actor,
      id: String(user.value.id),
      kind: "user",
      isRequested: false,
    });
  }
  return Result.succeed({ candidates, rawCount: decoded.success.length });
}

const RawLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeLabelEntry = Schema.decodeUnknownExit(RawLabelSchema);

export interface GitLabProjectLabels {
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly rawCount: number;
}

export function decodeProjectLabelsJson(
  raw: string,
): Result.Result<GitLabProjectLabels, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const labels: PullRequestLabel[] = [];
  for (const entry of decoded.success) {
    const label = decodeLabelEntry(entry);
    if (Exit.isFailure(label)) continue;
    const name = trimmed(label.value.name);
    if (name !== null) labels.push({ name, color: trimmed(label.value.color) });
  }
  return Result.succeed({ labels, rawCount: decoded.success.length });
}

export function decodeProjectMergeCapabilitiesJson(
  raw: string,
): Result.Result<PullRequestMergeCapabilities, DecodeFailure> {
  const decoded = decodeProjectMergeSettings(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const mergeMethod = decoded.success.merge_method?.trim().toLowerCase();
  const squashOption = decoded.success.squash_option?.trim().toLowerCase();
  return Result.succeed({
    merge: mergeMethod === "merge",
    rebase: mergeMethod === "rebase_merge" || mergeMethod === "ff",
    squash:
      squashOption === "always" || squashOption === "default_on" || squashOption === "default_off",
  });
}

export interface GitLabDiffRefs {
  readonly baseSha: string;
  readonly headSha: string;
  readonly startSha: string;
}

export interface GitLabDiscussions {
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
  readonly rawCount: number;
}

export function decodeDiscussionsJson(
  raw: string,
): Result.Result<GitLabDiscussions, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const threads: PullRequestReviewThread[] = [];
  for (const entry of decoded.success) {
    const discussion = decodeDiscussionEntry(entry);
    if (!Exit.isSuccess(discussion)) continue;
    const notes = (discussion.value.notes ?? []).filter((note) => note.system !== true);
    const root = notes[0];
    const position = root?.position;
    if (root === undefined || !position || position.position_type !== "text") continue;
    const side = position.new_line === null || position.new_line === undefined ? "left" : "right";
    const path = trimmed(side === "left" ? position.old_path : position.new_path);
    const line = side === "left" ? position.old_line : position.new_line;
    if (path === null) continue;
    threads.push({
      id: discussion.value.id,
      path,
      line: typeof line === "number" && line > 0 ? line : null,
      side,
      isResolved: root.resolved === true,
      isOutdated: false,
      comments: notes.map((note) => ({
        id: String(note.id),
        author: toActor(note.author),
        body: note.body ?? "",
        createdAt: note.created_at,
        url: null,
      })),
    });
  }
  return Result.succeed({ threads, rawCount: decoded.success.length });
}

export function decodeDiffRefsJson(
  raw: string,
): Result.Result<GitLabDiffRefs | null, DecodeFailure> {
  const decoded = decodeDiffRefs(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const refs = decoded.success.diff_refs;
  return Result.succeed(
    refs ? { baseSha: refs.base_sha, headSha: refs.head_sha, startSha: refs.start_sha } : null,
  );
}

export function decodeNotesJson(
  raw: string,
): Result.Result<
  { readonly comments: ReadonlyArray<PullRequestComment>; readonly rawCount: number },
  DecodeFailure
> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const comments: PullRequestComment[] = [];
  for (const entry of decoded.success) {
    const note = decodeNoteEntry(entry);
    if (Exit.isFailure(note)) continue;
    const value = note.value;
    if (value.system === true) continue;
    const body = value.body ?? "";
    if (body.trim().length === 0) continue;
    const isDiffNote = value.type?.trim() === "DiffNote";
    comments.push({
      id: String(value.id),
      kind: isDiffNote ? "review-comment" : "issue-comment",
      author: toActor(value.author),
      body,
      createdAt: value.created_at,
      url: null,
      path: trimmed(value.position?.new_path) ?? trimmed(value.position?.old_path),
      reviewState: null,
    });
  }
  return Result.succeed({ comments, rawCount: decoded.success.length });
}

export function decodeCommitsJson(
  raw: string,
): Result.Result<ReadonlyArray<PullRequestCommit>, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const commits: PullRequestCommit[] = [];
  for (const entry of decoded.success) {
    const commit = decodeCommitEntry(entry);
    if (Exit.isFailure(commit)) continue;
    const committedDate = trimmed(commit.value.committed_date) ?? trimmed(commit.value.created_at);
    if (committedDate === null) continue;
    commits.push({
      oid: commit.value.id,
      messageHeadline: commit.value.title ?? "",
      committedDate,
      ...(commit.value.stats === null || commit.value.stats === undefined
        ? {}
        : {
            additions: Math.max(0, commit.value.stats.additions ?? 0),
            deletions: Math.max(0, commit.value.stats.deletions ?? 0),
          }),
      authors: (() => {
        const login = trimmed(commit.value.author_name) ?? trimmed(commit.value.author_email);
        return login === null
          ? []
          : [{ login, name: trimmed(commit.value.author_name), avatarUrl: null }];
      })(),
    });
  }
  return Result.succeed(commits.toReversed());
}

export function decodeCommitDiffRefsJson(
  raw: string,
): Result.Result<GitLabDiffRefs | null, DecodeFailure> {
  const decoded = decodeCommit(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const baseSha = trimmed(decoded.success.parent_ids?.[0]);
  const headSha = trimmed(decoded.success.id);
  return Result.succeed(
    baseSha === null || headSha === null ? null : { baseSha, headSha, startSha: baseSha },
  );
}

function diffHeaderPaths(raw: Schema.Schema.Type<typeof RawDiffSchema>): {
  readonly from: string;
  readonly to: string;
} {
  return {
    from: raw.new_file === true ? "/dev/null" : quoteGitPatchPath(`a/${raw.old_path}`),
    to: raw.deleted_file === true ? "/dev/null" : quoteGitPatchPath(`b/${raw.new_path}`),
  };
}

export interface GitLabMergeRequestPatch {
  readonly patch: string;
  readonly truncated: boolean;
  readonly rawCount: number;
}

export function decodeMergeRequestDiffsJson(
  raw: string,
): Result.Result<GitLabMergeRequestPatch, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  return Result.succeed(mergeRequestPatch(decoded.success));
}

/** Older GitLab instances return all files in a non-paginated merge request wrapper. */
export function decodeMergeRequestChangesJson(
  raw: string,
): Result.Result<GitLabMergeRequestPatch, DecodeFailure> {
  const decoded = decodeMergeRequestChanges(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const patch = mergeRequestPatch(decoded.success.changes);
  return Result.succeed({
    ...patch,
    truncated:
      patch.truncated ||
      decoded.success.overflow === true ||
      decoded.success.changes_count?.endsWith("+") === true,
  });
}

function mergeRequestPatch(entries: ReadonlyArray<unknown>): GitLabMergeRequestPatch {
  const sections: string[] = [];
  let truncated = false;
  for (const entry of entries) {
    const file = decodeDiffEntry(entry);
    if (Exit.isFailure(file)) {
      truncated = true;
      continue;
    }
    const value = file.value;
    const hunks = value.diff ?? "";
    if (hunks.length === 0) {
      truncated = truncated || value.too_large === true || value.collapsed === true;
    }
    const { from, to } = diffHeaderPaths(value);
    const header = [
      `diff --git ${quoteGitPatchPath(`a/${value.old_path}`)} ${quoteGitPatchPath(`b/${value.new_path}`)}`,
      ...(value.new_file === true ? [`new file mode ${value.b_mode ?? "100644"}`] : []),
      ...(value.deleted_file === true ? [`deleted file mode ${value.a_mode ?? "100644"}`] : []),
      ...(value.renamed_file === true
        ? [
            `rename from ${quoteGitPatchPath(value.old_path)}`,
            `rename to ${quoteGitPatchPath(value.new_path)}`,
          ]
        : []),
      `--- ${from}`,
      `+++ ${to}`,
    ].join("\n");
    sections.push(hunks.length === 0 ? header : `${header}\n${hunks.replace(/\n?$/, "\n")}`);
  }
  return {
    patch: sections.join("\n"),
    truncated,
    rawCount: entries.length,
  };
}

const GITLAB_AWARD_BY_CONTENT: Readonly<Record<PullRequestReactionContent, string>> = {
  "thumbs-up": "thumbsup",
  "thumbs-down": "thumbsdown",
  laugh: "laughing",
  hooray: "tada",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

const CONTENT_BY_GITLAB_AWARD: Readonly<Record<string, PullRequestReactionContent>> =
  Object.fromEntries(
    Object.entries(GITLAB_AWARD_BY_CONTENT).map(([content, name]) => [name, content]),
  ) as Readonly<Record<string, PullRequestReactionContent>>;

export function gitLabAwardName(content: PullRequestReactionContent): string {
  return GITLAB_AWARD_BY_CONTENT[content];
}

export const AWARD_EMOJI_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!, $cursor: String) {
  currentUser { username }
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      awardEmoji { nodes { name user { username } } }
      notes(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id awardEmoji { nodes { name user { username } } } }
      }
    }
  }
}`;

const RawAwardEmojiNodesSchema = Schema.optional(
  Schema.NullOr(
    Schema.Struct({
      nodes: Schema.optional(
        Schema.NullOr(
          Schema.Array(
            Schema.NullOr(
              Schema.Struct({
                name: Schema.optional(Schema.NullOr(Schema.String)),
                user: Schema.optional(
                  Schema.NullOr(
                    Schema.Struct({ username: Schema.optional(Schema.NullOr(Schema.String)) }),
                  ),
                ),
              }),
            ),
          ),
        ),
      ),
    }),
  ),
);

const RawAwardEmojiPageSchema = Schema.Struct({
  data: Schema.Struct({
    currentUser: Schema.optional(
      Schema.NullOr(Schema.Struct({ username: Schema.optional(Schema.NullOr(Schema.String)) })),
    ),
    project: Schema.NullOr(
      Schema.Struct({
        mergeRequest: Schema.NullOr(
          Schema.Struct({
            awardEmoji: RawAwardEmojiNodesSchema,
            notes: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  pageInfo: Schema.optional(
                    Schema.Struct({
                      hasNextPage: Schema.optional(Schema.Boolean),
                      endCursor: Schema.optional(Schema.NullOr(Schema.String)),
                    }),
                  ),
                  nodes: Schema.Array(
                    Schema.NullOr(
                      Schema.Struct({
                        id: Schema.optional(Schema.NullOr(Schema.String)),
                        awardEmoji: RawAwardEmojiNodesSchema,
                      }),
                    ),
                  ),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  }),
});

const decodeAwardEmojiPage = decodeJsonResult(RawAwardEmojiPageSchema);

function toReactions(
  nodes: Schema.Schema.Type<typeof RawAwardEmojiNodesSchema>,
  viewer: string | null,
): ReadonlyArray<PullRequestReaction> {
  const normalizedViewer = viewer?.toLowerCase() ?? null;
  const groups = new Map<
    PullRequestReactionContent,
    { count: number; actors: string[]; viewer: boolean }
  >();
  for (const node of nodes?.nodes ?? []) {
    const content = CONTENT_BY_GITLAB_AWARD[trimmed(node?.name)?.toLowerCase() ?? ""];
    if (content === undefined) continue;
    const username = trimmed(node?.user?.username);
    if (username === null) continue;
    const group = groups.get(content) ?? { count: 0, actors: [], viewer: false };
    group.count++;
    if (normalizedViewer !== null && username.toLowerCase() === normalizedViewer) {
      group.viewer = true;
    } else {
      group.actors.push(username);
    }
    groups.set(content, group);
  }
  return [...groups].flatMap(([content, group]) =>
    group.count === 0
      ? []
      : [{ content, count: group.count, actors: group.actors, viewerHasReacted: group.viewer }],
  );
}

function noteIdOf(gid: string | null | undefined): string | null {
  const id = trimmed(gid)?.split("/").at(-1);
  return id !== undefined && /^\d+$/.test(id) ? id : null;
}

export interface GitLabAwardEmojiPage {
  readonly reactions: ReadonlyArray<PullRequestReaction>;
  readonly reactionsByNoteId: ReadonlyMap<string, ReadonlyArray<PullRequestReaction>>;
  readonly nextCursor: string | null;
}

export function decodeAwardEmojiJson(
  raw: string,
): Result.Result<GitLabAwardEmojiPage, DecodeFailure> {
  const decoded = decodeAwardEmojiPage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const data = decoded.success.data;
  const viewer = trimmed(data.currentUser?.username);
  const mergeRequest = data.project?.mergeRequest;
  const reactionsByNoteId = new Map<string, ReadonlyArray<PullRequestReaction>>();
  for (const node of mergeRequest?.notes?.nodes ?? []) {
    const id = noteIdOf(node?.id);
    if (id === null) continue;
    const reactions = toReactions(node?.awardEmoji, viewer);
    if (reactions.length > 0) reactionsByNoteId.set(id, reactions);
  }
  const pageInfo = mergeRequest?.notes?.pageInfo;
  return Result.succeed({
    reactions: toReactions(mergeRequest?.awardEmoji, viewer),
    reactionsByNoteId,
    nextCursor: pageInfo?.hasNextPage === true ? (trimmed(pageInfo.endCursor) ?? null) : null,
  });
}

const RawAwardSchema = Schema.Struct({
  id: Schema.Int,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(
    Schema.NullOr(Schema.Struct({ username: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

const decodeAward = Schema.decodeUnknownExit(RawAwardSchema);

export function decodeOwnAwardIdJson(
  raw: string,
  input: { readonly content: PullRequestReactionContent; readonly viewer: string },
): Result.Result<number | null, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const name = gitLabAwardName(input.content);
  for (const entry of decoded.success) {
    const award = decodeAward(entry);
    if (Exit.isFailure(award)) continue;
    const value = award.value;
    if (trimmed(value.name)?.toLowerCase() !== name) continue;
    if (trimmed(value.user?.username) !== input.viewer) continue;
    return Result.succeed(value.id);
  }
  return Result.succeed(null);
}

export const REPOSITORY_BLOBS_GRAPHQL_QUERY = `query($fullPath: ID!, $ref: String!, $paths: [String!]!) {
  project(fullPath: $fullPath) {
    repository {
      blobs(ref: $ref, paths: $paths) {
        nodes { path oid }
      }
    }
  }
}`;

const RawRepositoryBlobsSchema = Schema.Struct({
  data: Schema.Struct({
    project: Schema.NullOr(
      Schema.Struct({
        repository: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              blobs: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    nodes: Schema.optional(
                      Schema.NullOr(
                        Schema.Array(
                          Schema.NullOr(
                            Schema.Struct({
                              path: Schema.optional(Schema.NullOr(Schema.String)),
                              oid: Schema.optional(Schema.NullOr(Schema.String)),
                            }),
                          ),
                        ),
                      ),
                    ),
                  }),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  }),
});

const decodeRepositoryBlobs = decodeJsonResult(RawRepositoryBlobsSchema);

/** Null means unknown, not deleted; preserve viewed marks. */
export function decodeRepositoryBlobsJson(
  raw: string,
): Result.Result<ReadonlyMap<string, string> | null, DecodeFailure> {
  const decoded = decodeRepositoryBlobs(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const nodes = decoded.success.data.project?.repository?.blobs?.nodes;
  if (nodes === undefined || nodes === null) return Result.succeed(null);
  const blobs = new Map<string, string>();
  for (const node of nodes) {
    // Preserve path whitespace so blob-map keys match the caller's exact filenames.
    const path = node?.path;
    const oid = trimmed(node?.oid);
    if (path === undefined || path === null || path.length === 0 || oid === null) continue;
    blobs.set(path, oid);
  }
  return Result.succeed(blobs);
}

/**
 * Line counts for merge requests of one project. The REST listing carries no line counts, and
 * reading each diff to count them would cost a request per row, so GraphQL's per-merge-request
 * summary is asked for in one read instead.
 */
export const MERGE_REQUEST_STATS_GRAPHQL_QUERY = `query($fullPath: ID!, $iids: [String!]) {
  project(fullPath: $fullPath) {
    mergeRequests(iids: $iids, first: 100) {
      nodes { iid diffStatsSummary { additions deletions } }
    }
  }
}`;

const LineCountsSchema = Schema.Struct({ additions: Schema.Int, deletions: Schema.Int });

const RawMergeRequestStatsSchema = Schema.Struct({
  data: Schema.Struct({
    project: Schema.NullOr(
      Schema.Struct({
        mergeRequests: Schema.NullOr(
          Schema.Struct({
            nodes: Schema.Array(
              Schema.NullOr(
                Schema.Struct({
                  iid: Schema.String,
                  diffStatsSummary: Schema.NullOr(LineCountsSchema),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  }),
});

const decodeMergeRequestStats = decodeJsonResult(RawMergeRequestStatsSchema);

/**
 * The counts by merge request number. A merge request GitLab returned no summary for is left
 * out rather than counted as zero, so its row keeps whatever it already showed.
 */
export function decodeMergeRequestStatsJson(
  raw: string,
): Result.Result<
  ReadonlyMap<number, { readonly additions: number; readonly deletions: number }>,
  DecodeFailure
> {
  const decoded = decodeMergeRequestStats(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const stats = new Map<number, { readonly additions: number; readonly deletions: number }>();
  for (const node of decoded.success.data.project?.mergeRequests?.nodes ?? []) {
    const iid = Number(node?.iid);
    if (!Number.isSafeInteger(iid) || iid <= 0 || node?.diffStatsSummary == null) continue;
    stats.set(iid, node.diffStatsSummary);
  }
  return Result.succeed(stats);
}

/** Per-file line counts for one merge request, which the code/tests/generated breakdown sorts. */
export const MERGE_REQUEST_FILE_STATS_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      diffStatsSummary { fileCount }
      diffStats { path additions deletions }
    }
  }
}`;

const decodeMergeRequestFileStats = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      project: Schema.NullOr(
        Schema.Struct({
          mergeRequest: Schema.NullOr(
            Schema.Struct({
              diffStatsSummary: Schema.NullOr(Schema.Struct({ fileCount: Schema.Int })),
              diffStats: Schema.NullOr(
                Schema.Array(Schema.Struct({ path: Schema.String, ...LineCountsSchema.fields })),
              ),
            }),
          ),
        }),
      ),
    }),
  }),
);

/**
 * GitLab stops listing files past its diff limits while the summary still counts them all, so a
 * shorter list is reported as truncated rather than as a breakdown that misses lines.
 */
export function decodeMergeRequestFileStatsJson(raw: string): Result.Result<
  {
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly additions: number;
      readonly deletions: number;
    }>;
    readonly truncated: boolean;
  },
  DecodeFailure
> {
  const decoded = decodeMergeRequestFileStats(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const mergeRequest = decoded.success.data.project?.mergeRequest;
  const files = mergeRequest?.diffStats ?? [];
  const fileCount = mergeRequest?.diffStatsSummary?.fileCount;
  return Result.succeed({ files, truncated: fileCount === undefined || files.length < fileCount });
}
