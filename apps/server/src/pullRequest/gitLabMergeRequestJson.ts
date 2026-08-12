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
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewThread,
  PullRequestReviewerCandidate,
  PullRequestState,
} from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

/**
 * GitLab's REST enums are decoded as plain strings and normalized here: a GitLab release that
 * adds a pipeline status or a merge status must not fail the whole payload.
 */
const RawUserSchema = Schema.Struct({
  /**
   * GitLab writes a merge request's reviewers as numeric ids and takes no usernames there, so the
   * id is carried alongside the handle rather than looked up again when a review is asked for.
   */
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
  /**
   * What the requesting account may do, which only the single-merge-request endpoint carries.
   * GitLab answers `can_merge` for this viewer against this merge request, so it already accounts
   * for the role, the approval rules and a protected target branch — none of which a project's
   * access level on its own would tell apart.
   */
  user: Schema.optional(
    Schema.NullOr(Schema.Struct({ can_merge: Schema.optional(Schema.Boolean) })),
  ),
  /**
   * Whether GitLab is holding this merge request to merge it once its pipeline goes green.
   * `merge_when_pipeline_succeeds` is the field every version answers with; newer ones also
   * carry `auto_merge_enabled`, which is the same fact under the name GitLab settled on, so
   * either one saying yes is a yes.
   */
  merge_when_pipeline_succeeds: Schema.optional(Schema.NullOr(Schema.Boolean)),
  auto_merge_enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /**
   * How far the target branch has moved on since this one left it, which is the same number
   * GitLab's own "out of date" wording counts. It costs a walk of the two branches, so GitLab
   * withholds it unless `include_diverged_commits_count` asks for it, and answers it only for a
   * single merge request — a list never carries it, however it is asked for.
   */
  diverged_commits_count: Schema.optional(Schema.NullOr(Schema.Int)),
});

const RawNoteSchema = Schema.Struct({
  id: Schema.Int,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawUserSchema)),
  created_at: Schema.String,
  /** True for notes GitLab writes itself ("assigned to…"), which are events, not comments. */
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

/**
 * A discussion note carrying its place in the diff, which is the shape the whole thread view
 * is built from. `resolved` lives on the note rather than on the discussion: GitLab calls a
 * discussion resolved once every resolvable note in it is.
 */
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
  /** GitLab omits the hunks for a file it considers too large to inline. */
  too_large: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /** And for one it collapsed, which withholds them the same way. */
  collapsed: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const RawViewerSchema = Schema.Struct({
  username: Schema.optional(Schema.NullOr(Schema.String)),
});

/** A GitLab project settles on one merge strategy plus an optional squash. */
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
  /**
   * GitLab reports neither added nor removed lines on a merge request, so both stay zero and
   * the surface omits the stat. The Code tab counts them from the patch it already fetched.
   */
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
  /** False only where GitLab said so; an answer without the field leaves merging permitted. */
  readonly viewerCanMerge: boolean;
  /** The reviewers as GitLab addresses them, which is what writing the set back takes. */
  readonly reviewerIds: ReadonlyArray<number>;
  /** Absent where GitLab named neither auto-merge field, which is not the same as off. */
  readonly autoMergeEnabled?: boolean;
  /**
   * Absent where GitLab did not count, which is not the same as a branch that has nothing behind
   * it: an install too old to answer must not be read as saying the branch is current.
   */
  readonly divergedCommits?: number;
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
      // `locked` is an open merge request whose discussion is locked.
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
      // `unchecked` and `checking` mean GitLab has not finished the merge check yet.
      return "unknown";
  }
}

function toLabels(raw: ReadonlyArray<string> | null | undefined): ReadonlyArray<PullRequestLabel> {
  // GitLab returns label names only, so there is no colour to carry.
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label);
    return name === null ? [] : [{ name, color: null }];
  });
}

/**
 * "3" for a counted change set, "1000+" once GitLab gives up counting. The leading number is
 * the floor either way, which reads better than dropping an uncounted change set to nothing.
 */
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
    // A pipeline waiting on a person is not progress, and it is not a failure either.
    case "manual":
    case "scheduled":
      return "neutral";
    default:
      return "pending";
  }
}

