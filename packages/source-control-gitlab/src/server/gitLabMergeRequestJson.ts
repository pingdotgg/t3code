import { trimOptionalString as trimmed } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestChecksState,
  PullRequestComment,
  PullRequestCommit,
  PullRequestLabel,
  PullRequestMergeability,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReferenceCandidate,
  PullRequestReviewDecision,
  PullRequestConversationThread,
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

const RawDiffRefs = Schema.Struct({
  base_sha: Schema.String,
  head_sha: Schema.String,
  start_sha: Schema.String,
});

const RawMergeRequestDiffRefs = Schema.Struct({
  base_sha: Schema.NullOr(Schema.String),
  head_sha: Schema.NullOr(Schema.String),
  start_sha: Schema.NullOr(Schema.String),
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
  source_project_id: Schema.optional(Schema.NullOr(Schema.Int)),
  target_project_id: Schema.optional(Schema.NullOr(Schema.Int)),
  /** Null on merge requests from the same project, where it means nothing. */
  allow_collaboration: Schema.optional(Schema.NullOr(Schema.Boolean)),
  diff_refs: Schema.optional(Schema.NullOr(RawMergeRequestDiffRefs)),
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
        base_sha: Schema.optional(Schema.NullOr(Schema.String)),
        start_sha: Schema.optional(Schema.NullOr(Schema.String)),
        head_sha: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const RawDiscussionSchema = Schema.Struct({
  id: Schema.String,
  notes: Schema.optional(Schema.NullOr(Schema.Array(RawDiscussionNoteSchema))),
});

const RawDiffRefsSchema = Schema.Struct({
  diff_refs: Schema.optional(Schema.NullOr(RawDiffRefs)),
});

const RawRevertTargetSchema = Schema.Struct({
  title: Schema.String,
  state: Schema.String,
  target_branch: Schema.String,
  merge_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
  squash_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
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
  /** Read only for a closed or merged merge request; absent on an open one. */
  readonly viewerCanDeleteBranch?: boolean;
  /** Set by the detail read, which asks GraphQL; REST carries no label permission. */
  readonly viewerCanEditLabels?: boolean;
  /** Every reviewer id, even one without a username to show, since writes replace the set. */
  readonly reviewerIds: ReadonlyArray<number>;
  /** The candidate list leads with these, since one page of project users need not reach them. */
  readonly reviewerUsers: ReadonlyArray<PullRequestActor & { readonly id: number }>;
  readonly autoMergeEnabled?: boolean;
  readonly autoMergeMethod?: PullRequestMergeMethod;
  /** Absent means not counted, not up to date. */
  readonly divergedCommits?: number;
  readonly headSha?: string;
  readonly diffRefs?: GitLabDiffRefs;
  /** On a fork the pipeline often belongs to the source project, not the target. */
  readonly headPipeline?: { readonly id: number; readonly projectId: number };
  /** Whether target maintainers may push to the source branch. Only set on merge requests from forks. */
  readonly maintainerCanModify?: boolean;
  readonly viewerCanEditMaintainerEdits?: boolean;
}

function toActor(raw: Schema.Schema.Type<typeof RawUserSchema> | null | undefined) {
  const login = trimmed(raw?.username);
  return login === null
    ? null
    : { login, name: trimmed(raw?.name), avatarUrl: trimmed(raw?.avatar_url) };
}

function toState(
  raw: Pick<Schema.Schema.Type<typeof RawMergeRequestSchema>, "state" | "merged_at">,
): PullRequestState {
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
  raw: Pick<Schema.Schema.Type<typeof RawMergeRequestSchema>, "has_conflicts" | "merge_status">,
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

export const PIPELINE_STAGES_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      headPipeline {
        path
        stages(first: 100) {
          nodes {
            name
            status
            detailedStatus { label detailsPath }
            jobs(first: 100) {
              nodes {
                name status allowFailure retried webPath detailedStatus { label }
                downstreamPipeline { status path }
              }
              pageInfo { hasNextPage }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    }
  }
}`;

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const RawStageJobSchema = Schema.Struct({
  name: OptionalString,
  status: OptionalString,
  allowFailure: Schema.optional(Schema.NullOr(Schema.Boolean)),
  retried: Schema.optional(Schema.NullOr(Schema.Boolean)),
  webPath: OptionalString,
  detailedStatus: Schema.optional(Schema.NullOr(Schema.Struct({ label: OptionalString }))),
  downstreamPipeline: Schema.optional(
    Schema.NullOr(Schema.Struct({ status: OptionalString, path: OptionalString })),
  ),
});

const RawStageSchema = Schema.Struct({
  name: OptionalString,
  status: OptionalString,
  detailedStatus: Schema.optional(
    Schema.NullOr(Schema.Struct({ label: OptionalString, detailsPath: OptionalString })),
  ),
  jobs: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(Schema.NullOr(RawStageJobSchema)),
        pageInfo: Schema.optional(
          Schema.NullOr(
            Schema.Struct({ hasNextPage: Schema.optional(Schema.NullOr(Schema.Boolean)) }),
          ),
        ),
      }),
    ),
  ),
});

const RawPipelineStagesSchema = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        project: Schema.NullOr(
          Schema.Struct({
            mergeRequest: Schema.NullOr(
              Schema.Struct({
                headPipeline: Schema.NullOr(
                  Schema.Struct({
                    path: OptionalString,
                    stages: Schema.optional(
                      Schema.NullOr(
                        Schema.Struct({
                          nodes: Schema.Array(Schema.NullOr(RawStageSchema)),
                          pageInfo: Schema.optional(
                            Schema.NullOr(
                              Schema.Struct({
                                hasNextPage: Schema.optional(Schema.NullOr(Schema.Boolean)),
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
        ),
      }),
    ),
  ),
});

const decodePipelineStages = decodeJsonResult(RawPipelineStagesSchema);

/**
 * The head pipeline as one check per job, named after its stage. A stage whose jobs GitLab did
 * not list whole stays one check with GitLab's stage status. Null where there are no stages to
 * show, or GitLab returned only some of them, so the caller keeps the single pipeline check.
 */
export function decodePipelineStageChecksJson(
  raw: string,
  origin: string,
): Result.Result<ReadonlyArray<PullRequestCheck> | null, DecodeFailure> {
  const decoded = decodePipelineStages(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const pipeline = decoded.success.data?.project?.mergeRequest?.headPipeline;
  // Any stage left out could be the failed one, so a partial list is no list.
  if (
    (decoded.success.errors?.length ?? 0) > 0 ||
    pipeline?.stages?.pageInfo?.hasNextPage === true ||
    pipeline?.stages?.nodes.some((stage) => stage === null || trimmed(stage.name) === null) === true
  ) {
    return Result.succeed(null);
  }
  const link = (path: string | null) => (path?.startsWith("/") ? `${origin}${path}` : null);
  const checks: Array<PullRequestCheck> = [];
  for (const stage of pipeline?.stages?.nodes ?? []) {
    const name = trimmed(stage?.name);
    if (stage === null || name === null) continue;
    const jobs = stage.jobs?.nodes ?? [];
    const listedWhole =
      jobs.length > 0 &&
      stage.jobs?.pageInfo?.hasNextPage !== true &&
      jobs.every((job) => job !== null && trimmed(job.name) !== null);
    if (!listedWhole) {
      checks.push({
        name,
        status: toPipelineStatus(stage.status),
        description: trimmed(stage.detailedStatus?.label),
        url: link(trimmed(stage.detailedStatus?.detailsPath) ?? trimmed(pipeline?.path)),
      });
      continue;
    }
    for (const job of jobs) {
      if (job === null || job.retried === true) continue;
      // A trigger job reads as its downstream pipeline, as `decodeTriggerJobChecksJson` explains.
      const downstream = job.downstreamPipeline;
      const status = toPipelineStatus(downstream ? downstream.status : job.status);
      checks.push({
        name: `${name} / ${trimmed(job.name)}`,
        // The same reading as `manual`: GitLab was told this failure does not fail the pipeline.
        status: status === "failure" && job.allowFailure === true ? "neutral" : status,
        description: downstream ? "Downstream pipeline" : trimmed(job.detailedStatus?.label),
        url: link(trimmed(downstream ? downstream.path : job.webPath)),
      });
    }
  }
  return Result.succeed(checks.length === 0 ? null : checks);
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
  const refs = raw.diff_refs;
  const diffRefs =
    refs && refs.base_sha !== null && refs.head_sha !== null && refs.start_sha !== null
      ? toDiffRefs({ base_sha: refs.base_sha, head_sha: refs.head_sha, start_sha: refs.start_sha })
      : null;
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
    reviewerUsers: (raw.reviewers ?? []).flatMap((reviewer) => {
      const actor = toActor(reviewer);
      return actor === null || reviewer.id === undefined ? [] : [{ ...actor, id: reviewer.id }];
    }),
    ...(autoMerge === undefined ? {} : { autoMergeEnabled: autoMerge }),
    ...(autoMerge === true && raw.squash_on_merge === true
      ? { autoMergeMethod: "squash" as const }
      : {}),
    ...(raw.diverged_commits_count == null ? {} : { divergedCommits: raw.diverged_commits_count }),
    ...(headSha === null ? {} : { headSha }),
    ...(diffRefs === null ? {} : { diffRefs }),
    ...(raw.head_pipeline?.id == null || raw.head_pipeline.project_id == null
      ? {}
      : { headPipeline: { id: raw.head_pipeline.id, projectId: raw.head_pipeline.project_id } }),
    ...(raw.source_project_id != null &&
    raw.target_project_id != null &&
    raw.source_project_id !== raw.target_project_id
      ? { maintainerCanModify: raw.allow_collaboration === true }
      : {}),
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
const decodeRevertTarget = decodeJsonResult(RawRevertTargetSchema);
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

const RawReferenceSchema = Schema.Struct({
  iid: Schema.Number,
  title: Schema.String,
  state: Schema.String,
});
const decodeReferenceEntry = Schema.decodeUnknownExit(RawReferenceSchema);

/** A list of issues (`#`) or merge requests (`!`), as composers reference them. */
export function decodeReferenceCandidatesJson(
  raw: string,
  kind: PullRequestReferenceCandidate["kind"],
): Result.Result<
  { readonly items: ReadonlyArray<PullRequestReferenceCandidate>; readonly rawCount: number },
  DecodeFailure
> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const items: PullRequestReferenceCandidate[] = [];
  for (const entry of decoded.success) {
    const reference = decodeReferenceEntry(entry);
    if (Exit.isFailure(reference) || !Number.isInteger(reference.value.iid)) continue;
    if (reference.value.iid < 1) continue;
    const { iid, title, state } = reference.value;
    items.push({
      reference: `${kind === "issue" ? "#" : "!"}${iid}`,
      kind,
      number: iid,
      title,
      state: state === "merged" ? "merged" : state === "opened" ? "open" : "closed",
    });
  }
  return Result.succeed({ items, rawCount: decoded.success.length });
}

const RawLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  archived: Schema.optional(Schema.Boolean),
});
const decodeLabelEntry = Schema.decodeUnknownExit(RawLabelSchema);
const decodeLabel = decodeJsonResult(RawLabelSchema);

export function decodeLabelNameJson(raw: string): Result.Result<string | null, DecodeFailure> {
  return Result.map(decodeLabel(raw), (label) => trimmed(label.name));
}

export interface GitLabProjectLabel extends PullRequestLabel {
  readonly description: string | null;
  readonly archived: boolean;
}

export interface GitLabProjectLabels {
  readonly labels: ReadonlyArray<GitLabProjectLabel>;
  readonly rawCount: number;
}

export function decodeProjectLabelsJson(
  raw: string,
): Result.Result<GitLabProjectLabels, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const labels: GitLabProjectLabel[] = [];
  for (const entry of decoded.success) {
    const label = decodeLabelEntry(entry);
    if (Exit.isFailure(label)) continue;
    const name = trimmed(label.value.name);
    if (name !== null) {
      labels.push({
        name,
        color: trimmed(label.value.color),
        description: trimmed(label.value.description),
        archived: label.value.archived === true,
      });
    }
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
  readonly threads: ReadonlyArray<PullRequestConversationThread>;
  /** GitLab moves a thread onto each new diff that still has its line; this is the last one. */
  readonly diffRefsByThreadId: ReadonlyMap<string, GitLabDiffRefs>;
  /** First notes of unresolved discussions on the MR itself rather than a diff line. */
  readonly overviewFindingIds: ReadonlyArray<string>;
  readonly rawCount: number;
}

function toDiffRefs(raw: Schema.Schema.Type<typeof RawDiffRefs>): GitLabDiffRefs {
  return { baseSha: raw.base_sha, headSha: raw.head_sha, startSha: raw.start_sha };
}

export function decodeDiscussionsJson(
  raw: string,
): Result.Result<GitLabDiscussions, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const threads: PullRequestConversationThread[] = [];
  const diffRefsByThreadId = new Map<string, GitLabDiffRefs>();
  const overviewFindingIds: string[] = [];
  for (const entry of decoded.success) {
    const discussion = decodeDiscussionEntry(entry);
    if (!Exit.isSuccess(discussion)) continue;
    const notes = (discussion.value.notes ?? []).filter((note) => note.system !== true);
    const root = notes[0];
    if (root === undefined) continue;
    const comments = notes.map((note) => ({
      id: String(note.id),
      author: toActor(note.author),
      body: note.body ?? "",
      createdAt: note.created_at,
      url: null,
    }));
    const position = root.position;
    if (!position) {
      // A thread started on the overview: resolvable, unlike a single comment.
      if (root.resolvable !== true) continue;
      if (root.resolved !== true) overviewFindingIds.push(String(root.id));
      threads.push({
        id: discussion.value.id,
        path: null,
        line: null,
        side: "right",
        isResolved: root.resolved === true,
        isOutdated: false,
        comments,
      });
      continue;
    }
    let side: "left" | "right";
    let path: string | null;
    let line: number | null | undefined;
    if (position.position_type === "text") {
      side = position.new_line === null || position.new_line === undefined ? "left" : "right";
      path = trimmed(side === "left" ? position.old_path : position.new_path);
      line = side === "left" ? position.old_line : position.new_line;
    } else if (position.position_type === "file" || position.position_type === "image") {
      side = "right";
      path = trimmed(position.new_path) ?? trimmed(position.old_path);
      line = null;
    } else {
      continue;
    }
    if (path === null) continue;
    if (position.base_sha && position.start_sha && position.head_sha) {
      diffRefsByThreadId.set(discussion.value.id, {
        baseSha: position.base_sha,
        startSha: position.start_sha,
        headSha: position.head_sha,
      });
    }
    threads.push({
      id: discussion.value.id,
      path,
      line: typeof line === "number" && line > 0 ? line : null,
      side,
      isResolved: root.resolved === true,
      isOutdated: false,
      comments,
    });
  }
  return Result.succeed({
    threads,
    diffRefsByThreadId,
    overviewFindingIds,
    rawCount: decoded.success.length,
  });
}

export function decodeDiffRefsJson(
  raw: string,
): Result.Result<GitLabDiffRefs | null, DecodeFailure> {
  const decoded = decodeDiffRefs(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const refs = decoded.success.diff_refs;
  return Result.succeed(refs ? toDiffRefs(refs) : null);
}

export interface GitLabRevertTarget {
  readonly merged: boolean;
  readonly title: string;
  readonly targetBranch: string;
  /** Null for a fast-forward merge without squash, which records neither SHA. */
  readonly commitSha: string | null;
}

export function decodeRevertTargetJson(
  raw: string,
): Result.Result<GitLabRevertTarget, DecodeFailure> {
  const decoded = decodeRevertTarget(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const mr = decoded.success;
  return Result.succeed({
    merged: mr.state === "merged",
    title: mr.title,
    targetBranch: mr.target_branch,
    commitSha: trimmed(mr.merge_commit_sha) ?? trimmed(mr.squash_commit_sha),
  });
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
            // GitLab has no similarity score; Pierre needs this header to keep the rename.
            `similarity index ${hunks.length > 0 || value.too_large === true || value.collapsed === true ? 0 : 100}%`,
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
        nodes { id author { username bot } lastEditedAt lastEditedBy { username } resolved awardEmoji { nodes { name user { username } } } }
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
                        lastEditedAt: Schema.optional(Schema.NullOr(Schema.String)),
                        lastEditedBy: Schema.optional(
                          Schema.NullOr(
                            Schema.Struct({
                              username: Schema.optional(Schema.NullOr(Schema.String)),
                            }),
                          ),
                        ),
                        resolved: Schema.optional(Schema.NullOr(Schema.Boolean)),
                        // REST note authors carry no bot flag; GraphQL's does.
                        author: Schema.optional(
                          Schema.NullOr(
                            Schema.Struct({
                              username: Schema.optional(Schema.NullOr(Schema.String)),
                              bot: Schema.optional(Schema.NullOr(Schema.Boolean)),
                            }),
                          ),
                        ),
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
  readonly editedAtByNoteId: ReadonlyMap<string, string>;
  readonly botLogins: ReadonlySet<string>;
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
  const editedAtByNoteId = new Map<string, string>();
  const botLogins = new Set<string>();
  for (const node of mergeRequest?.notes?.nodes ?? []) {
    const author = trimmed(node?.author?.username);
    if (author !== null && node?.author?.bot === true) botLogins.add(author);
    const id = noteIdOf(node?.id);
    if (id === null) continue;
    const reactions = toReactions(node?.awardEmoji, viewer);
    if (reactions.length > 0) reactionsByNoteId.set(id, reactions);
    // Resolving a thread moves lastEditedAt on every note in it; only lastEditedBy marks a
    // text edit, and a resolved note's stamp may be the resolve rather than that edit.
    const editedAt = trimmed(node?.lastEditedAt);
    if (
      editedAt !== null &&
      trimmed(node?.lastEditedBy?.username) !== null &&
      node?.resolved !== true
    ) {
      editedAtByNoteId.set(id, editedAt);
    }
  }
  const pageInfo = mergeRequest?.notes?.pageInfo;
  return Result.succeed({
    reactions: toReactions(mergeRequest?.awardEmoji, viewer),
    reactionsByNoteId,
    editedAtByNoteId,
    botLogins,
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

export const SOURCE_BRANCH_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      state sourceBranch diffHeadSha
      sourceProject { fullPath }
      userPermissions { removeSourceBranch }
    }
  }
}`;

const RawSourceBranchSchema = Schema.Struct({
  data: Schema.Struct({
    project: Schema.NullOr(
      Schema.Struct({
        mergeRequest: Schema.NullOr(
          Schema.Struct({
            state: Schema.String,
            sourceBranch: Schema.String,
            diffHeadSha: Schema.optional(Schema.NullOr(Schema.String)),
            sourceProject: Schema.optional(
              Schema.NullOr(Schema.Struct({ fullPath: Schema.String })),
            ),
            userPermissions: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  removeSourceBranch: Schema.optional(Schema.NullOr(Schema.Boolean)),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  }),
});

const decodeSourceBranch = decodeJsonResult(RawSourceBranchSchema);

export interface GitLabSourceBranch {
  readonly open: boolean;
  readonly branch: string;
  readonly headSha: string | null;
  /** Null when the source project is gone or hidden from the viewer, as a deleted fork is. */
  readonly sourceProject: string | null;
  /** GitLab's own answer: false once the branch is gone, protected, or out of the viewer's reach. */
  readonly canDelete: boolean;
}

export function decodeSourceBranchJson(
  raw: string,
): Result.Result<GitLabSourceBranch | null, DecodeFailure> {
  return Result.map(decodeSourceBranch(raw), (decoded) => {
    const mergeRequest = decoded.data.project?.mergeRequest;
    if (mergeRequest == null) return null;
    return {
      // `locked` is GitLab's transient state while a merge runs, so only these two are settled.
      open: mergeRequest.state !== "merged" && mergeRequest.state !== "closed",
      branch: mergeRequest.sourceBranch,
      headSha: trimmed(mergeRequest.diffHeadSha),
      sourceProject: mergeRequest.sourceProject?.fullPath ?? null,
      canDelete: mergeRequest.userPermissions?.removeSourceBranch === true,
    };
  });
}

const decodeBranch = decodeJsonResult(
  Schema.Struct({
    default: Schema.optional(Schema.NullOr(Schema.Boolean)),
    commit: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          id: Schema.String,
          authored_date: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  }),
);

export function decodeBranchJson(raw: string): Result.Result<
  {
    readonly isDefault: boolean;
    readonly headSha: string | null;
    readonly headAuthoredDate: string | null;
  },
  DecodeFailure
> {
  return Result.map(decodeBranch(raw), (branch) => ({
    isDefault: branch.default === true,
    headSha: trimmed(branch.commit?.id),
    headAuthoredDate: trimmed(branch.commit?.authored_date),
  }));
}

export const MERGE_MESSAGES_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) { title squashOnMerge defaultMergeCommitMessage defaultSquashCommitMessage }
  }
}`;

const RawMergeMessagesSchema = Schema.Struct({
  // A field that errored reads as null, which must not pass for an absent template.
  errors: Schema.optionalKey(Schema.Never),
  data: Schema.Struct({
    project: Schema.NullOr(
      Schema.Struct({
        mergeRequest: Schema.NullOr(
          Schema.Struct({
            title: Schema.optional(Schema.NullOr(Schema.String)),
            squashOnMerge: Schema.optional(Schema.NullOr(Schema.Boolean)),
            defaultMergeCommitMessage: Schema.optional(Schema.NullOr(Schema.String)),
            defaultSquashCommitMessage: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      }),
    ),
  }),
});

const decodeMergeMessages = decodeJsonResult(RawMergeMessagesSchema);

export interface GitLabMergeMessages {
  readonly title: string | null;
  readonly merge: string | null;
  readonly squash: string | null;
  /** GitLab squashes when the project always does or the merge request asks to. */
  readonly squashOnMerge: boolean;
}

/** The messages GitLab would write from the project's merge and squash templates. */
export function decodeMergeMessagesJson(
  raw: string,
): Result.Result<GitLabMergeMessages, DecodeFailure> {
  return Result.map(decodeMergeMessages(raw), (decoded) => {
    const mergeRequest = decoded.data.project?.mergeRequest;
    return {
      title: mergeRequest?.title ?? null,
      merge: mergeRequest?.defaultMergeCommitMessage ?? null,
      squash: mergeRequest?.defaultSquashCommitMessage ?? null,
      squashOnMerge: mergeRequest?.squashOnMerge === true,
    };
  });
}

/** What a listed merge request needs beyond REST: its approval, reviewer and pipeline state. */
const LIST_STATE_GRAPHQL_FIELDS = `iid approved approvedBy(first: 1) { nodes { username } }
  reviewers(first: 20) { nodes { username mergeRequestInteraction { reviewState } } }
  headPipeline { status }`;

export const LIST_STATES_GRAPHQL_QUERY = `query($fullPath: ID!, $iids: [String!]) {
  metadata { enterprise }
  project(fullPath: $fullPath) {
    mergeRequests(iids: $iids, first: 100) {
      nodes { ${LIST_STATE_GRAPHQL_FIELDS} }
    }
  }
}`;

const RawMetadataSchema = Schema.optional(
  Schema.NullOr(Schema.Struct({ enterprise: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
);

const RawListStateFields = {
  iid: Schema.String,
  approved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  approvedBy: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
      }),
    ),
  ),
  reviewers: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(
          Schema.NullOr(
            Schema.Array(
              Schema.NullOr(
                Schema.Struct({
                  username: Schema.optional(Schema.NullOr(Schema.String)),
                  mergeRequestInteraction: Schema.optional(
                    Schema.NullOr(
                      Schema.Struct({ reviewState: Schema.optional(Schema.NullOr(Schema.String)) }),
                    ),
                  ),
                }),
              ),
            ),
          ),
        ),
      }),
    ),
  ),
  headPipeline: Schema.optional(
    Schema.NullOr(Schema.Struct({ status: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
};

const RawListStateNodeSchema = Schema.Struct(RawListStateFields);

const RawListStatesSchema = Schema.Struct({
  data: Schema.Struct({
    metadata: RawMetadataSchema,
    project: Schema.NullOr(
      Schema.Struct({
        mergeRequests: Schema.optional(
          Schema.NullOr(
            Schema.Struct({ nodes: Schema.Array(Schema.NullOr(RawListStateNodeSchema)) }),
          ),
        ),
      }),
    ),
  }),
});

const decodeListStates = decodeJsonResult(RawListStatesSchema);

export interface GitLabMergeRequestListState {
  /** Absent when the approval state can't be judged. */
  readonly reviewDecision?: PullRequestReviewDecision | null;
  readonly checksState: PullRequestChecksState | null;
}

function toChecksState(pipelineStatus: string | null | undefined): PullRequestChecksState | null {
  if (pipelineStatus == null) return null;
  switch (toPipelineStatus(pipelineStatus)) {
    case "success":
      return "passing";
    case "failure":
    case "cancelled":
      return "failing";
    case "pending":
      return "pending";
    default:
      return null;
  }
}

/**
 * Only Enterprise Edition holds `approved` to the project's approval rules, so an unapproved
 * merge request there still needs review even when someone, such as a bot, approved it.
 * Community Edition reports `approved` once anyone approves and requires no review.
 * A reviewer asking for changes outranks both, as it does on GitHub.
 */
function toListState(
  node: typeof RawListStateNodeSchema.Type,
  enterprise: boolean | null | undefined,
): GitLabMergeRequestListState {
  const checksState = toChecksState(node.headPipeline?.status);
  if (
    node.reviewers?.nodes?.some(
      (reviewer) => reviewer?.mergeRequestInteraction?.reviewState === "REQUESTED_CHANGES",
    )
  ) {
    return { reviewDecision: "changes-requested", checksState };
  }
  const approvals = node.approvedBy?.nodes?.length;
  if (
    node.approved == null ||
    approvals === undefined ||
    (node.approved === false && approvals === 0 && enterprise == null)
  ) {
    return { checksState };
  }
  return {
    reviewDecision:
      node.approved === false && (enterprise || approvals > 0)
        ? "review-required"
        : approvals > 0
          ? "approved"
          : null,
    checksState,
  };
}

export function decodeListStatesJson(
  raw: string,
): Result.Result<ReadonlyMap<number, GitLabMergeRequestListState>, DecodeFailure> {
  const decoded = decodeListStates(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const enterprise = decoded.success.data.metadata?.enterprise;
  const states = new Map<number, GitLabMergeRequestListState>();
  for (const node of decoded.success.data.project?.mergeRequests?.nodes ?? []) {
    const number = Number(node?.iid);
    if (node === null || !Number.isSafeInteger(number)) continue;
    states.set(number, toListState(node, enterprise));
  }
  return Result.succeed(states);
}

/** The fields a listed merge request needs, so one GraphQL read stands in for REST and states. */
export const LIST_ITEM_GRAPHQL_FIELDS = `${LIST_STATE_GRAPHQL_FIELDS}
  title webUrl state draft createdAt updatedAt mergedAt sourceBranch targetBranch
  conflicts mergeStatusEnum author { username name avatarUrl } labels(first: 100) { nodes { title } }`;

const RawGraphqlListNodeSchema = Schema.Struct({
  ...RawListStateFields,
  title: Schema.String,
  webUrl: Schema.String,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  sourceBranch: Schema.String,
  targetBranch: Schema.String,
  conflicts: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeStatusEnum: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        username: Schema.optional(Schema.NullOr(Schema.String)),
        name: Schema.optional(Schema.NullOr(Schema.String)),
        avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(
          Schema.NullOr(Schema.Array(Schema.NullOr(Schema.Struct({ title: Schema.String })))),
        ),
      }),
    ),
  ),
});

// GitLab answers `project: null` for a project the reader cannot see, which REST reports as an error.
const RawGraphqlListSchema = Schema.Struct({
  data: Schema.Struct({
    metadata: RawMetadataSchema,
    project: Schema.Struct({
      mergeRequests: Schema.Struct({
        pageInfo: Schema.Struct({
          hasNextPage: Schema.Boolean,
          endCursor: Schema.optional(Schema.NullOr(Schema.String)),
        }),
        nodes: Schema.Array(Schema.Unknown),
      }),
    }),
  }),
});

const decodeGraphqlList = decodeJsonResult(RawGraphqlListSchema);
const decodeGraphqlListNode = Schema.decodeUnknownExit(RawGraphqlListNodeSchema);

export interface GitLabMergeRequestGraphqlPage {
  readonly items: ReadonlyArray<GitLabMergeRequestListItem>;
  readonly states: ReadonlyMap<number, GitLabMergeRequestListState>;
  /** Count before decoding, so a page of rows that fail to decode still moves on. */
  readonly rawCount: number;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export function decodeMergeRequestGraphqlListJson(
  raw: string,
): Result.Result<GitLabMergeRequestGraphqlPage, DecodeFailure> {
  const decoded = decodeGraphqlList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const page = decoded.success.data.project.mergeRequests;
  const enterprise = decoded.success.data.metadata?.enterprise;
  const items: GitLabMergeRequestListItem[] = [];
  const states = new Map<number, GitLabMergeRequestListState>();
  for (const entry of page.nodes) {
    const exit = decodeGraphqlListNode(entry);
    if (!Exit.isSuccess(exit)) continue;
    const node = exit.value;
    const number = Number(node.iid);
    if (!Number.isSafeInteger(number)) continue;
    items.push({
      number,
      title: node.title,
      url: node.webUrl,
      author: toActor(
        node.author == null
          ? null
          : {
              username: node.author.username ?? "",
              name: node.author.name,
              avatar_url: node.author.avatarUrl,
            },
      ),
      headBranch: node.sourceBranch,
      baseBranch: node.targetBranch,
      state: toState({ state: node.state, merged_at: node.mergedAt }),
      isDraft: node.draft ?? false,
      mergeability: toMergeability({
        has_conflicts: node.conflicts,
        merge_status: node.mergeStatusEnum,
      }),
      additions: 0,
      deletions: 0,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      reviewRequestLogins: (node.reviewers?.nodes ?? []).flatMap((reviewer) => {
        const login = trimmed(reviewer?.username);
        return login === null ? [] : [login];
      }),
      labels: toLabels((node.labels?.nodes ?? []).flatMap((label) => (label ? [label.title] : []))),
    });
    states.set(number, toListState(node, enterprise));
  }
  return Result.succeed({
    items,
    states,
    rawCount: page.nodes.length,
    hasNextPage: page.pageInfo.hasNextPage,
    endCursor: trimmed(page.pageInfo.endCursor),
  });
}

export const SERVER_VERSION_GRAPHQL_QUERY = "{ metadata { version } }";

const decodeServerVersion = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      metadata: Schema.optional(
        Schema.NullOr(Schema.Struct({ version: Schema.optional(Schema.NullOr(Schema.String)) })),
      ),
    }),
  }),
);

