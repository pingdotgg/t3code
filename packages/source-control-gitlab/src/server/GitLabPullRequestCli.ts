import { isCommitSha } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { resolvePullRequestAuthorFilter, VcsProcessExitError } from "@t3tools/contracts";
import type {
  PullRequestAction,
  PullRequestActor,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewDecision,
  PullRequestReviewPosition,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
} from "@t3tools/contracts";

import * as GitLabCli from "./GitLabCli.ts";
import {
  AWARD_EMOJI_GRAPHQL_QUERY,
  decodeAwardEmojiJson,
  decodeCommitDiffRefsJson,
  decodeCommitsJson,
  decodeDiffRefsJson,
  decodeDiscussionsJson,
  decodeMergeRequestDetailJson,
  decodeMergeRequestDiffsJson,
  decodeMergeRequestChangesJson,
  decodeMergeRequestListJson,
  decodeMergeRequestFileStatsJson,
  decodeMergeRequestStatsJson,
  decodeNotesJson,
  decodeOwnAwardIdJson,
  decodeProjectMergeCapabilitiesJson,
  decodeProjectLabelsJson,
  decodeProjectUsersJson,
  decodeRepositoryBlobsJson,
  decodeReviewDecisionsJson,
  decodeTriggerJobChecksJson,
  decodeViewerJson,
  gitLabAwardName,
  MERGE_REQUEST_FILE_STATS_GRAPHQL_QUERY,
  MERGE_REQUEST_STATS_GRAPHQL_QUERY,
  REPOSITORY_BLOBS_GRAPHQL_QUERY,
  REVIEW_DECISIONS_GRAPHQL_QUERY,
  type GitLabDiffRefs,
  type GitLabMergeRequestDetail,
  type GitLabMergeRequestListItem,
  type GitLabProjectUsers,
} from "./gitLabMergeRequestJson.ts";
import type {
  ProviderFileStats,
  ProviderListCursor,
} from "@t3tools/source-control-core/server/PullRequestProvider";

export class GitLabMergeRequestReadError extends Schema.TaggedError<GitLabMergeRequestReadError>()(
  "GitLabMergeRequestReadError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `GitLab CLI returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitLabViewerUnavailableError extends Schema.TaggedError<GitLabViewerUnavailableError>()(
  "GitLabViewerUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "GitLab CLI returned no username for the authenticated account.";
  }

  override get message(): string {
    return `GitLab CLI failed in getViewerUsername: ${this.detail}`;
  }
}

export class GitLabDiffRefsUnavailableError extends Schema.TaggedError<GitLabDiffRefsUnavailableError>()(
  "GitLabDiffRefsUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  get detail(): string {
    return "The merge request reported no diff revisions.";
  }

  override get message(): string {
    return `GitLab CLI failed in getDiffRefs: ${this.detail}`;
  }
}

export class GitLabDiffCursorError extends Schema.TaggedError<GitLabDiffCursorError>()(
  "GitLabDiffCursorError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "The diff cursor was not one this merge request handed out.";
  }

  override get message(): string {
    return `GitLab CLI failed in getMergeRequestDiff: ${this.detail}`;
  }
}

export class GitLabDiffCommitError extends Schema.TaggedError<GitLabDiffCommitError>()(
  "GitLabDiffCommitError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "The named commit was not a commit sha.";
  }

  override get message(): string {
    return `GitLab CLI failed in getMergeRequestDiff: ${this.detail}`;
  }
}

export class GitLabDiffCommitParentUnavailableError extends Schema.TaggedError<GitLabDiffCommitParentUnavailableError>()(
  "GitLabDiffCommitParentUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    commit: Schema.String,
  },
) {
  get detail(): string {
    return `Commit ${this.commit} reported no parent revision.`;
  }

  override get message(): string {
    return `GitLab CLI failed in getMergeRequestDiffFileContents: ${this.detail}`;
  }
}

export class GitLabDiffFileContentsUnavailableError extends Schema.TaggedError<GitLabDiffFileContentsUnavailableError>()(
  "GitLabDiffFileContentsUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    path: Schema.String,
    reason: Schema.Literals(["oversized", "binary"]),
  },
) {
  get detail(): string {
    return this.reason === "oversized"
      ? `The diff file '${this.path}' exceeds the 1 MB expansion limit.`
      : `The diff file '${this.path}' is binary.`;
  }

  override get message(): string {
    return `GitLab CLI failed in getMergeRequestDiffFileContents: ${this.detail}`;
  }
}

export type GitLabPullRequestCliError =
  | GitLabCli.GitLabCliError
  | GitLabMergeRequestReadError
  | GitLabDiffCursorError
  | GitLabDiffCommitError
  | GitLabDiffCommitParentUnavailableError
  | GitLabDiffFileContentsUnavailableError
  | GitLabDiffRefsUnavailableError
  | GitLabViewerUnavailableError;

/** GitLab's `per_page` limit. */
const MAX_PAGE_SIZE = 100;
const COMMIT_PAGE_SIZE = 100;
/**
 * GitLab 15.7 through 17.10 answer the merge request `/diffs` endpoint with a 500 for any
 * `per_page` above 30 (fixed in 17.11), so those pages stay at a size every version accepts.
 * A commit's own diff endpoint never had that bug and keeps the full page.
 */
const MERGE_REQUEST_DIFF_PAGE_SIZE = 30;
const diffPageSize = (commit: string | undefined) =>
  commit === undefined ? MERGE_REQUEST_DIFF_PAGE_SIZE : MAX_PAGE_SIZE;
const CONVERSATION_PAGES = 10;
const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 60_000;
const isVcsProcessExitError = Schema.is(VcsProcessExitError);
const DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface GitLabMergeRequestListBatch {
  readonly items: ReadonlyArray<GitLabMergeRequestListItem>;
  readonly truncated: boolean;
  readonly cursorAdvance: number;
}

