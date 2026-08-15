import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestListState,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewPosition,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
} from "@t3tools/contracts";

import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import {
  AWARD_EMOJI_GRAPHQL_QUERY,
  decodeAwardEmojiJson,
  decodeCommitDiffRefsJson,
  decodeCommitsJson,
  decodeDiffRefsJson,
  decodeDiscussionsJson,
  decodeMergeRequestDetailJson,
  decodeMergeRequestDiffsJson,
  decodeMergeRequestListJson,
  decodeNotesJson,
  decodeOwnAwardIdJson,
  decodeProjectMergeCapabilitiesJson,
  decodeProjectUsersJson,
  decodeViewerJson,
  gitLabAwardName,
  type GitLabDiffRefs,
  type GitLabMergeRequestDetail,
  type GitLabMergeRequestListItem,
  type GitLabProjectUsers,
} from "./gitLabMergeRequestJson.ts";
import type { ProviderListCursor } from "./PullRequestProvider.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class GitLabMergeRequestReadError extends Schema.TaggedErrorClass<GitLabMergeRequestReadError>()(
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

/** Not a decode failure: glab answered, the account it answered for just has no username. */
export class GitLabViewerUnavailableError extends Schema.TaggedErrorClass<GitLabViewerUnavailableError>()(
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

/** Not a decode failure: GitLab answered, the merge request just has no revisions to place a
 *  comment against. */
export class GitLabDiffRefsUnavailableError extends Schema.TaggedErrorClass<GitLabDiffRefsUnavailableError>()(
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

/** Not a decode failure: the reader asked to carry on from a cursor this walk never handed out. */
export class GitLabDiffCursorError extends Schema.TaggedErrorClass<GitLabDiffCursorError>()(
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

/** Not a decode failure: the reader named a commit that is not a sha this project could hold. */
export class GitLabDiffCommitError extends Schema.TaggedErrorClass<GitLabDiffCommitError>()(
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

/** The commit exists and decoded, but it has no parent to use as the old revision. */
export class GitLabDiffCommitParentUnavailableError extends Schema.TaggedErrorClass<GitLabDiffCommitParentUnavailableError>()(
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

/** A blob exists, but expanding it would be unsafe or would not produce text. */
export class GitLabDiffFileContentsUnavailableError extends Schema.TaggedErrorClass<GitLabDiffFileContentsUnavailableError>()(
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

/** GitLab's own ceiling on `per_page`, so a larger page has to be walked. */
const MAX_PAGE_SIZE = 100;
/** Commit history is read one page deep; the rest of a long history stays on GitLab. */
const COMMIT_PAGE_SIZE = 100;
/**
 * Pages of the conversation to follow before it is reported as truncated. GitLab caps a page at
 * a hundred, so this is a thousand notes and a thousand discussions — more than any merge
 * request a person is reading holds, and a walk that ends whatever the host has.
 */
const CONVERSATION_PAGES = 10;
const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 60_000;
const DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface GitLabMergeRequestListBatch {
  readonly items: ReadonlyArray<GitLabMergeRequestListItem>;
  readonly truncated: boolean;
  /** Raw GitLab rows consumed to produce this page, including malformed rows. */
  readonly cursorAdvance: number;
}

export interface GitLabMergeRequestDiffSlice {
  readonly patch: string;
  /** Files in this slice had their hunks withheld, as opposed to there being more slices. */
  readonly truncated: boolean;
  /** Where the next slice starts, or null once the patch is whole. */
  readonly nextCursor: string | null;
}

export class GitLabPullRequestCli extends Context.Service<
  GitLabPullRequestCli,
  {
    readonly getViewerUsername: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string, GitLabPullRequestCliError>;

    readonly listMergeRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /** Free text for GitLab's own `search`, which matches title and description. */
      readonly query?: string | undefined;
      /** Where to carry on from in GitLab's stable update-ordered row set. */
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<GitLabMergeRequestListBatch, GitLabPullRequestCliError>;

    readonly getMergeRequestDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<GitLabMergeRequestDetail, GitLabPullRequestCliError>;

    readonly listNotes: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly comments: ReadonlyArray<PullRequestComment>; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly listCommits: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCommit>, GitLabPullRequestCliError>;

    readonly getMergeRequestDiff: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      /** Absent asks for the first slice; anything else is a cursor a slice handed back. */
      readonly cursor?: string | undefined;
      /** One commit's own changes, rather than everything the merge request carries. */
      readonly commit?: string | undefined;
    }) => Effect.Effect<GitLabMergeRequestDiffSlice, GitLabPullRequestCliError>;

    readonly getMergeRequestDiffFileContents: (input: {
      readonly cwd: string;
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
      readonly repository: string;
    }) => Effect.Effect<PullRequestMergeCapabilities, GitLabPullRequestCliError>;

    /**
     * Who this merge request may be sent to, and who it has already been sent to. Two reads at
     * once, because GitLab keeps the people with access on the project and the reviewers on the
     * merge request, and neither answers for the other.
     */
    readonly listReviewerCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestReviewerCandidateList, GitLabPullRequestCliError>;

    readonly setReviewerRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<{ readonly id: string }>;
      readonly requested: boolean;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly runMergeRequestAction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    /** Whichever of the two is given is sent. GitLab calls a merge request's body its description. */
    readonly updateMergeRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly description?: string | undefined;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly commentOnMergeRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly updateNote: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly noteId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly listDiscussions: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly threads: ReadonlyArray<PullRequestReviewThread>; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly submitReview: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly replyToDiscussion: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly discussionId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly setDiscussionResolution: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly discussionId: string;
      readonly resolved: boolean;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    /** The awards on the merge request and on every note of it, keyed by the note's REST id. */
    readonly listReactions: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      {
        readonly reactions: ReadonlyArray<PullRequestReaction>;
        readonly reactionsByNoteId: ReadonlyMap<string, ReadonlyArray<PullRequestReaction>>;
      },
      GitLabPullRequestCliError
    >;

    /**
     * Awards an emoji, or takes the award back. `noteId` is a note of the merge request; absent
     * awards the merge request itself, which is where its description's reactions live.
     */
    readonly setReaction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly noteId?: string | undefined;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;
  }
>()("t3/pullRequest/GitLabPullRequestCli") {}

/** The REST API addresses a project by its URL-encoded full path. */
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
  // GitLab's `closed` already excludes merged merge requests, so no extra filter is needed,
  // and it spans every state under `all`.
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
 * The page a diff cursor names, or null for anything this walk cannot have issued. The cursor
 * arrives from the reader as a string and goes straight into a query, so it is parsed rather
 * than trusted; the length bound keeps a page number out of exponential notation.
 */
function diffCursorPage(cursor: string): number | null {
  return /^[1-9][0-9]{0,6}$/.test(cursor) ? Number(cursor) : null;
}

/**
 * A commit sha arrives from the reader and goes straight into a request path, so it is checked
 * rather than trusted: hexadecimal only, from the shortest abbreviation a host prints up to a
 * whole sha.
 */
function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
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
        // glab turns on auto-merge whenever a pipeline is running. The button means merge now.
        "--auto-merge=false",
        "--yes",
        ...(mergeMethod === "squash" ? ["--squash"] : []),
        ...(mergeMethod === "rebase" ? ["--rebase"] : []),
      ];
    // The same command with the flag the other way up: here the wait is the whole point, so
    // glab is told to arm the merge rather than talked out of it.
    case "enable-auto-merge":
      return [
        "merge",
        "--auto-merge=true",
        "--yes",
        ...(mergeMethod === "squash" ? ["--squash"] : []),
        ...(mergeMethod === "rebase" ? ["--rebase"] : []),
      ];
    // Never reached: taking the arming back has no `glab mr` command, so it goes to the API.
    case "disable-auto-merge":
      return [];
    case "ready":
      return ["update", "--ready"];
    case "draft":
      return ["update", "--draft"];
    case "close":
      return ["close"];
    // A rebase, because GitLab has no other way to move a branch onto its target: there is no
    // merge-the-target-in equivalent of GitHub's update button, which is why this host declares
    // `rebase` alone and never has to read the method it was handed.
    case "update-branch":
      return ["rebase"];
    case "reopen":
      return ["reopen"];
  }
}

export const make = Effect.gen(function* () {
  const gitlab = yield* GitLabCli.GitLabCli;

  const api = (input: {
    readonly cwd: string;
    readonly path: string;
    readonly method?: string;
    readonly stdin?: string;
    readonly maxOutputBytes?: number;
    readonly timeoutMs?: number;
  }) =>
    gitlab.execute({
      cwd: input.cwd,
      args: [
        "api",
        input.path,
        ...(input.method === undefined ? [] : ["--method", input.method]),
        // A raw body from stdin: argv is visible in process listings and is echoed back
        // inside process-runner failure messages. Unlike `gh`, `glab api --input` sends no
        // Content-Type at all, and GitLab answers a bodyless content type with HTTP 415.
        ...(input.stdin === undefined
          ? []
          : ["--input", "-", "--header", "Content-Type: application/json"]),
      ],
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });

  /**
   * `per_page` stops at 100, so a larger page is walked one request at a time. The walk is
   * bounded twice over: it stops on a short page or once the extra row that reveals a next
   * page has been read, and it never asks for more pages than the caller's page needs. The
   * second bound is what makes it terminate when every row on a page fails to decode, which
   * leaves nothing collected but does not mean GitLab has run out of rows.
   */
  const listPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly limit: number;
    readonly query?: string | undefined;
    readonly cursor?: ProviderListCursor | undefined;
    readonly page: number;
    readonly collected: ReadonlyArray<GitLabMergeRequestListItem>;
    readonly cursorAdvance: number;
  }): Effect.Effect<GitLabMergeRequestListBatch, GitLabPullRequestCliError> => {
    // A continuation uses GitLab's offset pagination. Its timestamp filter is inclusive and has
    // no tie-breaker, so a page where many rows share the boundary would otherwise return the
    // same prefix forever. `delivered` is the stable offset the service has already handed over.
    const delivered = input.cursor?.delivered ?? 0;
    const perPage = Math.min(input.limit + 1, MAX_PAGE_SIZE);
    const firstPage = Math.floor(delivered / perPage) + 1;
    const skipOnFirstPage = input.page === firstPage ? delivered % perPage : 0;
    // A page made entirely of malformed rows has no item from which the service can build a
    // continuation. Bound the walk to the raw span this request asked for rather than recursing
    // forever on a host that keeps returning full unusable pages.
    const lastPage = Math.floor((delivered + input.limit) / perPage) + 1;
    return api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/merge_requests?${query([
        ["state", stateParam(input.state)],
        ...involvementParams(input),
        // The listing is read through `glab api` rather than `glab mr list`, so the search is
        // the REST API's own `search` parameter — the one `mr list --search` passes on. It
        // matches title and description, and travels URL-encoded like every other value here,
        // so no text in it can become a parameter of its own.
        ...searchParams(input.query),
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
        // Counted before decoding, so a skipped malformed row cannot end paging early.
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

  /**
   * One page of a merge request's files, as a patch that stands on its own. GitLab pages
   * `/diffs` by offset and has no cursor of its own, so the page number is the cursor; the
   * caller carries on from it for as long as GitLab keeps handing full pages back.
   *
   * A named commit is read from the commit's own diff, which answers in the same shape and pages
   * the same way.
   */
  const diffPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly page: number;
    readonly commit?: string | undefined;
  }): Effect.Effect<GitLabMergeRequestDiffSlice, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/${
        input.commit === undefined
          ? `merge_requests/${input.number}/diffs`
          : `repository/commits/${input.commit}/diff`
      }?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
        ["page", String(input.page)],
      ])}`,
      maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
      timeoutMs: DIFF_TIMEOUT_MS,
    }).pipe(
      Effect.flatMap((result) => {
        // A byte-truncated response is a JSON prefix, so this page cannot be read at all.
        // Answering with no cursor would call the diff whole while silently dropping this page
        // and every one after it, so the read fails and says which page could not be had.
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
        const decoded = decodeMergeRequestDiffsJson(result.stdout.trim());
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
        const morePages = decoded.success.rawCount >= MAX_PAGE_SIZE;
        return Effect.succeed({
          // The slice ends on a newline, so a file GitLab gave a header and no hunks for does
          // not run into the first line of the next slice.
          patch: patch.length === 0 ? patch : patch.replace(/\n?$/, "\n"),
          truncated: decoded.success.truncated,
          nextCursor: morePages ? String(input.page + 1) : null,
        });
      }),
    );

  /**
   * The conversation, a page at a time. GitLab pages by offset and reports no total, so a short
   * page is the only thing that says it is done — and the raw count decides, not the kept one:
   * the notes GitLab wrote itself are dropped, and a whole page of them still means there is
   * more to read.
   */
  const notesPage = (input: {
    readonly cwd: string;
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

  /** The positioned discussions, walked the same way and stopped by the same bound. */
  const discussionsPage = (input: {
    readonly cwd: string;
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
        // The raw count again: this endpoint returns the plain notes too, so a full page of
        // those is not the end of the positioned ones.
        if (decoded.success.rawCount < MAX_PAGE_SIZE) {
          return Effect.succeed({ threads: collected, truncated: false });
        }
        return input.page >= CONVERSATION_PAGES
          ? Effect.succeed({ threads: collected, truncated: true })
          : discussionsPage({ ...input, page: input.page + 1, collected });
      }),
    );

  /**
   * The revisions a positioned comment is written against. GitLab resolves a comment's line
   * against these three shas, so a review with line comments cannot be sent without them.
   */
  const getDiffRefs = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
  }): Effect.Effect<GitLabDiffRefs, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
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
        // A merge request with no diff refs is a well-formed answer that cannot carry a
        // positioned comment — a dead end, but not something that failed to be read.
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
    readonly repository: string;
    readonly commit: string;
    readonly allowRoot: boolean;
  }): Effect.Effect<GitLabDiffRefs, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
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

  /**
   * The merge request itself, which several calls need for different parts of it: the detail for
   * everything, and the reviewer paths for the ids GitLab writes a reviewer set with.
   */
  const mergeRequestDetail = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
  }): Effect.Effect<GitLabMergeRequestDetail, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      // How far behind the target branch this one is comes only when asked for by name, and it
      // is asked for here rather than on a second read because it is the same merge request.
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

  /** The people with access to the project, one page deep. */
  const projectUsers = (input: {
    readonly cwd: string;
    readonly repository: string;
  }): Effect.Effect<GitLabProjectUsers, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/users?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
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

  /** Where an award is written: a note of the merge request, or the merge request itself. */
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

  /**
   * The awards on the merge request and its notes, a page of notes at a time. Bounded by the same
   * count as the conversation itself: awards past the notes that were read belong to notes the
   * page is not showing.
   */
  const awardsPage = (input: {
    readonly cwd: string;
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

  const viewerUsername = (input: { readonly cwd: string }) =>
    api({ cwd: input.cwd, path: "user" }).pipe(
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

    listMergeRequests: (input) => {
      const perPage = Math.min(input.limit + 1, MAX_PAGE_SIZE);
      const page = Math.floor((input.cursor?.delivered ?? 0) / perPage) + 1;
      return listPage({ ...input, page, collected: [], cursorAdvance: 0 });
    },

    getMergeRequestDetail: mergeRequestDetail,

    listNotes: (input) => notesPage({ ...input, page: 1, collected: [] }),

    listReactions: (input) => awardsPage({ ...input, cursor: null, page: 1, collected: null }),

    setReaction: (input) =>
      Effect.gen(function* () {
        const subject = awardSubjectPath(input);
        if (input.reacted) {
          yield* api({
            cwd: input.cwd,
            path: `${subject}?${query([["name", gitLabAwardName(input.content)]])}`,
            method: "POST",
          });
          return;
        }
        // GitLab deletes an award by its id and takes no emoji name there, so the reader's own
        // award of that name is looked up first. Nothing to delete is success: the reaction the
        // caller asked to take back is already gone.
        const viewer = yield* viewerUsername({ cwd: input.cwd });
        const listed = yield* api({ cwd: input.cwd, path: subject });
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
          path: `${subject}/${own.success}`,
          method: "DELETE",
        });
      }),

    listCommits: (input) =>
      api({
        cwd: input.cwd,
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
      ),

    getMergeRequestDiff: (input) => {
      if (input.commit !== undefined && !isCommitSha(input.commit)) {
        return Effect.fail(new GitLabDiffCommitError({ command: "glab", cwd: input.cwd }));
      }
      const target = {
        cwd: input.cwd,
        repository: input.repository,
        number: input.number,
        ...(input.commit === undefined ? {} : { commit: input.commit }),
      };
      if (input.cursor === undefined) {
        return diffPage({ ...target, page: 1 });
      }
      const page = diffCursorPage(input.cursor);
      return page === null
        ? Effect.fail(new GitLabDiffCursorError({ command: "glab", cwd: input.cwd }))
        : diffPage({ ...target, page });
    },

    getMergeRequestDiffFileContents: (input) =>
      Effect.gen(function* () {
        if (input.commit !== undefined && !isCommitSha(input.commit)) {
          return yield* Effect.fail(new GitLabDiffCommitError({ command: "glab", cwd: input.cwd }));
        }
        const refs = yield* input.commit === undefined
          ? getDiffRefs(input)
          : getCommitDiffRefs({
              cwd: input.cwd,
              repository: input.repository,
              commit: input.commit,
              allowRoot: input.changeType === "new",
            });

        const readFile = (revision: string, filePath: string) =>
          api({
            cwd: input.cwd,
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

    getProjectMergeCapabilities: (input) =>
      api({
        cwd: input.cwd,
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
      ),

    listReviewerCandidates: (input) =>
      Effect.all([mergeRequestDetail(input), projectUsers(input)], { concurrency: 2 }).pipe(
        Effect.map(([mergeRequest, users]) => {
          const author = mergeRequest.author?.login;
          const requested = new Set(mergeRequest.reviewRequestLogins);
          return {
            // The author is dropped rather than shown unusable: GitLab refuses to make the person
            // who opened a merge request its reviewer.
            candidates: users.candidates.flatMap((candidate) =>
              candidate.login === author
                ? []
                : [{ ...candidate, isRequested: requested.has(candidate.login) }],
            ),
            truncated: users.rawCount >= MAX_PAGE_SIZE,
          };
        }),
      ),

    setReviewerRequest: (input) =>
      mergeRequestDetail(input).pipe(
        Effect.flatMap((mergeRequest) => {
          // GitLab has no endpoint that adds or removes one reviewer: `reviewer_ids` replaces the
          // whole set, so the set that is already there is read first and the change applied to
          // it. Asking again for somebody already on it writes the same set back, which is how
          // GitLab re-requests a review.
          const ids = new Set(mergeRequest.reviewerIds);
          for (const reviewer of input.reviewers) {
            const id = Number(reviewer.id);
            // A candidate GitLab did not name is not an id it would accept, and sending it would
            // rewrite the reviewer set around a number nobody chose.
            if (!Number.isSafeInteger(id) || id <= 0) continue;
            if (input.requested) ids.add(id);
            else ids.delete(id);
          }
          return api({
            cwd: input.cwd,
            path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}`,
            method: "PUT",
            stdin: JSON.stringify({ reviewer_ids: [...ids] }),
          });
        }),
        Effect.asVoid,
      ),

    runMergeRequestAction: (input) => {
      // `glab mr merge` arms auto-merge and never disarms it, so the one direction the CLI has
      // no flag for is asked of GitLab directly through the same `api` passthrough the rest of
      // this module writes with.
      if (input.action === "disable-auto-merge") {
        return api({
          cwd: input.cwd,
          path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/cancel_merge_when_pipeline_succeeds`,
          method: "POST",
        }).pipe(Effect.asVoid);
      }
      const [subcommand, ...flags] = actionArgs(input.action, input.mergeMethod);
      return gitlab
        .execute({
          cwd: input.cwd,
          args: ["mr", subcommand!, String(input.number), "--repo", input.repository, ...flags],
        })
        .pipe(Effect.asVoid);
    },

    updateMergeRequest: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}`,
        method: "PUT",
        // Only the fields the caller asked to change: GitLab leaves out what it is not sent, and
        // clears what it is sent empty — so a title corrected on its own must carry no
        // description at all.
        stdin: JSON.stringify({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
        }),
      }).pipe(Effect.asVoid),

    commentOnMergeRequest: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/notes`,
        method: "POST",
        // A JSON body rather than a `--raw-field`: glab coerces a field that reads as a
        // literal `true` or a number, and a comment body is text either way.
        stdin: JSON.stringify({ body: input.body }),
      }).pipe(Effect.asVoid),

    updateNote: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/notes/${encodeURIComponent(
          input.noteId,
        )}`,
        method: "PUT",
        stdin: JSON.stringify({ body: input.body }),
      }).pipe(Effect.asVoid),

    listDiscussions: (input) => discussionsPage({ ...input, page: 1, collected: [] }),

    submitReview: (input) =>
      Effect.gen(function* () {
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
            path: `${mergeRequest}/notes`,
            method: "POST",
            // A JSON body rather than a `--raw-field`, for the reason the plain comment gives:
            // glab coerces a field that reads as a literal `true` or a number.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            stdin: JSON.stringify({ body: input.body }),
          });
        }
        if (input.verdict === "approve") {
          yield* api({ cwd: input.cwd, path: `${mergeRequest}/approve`, method: "POST" });
        }
      }),

    replyToDiscussion: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/discussions/${encodeURIComponent(
          input.discussionId,
        )}/notes`,
        method: "POST",
        stdin: JSON.stringify({ body: input.body }),
      }).pipe(Effect.asVoid),

    setDiscussionResolution: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/discussions/${encodeURIComponent(
          input.discussionId,
        )}`,
        method: "PUT",
        stdin: JSON.stringify({ resolved: input.resolved }),
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitLabPullRequestCli, make);