/**
 * Whether the GraphQL merge request list takes every filter the REST list does: `search` came
 * last, in 17.9. An instance that hides its version keeps REST.
 */
export function decodeGraphqlListSupportJson(raw: string): Result.Result<boolean, DecodeFailure> {
  const decoded = decodeServerVersion(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const match = /^(\d+)\.(\d+)/u.exec(decoded.success.data.metadata?.version?.trim() ?? "");
  if (match === null) return Result.succeed(false);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Result.succeed(major > 17 || (major === 17 && minor >= 9));
}

const decodeMutationPayloads = decodeJsonResult(
  Schema.Struct({
    data: Schema.Record(
      Schema.String,
      Schema.NullOr(
        Schema.Struct({ errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))) }),
      ),
    ),
  }),
);

/** GitLab answers a refused mutation with HTTP 200 and the reasons in each payload's `errors`. */
export function decodeMutationErrorsJson(
  raw: string,
): Result.Result<ReadonlyArray<string>, DecodeFailure> {
  const decoded = decodeMutationPayloads(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  return Result.succeed(
    Object.values(decoded.success.data).flatMap((payload) => payload?.errors ?? []),
  );
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

/** GitLab lets whoever may change a merge request's metadata set its labels. */
export const LABEL_PERMISSION_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      userPermissions { adminMergeRequest }
    }
  }
}`;

const decodeLabelPermission = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      project: Schema.NullOr(
        Schema.Struct({
          mergeRequest: Schema.NullOr(
            Schema.Struct({
              userPermissions: Schema.Struct({ adminMergeRequest: Schema.Boolean }),
            }),
          ),
        }),
      ),
    }),
  }),
);

export function decodeLabelPermissionJson(raw: string): Result.Result<boolean, DecodeFailure> {
  const decoded = decodeLabelPermission(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(
        decoded.success.data.project?.mergeRequest?.userPermissions.adminMergeRequest === true,
      )
    : Result.fail(decoded.failure);
}

/**
 * GitLab lets whoever can push to a fork's branch allow maintainer pushes, but once allowed the
 * target's maintainers can push too, so only the author may change it, as on GitHub. GitLab
 * drops the setting unless the source branch is unprotected and neither project is private
 * (`MergeRequest#collaborative_push_possible?`).
 */
