import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
} from "@t3tools/contracts";

import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
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
import type { ProviderListCursor } from "./PullRequestProvider.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class BitbucketPullRequestReadError extends Schema.TaggedErrorClass<BitbucketPullRequestReadError>()(
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

/** Not a decode failure: Bitbucket answered, the account it answered for just has no handle. */
export class BitbucketViewerUnavailableError extends Schema.TaggedErrorClass<BitbucketViewerUnavailableError>()(
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

/** A repository that is not `workspace/slug`, which is the only form Bitbucket addresses. */
export class BitbucketRepositoryUnsupportedError extends Schema.TaggedErrorClass<BitbucketRepositoryUnsupportedError>()(
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

/** Not a decode failure: the reader named a commit that is not a sha this repository could hold. */
export class BitbucketDiffCommitError extends Schema.TaggedErrorClass<BitbucketDiffCommitError>()(
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

/**
 * Bitbucket's own ceiling. Asking for more does not fail — it answers with an empty page and no
 * error at all, so this is a number to respect rather than to push against.
 */
const MAX_PAGE_SIZE = 50;
/** Pages to walk before a listing is reported as truncated. */
const MAX_LIST_PAGES = 10;
/** The page size for pull request conversations, commits, and checks. */
const CONVERSATION_PAGE_SIZE = 50;
/**
 * Pages of the conversation to follow before it is reported as truncated. Bitbucket serves
 * fifty comments a page, so this is five hundred — beyond any pull request a person is reading,
 * and an end to a walk whose only other stop is Bitbucket running out.
 */
const CONVERSATION_PAGES = 10;
/** The same ceiling the gh and glab diff reads use. */
const DIFF_MAX_BYTES = 8 * 1024 * 1024;

export interface BitbucketPullRequestBatch {
  readonly items: ReadonlyArray<BitbucketPullRequest>;
  readonly truncated: boolean;
}

export class BitbucketPullRequestApi extends Context.Service<
  BitbucketPullRequestApi,
  {
    /** A function rather than a value, so the request is built per call and not at layer time. */
    readonly getViewer: () => Effect.Effect<string, BitbucketPullRequestApiError>;

    readonly listPullRequests: (input: {
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly limit: number;
      /** Free text, matched against a pull request's title and description. */
      readonly query?: string | undefined;
      /** Where to carry on from, as a predicate on `updated_on` beside any other. */
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<BitbucketPullRequestBatch, BitbucketPullRequestApiError>;

    readonly getPullRequest: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<BitbucketPullRequest, BitbucketPullRequestApiError>;

    /** True where the credentials can write to the repository, which is what merging needs. */
    readonly getRepositoryPermission: (input: {
      readonly repository: string;
    }) => Effect.Effect<boolean, BitbucketPullRequestApiError>;

    readonly getPullRequestDiff: (input: {
      readonly repository: string;
      readonly number: number;
      /** One commit's own changes, rather than everything the pull request carries. */
      readonly commit?: string | undefined;
    }) => Effect.Effect<
      { readonly patch: string; readonly truncated: boolean },
      BitbucketPullRequestApiError
    >;

    readonly getDiffStat: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<BitbucketDiffStat, BitbucketPullRequestApiError>;

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

    /**
     * Who this pull request may be sent to, and who it has already been sent to. Two reads at
     * once, because Bitbucket keeps the people on the workspace and the reviewers on the pull
     * request, and neither answers for the other.
     */
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

    readonly comment: (input: {
      readonly repository: string;
      readonly number: number;
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
>()("t3/pullRequest/BitbucketPullRequestApi") {}

/** `workspace/slug`; Bitbucket has no deeper nesting to address. */
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

/**
 * A commit sha arrives from the reader and goes straight into a request path, so it is checked
 * rather than trusted: hexadecimal only, from the shortest abbreviation a host prints up to a
 * whole sha.
 */
function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

/**
 * Bitbucket unions repeated `state` parameters, so a tab that spans several of its states asks
 * for each. It separates a declined pull request from one superseded by another, and both read
 * as closed here.
 */
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

/**
 * Bitbucket has no search term, only a filter expression, so free text becomes one: a
 * case-insensitive contains against the two fields a pull request carries words in. The
 * parentheses matter, because the expression is ANDed with the state filter beside it and an
 * unbracketed `OR` would swallow it.
 *
 * A string literal in that grammar is delimited by double quotes, so the reader's text is
 * escaped before it goes inside one — a quote would otherwise end the literal and leave the
 * rest of the text standing as filter syntax. The whole expression is then URL-encoded, so
 * nothing in it reaches the query string as a parameter of its own.
 */
function searchFilter(query: string): string {
  const literal = filterLiteral(query);
  return `(title ~ "${literal}" OR description ~ "${literal}")`;
}

/**
 * Text as a string literal of Bitbucket's filter grammar. The backslash is escaped first, or
 * escaping the quote would only produce a literal backslash followed by a live quote.
 */
function filterLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Bitbucket's merge strategies, named differently from the three the contract carries. */
function mergeStrategy(method: PullRequestMergeMethod | undefined): string {
  switch (method) {
    case "squash":
      return "squash";
    case "rebase":
      // The linear history GitHub calls "rebase and merge".
      return "rebase_fast_forward";
    default:
      return "merge_commit";
  }
}

export const make = Effect.gen(function* () {
  const bitbucket = yield* BitbucketApi.BitbucketApi;

  /**
   * The repository's own path, and the workspace above it — which the people who may review are
   * kept on rather than on the repository, so both are handed over at once.
   */
  const withRepository = <A>(
    repository: string,
    use: (path: string, workspace: string) => Effect.Effect<A, BitbucketPullRequestApiError>,
  ): Effect.Effect<A, BitbucketPullRequestApiError> => {
    const segments = repositorySegments(repository);
    return Result.isSuccess(segments)
      ? use(repositoryPathOf(segments.success), segments.success.workspace)
      : Effect.fail(segments.failure);
  };

  /**
   * Bitbucket pages with a cursor rather than an offset, so the walk follows the `next` URL it
   * sends. It stops once the caller's page is filled, when Bitbucket reports no next page, or at
   * the page cap — and anything but running out of pages means there is more to be had.
   */
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
            // Bitbucket pages in fifties whatever was asked for, so a walk that stopped on the
            // count rather than on the last page is holding rows it is about to drop. Those are
            // more results just as surely as another page would be.
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

  /**
   * The conversation, following the `next` Bitbucket sends until it sends none. Threads are
   * assembled once at the end rather than per page, because a reply and the remark it answers
   * can land either side of a page boundary.
   */
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

  /** Walks a Bitbucket cursor to its end and combines every decoded item. */
  const itemPages = <A>(input: {
    readonly operation: string;
    readonly url: string;
    readonly decode: (
      body: string,
    ) => Result.Result<{ readonly items: ReadonlyArray<A>; readonly next: string | null }, unknown>;
    readonly items: ReadonlyArray<A>;
    /** Commit pages are individually oldest-first, so older pages are prepended. */
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

  /** Diffstat has one aggregate per page, so its totals are folded while following `next`. */
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

  return BitbucketPullRequestApi.of({
    getViewer: () =>
      bitbucket.request({ method: "GET", url: "/user" }).pipe(
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
      ),

    listPullRequests: (input) =>
      withRepository(input.repository, (path) => {
        const search = input.query?.trim() ?? "";
        // Both narrowings share the one `q` Bitbucket takes, so they are ANDed rather than one
        // replacing the other. The boundary instant is read inclusively — the rows already sent
        // at it come back and the caller drops them, which is what keeps their neighbours at the
        // same instant from being skipped. A date is a bare literal in this grammar, and this one
        // was checked against a timestamp's shape before it got here.
        const predicates = [
          ...(search.length === 0 ? [] : [searchFilter(search)]),
          ...(input.cursor === undefined ? [] : [`updated_on <= ${input.cursor.updatedBefore}`]),
        ];
        return listPage({
          // Reviewers are not on a listing by default, and `viewerReviewRequested` needs them.
          url: `${path}/pullrequests?${stateParams(input.state)
            .map((state) => `state=${state}`)
            .join("&")}&pagelen=${MAX_PAGE_SIZE}&sort=-updated_on&fields=%2Bvalues.reviewers${
            predicates.length === 0 ? "" : `&q=${encodeURIComponent(predicates.join(" AND "))}`
          }`,
          limit: input.limit,
          page: 1,
          collected: [],
        });
      }),

    getPullRequest: (input) =>
      withRepository(input.repository, (path) =>
        readPage({
          operation: "getPullRequest",
          url: `${path}/pullrequests/${input.number}`,
          decode: decodePullRequestJson,
        }),
      ),

    // Nothing on the repository, the pull request or the workspace states what the credentials
    // may do, so this endpoint is the one request Bitbucket makes unavoidable. It is asked
    // alongside the reads the detail was already making, so it costs no round trip of its own.
    getRepositoryPermission: (input) =>
      withRepository(input.repository, () =>
        readPage({
          operation: "getRepositoryPermission",
          url: `/user/permissions/repositories?q=${encodeURIComponent(
            `repository.full_name="${filterLiteral(input.repository.trim())}"`,
          )}`,
          decode: decodeRepositoryPermissionJson,
        }),
      ),

    getPullRequestDiff: (input) =>
      input.commit !== undefined && !isCommitSha(input.commit)
        ? Effect.fail(new BitbucketDiffCommitError())
        : withRepository(input.repository, (path) =>
            // Already a unified patch, so it needs no decoding at all — only a bound, which a
            // diff of any size would otherwise ignore. A commit's own patch sits beside the pull
            // request's at `/diff/{sha}` and reads the same way.
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
          ),

    getDiffStat: (input) =>
      withRepository(input.repository, (path) =>
        diffStatPages({
          url: `${path}/pullrequests/${input.number}/diffstat?pagelen=${MAX_PAGE_SIZE}`,
          totals: { additions: 0, deletions: 0, changedFiles: 0 },
        }),
      ),

    getMergeability: (input) =>
      withRepository(input.repository, (path) =>
        readPage({
          operation: "getMergeability",
          url: `${path}/pullrequests/${input.number}/conflicts`,
          decode: decodeConflictsJson,
        }),
      ),

    listComments: (input) =>
      withRepository(input.repository, (path) =>
        commentsPage({
          url: `${path}/pullrequests/${input.number}/comments?pagelen=${CONVERSATION_PAGE_SIZE}`,
          page: 1,
          comments: [],
          entries: [],
        }),
      ),

    listCommits: (input) =>
      withRepository(input.repository, (path) =>
        itemPages({
          operation: "listCommits",
          url: `${path}/pullrequests/${input.number}/commits?pagelen=${CONVERSATION_PAGE_SIZE}`,
          decode: decodeCommitsJson,
          items: [],
          prepend: true,
        }),
      ),

    listChecks: (input) =>
      withRepository(input.repository, (path) =>
        itemPages({
          operation: "listChecks",
          url: `${path}/pullrequests/${input.number}/statuses?pagelen=${CONVERSATION_PAGE_SIZE}`,
          decode: decodeStatusesJson,
          items: [],
          prepend: false,
        }),
      ),

    listReviewerCandidates: (input) =>
      withRepository(input.repository, (path, workspace) =>
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
              // The author is dropped rather than shown unusable: Bitbucket refuses to make the
              // person who opened a pull request its reviewer.
              candidates: members.items.flatMap((candidate) =>
                candidate.login === author
                  ? []
                  : [{ ...candidate, isRequested: requested.has(candidate.id) }],
              ),
              truncated: members.next !== null,
            };
          }),
        ),
      ),

    setReviewerRequest: (input) =>
      withRepository(input.repository, (path) => {
        const pullRequest = `${path}/pullrequests/${input.number}`;
        return readPage({
          operation: "getPullRequest",
          url: pullRequest,
          decode: decodePullRequestJson,
        }).pipe(
          Effect.flatMap((current) => {
            // Bitbucket has no endpoint that adds or removes one reviewer: the pull request's
            // `reviewers` is written whole, so the set that is already there is read first and
            // the change applied to it. Everything else about the pull request is left out of
            // the body, which leaves it as it was.
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
      }),

    runAction: (input) =>
      withRepository(input.repository, (path) => {
        const pullRequest = `${path}/pullrequests/${input.number}`;
        // Only merge and close reach here: the provider declares the others unsupported, so the
        // surface never offers them.
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
      }),

    comment: (input) =>
      withRepository(input.repository, (path) =>
        bitbucket
          .request({
            method: "POST",
            url: `${path}/pullrequests/${input.number}/comments`,
            // A JSON document rather than a form field, so the body stays text whatever it says.
            body: JSON.stringify({ content: { raw: input.body } }),
          })
          .pipe(Effect.asVoid),
      ),

    submitReview: (input) =>
      withRepository(input.repository, (path) =>
        Effect.gen(function* () {
          const pullRequest = `${path}/pullrequests/${input.number}`;
          // Bitbucket has no pending review, so a review is replayed as the requests it is
          // made of: the line comments, then the summary, then the verdict. The verdict goes
          // last so a review that fails part-way is never left standing as an approval.
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
                    ...(comment.side === "left" ? { from: comment.line } : { to: comment.line }),
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
      ),

    replyToComment: (input) =>
      withRepository(input.repository, (path) =>
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
      ),

    setCommentResolution: (input) =>
      withRepository(input.repository, (path) =>
        bitbucket
          .request({
            // Resolving is a sub-resource that is created and deleted, rather than a field.
            method: input.resolved ? "POST" : "DELETE",
            url: `${path}/pullrequests/${input.number}/comments/${encodeURIComponent(
              input.commentId,
            )}/resolve`,
          })
          .pipe(Effect.asVoid),
      ),
  });
});

export const layer = Layer.effect(BitbucketPullRequestApi, make);
