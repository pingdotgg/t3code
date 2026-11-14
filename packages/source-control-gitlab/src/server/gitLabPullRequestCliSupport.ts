import * as Schema from "effect/Schema";
import { resolvePullRequestAuthorFilter, VcsProcessExitError } from "@t3tools/contracts";
import type {
  PullRequestAction,
  PullRequestInvolvement,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestReviewPosition,
} from "@t3tools/contracts";

import * as GitLabCli from "./GitLabCli.ts";
import { type GitLabMergeRequestListItem } from "./gitLabMergeRequestJson.ts";

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
export const MAX_PAGE_SIZE = 100;
export const COMMIT_PAGE_SIZE = 100;
/**
 * GitLab 15.7 through 17.10 answer the merge request `/diffs` endpoint with a 500 for any
 * `per_page` above 30 (fixed in 17.11), so those pages stay at a size every version accepts.
 * A commit's own diff endpoint never had that bug and keeps the full page.
 */
export const MERGE_REQUEST_DIFF_PAGE_SIZE = 30;
export const diffPageSize = (commit: string | undefined) =>
  commit === undefined ? MERGE_REQUEST_DIFF_PAGE_SIZE : MAX_PAGE_SIZE;
export const CONVERSATION_PAGES = 10;
export const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DIFF_TIMEOUT_MS = 60_000;
export const isVcsProcessExitError = Schema.is(VcsProcessExitError);
export const DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;

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

export function projectPath(repository: string): string {
  return encodeURIComponent(repository.trim());
}

export function gitLabReviewPositionLines(
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

export function stateParam(state: PullRequestListState): string {
  return state === "open" ? "opened" : state;
}

export function involvementParams(input: {
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
export function filterParams(input: {
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

export function diffCursorPage(cursor: string): number | null {
  return /^[1-9][0-9]{0,6}$/.test(cursor) ? Number(cursor) : null;
}

export function searchParams(search: string | undefined): ReadonlyArray<readonly [string, string]> {
  const trimmed = search?.trim() ?? "";
  return trimmed.length === 0 ? [] : [["search", trimmed]];
}

export function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

export function actionArgs(
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