export const MAINTAINER_EDITS_PERMISSION_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!) {
  currentUser { username }
  project(fullPath: $fullPath) {
    visibility
    mergeRequest(iid: $iid) {
      author { username }
      userPermissions { pushToSourceBranch }
      sourceBranchProtected
      sourceProject { visibility }
    }
  }
}`;

const decodeMaintainerEditsPermission = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      currentUser: Schema.NullOr(Schema.Struct({ username: Schema.String })),
      project: Schema.NullOr(
        Schema.Struct({
          visibility: Schema.NullOr(Schema.String),
          mergeRequest: Schema.NullOr(
            Schema.Struct({
              author: Schema.NullOr(Schema.Struct({ username: Schema.String })),
              userPermissions: Schema.Struct({ pushToSourceBranch: Schema.Boolean }),
              sourceBranchProtected: Schema.Boolean,
              sourceProject: Schema.NullOr(
                Schema.Struct({ visibility: Schema.NullOr(Schema.String) }),
              ),
            }),
          ),
        }),
      ),
    }),
  }),
);

export function decodeMaintainerEditsPermissionJson(
  raw: string,
): Result.Result<boolean, DecodeFailure> {
  const decoded = decodeMaintainerEditsPermission(raw);
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
  const { currentUser, project } = decoded.success.data;
  const mergeRequest = project?.mergeRequest;
  const isPublicOrInternal = (visibility: string | null | undefined) =>
    visibility === "public" || visibility === "internal";
  return Result.succeed(
    currentUser !== null &&
      mergeRequest?.author?.username === currentUser.username &&
      mergeRequest.userPermissions.pushToSourceBranch &&
      !mergeRequest.sourceBranchProtected &&
      isPublicOrInternal(project?.visibility) &&
      isPublicOrInternal(mergeRequest.sourceProject?.visibility),
  );
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