export interface GitLabMergeRequestDiffSlice {
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export class GitLabPullRequestCli extends Context.Service<
  GitLabPullRequestCli,
  {
    readonly getViewerUsername: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
    }) => Effect.Effect<string, GitLabPullRequestCliError>;

    readonly listMergeRequests: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
      readonly filters?: PullRequestListFilters | undefined;
    }) => Effect.Effect<GitLabMergeRequestListBatch, GitLabPullRequestCliError>;

    readonly getMergeRequestDetail: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      /** `false` skips the trigger job read; the permission check before every write does. */
      readonly downstreamChecks?: boolean;
    }) => Effect.Effect<GitLabMergeRequestDetail, GitLabPullRequestCliError>;

    readonly getReviewDecisions: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly numbers: ReadonlyArray<number>;
    }) => Effect.Effect<
      ReadonlyMap<number, PullRequestReviewDecision | null>,
      GitLabPullRequestCliError
    >;

    /** Line counts for the given merge requests; one with no answer is left out. */
    readonly listMergeRequestStats: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly changeRequests: ReadonlyArray<{
        readonly repository: string;
        readonly number: number;
      }>;
    }) => Effect.Effect<
      ReadonlyArray<{
        readonly repository: string;
        readonly number: number;
        readonly additions: number;
        readonly deletions: number;
      }>,
      GitLabPullRequestCliError
    >;

    readonly getMergeRequestFileStats: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ProviderFileStats, GitLabPullRequestCliError>;

    readonly listNotes: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly comments: ReadonlyArray<PullRequestComment>; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly listCommits: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCommit>, GitLabPullRequestCliError>;

    readonly getMergeRequestDiff: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly cursor?: string | undefined;
      readonly commit?: string | undefined;
    }) => Effect.Effect<GitLabMergeRequestDiffSlice, GitLabPullRequestCliError>;

    readonly getMergeRequestDiffFileContents: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly commit?: string | undefined;
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    }) => Effect.Effect<
      { readonly oldContents: string; readonly newContents: string },
      GitLabPullRequestCliError
    >;

    readonly getProjectMergeCapabilities: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
    }) => Effect.Effect<PullRequestMergeCapabilities, GitLabPullRequestCliError>;

    readonly getFileRevisions: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly paths: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyMap<string, string>, GitLabPullRequestCliError>;

    readonly listReviewerCandidates: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestReviewerCandidateList, GitLabPullRequestCliError>;

    readonly listProjectLabels: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly search?: string | undefined;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<PullRequestLabel>; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly listProjectUsers: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly search?: string | undefined;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<PullRequestActor>; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly setReviewerRequest: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<{ readonly id: string }>;
      readonly requested: boolean;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly runMergeRequestAction: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly updateMergeRequest: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly description?: string | undefined;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly commentOnMergeRequest: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly updateNote: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly noteId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly listDiscussions: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly threads: ReadonlyArray<PullRequestReviewThread>; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly submitReview: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly replyToDiscussion: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly discussionId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly setDiscussionResolution: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly discussionId: string;
      readonly resolved: boolean;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly listReactions: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      {
        readonly reactions: ReadonlyArray<PullRequestReaction>;
        readonly reactionsByNoteId: ReadonlyMap<string, ReadonlyArray<PullRequestReaction>>;
      },
      GitLabPullRequestCliError
    >;

    readonly setReaction: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly noteId?: string | undefined;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;
  }
>()("@t3tools/source-control-gitlab/server/GitLabPullRequestCli") {}

function projectPath(repository: string): string {
  return encodeURIComponent(repository.trim());
}

function gitLabReviewPositionLines(
  position: PullRequestReviewPosition,
):
  | { readonly new_line: number }
  | { readonly old_line: number }
  | { readonly old_line: number; readonly new_line: number } {
  switch (position.kind) {
    case "added":
      return { new_line: position.newLine };
    case "deleted":
      return { old_line: position.oldLine };
    case "context":
      return { old_line: position.oldLine, new_line: position.newLine };
  }
}

function stateParam(state: PullRequestListState): string {
  return state === "open" ? "opened" : state;
}

function involvementParams(input: {
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
}): ReadonlyArray<readonly [string, string]> {
  switch (input.involvement) {
    case "authored":
      return [["author_username", input.viewer]];
    case "reviewing":
      return [["reviewer_username", input.viewer]];
    case "all":
      return [];
  }
}

/**
 * GitLab's `labels` asks for every label it names, so only groups of one go to it; a group of
 * alternatives is left for the service to narrow. A comma would split a name in two, and `None`
 * and `Any` mean "unlabeled" and "labeled" to GitLab rather than labels of those names.
 */
function filterParams(input: {
  readonly filters?: PullRequestListFilters | undefined;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
}): ReadonlyArray<readonly [string, string]> {
  const filters = input.filters;
  if (filters === undefined) return [];
  const listable = (names: ReadonlyArray<string>) =>
    names.filter((name) => !name.includes(",") && !/^(?:none|any)$/iu.test(name.trim()));
  const required = listable(
    (filters.labels ?? []).flatMap((group) => (group.length === 1 ? group : [])),
  );
  const excluded = listable(filters.excludedLabels ?? []);
  return [
    ...(required.length === 0 ? [] : [["labels", required.join(",")] as const]),
    ...(excluded.length === 0 ? [] : [["not[labels]", excluded.join(",")] as const]),
    ...(filters.author === undefined || input.involvement === "authored"
      ? []
      : [
          [
            "author_username",
            resolvePullRequestAuthorFilter(filters.author, input.viewer),
          ] as const,
        ]),
    ...(filters.draft === undefined
      ? []
      : [["wip", filters.draft === "only" ? "yes" : "no"] as const]),
  ];
}

function diffCursorPage(cursor: string): number | null {
  return /^[1-9][0-9]{0,6}$/.test(cursor) ? Number(cursor) : null;
}

