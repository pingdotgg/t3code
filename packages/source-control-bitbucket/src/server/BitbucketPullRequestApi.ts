import { isCommitSha } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestReviewCommentDraft,
  PullRequestReviewPosition,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
} from "@t3tools/contracts";

import * as BitbucketApi from "./BitbucketApi.ts";
import { parseDiffFileRevisions } from "@t3tools/source-control-core/server/diffFileRevisions";
import { sortChecks } from "@t3tools/source-control-core/server/pullRequestChecks";
import {
  buildReviewThreads,
  decodeCommentsJson,
  decodeCommitsJson,
  decodeConflictsJson,
  decodeDiffstatJson,
  decodePullRequestJson,
  decodePullRequestPageJson,
  decodeRepositoryPermissionJson,
  decodeStatusesJson,
  decodeViewerJson,
  decodeWorkspaceMembersJson,
  type BitbucketDiffStat,
  type BitbucketPullRequest,
  type BitbucketRawComment,
} from "./bitbucketPullRequestJson.ts";
import type { ProviderListCursor } from "@t3tools/source-control-core/server/PullRequestProvider";

export class BitbucketPullRequestReadError extends Schema.TaggedError<BitbucketPullRequestReadError>()(
  "BitbucketPullRequestReadError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Bitbucket returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `Bitbucket failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketViewerUnavailableError extends Schema.TaggedError<BitbucketViewerUnavailableError>()(
  "BitbucketViewerUnavailableError",
  {},
) {
  get detail(): string {
    return "Bitbucket returned no account name for the configured credentials.";
  }

  override get message(): string {
    return `Bitbucket failed in getViewer: ${this.detail}`;
  }
}

