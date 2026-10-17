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

/**
 * GitLab's REST enums are decoded as plain strings and normalized here: a GitLab release that
 * adds a pipeline status or a merge status must not fail the whole payload.
 */
const RawUserSchema = Schema.Struct({
  id: Schema.optional(Schema.Int),
  username: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawPipelineSchema = Schema.Struct({
  status: Schema.optional(Schema.NullOr(Schema.String)),
  web_url: Schema.optional(Schema.NullOr(Schema.String)),
  source: Schema.optional(Schema.NullOr(Schema.String)),
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
  // A string, and "1000+" past GitLab's counting limit, so it is parsed rather than decoded.
  changes_count: Schema.optional(Schema.NullOr(Schema.String)),
  head_pipeline: Schema.optional(Schema.NullOr(RawPipelineSchema)),
  user: Schema.optional(
    Schema.NullOr(Schema.Struct({ can_merge: Schema.optional(Schema.Boolean) })),
  ),
  merge_when_pipeline_succeeds: Schema.optional(Schema.NullOr(Schema.Boolean)),
  auto_merge_enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  squash_on_merge: Schema.optional(Schema.NullOr(Schema.Boolean)),
  squash: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /**
   * It costs a walk of the two branches, so GitLab withholds it unless
   * `include_diverged_commits_count` asks for it, and answers it only for a single merge
   * request — a list never carries it, however it is asked for.
   */
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

const RawProjectPathSchema = Schema.Struct({ path_with_namespace: TrimmedNonEmptyString });

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
  /**
   * Absent where GitLab did not count, which is not the same as a branch that has nothing behind
   * it: an install too old to answer must not be read as saying the branch is current.
   */
  readonly divergedCommits?: number;
  readonly headSha?: string;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
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
    case "cancelling":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "manual":
    case "scheduled":
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
  };
}

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeMergeRequestEntry = Schema.decodeUnknownExit(RawMergeRequestSchema);
const decodeMergeRequest = decodeJsonResult(RawMergeRequestSchema);
const decodeNoteEntry = Schema.decodeUnknownExit(RawNoteSchema);
const decodeUserEntry = Schema.decodeUnknownExit(RawUserSchema);
const decodeCommitEntry = Schema.decodeUnknownExit(RawCommitSchema);
const decodeCommit = decodeJsonResult(RawCommitSchema);
const decodeDiffEntry = Schema.decodeUnknownExit(RawDiffSchema);
const decodeDiscussionEntry = Schema.decodeUnknownExit(RawDiscussionSchema);
const decodeDiffRefs = decodeJsonResult(RawDiffRefsSchema);
const decodeViewer = decodeJsonResult(RawViewerSchema);
const decodeProjectMergeSettings = decodeJsonResult(RawProjectMergeSettingsSchema);
const decodeProjectPath = decodeJsonResult(RawProjectPathSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface GitLabProjectUsers {
  readonly candidates: ReadonlyArray<PullRequestReviewerCandidate>;
  /** Rows GitLab returned, counted before decoding, so a skipped row cannot hide a next page. */
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

export function decodeViewerJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeViewer(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.username))
    : Result.fail(decoded.failure);
}

export function decodeProjectPathJson(raw: string): Result.Result<string, DecodeFailure> {
  const decoded = decodeProjectPath(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success.path_with_namespace)
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
  const sections: string[] = [];
  let truncated = false;
  for (const entry of decoded.success) {
    const file = decodeDiffEntry(entry);
    if (Exit.isFailure(file)) continue;
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
  return Result.succeed({
    patch: sections.join("\n"),
    truncated,
    rawCount: decoded.success.length,
  });
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

/**
 * Blob ids by path, or null where GitLab did not answer the query at all (a project the token
 * cannot see, or a repository with no blobs connection). That case must be told apart from an
 * empty answer: read as "the revision has none of these files", it would report every cleared
 * file as changed again.
 */
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
    // Not trimmed, unlike everything else read out of this payload: a leading or trailing space
    // is a legal part of a file's name, and trimming it would key this map under a name the
    // caller's asked-for path never matches.
    const path = node?.path;
    const oid = trimmed(node?.oid);
    if (path === undefined || path === null || path.length === 0 || oid === null) continue;
    blobs.set(path, oid);
  }
  return Result.succeed(blobs);
}
