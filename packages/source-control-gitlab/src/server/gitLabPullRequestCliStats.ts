import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type {
  PullRequestCheck,
  PullRequestReaction,
  PullRequestReviewDecision,
} from "@t3tools/contracts";

import {
  AWARD_EMOJI_GRAPHQL_QUERY,
  decodeAwardEmojiJson,
  decodeMergeRequestStatsJson,
  decodeProjectUsersJson,
  decodeRepositoryBlobsJson,
  decodeReviewDecisionsJson,
  decodeTriggerJobChecksJson,
  decodeViewerJson,
  MERGE_REQUEST_STATS_GRAPHQL_QUERY,
  REPOSITORY_BLOBS_GRAPHQL_QUERY,
  REVIEW_DECISIONS_GRAPHQL_QUERY,
  type GitLabProjectUsers,
} from "./gitLabMergeRequestJson.ts";

import {
  GitLabMergeRequestReadError,
  GitLabViewerUnavailableError,
  type GitLabPullRequestCliError,
  MAX_PAGE_SIZE,
  CONVERSATION_PAGES,
  projectPath,
  searchParams,
  query,
} from "./gitLabPullRequestCliSupport.ts";
import type { makeGitLabCliApi } from "./gitLabPullRequestCliApi.ts";
import type { GitLabPullRequestCli } from "./GitLabPullRequestCli.ts";

/** Statistics, blob and review reads built on the API layer. */
export const makeGitLabCliStats = (client: Effect.Success<typeof makeGitLabCliApi>) => {
  const api = client.api;
  const getDiffRefs = client.getDiffRefs;

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

  return {
    ...client,
    triggerJobChecks,
    projectUsers,
    awardSubjectPath,
    awardsPage,
    STAT_IIDS_PER_REQUEST,
    graphqlRead,
    mergeRequestStats,
    STAT_REQUEST_CONCURRENCY,
    listMergeRequestStats,
    BLOB_PATHS_PER_REQUEST,
    blobsAt,
    fileRevisions,
    reviewDecisionsOf,
    viewerUsername,
  };
};
