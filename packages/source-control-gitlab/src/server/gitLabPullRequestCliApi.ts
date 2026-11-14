import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type {
  PullRequestComment,
  PullRequestInvolvement,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestReviewThread,
} from "@t3tools/contracts";

import * as GitLabCli from "./GitLabCli.ts";
import {
  decodeCommitDiffRefsJson,
  decodeDiffRefsJson,
  decodeDiscussionsJson,
  decodeMergeRequestDetailJson,
  decodeMergeRequestDiffsJson,
  decodeMergeRequestChangesJson,
  decodeMergeRequestListJson,
  decodeNotesJson,
  type GitLabDiffRefs,
  type GitLabMergeRequestDetail,
  type GitLabMergeRequestListItem,
} from "./gitLabMergeRequestJson.ts";
import type { ProviderListCursor } from "@t3tools/source-control-core/server/PullRequestProvider";

import {
  GitLabMergeRequestReadError,
  GitLabDiffRefsUnavailableError,
  GitLabDiffCommitParentUnavailableError,
  type GitLabPullRequestCliError,
  MAX_PAGE_SIZE,
  diffPageSize,
  CONVERSATION_PAGES,
  DIFF_MAX_OUTPUT_BYTES,
  DIFF_TIMEOUT_MS,
  isVcsProcessExitError,
  type GitLabMergeRequestListBatch,
  type GitLabMergeRequestDiffSlice,
  projectPath,
  stateParam,
  involvementParams,
  filterParams,
  searchParams,
  query,
} from "./gitLabPullRequestCliSupport.ts";

/** GitLab API reads: paged merge-request, diff and conversation fetches. */
export const makeGitLabCliApi = Effect.gen(function* () {
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

  return {
    gitlab,
    api,
    listPage,
    diffPage,
    notesPage,
    discussionsPage,
    getDiffRefs,
    getCommitDiffRefs,
    mergeRequestDetail,
  };
});
