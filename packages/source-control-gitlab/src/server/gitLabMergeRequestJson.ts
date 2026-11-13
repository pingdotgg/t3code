import { trimOptionalString as trimmed } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestComment,
  PullRequestCommit,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewDecision,
} from "@t3tools/contracts";
import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import type { DecodeFailure, GitLabDiffRefs } from "./gitLabMergeRequestJsonPart2.ts";
import { RawDiffSchema, decodeCommit, decodeCommitEntry, decodeDiffEntry, decodeMergeRequestChanges, decodeNoteEntry, decodeUnknownList, toActor } from "./gitLabMergeRequestJsonPart2.ts";
export type {
  GitLabDiffRefs,
  GitLabDiscussions,
  GitLabMergeRequestDetail,
  GitLabMergeRequestListBatch,
  GitLabMergeRequestListItem,
  GitLabProjectLabels,
  GitLabProjectUsers,
  GitLabTriggerJobChecks,
} from "./gitLabMergeRequestJsonPart2.ts";
export {
  decodeDiffRefsJson,
  decodeDiscussionsJson,
  decodeMergeRequestDetailJson,
  decodeMergeRequestListJson,
  decodeProjectLabelsJson,
  decodeProjectMergeCapabilitiesJson,
  decodeProjectUsersJson,
  decodeTriggerJobChecksJson,
  decodeViewerJson,
} from "./gitLabMergeRequestJsonPart2.ts";

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

export const REVIEW_DECISIONS_GRAPHQL_QUERY = `query($fullPath: ID!, $iids: [String!]) {
  metadata { enterprise }
  project(fullPath: $fullPath) {
    mergeRequests(iids: $iids, first: 100) {
      nodes { iid approved approvedBy(first: 1) { nodes { username } } }
    }
  }
}`;

const RawReviewDecisionsSchema = Schema.Struct({
  data: Schema.Struct({
    metadata: Schema.optional(
      Schema.NullOr(Schema.Struct({ enterprise: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
    ),
    project: Schema.NullOr(
      Schema.Struct({
        mergeRequests: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              nodes: Schema.Array(
                Schema.NullOr(
                  Schema.Struct({
                    iid: Schema.String,
                    approved: Schema.optional(Schema.NullOr(Schema.Boolean)),
                    approvedBy: Schema.optional(
                      Schema.NullOr(
                        Schema.Struct({
                          nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
                        }),
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

const decodeReviewDecisions = decodeJsonResult(RawReviewDecisionsSchema);

/**
 * Only Enterprise Edition holds `approved` to the project's approval rules, so an unapproved
 * merge request there still needs review even when someone, such as a bot, approved it.
 * Community Edition reports `approved` once anyone approves and requires no review.
 */
export function decodeReviewDecisionsJson(
  raw: string,
): Result.Result<ReadonlyMap<number, PullRequestReviewDecision | null>, DecodeFailure> {
  const decoded = decodeReviewDecisions(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const enterprise = decoded.success.data.metadata?.enterprise;
  const decisions = new Map<number, PullRequestReviewDecision | null>();
  for (const node of decoded.success.data.project?.mergeRequests?.nodes ?? []) {
    const number = Number(node?.iid);
    if (
      node === null ||
      !Number.isSafeInteger(number) ||
      node.approved == null ||
      node.approvedBy?.nodes == null
    )
      continue;
    const approvals = node.approvedBy.nodes.length;
    if (node.approved === false && approvals === 0 && enterprise == null) continue;
    decisions.set(
      number,
      node.approved === false && (enterprise || approvals > 0)
        ? "review-required"
        : approvals > 0
          ? "approved"
          : null,
    );
  }
  return Result.succeed(decisions);
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
