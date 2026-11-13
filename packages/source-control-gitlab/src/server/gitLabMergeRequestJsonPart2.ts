import { trimOptionalString as trimmed } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestLabel,
  PullRequestMergeability,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestReviewThread,
  PullRequestReviewerCandidate,
  PullRequestState,
} from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
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

export const RawDiffSchema = Schema.Struct({
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

export function toActor(raw: Schema.Schema.Type<typeof RawUserSchema> | null | undefined) {
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

export const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));

const decodeMergeRequestEntry = Schema.decodeUnknownExit(RawMergeRequestSchema);

const decodeMergeRequest = decodeJsonResult(RawMergeRequestSchema);

const decodeTriggerJobEntry = Schema.decodeUnknownExit(RawTriggerJobSchema);

export const decodeNoteEntry = Schema.decodeUnknownExit(RawNoteSchema);

const decodeUserEntry = Schema.decodeUnknownExit(RawUserSchema);

export const decodeCommitEntry = Schema.decodeUnknownExit(RawCommitSchema);

export const decodeCommit = decodeJsonResult(RawCommitSchema);

export const decodeMergeRequestChanges = decodeJsonResult(
  Schema.Struct({
    changes: Schema.Array(Schema.Unknown),
    overflow: Schema.optional(Schema.Boolean),
    changes_count: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

export const decodeDiffEntry = Schema.decodeUnknownExit(RawDiffSchema);

const decodeDiscussionEntry = Schema.decodeUnknownExit(RawDiscussionSchema);

const decodeDiffRefs = decodeJsonResult(RawDiffRefsSchema);

const decodeViewer = decodeJsonResult(RawViewerSchema);

const decodeProjectMergeSettings = decodeJsonResult(RawProjectMergeSettingsSchema);

export type DecodeFailure = Cause.Cause<Schema.SchemaError>;

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