function searchParams(search: string | undefined): ReadonlyArray<readonly [string, string]> {
  const trimmed = search?.trim() ?? "";
  return trimmed.length === 0 ? [] : [["search", trimmed]];
}

function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

function actionArgs(
  action: PullRequestAction,
  mergeMethod: PullRequestMergeMethod | undefined,
): ReadonlyArray<string> {
  switch (action) {
    case "merge":
      return [
        "merge",
        // glab defaults to auto-merge during a running pipeline.
        "--auto-merge=false",
        "--yes",
        ...(mergeMethod === "squash" ? ["--squash"] : []),
      ];
    case "enable-auto-merge":
      return [
        "merge",
        "--auto-merge=true",
        "--yes",
        ...(mergeMethod === "squash" ? ["--squash"] : []),
      ];
    case "disable-auto-merge":
      return [];
    case "ready":
      return ["update", "--ready"];
    case "draft":
      return ["update", "--draft"];
    case "close":
      return ["close"];
    case "update-branch":
      return ["rebase"];
    case "reopen":
      return ["reopen"];
    case "revert":
    case "approve-workflows":
    case "delete-branch":
      throw new Error(`GitLab merge request action ${action} is unsupported`);
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const gitlab = yield* GitLabCli.GitLabCli;

  const api = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly path: string;
    readonly method?: string;
    readonly stdin?: string;
    readonly maxOutputBytes?: number;
    readonly timeoutMs?: number;
  }) =>
    gitlab.execute({
      cwd: input.cwd,
      host: input.host,
      args: [
        "api",
        input.path,
        ...(input.method === undefined ? [] : ["--method", input.method]),
        // glab --input keeps payloads out of argv/logs but omits GitLab's required Content-Type.
        ...(input.stdin === undefined
          ? []
          : ["--input", "-", "--header", "Content-Type: application/json"]),
      ],
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });

  const listPage = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly limit: number;
    readonly query?: string | undefined;
    readonly cursor?: ProviderListCursor | undefined;
    readonly filters?: PullRequestListFilters | undefined;
    readonly page: number;
    readonly collected: ReadonlyArray<GitLabMergeRequestListItem>;
    readonly cursorAdvance: number;
  }): Effect.Effect<GitLabMergeRequestListBatch, GitLabPullRequestCliError> => {
    // GitLab's timestamp filter can repeat equal-time pages forever; use offsets.
    const delivered = input.cursor?.delivered ?? 0;
    const perPage = Math.min(input.limit + 1, MAX_PAGE_SIZE);
    const firstPage = Math.floor(delivered / perPage) + 1;
    const skipOnFirstPage = input.page === firstPage ? delivered % perPage : 0;
    // Bound raw pages to stop recursion on entirely malformed results.
    const lastPage = Math.floor((delivered + input.limit) / perPage) + 1;
    return api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/merge_requests?${query([
        ["state", stateParam(input.state)],
        ...involvementParams(input),
        ...searchParams(input.query),
        ...filterParams(input),
        ["order_by", "updated_at"],
        ["sort", "desc"],
        ["per_page", String(perPage)],
        ["page", String(input.page)],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const raw = result.stdout.trim();
        if (raw.length === 0) {
          return Effect.succeed({
            items: input.collected,
            truncated: false,
            cursorAdvance: input.cursorAdvance,
          });
        }
        const decoded = decodeMergeRequestListJson(raw);
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "listMergeRequests",
              cause: decoded.failure,
            }),
          );
        }
        const pageItems: GitLabMergeRequestListItem[] = [];
        const pageRawIndexes: number[] = [];
        for (const [index, item] of decoded.success.items.entries()) {
          const rawIndex = decoded.success.rawIndexes[index]!;
          if (rawIndex < skipOnFirstPage) continue;
          pageItems.push(item);
          pageRawIndexes.push(rawIndex);
        }
        const remaining = input.limit - input.collected.length;
        const lastItemRawIndex = pageRawIndexes[remaining - 1];
        if (lastItemRawIndex !== undefined) {
          const consumed = lastItemRawIndex + 1 - skipOnFirstPage;
          return Effect.succeed({
            items: [...input.collected, ...pageItems.slice(0, remaining)],
            truncated:
              lastItemRawIndex + 1 < decoded.success.rawCount ||
              decoded.success.rawCount === perPage,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }
        const collected = [...input.collected, ...pageItems];
        const consumed = Math.max(0, decoded.success.rawCount - skipOnFirstPage);
        // Count malformed rows to avoid ending pagination early.
        const exhausted = decoded.success.rawCount < perPage;
        if (exhausted) {
          return Effect.succeed({
            items: collected,
            truncated: false,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }
        if (input.page >= lastPage) {
          return Effect.succeed({
            items: collected,
            truncated: true,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }
        return listPage({
          ...input,
          page: input.page + 1,
          collected,
          cursorAdvance: input.cursorAdvance + consumed,
        });
      }),
    );
  };

  const diffPage = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
    readonly page: number;
    readonly commit?: string | undefined;
  }): Effect.Effect<GitLabMergeRequestDiffSlice, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/${
        input.commit === undefined
          ? `merge_requests/${input.number}/diffs`
          : `repository/commits/${input.commit}/diff`
      }?${query([
        ["per_page", String(diffPageSize(input.commit))],
        ["page", String(input.page)],
      ])}`,
      maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
      timeoutMs: DIFF_TIMEOUT_MS,
    }).pipe(
      Effect.map((result) => ({ result, legacy: false })),
      Effect.catchTags({
        GitLabCliCommandError: (error) => {
          if (
            input.commit !== undefined ||
            input.page !== 1 ||
            !isVcsProcessExitError(error.cause) ||
            error.cause.failureKind !== "not-found"
          ) {
            return Effect.fail(error);
          }
          // GitLab before 15.7 has no /diffs endpoint. /changes returns one complete slice.
          return api({
            cwd: input.cwd,
            host: input.host,
            path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/changes?access_raw_diffs=true`,
            maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
            timeoutMs: DIFF_TIMEOUT_MS,
          }).pipe(Effect.map((result) => ({ result, legacy: true })));
        },
      }),
      Effect.flatMap(({ result, legacy }) => {
        // Returning no cursor for byte-truncated JSON would lose subsequent pages.
        if (result.stdoutTruncated) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "getMergeRequestDiff",
              cause: new Error(
                `Page ${input.page} of the merge request diff was too large to read.`,
              ),
            }),
          );
        }
        const decoded = (legacy ? decodeMergeRequestChangesJson : decodeMergeRequestDiffsJson)(
          result.stdout.trim(),
        );
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "getMergeRequestDiff",
              cause: decoded.failure,
            }),
          );
        }
        const patch = decoded.success.patch;
        // Counted before decoding, so a page whose files all failed to decode still moves on
        // rather than pointing the reader back at the page it just read.
        const morePages = !legacy && decoded.success.rawCount >= diffPageSize(input.commit);
        return Effect.succeed({
          // Terminate slices so a hunkless header cannot run into the next slice.
          patch: patch.length === 0 ? patch : patch.replace(/\n?$/, "\n"),
          truncated: decoded.success.truncated,
          nextCursor: morePages ? String(input.page + 1) : null,
        });
      }),
    );

  const notesPage = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
    readonly page: number;
    readonly collected: ReadonlyArray<PullRequestComment>;
  }): Effect.Effect<
    { readonly comments: ReadonlyArray<PullRequestComment>; readonly truncated: boolean },
    GitLabPullRequestCliError
  > =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/notes?${query(
        [
          ["per_page", String(MAX_PAGE_SIZE)],
          ["page", String(input.page)],
          ["order_by", "created_at"],
          ["sort", "asc"],
        ],
      )}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeNotesJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "listNotes",
              cause: decoded.failure,
            }),
          );
        }
        const collected = [...input.collected, ...decoded.success.comments];
        if (decoded.success.rawCount < MAX_PAGE_SIZE) {
          return Effect.succeed({ comments: collected, truncated: false });
        }
        return input.page >= CONVERSATION_PAGES
          ? Effect.succeed({ comments: collected, truncated: true })
          : notesPage({ ...input, page: input.page + 1, collected });
      }),
    );

  const discussionsPage = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
    readonly page: number;
    readonly collected: ReadonlyArray<PullRequestReviewThread>;
  }): Effect.Effect<
    { readonly threads: ReadonlyArray<PullRequestReviewThread>; readonly truncated: boolean },
    GitLabPullRequestCliError
  > =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/discussions?${query(
        [
          ["per_page", String(MAX_PAGE_SIZE)],
          ["page", String(input.page)],
        ],
      )}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeDiscussionsJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "listDiscussions",
              cause: decoded.failure,
            }),
          );
        }
        const collected = [...input.collected, ...decoded.success.threads];
        // Plain notes count toward the page size even when no positioned threads survive decoding.
        if (decoded.success.rawCount < MAX_PAGE_SIZE) {
          return Effect.succeed({ threads: collected, truncated: false });
        }
        return input.page >= CONVERSATION_PAGES
          ? Effect.succeed({ threads: collected, truncated: true })
          : discussionsPage({ ...input, page: input.page + 1, collected });
      }),
    );

  const getDiffRefs = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
  }): Effect.Effect<GitLabDiffRefs, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}`,
    }).pipe(
      Effect.flatMap((result): Effect.Effect<GitLabDiffRefs, GitLabPullRequestCliError> => {
        const decoded = decodeDiffRefsJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "getDiffRefs",
              cause: decoded.failure,
            }),
          );
        }
        return decoded.success === null
          ? Effect.fail(
              new GitLabDiffRefsUnavailableError({
                command: "glab",
                cwd: input.cwd,
                number: input.number,
              }),
            )
          : Effect.succeed(decoded.success);
      }),
    );

  const getCommitDiffRefs = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly commit: string;
    readonly allowRoot: boolean;
  }): Effect.Effect<GitLabDiffRefs, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/repository/commits/${input.commit}`,
    }).pipe(
      Effect.flatMap((result): Effect.Effect<GitLabDiffRefs, GitLabPullRequestCliError> => {
        const decoded = decodeCommitDiffRefsJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "getMergeRequestDiffFileContents",
              cause: decoded.failure,
            }),
          );
        }
        return decoded.success === null
          ? input.allowRoot
            ? Effect.succeed({
                baseSha: "",
                headSha: input.commit,
                startSha: "",
              })
            : Effect.fail(
                new GitLabDiffCommitParentUnavailableError({
                  command: "glab",
                  cwd: input.cwd,
                  commit: input.commit,
                }),
              )
          : Effect.succeed(decoded.success);
      }),
    );

  const mergeRequestDetail = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
  }): Effect.Effect<GitLabMergeRequestDetail, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}?${query([
        ["include_diverged_commits_count", "true"],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeMergeRequestDetailJson(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new GitLabMergeRequestReadError({
                command: "glab",
                cwd: input.cwd,
                operation: "getMergeRequestDetail",
                cause: decoded.failure,
              }),
            );
      }),
    );

  // Best-effort: a trigger job read that fails, or a full page that may have left out the one
  // whose pipeline failed, adds no rows and leaves the detail as it was.
  const triggerJobChecks = (input: {
    readonly cwd: string;
    readonly pipeline: { readonly id: number; readonly projectId: number };
  }): Effect.Effect<ReadonlyArray<PullRequestCheck>> =>
    api({
      cwd: input.cwd,
      // `bridges` rather than `trigger_jobs`: GitLab 19.2 deprecates it but still serves it, and
      // older self-managed installs know no other name.
      path: `projects/${input.pipeline.projectId}/pipelines/${input.pipeline.id}/bridges?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
      ])}`,
    }).pipe(
      Effect.map((result) => {
        const decoded = decodeTriggerJobChecksJson(result.stdout.trim());
        return Result.isSuccess(decoded) && decoded.success.rawCount < MAX_PAGE_SIZE
          ? decoded.success.checks
          : [];
      }),
      Effect.orElseSucceed((): ReadonlyArray<PullRequestCheck> => []),
    );

  const projectUsers = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly search?: string | undefined;
  }): Effect.Effect<GitLabProjectUsers, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/users?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
        ...searchParams(input.search),
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeProjectUsersJson(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new GitLabMergeRequestReadError({
                command: "glab",
                cwd: input.cwd,
                operation: "listReviewerCandidates",
                cause: decoded.failure,
              }),
            );
      }),
    );

  const awardSubjectPath = (input: {
    readonly repository: string;
    readonly number: number;
    readonly noteId?: string | undefined;
  }) => {
    const mergeRequest = `projects/${projectPath(input.repository)}/merge_requests/${input.number}`;
    return input.noteId === undefined
      ? `${mergeRequest}/award_emoji`
      : `${mergeRequest}/notes/${encodeURIComponent(input.noteId)}/award_emoji`;
  };

  const awardsPage = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
    readonly cursor: string | null;
    readonly page: number;
    readonly collected: {
      readonly reactions: ReadonlyArray<PullRequestReaction>;
      readonly reactionsByNoteId: Map<string, ReadonlyArray<PullRequestReaction>>;
    } | null;
  }): Effect.Effect<
    {
      readonly reactions: ReadonlyArray<PullRequestReaction>;
      readonly reactionsByNoteId: ReadonlyMap<string, ReadonlyArray<PullRequestReaction>>;
    },
    GitLabPullRequestCliError
  > =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: "graphql",
      method: "POST",
      stdin: JSON.stringify({
        query: AWARD_EMOJI_GRAPHQL_QUERY,
        variables: {
          fullPath: input.repository,
          iid: String(input.number),
          cursor: input.cursor,
        },
      }),
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeAwardEmojiJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "listReactions",
              cause: decoded.failure,
            }),
          );
        }
        const collected = input.collected ?? {
          reactions: decoded.success.reactions,
          reactionsByNoteId: new Map<string, ReadonlyArray<PullRequestReaction>>(),
        };
        for (const [id, reactions] of decoded.success.reactionsByNoteId)
          collected.reactionsByNoteId.set(id, reactions);
        return decoded.success.nextCursor === null || input.page >= CONVERSATION_PAGES
          ? Effect.succeed(collected)
          : awardsPage({
              ...input,
              cursor: decoded.success.nextCursor,
              page: input.page + 1,
              collected,
            });
      }),
    );

  /** The stats connection hands back one page, so a repository's rows are asked for 100 at a time. */
  const STAT_IIDS_PER_REQUEST = 100;

  const graphqlRead = <A>(input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly operation: string;
    readonly query: string;
    readonly variables: Record<string, unknown>;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }) =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: "graphql",
      method: "POST",
      stdin: JSON.stringify({ query: input.query, variables: input.variables }),
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = input.decode(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new GitLabMergeRequestReadError({
                command: "glab",
                cwd: input.cwd,
                operation: input.operation,
                cause: decoded.failure,
              }),
            );
      }),
    );

  const mergeRequestStats = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly numbers: ReadonlyArray<number>;
  }) =>
    graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "listMergeRequestStats",
      query: MERGE_REQUEST_STATS_GRAPHQL_QUERY,
      variables: { fullPath: input.repository, iids: input.numbers.map(String) },
      decode: decodeMergeRequestStatsJson,
    });

  const STAT_REQUEST_CONCURRENCY = 4;

  const listMergeRequestStats: GitLabPullRequestCli["Service"]["listMergeRequestStats"] = (
    input,
  ) => {
    const byRepository = new Map<string, Set<number>>();
    for (const { repository, number } of input.changeRequests) {
      const numbers = byRepository.get(repository) ?? new Set<number>();
      numbers.add(number);
      byRepository.set(repository, numbers);
    }
    const reads: Array<{ readonly repository: string; readonly numbers: ReadonlyArray<number> }> =
      [];
    for (const [repository, numberSet] of byRepository) {
      const numbers = [...numberSet];
      for (let start = 0; start < numbers.length; start += STAT_IIDS_PER_REQUEST) {
        reads.push({ repository, numbers: numbers.slice(start, start + STAT_IIDS_PER_REQUEST) });
      }
    }
    return Effect.forEach(
      reads,
      (read) =>
        mergeRequestStats({ cwd: input.cwd, host: input.host, ...read }).pipe(
          Effect.map((stats) =>
            read.numbers.flatMap((number) => {
              const stat = stats.get(number);
              return stat === undefined ? [] : [{ repository: read.repository, number, ...stat }];
            }),
          ),
          // One read GitLab could not answer costs its own rows their counts, not every other
          // read's on the same page. An unusable CLI or account still reaches the caller.
          Effect.catchIf(
            (cause) =>
              cause._tag !== "GitLabCliUnavailableError" &&
              cause._tag !== "GitLabCliAuthenticationError" &&
              cause._tag !== "GitLabCliRateLimitError",
            (cause) =>
              Effect.logWarning("GitLab merge request line count read failed", {
                repository: read.repository,
                reason: cause._tag,
              }).pipe(Effect.as([])),
          ),
        ),
      { concurrency: STAT_REQUEST_CONCURRENCY },
    ).pipe(Effect.map((results) => results.flat()));
  };

  // GitLab charges by path count and returns one connection page; respect both limits.
  const BLOB_PATHS_PER_REQUEST = 100;

  const blobsAt = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly ref: string;
    readonly paths: ReadonlyArray<string>;
  }): Effect.Effect<ReadonlyMap<string, string> | null, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: "graphql",
      method: "POST",
      stdin: JSON.stringify({
        query: REPOSITORY_BLOBS_GRAPHQL_QUERY,
        variables: { fullPath: input.repository, ref: input.ref, paths: input.paths },
      }),
    }).pipe(
      Effect.flatMap(
        (result): Effect.Effect<ReadonlyMap<string, string> | null, GitLabPullRequestCliError> => {
          const decoded = decodeRepositoryBlobsJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: input.cwd,
                  operation: "getFileRevisions",
                  cause: decoded.failure,
                }),
              );
        },
      ),
    );

  const fileRevisions = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
    readonly paths: ReadonlyArray<string>;
  }): Effect.Effect<ReadonlyMap<string, string>, GitLabPullRequestCliError> =>
    input.paths.length === 0
      ? Effect.succeed(new Map())
      : getDiffRefs(input).pipe(
          Effect.flatMap((refs) => {
            const batches: Array<ReadonlyArray<string>> = [];
            for (let at = 0; at < input.paths.length; at += BLOB_PATHS_PER_REQUEST) {
              batches.push(input.paths.slice(at, at + BLOB_PATHS_PER_REQUEST));
            }
            return Effect.forEach(
              batches,
              (paths) =>
                blobsAt({ ...input, ref: refs.headSha, paths }).pipe(
                  Effect.map((page) => ({ paths, page })),
                ),
              { concurrency: 2 },
            ).pipe(
              Effect.map((pages) => {
                const revisions = new Map<string, string>();
                for (const { paths, page } of pages) {
                  // Unanswered paths are unknown; omit them to preserve viewed marks.
                  if (page === null) continue;
                  for (const [path, oid] of page) revisions.set(path, oid);
                  for (const path of paths) {
                    if (!revisions.has(path)) revisions.set(path, "");
                  }
                }
                return revisions as ReadonlyMap<string, string>;
              }),
            );
          }),
        );

  const reviewDecisionsOf = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly numbers: ReadonlyArray<number>;
  }): Effect.Effect<
    ReadonlyMap<number, PullRequestReviewDecision | null>,
    GitLabPullRequestCliError
  > =>
    graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "getReviewDecisions",
      query: REVIEW_DECISIONS_GRAPHQL_QUERY,
      variables: { fullPath: input.repository, iids: input.numbers.map(String) },
      decode: decodeReviewDecisionsJson,
    });

  const viewerUsername = (input: { readonly cwd: string; readonly host?: string | undefined }) =>
    api({ cwd: input.cwd, host: input.host, path: "user" }).pipe(
      Effect.flatMap((result): Effect.Effect<string, GitLabPullRequestCliError> => {
        const decoded = decodeViewerJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "getViewerUsername",
              cause: decoded.failure,
            }),
          );
        }
        return decoded.success === null
          ? Effect.fail(new GitLabViewerUnavailableError({ command: "glab", cwd: input.cwd }))
          : Effect.succeed(decoded.success);
      }),
    );

  return GitLabPullRequestCli.of({
    getViewerUsername: viewerUsername,

    listMergeRequests: Effect.fn("GitLabPullRequestCli.listMergeRequests")(function (input) {
      const perPage = Math.min(input.limit + 1, MAX_PAGE_SIZE);
      const page = Math.floor((input.cursor?.delivered ?? 0) / perPage) + 1;
      return listPage({ ...input, page, collected: [], cursorAdvance: 0 });
    }),

    getMergeRequestDetail: Effect.fn("GitLabPullRequestCli.getMergeRequestDetail")(
      function* (input) {
        const detail = yield* mergeRequestDetail(input);
        if (input.downstreamChecks === false || detail.headPipeline === undefined) return detail;
        const downstream = yield* triggerJobChecks({
          cwd: input.cwd,
          pipeline: detail.headPipeline,
        });
        return downstream.length === 0
          ? detail
          : { ...detail, checks: [...detail.checks, ...downstream] };
      },
    ),

    getReviewDecisions: Effect.fn("GitLabPullRequestCli.getReviewDecisions")(function (input) {
      const batches: Array<ReadonlyArray<number>> = [];
      for (let at = 0; at < input.numbers.length; at += MAX_PAGE_SIZE) {
        batches.push(input.numbers.slice(at, at + MAX_PAGE_SIZE));
      }
      return Effect.forEach(batches, (numbers) => reviewDecisionsOf({ ...input, numbers }), {
        concurrency: 2,
      }).pipe(Effect.map((pages) => new Map(pages.flatMap((page) => [...page]))));
    }),

    listMergeRequestStats,

    getMergeRequestFileStats: Effect.fn("GitLabPullRequestCli.getMergeRequestFileStats")((input) =>
      graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getMergeRequestFileStats",
        query: MERGE_REQUEST_FILE_STATS_GRAPHQL_QUERY,
        variables: { fullPath: input.repository, iid: String(input.number) },
        decode: decodeMergeRequestFileStatsJson,
      }),
    ),

    listNotes: Effect.fn("GitLabPullRequestCli.listNotes")(function (input) {
      return notesPage({ ...input, page: 1, collected: [] });
    }),

    listReactions: Effect.fn("GitLabPullRequestCli.listReactions")(function (input) {
      return awardsPage({ ...input, cursor: null, page: 1, collected: null });
    }),

    getFileRevisions: fileRevisions,

    setReaction: Effect.fn("GitLabPullRequestCli.setReaction")(function* (input) {
      const subject = awardSubjectPath(input);
      if (input.reacted) {
        yield* api({
          cwd: input.cwd,
          host: input.host,
          path: `${subject}?${query([["name", gitLabAwardName(input.content)]])}`,
          method: "POST",
        });
        return;
      }
      // GitLab deletes an award by its id and takes no emoji name there, so the reader's own
      // award of that name is looked up first.
      const viewer = yield* viewerUsername(input);
      const listed = yield* api({ cwd: input.cwd, host: input.host, path: subject });
      const own = decodeOwnAwardIdJson(listed.stdout.trim(), {
        content: input.content,
        viewer,
      });
      if (!Result.isSuccess(own)) {
        return yield* new GitLabMergeRequestReadError({
          command: "glab",
          cwd: input.cwd,
          operation: "setReaction",
          cause: own.failure,
        });
      }
      if (own.success === null) return;
      yield* api({
        cwd: input.cwd,
        host: input.host,
        path: `${subject}/${own.success}`,
        method: "DELETE",
      });
    }),

    listCommits: Effect.fn("GitLabPullRequestCli.listCommits")(function (input) {
      return api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/commits?${query(
          [
            ["per_page", String(COMMIT_PAGE_SIZE)],
            ["with_stats", "true"],
          ],
        )}`,
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeCommitsJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: input.cwd,
                  operation: "listCommits",
                  cause: decoded.failure,
                }),
              );
        }),
      );
    }),

    getMergeRequestDiff: Effect.fn("GitLabPullRequestCli.getMergeRequestDiff")(function* (input) {
      if (input.commit !== undefined && !isCommitSha(input.commit)) {
        return yield* new GitLabDiffCommitError({ command: "glab", cwd: input.cwd });
      }
      const target = {
        cwd: input.cwd,
        host: input.host,
        repository: input.repository,
        number: input.number,
        ...(input.commit === undefined ? {} : { commit: input.commit }),
      };
      if (input.cursor === undefined) {
        return yield* diffPage({ ...target, page: 1 });
      }
      const page = diffCursorPage(input.cursor);
      if (page === null)
        return yield* new GitLabDiffCursorError({ command: "glab", cwd: input.cwd });
      return yield* diffPage({ ...target, page });
    }),

    getMergeRequestDiffFileContents: Effect.fn(
      "GitLabPullRequestCli.getMergeRequestDiffFileContents",
    )(function* (input) {
      if (input.commit !== undefined && !isCommitSha(input.commit)) {
        return yield* new GitLabDiffCommitError({ command: "glab", cwd: input.cwd });
      }
      const refs = yield* input.commit === undefined
        ? getDiffRefs(input)
        : getCommitDiffRefs({
            cwd: input.cwd,
            host: input.host,
            repository: input.repository,
            commit: input.commit,
            allowRoot: input.changeType === "new",
          });

      const readFile = (revision: string, filePath: string) =>
        api({
          cwd: input.cwd,
          host: input.host,
          path: `projects/${projectPath(input.repository)}/repository/files/${encodeURIComponent(
            filePath,
          )}/raw?ref=${encodeURIComponent(revision)}`,
          maxOutputBytes: DIFF_FILE_MAX_OUTPUT_BYTES,
          timeoutMs: DIFF_TIMEOUT_MS,
        }).pipe(
          Effect.flatMap((result) =>
            result.stdoutTruncated ||
            result.stdout.includes("\0") ||
            result.stdoutInvalidUtf8 === true
              ? Effect.fail(
                  new GitLabDiffFileContentsUnavailableError({
                    command: "glab",
                    cwd: input.cwd,
                    path: filePath,
                    reason: result.stdoutTruncated ? "oversized" : "binary",
                  }),
                )
              : Effect.succeed(result.stdout),
          ),
        );

      const [oldContents, newContents] = yield* Effect.all(
        [
          input.changeType === "new" ? Effect.succeed("") : readFile(refs.baseSha, input.oldPath),
          input.changeType === "deleted"
            ? Effect.succeed("")
            : readFile(refs.headSha, input.newPath),
        ],
        { concurrency: 2 },
      );
      return { oldContents, newContents };
    }),

    getProjectMergeCapabilities: Effect.fn("GitLabPullRequestCli.getProjectMergeCapabilities")(
      function (input) {
        return api({
          cwd: input.cwd,
          host: input.host,
          path: `projects/${projectPath(input.repository)}?license=false`,
        }).pipe(
          Effect.flatMap((result) => {
            const decoded = decodeProjectMergeCapabilitiesJson(result.stdout.trim());
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(
                  new GitLabMergeRequestReadError({
                    command: "glab",
                    cwd: input.cwd,
                    operation: "getProjectMergeCapabilities",
                    cause: decoded.failure,
                  }),
                );
          }),
        );
      },
    ),

    listProjectLabels: Effect.fn("GitLabPullRequestCli.listProjectLabels")(function (input) {
      return api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/labels?${query([
          ["per_page", String(MAX_PAGE_SIZE)],
          ...searchParams(input.search),
        ])}`,
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeProjectLabelsJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed({
                items: decoded.success.labels,
                truncated: decoded.success.rawCount >= MAX_PAGE_SIZE,
              })
            : Effect.fail(
                new GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: input.cwd,
                  operation: "listProjectLabels",
                  cause: decoded.failure,
                }),
              );
        }),
      );
    }),

    listProjectUsers: Effect.fn("GitLabPullRequestCli.listProjectUsers")(function (input) {
      return projectUsers(input).pipe(
        Effect.map(({ candidates, rawCount }) => ({
          items: candidates.map(({ login, name, avatarUrl }) => ({ login, name, avatarUrl })),
          truncated: rawCount >= MAX_PAGE_SIZE,
        })),
      );
    }),

    listReviewerCandidates: Effect.fn("GitLabPullRequestCli.listReviewerCandidates")(
      function (input) {
        return Effect.all([mergeRequestDetail(input), projectUsers(input)], {
          concurrency: 2,
        }).pipe(
          Effect.map(([mergeRequest, users]) => {
            const author = mergeRequest.author?.login;
            const requested = new Set(mergeRequest.reviewRequestLogins);
            return {
              // GitLab forbids requesting a review from the MR author.
              candidates: users.candidates.flatMap((candidate) =>
                candidate.login === author
                  ? []
                  : [{ ...candidate, isRequested: requested.has(candidate.login) }],
              ),
              truncated: users.rawCount >= MAX_PAGE_SIZE,
            };
          }),
        );
      },
    ),

    setReviewerRequest: Effect.fn("GitLabPullRequestCli.setReviewerRequest")(function (input) {
      return mergeRequestDetail(input).pipe(
        Effect.flatMap((mergeRequest) => {
          // GitLab replaces reviewer_ids wholesale.
          const ids = new Set(mergeRequest.reviewerIds);
          for (const reviewer of input.reviewers) {
            const id = Number(reviewer.id);
            if (!Number.isSafeInteger(id) || id <= 0) continue;
            if (input.requested) ids.add(id);
            else ids.delete(id);
          }
          return api({
            cwd: input.cwd,
            host: input.host,
            path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}`,
            method: "PUT",
            stdin: JSON.stringify({ reviewer_ids: [...ids] }),
          });
        }),
        Effect.asVoid,
      );
    }),

    runMergeRequestAction: Effect.fn("GitLabPullRequestCli.runMergeRequestAction")(
      function* (input) {
        // `glab mr merge` arms auto-merge and never disarms it, so the one direction the CLI has
        // no flag for is asked of GitLab directly through the same `api` passthrough the rest of
        // this module writes with.
        if (input.action === "disable-auto-merge") {
          return yield* api({
            cwd: input.cwd,
            host: input.host,
            path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/cancel_merge_when_pipeline_succeeds`,
            method: "POST",
          }).pipe(Effect.asVoid);
        }
        const executeMr = (subcommand: string, ...flags: ReadonlyArray<string>) =>
          gitlab.execute({
            cwd: input.cwd,
            host: input.host,
            args: ["mr", subcommand, String(input.number), "--repo", input.repository, ...flags],
          });
        const [subcommand, ...flags] = actionArgs(input.action, input.mergeMethod);
        if (input.action === "merge" || input.action === "enable-auto-merge") {
          if (input.mergeMethod === "rebase") {
            // A rebase changes the source SHA, so wait for it before reading the merge guard.
            yield* executeMr("rebase");
          }
          const refs = yield* getDiffRefs(input);
          flags.push("--sha", refs.headSha);
        }
        yield* executeMr(subcommand!, ...flags);
      },
    ),

    updateMergeRequest: Effect.fn("GitLabPullRequestCli.updateMergeRequest")(function (input) {
      return api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}`,
        method: "PUT",
        // Omitted fields remain unchanged; empty values clear them.
        stdin: JSON.stringify({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
        }),
      }).pipe(Effect.asVoid);
    }),

    commentOnMergeRequest: Effect.fn("GitLabPullRequestCli.commentOnMergeRequest")(
      function (input) {
        return api({
          cwd: input.cwd,
          host: input.host,
          path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/notes`,
          method: "POST",
          // JSON avoids glab's coercion of numeric/boolean comment bodies.
          stdin: JSON.stringify({ body: input.body }),
        }).pipe(Effect.asVoid);
      },
    ),

    updateNote: Effect.fn("GitLabPullRequestCli.updateNote")(function (input) {
      return api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/notes/${encodeURIComponent(
          input.noteId,
        )}`,
        method: "PUT",
        stdin: JSON.stringify({ body: input.body }),
      }).pipe(Effect.asVoid);
    }),

    listDiscussions: Effect.fn("GitLabPullRequestCli.listDiscussions")(function (input) {
      return discussionsPage({ ...input, page: 1, collected: [] });
    }),

    submitReview: Effect.fn("GitLabPullRequestCli.submitReview")(function* (input) {
      const project = projectPath(input.repository);
      const mergeRequest = `projects/${project}/merge_requests/${input.number}`;
      // GitLab has no pending review to attach comments to, so a review is replayed as the
      // requests it is made of: the line comments, then the summary, then the verdict. A
      // failure part-way therefore leaves what was already posted in place, which is why
      // the verdict goes last — a half-sent review is never an approval.
      if (input.comments.length > 0) {
        const refs = yield* getDiffRefs(input);
        yield* Effect.forEach(
          input.comments,
          (comment) =>
            api({
              cwd: input.cwd,
              host: input.host,
              path: `${mergeRequest}/discussions`,
              method: "POST",
              stdin: JSON.stringify({
                body: comment.body,
                position: {
                  base_sha: refs.baseSha,
                  head_sha: refs.headSha,
                  start_sha: refs.startSha,
                  position_type: "text",
                  // Both paths are sent because GitLab resolves a position against both
                  // sides of the diff. They differ only for a renamed file, which is why the
                  // draft carries the name the file had before the change.
                  old_path: comment.oldPath ?? comment.path,
                  new_path: comment.path,
                  ...gitLabReviewPositionLines(comment.position),
                },
              }),
            }),
          { discard: true },
        );
      }
      if (input.body.trim().length > 0) {
        yield* api({
          cwd: input.cwd,
          host: input.host,
          path: `${mergeRequest}/notes`,
          method: "POST",
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          stdin: JSON.stringify({ body: input.body }),
        });
      }
      if (input.verdict === "approve") {
        yield* api({
          cwd: input.cwd,
          host: input.host,
          path: `${mergeRequest}/approve`,
          method: "POST",
        });
      }
    }),

    replyToDiscussion: Effect.fn("GitLabPullRequestCli.replyToDiscussion")(function (input) {
      return api({
        cwd: input.cwd,
        host: input.host,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/discussions/${encodeURIComponent(
          input.discussionId,
        )}/notes`,
        method: "POST",
        stdin: JSON.stringify({ body: input.body }),
      }).pipe(Effect.asVoid);
    }),

    setDiscussionResolution: Effect.fn("GitLabPullRequestCli.setDiscussionResolution")(
      function (input) {
        return api({
          cwd: input.cwd,
          host: input.host,
          path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/discussions/${encodeURIComponent(
            input.discussionId,
          )}`,
          method: "PUT",
          stdin: JSON.stringify({ resolved: input.resolved }),
        }).pipe(Effect.asVoid);
      },
    ),
  });
});

export const layer = Layer.effect(GitLabPullRequestCli, make);