export class BitbucketRepositoryUnsupportedError extends Schema.TaggedError<BitbucketRepositoryUnsupportedError>()(
  "BitbucketRepositoryUnsupportedError",
  {
    repository: Schema.String,
  },
) {
  get detail(): string {
    return "A Bitbucket repository is addressed as workspace/repository.";
  }

  override get message(): string {
    return `Bitbucket failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketDiffCommitError extends Schema.TaggedError<BitbucketDiffCommitError>()(
  "BitbucketDiffCommitError",
  {},
) {
  get detail(): string {
    return "The named commit was not a commit sha.";
  }

  override get message(): string {
    return `Bitbucket failed in getPullRequestDiff: ${this.detail}`;
  }
}

export type BitbucketPullRequestApiError =
  | BitbucketApi.BitbucketApiError
  | BitbucketPullRequestReadError
  | BitbucketViewerUnavailableError
  | BitbucketRepositoryUnsupportedError
  | BitbucketDiffCommitError;

function isRepositoryPermissionUnavailableError(
  error: BitbucketPullRequestApiError,
): error is BitbucketApi.BitbucketResponseError {
  return (
    error._tag === "BitbucketResponseError" &&
    (error.status === 403 || error.status === 404 || error.status === 410)
  );
}

/** Requests above this size return an empty page without an error. */
const MAX_PAGE_SIZE = 50;
const MAX_LIST_PAGES = 10;
const CONVERSATION_PAGE_SIZE = 50;
const CONVERSATION_PAGES = 10;
const DIFF_MAX_BYTES = 8 * 1024 * 1024;
/** Must expire before the caller's version cache so refreshes reach Bitbucket. */
const REVISION_PATCH_TTL = Duration.seconds(5);
const REVISION_PATCH_CAPACITY = 16;
const encodeRevisionKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Number])),
);
export interface BitbucketPullRequestBatch {
  readonly items: ReadonlyArray<BitbucketPullRequest>;
  readonly truncated: boolean;
}

export class BitbucketPullRequestApi extends Context.Service<
  BitbucketPullRequestApi,
  {
    readonly getViewer: () => Effect.Effect<string, BitbucketPullRequestApiError>;

    readonly listPullRequests: (input: {
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly limit: number;
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
      /** Matched against the login a row shows, which is the nickname or else the display name. */
      readonly author?: string | undefined;
      readonly draft?: boolean | undefined;
    }) => Effect.Effect<BitbucketPullRequestBatch, BitbucketPullRequestApiError>;

    readonly getPullRequest: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<BitbucketPullRequest, BitbucketPullRequestApiError>;

    readonly getRepositoryPermission: (input: {
      readonly repository: string;
    }) => Effect.Effect<boolean, BitbucketPullRequestApiError>;

    readonly getPullRequestDiff: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commit?: string | undefined;
    }) => Effect.Effect<
      { readonly patch: string; readonly truncated: boolean },
      BitbucketPullRequestApiError
    >;

    readonly getDiffStat: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<BitbucketDiffStat, BitbucketPullRequestApiError>;

    /** Truncated patches cannot identify absent paths as deleted. */
    readonly getFileRevisions: (input: {
      readonly repository: string;
      readonly number: number;
      readonly paths: ReadonlyArray<string>;
    }) => Effect.Effect<
      { readonly revisions: ReadonlyMap<string, string>; readonly complete: boolean },
      BitbucketPullRequestApiError
    >;

    readonly getMergeability: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestMergeability, BitbucketPullRequestApiError>;

    readonly listComments: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      {
        readonly comments: ReadonlyArray<PullRequestComment>;
        readonly threads: ReadonlyArray<PullRequestReviewThread>;
        readonly truncated: boolean;
      },
      BitbucketPullRequestApiError
    >;

    readonly listCommits: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCommit>, BitbucketPullRequestApiError>;

    readonly listChecks: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCheck>, BitbucketPullRequestApiError>;

    readonly listReviewerCandidates: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestReviewerCandidateList, BitbucketPullRequestApiError>;

    readonly setReviewerRequest: (input: {
      readonly repository: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<{ readonly id: string }>;
      readonly requested: boolean;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly runAction: (input: {
      readonly repository: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly updateChangeRequest: (input: {
      readonly repository: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly comment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly updateComment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commentId: string;
      readonly body: string;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly submitReview: (input: {
      readonly repository: string;
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly replyToComment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commentId: string;
      readonly body: string;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;

    readonly setCommentResolution: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commentId: string;
      readonly resolved: boolean;
    }) => Effect.Effect<void, BitbucketPullRequestApiError>;
  }
>()("@t3tools/source-control-bitbucket/server/BitbucketPullRequestApi") {}

function repositorySegments(
  repository: string,
): Result.Result<
  { readonly workspace: string; readonly slug: string },
  BitbucketRepositoryUnsupportedError
> {
  const segments = repository
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const [workspace, slug] = segments;
  if (segments.length !== 2 || workspace === undefined || slug === undefined) {
    return Result.fail(new BitbucketRepositoryUnsupportedError({ repository }));
  }
  return Result.succeed({ workspace, slug });
}

function repositoryPathOf(segments: { readonly workspace: string; readonly slug: string }): string {
  return `/repositories/${encodeURIComponent(segments.workspace)}/${encodeURIComponent(
    segments.slug,
  )}`;
}

function stateParams(state: PullRequestListState): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return ["OPEN"];
    case "merged":
      return ["MERGED"];
    case "closed":
      return ["DECLINED", "SUPERSEDED"];
    case "all":
      return ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"];
  }
}

function searchFilter(query: string): string {
  const literal = filterLiteral(query);
  return `(title ~ "${literal}" OR description ~ "${literal}")`;
}

function authorFilter(login: string): string {
  const literal = filterLiteral(login);
  return `(author.nickname = "${literal}" OR author.display_name = "${literal}")`;
}

/**
 * The backslash is escaped first, or escaping the quote would only produce a literal
 * backslash followed by a live quote.
 */
function filterLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

// Bitbucket keeps microseconds; include the cursor's whole millisecond before excluding seen IDs.
function updatedBeforeFilter(updatedBefore: string): string {
  return Option.match(DateTime.make(updatedBefore), {
    onNone: () => `updated_on <= ${updatedBefore}`,
    onSome: (instant) =>
      `updated_on < ${DateTime.formatIso(DateTime.add(instant, { milliseconds: 1 }))}`,
  });
}

function mergeStrategy(method: PullRequestMergeMethod | undefined): string {
  switch (method) {
    case "squash":
      return "squash";
    case "rebase":
      return "rebase_fast_forward";
    default:
      return "merge_commit";
  }
}

function bitbucketReviewPosition(
  position: PullRequestReviewPosition,
): { readonly from: number } | { readonly to: number } {
  switch (position.kind) {
    case "added":
      return { to: position.newLine };
    case "deleted":
      return { from: position.oldLine };
    case "context":
      return position.side === "left" ? { from: position.oldLine } : { to: position.newLine };
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const bitbucket = yield* BitbucketApi.BitbucketApi;

  const withRepository = <A>(
    repository: string,
    use: (
      path: string,
      workspace: string,
      slug: string,
    ) => Effect.Effect<A, BitbucketPullRequestApiError>,
  ): Effect.Effect<A, BitbucketPullRequestApiError> => {
    const segments = repositorySegments(repository);
    return Result.isSuccess(segments)
      ? use(repositoryPathOf(segments.success), segments.success.workspace, segments.success.slug)
      : Effect.fail(segments.failure);
  };

  const listPage = (input: {
    readonly url: string;
    readonly limit: number;
    readonly page: number;
    readonly collected: ReadonlyArray<BitbucketPullRequest>;
  }): Effect.Effect<BitbucketPullRequestBatch, BitbucketPullRequestApiError> =>
    bitbucket.request({ method: "GET", url: input.url }).pipe(
      Effect.flatMap((response) => {
        const decoded = decodePullRequestPageJson(response.body);
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new BitbucketPullRequestReadError({
              operation: "listPullRequests",
              cause: decoded.failure,
            }),
          );
        }
        const collected = [...input.collected, ...decoded.success.items];
        const next = decoded.success.next;
        if (next === null || collected.length >= input.limit || input.page >= MAX_LIST_PAGES) {
          return Effect.succeed({
            items: collected.slice(0, input.limit),
            truncated: next !== null || collected.length > input.limit,
          });
        }
        return listPage({ ...input, url: next, page: input.page + 1, collected });
      }),
    );

  const readPage = <A>(input: {
    readonly operation: string;
    readonly url: string;
    readonly decode: (body: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, BitbucketPullRequestApiError> =>
    bitbucket.request({ method: "GET", url: input.url }).pipe(
      Effect.flatMap((response) => {
        const decoded = input.decode(response.body);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new BitbucketPullRequestReadError({
                operation: input.operation,
                cause: decoded.failure,
              }),
            );
      }),
    );

  /** Replies and parents can span pages; assemble threads after pagination. */
  const commentsPage = (input: {
    readonly url: string;
    readonly page: number;
    readonly comments: ReadonlyArray<PullRequestComment>;
    readonly entries: ReadonlyArray<BitbucketRawComment>;
  }): Effect.Effect<
    {
      readonly comments: ReadonlyArray<PullRequestComment>;
      readonly threads: ReadonlyArray<PullRequestReviewThread>;
      readonly truncated: boolean;
    },
    BitbucketPullRequestApiError
  > =>
    readPage({ operation: "listComments", url: input.url, decode: decodeCommentsJson }).pipe(
      Effect.flatMap((page) => {
        const comments = [...input.comments, ...page.comments];
        const entries = [...input.entries, ...page.entries];
        if (page.next !== null && input.page < CONVERSATION_PAGES) {
          return commentsPage({ url: page.next, page: input.page + 1, comments, entries });
        }
        return Effect.succeed({
          comments,
          threads: buildReviewThreads(entries),
          truncated: page.next !== null,
        });
      }),
    );

  const itemPages = <A>(input: {
    readonly operation: string;
    readonly url: string;
    readonly decode: (
      body: string,
    ) => Result.Result<{ readonly items: ReadonlyArray<A>; readonly next: string | null }, unknown>;
    readonly items: ReadonlyArray<A>;
    /** Each commit page is oldest-first. */
    readonly prepend: boolean;
  }): Effect.Effect<ReadonlyArray<A>, BitbucketPullRequestApiError> =>
    readPage({ operation: input.operation, url: input.url, decode: input.decode }).pipe(
      Effect.flatMap((page) => {
        const items = input.prepend
          ? [...page.items, ...input.items]
          : [...input.items, ...page.items];
        return page.next === null
          ? Effect.succeed(items)
          : itemPages({ ...input, url: page.next, items });
      }),
    );

  const diffStatPages = (input: {
    readonly url: string;
    readonly totals: BitbucketDiffStat;
  }): Effect.Effect<BitbucketDiffStat, BitbucketPullRequestApiError> =>
    readPage({ operation: "getDiffStat", url: input.url, decode: decodeDiffstatJson }).pipe(
      Effect.flatMap((page) => {
        const totals = {
          additions: input.totals.additions + page.additions,
          deletions: input.totals.deletions + page.deletions,
          changedFiles: input.totals.changedFiles + page.changedFiles,
        };
        return page.next === null
          ? Effect.succeed(totals)
          : diffStatPages({ url: page.next, totals });
      }),
    );

  const pullRequestDiff = (input: {
    readonly repository: string;
    readonly number: number;
    readonly commit?: string | undefined;
  }): Effect.Effect<
    { readonly patch: string; readonly truncated: boolean },
    BitbucketPullRequestApiError
  > =>
    input.commit !== undefined && !isCommitSha(input.commit)
      ? Effect.fail(new BitbucketDiffCommitError())
      : withRepository(input.repository, (path) =>
          bitbucket
            .request({
              method: "GET",
              url:
                input.commit === undefined
                  ? `${path}/pullrequests/${input.number}/diff`
                  : `${path}/diff/${input.commit}`,
              maxBytes: DIFF_MAX_BYTES,
            })
            .pipe(
              Effect.map((response) => ({ patch: response.body, truncated: response.truncated })),
            ),
        );

  // Cache revisions, not large patch bodies that need reparsing.
  const revisionPatches = yield* Cache.makeWith(
    (key: string) => {
      const [repository, number] = JSON.parse(key) as [string, number];
      return pullRequestDiff({ repository, number }).pipe(
        Effect.map((diff) => ({
          revisions: parseDiffFileRevisions(diff.patch),
          truncated: diff.truncated,
        })),
      );
    },
    {
      capacity: REVISION_PATCH_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? REVISION_PATCH_TTL : Duration.zero),
    },
  );

  return BitbucketPullRequestApi.of({
    getViewer: Effect.fn("BitbucketPullRequestApi.getViewer")(function () {
      return bitbucket.request({ method: "GET", url: "/user" }).pipe(
        Effect.flatMap((response): Effect.Effect<string, BitbucketPullRequestApiError> => {
          const decoded = decodeViewerJson(response.body);
          if (!Result.isSuccess(decoded)) {
            return Effect.fail(
              new BitbucketPullRequestReadError({ operation: "getViewer", cause: decoded.failure }),
            );
          }
          return decoded.success === null
            ? Effect.fail(new BitbucketViewerUnavailableError())
            : Effect.succeed(decoded.success);
        }),
      );
    }),

    listPullRequests: Effect.fn("BitbucketPullRequestApi.listPullRequests")(function (input) {
      return withRepository(input.repository, (path) => {
        const search = input.query?.trim() ?? "";
        // Exclude already-sent IDs in the boundary millisecond before applying the page limit.
        const predicates = [
          ...(search.length === 0 ? [] : [searchFilter(search)]),
          ...(input.author === undefined ? [] : [authorFilter(input.author)]),
          ...(input.draft === undefined ? [] : [`draft = ${input.draft}`]),
          ...(input.cursor === undefined ? [] : [updatedBeforeFilter(input.cursor.updatedBefore)]),
          ...(input.cursor?.seenAt ?? []).map((number) => `id != ${number}`),
        ];
        return listPage({
          // Listings omit reviewers needed by `viewerReviewRequested`.
          url: `${path}/pullrequests?${stateParams(input.state)
            .map((state) => `state=${state}`)
            .join("&")}&pagelen=${MAX_PAGE_SIZE}&sort=-updated_on&fields=%2Bvalues.reviewers${
            predicates.length === 0 ? "" : `&q=${encodeURIComponent(predicates.join(" AND "))}`
          }`,
          limit: input.limit,
          page: 1,
          collected: [],
        });
      });
    }),

    getPullRequest: Effect.fn("BitbucketPullRequestApi.getPullRequest")(function (input) {
      return withRepository(input.repository, (path) =>
        readPage({
          operation: "getPullRequest",
          // Settlement needs `closed_on`, omitted by default.
          url: `${path}/pullrequests/${input.number}?fields=%2Bclosed_on`,
          decode: decodePullRequestJson,
        }),
      );
    }),

    // Permission endpoints may return 403/404/410 (CHANGE-2770); let writes enforce access.
    getRepositoryPermission: Effect.fn("BitbucketPullRequestApi.getRepositoryPermission")(
      function (input) {
        return withRepository(input.repository, (_path, workspace, slug) =>
          readPage({
            operation: "getRepositoryPermission",
            url: `/user/workspaces/${encodeURIComponent(workspace)}/permissions/repositories?q=${encodeURIComponent(
              `repository.full_name="${filterLiteral(`${workspace}/${slug}`)}"`,
            )}`,
            decode: decodeRepositoryPermissionJson,
          }),
        ).pipe(Effect.catchIf(isRepositoryPermissionUnavailableError, () => Effect.succeed(true)));
      },
    ),

    getPullRequestDiff: pullRequestDiff,

    getFileRevisions: Effect.fn("BitbucketPullRequestApi.getFileRevisions")(function* (input) {
      if (input.paths.length === 0)
        return { revisions: new Map<string, string>(), complete: false };
      return yield* Cache.get(
        revisionPatches,
        encodeRevisionKey([input.repository, input.number]),
      ).pipe(
        Effect.map((diff) => {
          const revisions = new Map(diff.revisions);
          // A truncated patch cannot identify absent paths as deleted.
          if (!diff.truncated) {
            for (const path of input.paths) {
              if (!revisions.has(path)) revisions.set(path, "");
            }
          }
          return { revisions, complete: !diff.truncated };
        }),
      );
    }),

    getDiffStat: Effect.fn("BitbucketPullRequestApi.getDiffStat")(function (input) {
      return withRepository(input.repository, (path) =>
        diffStatPages({
          url: `${path}/pullrequests/${input.number}/diffstat?pagelen=${MAX_PAGE_SIZE}`,
          totals: { additions: 0, deletions: 0, changedFiles: 0 },
        }),
      );
    }),

    getMergeability: Effect.fn("BitbucketPullRequestApi.getMergeability")(function (input) {
      return withRepository(input.repository, (path) =>
        readPage({
          operation: "getMergeability",
          url: `${path}/pullrequests/${input.number}/conflicts`,
          decode: decodeConflictsJson,
        }),
      );
    }),

    listComments: Effect.fn("BitbucketPullRequestApi.listComments")(function (input) {
      return withRepository(input.repository, (path) =>
        commentsPage({
          url: `${path}/pullrequests/${input.number}/comments?pagelen=${CONVERSATION_PAGE_SIZE}`,
          page: 1,
          comments: [],
          entries: [],
        }),
      );
    }),

    listCommits: Effect.fn("BitbucketPullRequestApi.listCommits")(function (input) {
      return withRepository(input.repository, (path) =>
        itemPages({
          operation: "listCommits",
          url: `${path}/pullrequests/${input.number}/commits?pagelen=${CONVERSATION_PAGE_SIZE}`,
          decode: decodeCommitsJson,
          items: [],
          prepend: true,
        }),
      );
    }),

    listChecks: Effect.fn("BitbucketPullRequestApi.listChecks")(function (input) {
      return withRepository(input.repository, (path) =>
        itemPages({
          operation: "listChecks",
          url: `${path}/pullrequests/${input.number}/statuses?pagelen=${CONVERSATION_PAGE_SIZE}`,
          decode: decodeStatusesJson,
          items: [],
          prepend: false,
        }).pipe(Effect.map(sortChecks)),
      );
    }),

    listReviewerCandidates: Effect.fn("BitbucketPullRequestApi.listReviewerCandidates")(
      function (input) {
        return withRepository(input.repository, (path, workspace) =>
          Effect.all(
            [
              readPage({
                operation: "getPullRequest",
                url: `${path}/pullrequests/${input.number}`,
                decode: decodePullRequestJson,
              }),
              readPage({
                operation: "listReviewerCandidates",
                url: `/workspaces/${encodeURIComponent(workspace)}/members?pagelen=${MAX_PAGE_SIZE}`,
                decode: decodeWorkspaceMembersJson,
              }),
            ],
            { concurrency: 2 },
          ).pipe(
            Effect.map(([pullRequest, members]) => {
              const requested = new Set(pullRequest.reviewerIds);
              const author = pullRequest.author?.login;
              return {
                // Bitbucket forbids requesting a review from the PR author.
                candidates: members.items.flatMap((candidate) =>
                  candidate.login === author
                    ? []
                    : [{ ...candidate, isRequested: requested.has(candidate.id) }],
                ),
                truncated: members.next !== null,
              };
            }),
          ),
        );
      },
    ),

    setReviewerRequest: Effect.fn("BitbucketPullRequestApi.setReviewerRequest")(function (input) {
      return withRepository(input.repository, (path) => {
        const pullRequest = `${path}/pullrequests/${input.number}`;
        return readPage({
          operation: "getPullRequest",
          url: pullRequest,
          decode: decodePullRequestJson,
        }).pipe(
          Effect.flatMap((current) => {
            // Bitbucket replaces the entire reviewer list.
            const uuids = new Set(current.reviewerIds);
            for (const reviewer of input.reviewers) {
              if (input.requested) uuids.add(reviewer.id);
              else uuids.delete(reviewer.id);
            }
            return bitbucket.request({
              method: "PUT",
              url: pullRequest,
              body: JSON.stringify({ reviewers: [...uuids].map((uuid) => ({ uuid })) }),
            });
          }),
          Effect.asVoid,
        );
      });
    }),

    runAction: Effect.fn("BitbucketPullRequestApi.runAction")(function (input) {
      return withRepository(input.repository, (path) => {
        const pullRequest = `${path}/pullrequests/${input.number}`;
        if (input.action === "merge") {
          return bitbucket
            .request({
              method: "POST",
              url: `${pullRequest}/merge`,
              body: JSON.stringify({ merge_strategy: mergeStrategy(input.mergeMethod) }),
            })
            .pipe(Effect.asVoid);
        }
        return bitbucket
          .request({ method: "POST", url: `${pullRequest}/decline` })
          .pipe(Effect.asVoid);
      });
    }),

    updateChangeRequest: Effect.fn("BitbucketPullRequestApi.updateChangeRequest")(function (input) {
      return withRepository(input.repository, (path) =>
        // Partial PUTs preserve concurrent edits to unchanged fields.
        bitbucket
          .request({
            method: "PUT",
            url: `${path}/pullrequests/${input.number}`,
            body: JSON.stringify({
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.body === undefined ? {} : { description: input.body }),
            }),
          })
          .pipe(Effect.asVoid),
      );
    }),

    comment: Effect.fn("BitbucketPullRequestApi.comment")(function (input) {
      return withRepository(input.repository, (path) =>
        bitbucket
          .request({
            method: "POST",
            url: `${path}/pullrequests/${input.number}/comments`,
            body: JSON.stringify({ content: { raw: input.body } }),
          })
          .pipe(Effect.asVoid),
      );
    }),

    updateComment: Effect.fn("BitbucketPullRequestApi.updateComment")(function (input) {
      return withRepository(input.repository, (path) =>
        bitbucket
          .request({
            method: "PUT",
            url: `${path}/pullrequests/${input.number}/comments/${encodeURIComponent(
              input.commentId,
            )}`,
            body: JSON.stringify({ content: { raw: input.body } }),
          })
          .pipe(Effect.asVoid),
      );
    }),

    submitReview: Effect.fn("BitbucketPullRequestApi.submitReview")(function (input) {
      return withRepository(input.repository, (path) =>
        Effect.gen(function* () {
          const pullRequest = `${path}/pullrequests/${input.number}`;
          // A partially failed review must not leave an approval.
          yield* Effect.forEach(
            input.comments,
            (comment) =>
              bitbucket.request({
                method: "POST",
                url: `${pullRequest}/comments`,
                body: JSON.stringify({
                  content: { raw: comment.body },
                  inline: {
                    path: comment.path,
                    ...bitbucketReviewPosition(comment.position),
                  },
                }),
              }),
            { discard: true },
          );
          if (input.body.trim().length > 0) {
            yield* bitbucket.request({
              method: "POST",
              url: `${pullRequest}/comments`,
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              body: JSON.stringify({ content: { raw: input.body } }),
            });
          }
          if (input.verdict === "approve") {
            yield* bitbucket.request({ method: "POST", url: `${pullRequest}/approve` });
          }
          if (input.verdict === "request-changes") {
            yield* bitbucket.request({ method: "POST", url: `${pullRequest}/request-changes` });
          }
        }),
      );
    }),

    replyToComment: Effect.fn("BitbucketPullRequestApi.replyToComment")(function (input) {
      return withRepository(input.repository, (path) =>
        bitbucket
          .request({
            method: "POST",
            url: `${path}/pullrequests/${input.number}/comments`,
            body: JSON.stringify({
              content: { raw: input.body },
              parent: { id: Number(input.commentId) },
            }),
          })
          .pipe(Effect.asVoid),
      );
    }),

    setCommentResolution: Effect.fn("BitbucketPullRequestApi.setCommentResolution")(
      function (input) {
        return withRepository(input.repository, (path) =>
          bitbucket
            .request({
              method: input.resolved ? "POST" : "DELETE",
              url: `${path}/pullrequests/${input.number}/comments/${encodeURIComponent(
                input.commentId,
              )}/resolve`,
            })
            .pipe(Effect.asVoid),
        );
      },
    ),
  });
});

export const layer = Layer.effect(BitbucketPullRequestApi, make);