/**
 * GitLab has no per-job check list on a merge request, so its pipeline is reported as the one
 * check. The jobs behind it stay one click away through the pipeline URL.
 */
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
    // Built from the reviewers themselves rather than from their logins, so the avatars survive.
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
    ...(raw.diverged_commits_count == null ? {} : { divergedCommits: raw.diverged_commits_count }),
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

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface GitLabProjectUsers {
  readonly candidates: ReadonlyArray<PullRequestReviewerCandidate>;
  /** Rows GitLab returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
}

export interface GitLabMergeRequestListBatch {
  readonly items: ReadonlyArray<GitLabMergeRequestListItem>;
  /** Zero-based positions of the decoded items in GitLab's raw page. */
  readonly rawIndexes: ReadonlyArray<number>;
  /** Rows GitLab returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
}

/** Malformed entries are skipped rather than failing the batch: one unexpected merge request
 *  must not blank the whole list. */
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

/**
 * The people with access to the project, which `GET /projects/:id/users` answers with — the same
 * list GitLab's own reviewer field is filled from, including the members a group above the project
 * lends it. A malformed row is skipped rather than failing the menu it belongs to.
 *
 * Nobody is marked requested here: who has been asked lives on the merge request, and only the
 * caller holds both.
 */
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

/**
 * GitLab settles the strategy per project rather than offering all three per merge request:
 * `merge_method` picks one of merge commit, semi-linear or fast-forward, and squashing is a
 * separate switch. An unrecognized setting offers nothing rather than offering a strategy the
 * project forbids.
 */
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
    // Both semi-linear and fast-forward histories are reached by rebasing onto the target.
    rebase: mergeMethod === "rebase_merge" || mergeMethod === "ff",
    // Only GitLab's own enabling values. An absent or unrecognized setting offers nothing,
    // rather than offering a squash the project may forbid.
    squash:
      squashOption === "always" || squashOption === "default_on" || squashOption === "default_off",
  });
}

/**
 * Comments only. System notes are GitLab's own activity feed entries, and a `DiffNote` is the
 * root of a line-level discussion, which is what the review-comment kind means.
 *
 * The raw note count comes back alongside, because dropping notes hides whether the page was
 * full: a caller cannot tell "no more notes" from "a page of activity entries" without it.
 */
/** The three revisions a positioned comment is written against. */
export interface GitLabDiffRefs {
  readonly baseSha: string;
  readonly headSha: string;
  readonly startSha: string;
}

export interface GitLabDiscussions {
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
  /** Discussions GitLab returned, counted before decoding, so a skipped one still counts. */
  readonly rawCount: number;
}

/**
 * Positioned discussions only. GitLab returns the merge request's whole conversation here,
 * including the plain notes the timeline already shows, and only a positioned one belongs
 * against a line of the diff.
 */
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
    // A comment on an added or context line carries `new_line`; one on a removed line carries
    // only `old_line`, and belongs against the file as it was.
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
      // GitLab reports no equivalent of "written against a line that has since moved", so a
      // thread the diff cannot place is worked out from the diff itself rather than claimed
      // here.
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
  // GitLab lists a merge request's commits newest first; the timeline reads oldest first.
  return Result.succeed(commits.toReversed());
}

/** The exact comparison GitLab uses for a commit-scoped diff. */
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
    from: raw.new_file === true ? "/dev/null" : `a/${raw.old_path}`,
    to: raw.deleted_file === true ? "/dev/null" : `b/${raw.new_path}`,
  };
}

export interface GitLabMergeRequestPatch {
  readonly patch: string;
  /** At least one file's hunks were withheld by GitLab as too large to inline. */
  readonly truncated: boolean;
  /** Files GitLab returned, counted before decoding, so the caller can page. */
  readonly rawCount: number;
}

/**
 * GitLab returns hunks per file with no `diff --git` header, so the unified patch every diff
 * viewer expects is assembled here. This decodes one page; walking pages is the caller's job,
 * which is why the raw file count comes back with the patch.
 */
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
      // A file GitLab declined to inline still belongs in the file list, header only.
      truncated = truncated || value.too_large === true || value.collapsed === true;
    }
    const { from, to } = diffHeaderPaths(value);
    const header = [
      `diff --git a/${value.old_path} b/${value.new_path}`,
      ...(value.new_file === true ? [`new file mode ${value.b_mode ?? "100644"}`] : []),
      ...(value.deleted_file === true ? [`deleted file mode ${value.a_mode ?? "100644"}`] : []),
      ...(value.renamed_file === true
        ? [`rename from ${value.old_path}`, `rename to ${value.new_path}`]
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

/** GitLab's award names for the eight reactions the contract carries. */
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

/**
 * Awards on the merge request and on every note of it, in one read. The REST notes endpoint the
 * conversation comes from carries no award at all, and asking per note would be a request each.
 *
 * `currentUser` rides along because GitLab names who awarded but never says whether that is the
 * reader — so the comparison is made here rather than paid for with a request of its own.
 */
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

/**
 * The awards on one subject, grouped the way a reaction pill is drawn. The viewer's own username
 * is left out of `actors` — the page names them "You" instead, and leaving it in would name them
 * twice — but `count` still counts them along with everyone else.
 */
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
    // An award outside the eight is left out rather than shown under a name the picker has no
    // way to take back: GitLab accepts any emoji, and the other hosts accept none of them.
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

/** `gid://gitlab/DiffNote/42` is note 42, which is the id the REST conversation carries. */
function noteIdOf(gid: string | null | undefined): string | null {
  const id = trimmed(gid)?.split("/").at(-1);
  return id !== undefined && /^\d+$/.test(id) ? id : null;
}

export interface GitLabAwardEmojiPage {
  /** The merge request's own awards, which are the ones on its description. */
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

/**
 * The reader's own award of one name on a subject, which is what taking a reaction back is
 * addressed by: GitLab deletes an award by its id and has no way to name one by its emoji.
 */
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
