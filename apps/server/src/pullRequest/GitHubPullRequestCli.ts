import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestActor,
  PullRequestInvolvement,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestReviewCommentDraft,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
  PullRequestReviewerKind,
  PullRequestThreadComment,
} from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import {
  ACTOR_AVATARS_GRAPHQL_QUERY,
  buildReviewSubmissionJson,
  buildReviewerRequestJson,
  decodeActorAvatarsJson,
  decodePullRequestActivityJson,
  decodePullRequestDetailJson,
  decodePullRequestFilesJson,
  decodePullRequestListJson,
  decodePullRequestSearchJson,
  decodePullRequestStatsJson,
  decodeRepositoryAccessJson,
  decodeReviewerCandidatesJson,
  decodeReviewThreadCommentsJson,
  decodeReviewThreadsJson,
  buildPullRequestStatsGraphQlQuery,
  encodeGraphQlRequestJson,
  pullRequestSearchGraphQlQuery,
  PULL_REQUEST_SEARCH_MAX_ROWS,
  PULL_REQUEST_ACTIVITY_JSON_FIELDS,
  PULL_REQUEST_DETAIL_JSON_FIELDS,
  PULL_REQUEST_LIST_JSON_FIELDS,
  REPOSITORY_ACCESS_JSON_FIELDS,
  RESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
  REVIEWER_CANDIDATES_GRAPHQL_QUERY,
  REVIEW_THREAD_COMMENTS_GRAPHQL_QUERY,
  REVIEW_THREAD_REPLY_GRAPHQL_MUTATION,
  REVIEW_THREADS_GRAPHQL_QUERY,
  reviewThreadConversation,
  UNRESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
  VIEWER_PERMISSIONS_GRAPHQL_QUERY,
  decodeViewerPermissionsJson,
  type GitHubPullRequestDetail,
  type GitHubPullRequestActivity,
  type GitHubPullRequestListItem,
  type GitHubPullRequestSearchItem,
  type GitHubReviewThreadComments,
  type GitHubRepositoryAccess,
  type GitHubReviewThreadEntry,
  type GitHubReviewThreadPage,
  type GitHubViewerAccess,
} from "./gitHubPullRequestJson.ts";
import type { ProviderListCursor } from "./PullRequestProvider.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class GitHubPullRequestReadError extends Schema.TaggedErrorClass<GitHubPullRequestReadError>()(
  "GitHubPullRequestReadError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `GitHub CLI returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
  }
}

/** Not a decode failure: gh answered, the account it answered for just has no login. */
export class GitHubViewerLoginUnavailableError extends Schema.TaggedErrorClass<GitHubViewerLoginUnavailableError>()(
  "GitHubViewerLoginUnavailableError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "GitHub CLI returned no login for the authenticated account.";
  }

  override get message(): string {
    return `GitHub CLI failed in getViewerLogin: ${this.detail}`;
  }
}

/** Not a decode failure: the reader asked to carry on from a cursor this walk never handed out. */
export class GitHubDiffCursorError extends Schema.TaggedErrorClass<GitHubDiffCursorError>()(
  "GitHubDiffCursorError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "The diff cursor was not one this pull request handed out.";
  }

  override get message(): string {
    return `GitHub CLI failed in getPullRequestDiff: ${this.detail}`;
  }
}

/** Not a decode failure: the reader named a commit that is not a sha this repository could hold. */
export class GitHubDiffCommitError extends Schema.TaggedErrorClass<GitHubDiffCommitError>()(
  "GitHubDiffCommitError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "The named commit was not a commit sha.";
  }

  override get message(): string {
    return `GitHub CLI failed in getPullRequestDiff: ${this.detail}`;
  }
}

/** The revisions read successfully, but cannot name both sides this file needs. */
export class GitHubDiffRevisionsUnavailableError extends Schema.TaggedErrorClass<GitHubDiffRevisionsUnavailableError>()(
  "GitHubDiffRevisionsUnavailableError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    number: Schema.Int,
    commit: Schema.optional(Schema.String),
  },
) {
  get detail(): string {
    return this.commit === undefined
      ? `Pull request #${this.number} reported no usable base and head revisions.`
      : `Commit ${this.commit} reported no usable revisions for this file.`;
  }

  override get message(): string {
    return `GitHub CLI failed in getPullRequestDiffFileContents: ${this.detail}`;
  }
}

/** A blob exists, but expanding it would be unsafe or would not produce text. */
export class GitHubDiffFileContentsUnavailableError extends Schema.TaggedErrorClass<GitHubDiffFileContentsUnavailableError>()(
  "GitHubDiffFileContentsUnavailableError",
  {
    command: Schema.Literal("gh"),
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
    return `GitHub CLI failed in getPullRequestDiffFileContents: ${this.detail}`;
  }
}

/**
 * Not a decode failure: a repository was named that cannot go into a search or into a GraphQL
 * document as itself. Every qualifier and every alias below is composed from `owner/name`, so a
 * name that is not one is refused here rather than escaped into something GitHub might read as a
 * qualifier of its own.
 */
export class GitHubRepositorySelectorError extends Schema.TaggedErrorClass<GitHubRepositorySelectorError>()(
  "GitHubRepositorySelectorError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    operation: Schema.String,
  },
) {
  get detail(): string {
    return "A repository was named that GitHub cannot address.";
  }

  override get message(): string {
    return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export type GitHubPullRequestCliError =
  | GitHubCli.GitHubCliError
  | GitHubPullRequestReadError
  | GitHubDiffCursorError
  | GitHubDiffCommitError
  | GitHubDiffRevisionsUnavailableError
  | GitHubDiffFileContentsUnavailableError
  | GitHubRepositorySelectorError
  | GitHubViewerLoginUnavailableError;

/** A large pull request can produce a multi-megabyte patch; past this it is truncated. */
const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 60_000;
/** Pierre expansion is for source files, not blobs large enough to stall a review surface. */
const DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;

/** A search-free fallback may scan older rows for local filters, but never the whole repository. */
const PULL_REQUEST_FALLBACK_MAX_ROWS = 1_000;

/** What the files API serves at most in one response, which is what one slice is made of. */
const DIFF_FILES_PAGE_SIZE = 100;

/**
 * Pages of review threads to follow before the conversation is reported as truncated. GitHub
 * serves a hundred threads a page, so this is a thousand threads — past anything a pull request
 * a person is reading has, and short of walking a repository-sized conversation forever.
 */
const REVIEW_THREAD_PAGES = 10;

/**
 * And pages of one thread's own comments, for the rare thread longer than a single page. A
 * thousand replies under one line is already a conversation nobody finishes reading.
 */
const REVIEW_THREAD_COMMENT_PAGES = 10;

/** How many over-long threads are finished at once, so a wide conversation is not read serially. */
const REVIEW_THREAD_CONCURRENCY = 4;

export interface GitHubPullRequestListBatch {
  readonly items: ReadonlyArray<GitHubPullRequestListItem>;
  readonly truncated: boolean;
  /** False for a page GitHub would not search, which came back in `gh`'s own order instead. */
  readonly continues: boolean;
}

export interface GitHubPullRequestStat {
  readonly repository: string;
  readonly number: number;
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Aliased lookups per request, and requests at once. Measured over a hundred rows: one request
 * carrying all hundred takes ~5.2s, four of twenty-five in parallel ~2.1s.
 */
const STAT_ALIASES_PER_REQUEST = 25;
const STAT_REQUEST_CONCURRENCY = 4;

export interface GitHubPullRequestSearchBatch {
  /** Rows across every repository asked for, newest update first, each naming its own. */
  readonly items: ReadonlyArray<GitHubPullRequestSearchItem>;
  readonly truncated: boolean;
}

export interface GitHubPullRequestDiffSlice {
  readonly patch: string;
  /** Files in this slice had their hunks withheld, as opposed to there being more slices. */
  readonly truncated: boolean;
  /** Where the next slice starts, or null once the patch is whole. */
  readonly nextCursor: string | null;
}

export class GitHubPullRequestCli extends Context.Service<
  GitHubPullRequestCli,
  {
    readonly getViewerLogin: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string, GitHubPullRequestCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /** Free text for `--search`, matched as one literal phrase. */
      readonly query?: string | undefined;
      /** Where to carry on from, as a `updated:` qualifier on the same search. */
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<GitHubPullRequestListBatch, GitHubPullRequestCliError>;

    /**
     * The same listing for a whole host in one search. `limit` is the size of the slice across
     * all of the repositories rather than per repository, because that is what a search answers:
     * the newest rows of the lot, which is exactly the page.
     */
    readonly searchPullRequests: (input: {
      /** Any checkout on the host; the search names its repositories itself. */
      readonly cwd: string;
      readonly host: string;
      readonly repositories: ReadonlyArray<string>;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<GitHubPullRequestSearchBatch, GitHubPullRequestCliError>;

    /** The line counts the search leaves out, for rows already on the page. */
    readonly listPullRequestStats: (input: {
      readonly cwd: string;
      readonly host: string;
      readonly changeRequests: ReadonlyArray<{
        readonly repository: string;
        readonly number: number;
      }>;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestStat>, GitHubPullRequestCliError>;

    readonly getPullRequestDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestDetail, GitHubPullRequestCliError>;

    readonly getPullRequestActivity: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestActivity, GitHubPullRequestCliError>;

    readonly getPullRequestDiff: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      /** Absent asks for the first slice; anything else is a cursor a slice handed back. */
      readonly cursor?: string | undefined;
      /** One commit's own changes, rather than everything the pull request carries. */
      readonly commit?: string | undefined;
    }) => Effect.Effect<GitHubPullRequestDiffSlice, GitHubPullRequestCliError>;

    readonly getPullRequestDiffFileContents: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly commit?: string | undefined;
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    }) => Effect.Effect<
      { readonly oldContents: string; readonly newContents: string },
      GitHubPullRequestCliError
    >;

    readonly listReviewThreadComments: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubReviewThreadComments, GitHubPullRequestCliError>;

    /** One request for a listing's authors, since no `gh` JSON field reports an avatar. */
    readonly listActorAvatars: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly ids: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyMap<string, string>, GitHubPullRequestCliError>;

    /** One `gh repo view`, which answers what the repository allows and where the viewer stands. */
    readonly getRepositoryAccess: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
    }) => Effect.Effect<GitHubRepositoryAccess, GitHubPullRequestCliError>;

    /** The viewer's standing on its own, for deciding a write without reading the whole detail. */
    readonly getViewerAccess: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubViewerAccess, GitHubPullRequestCliError>;

    /** Who this pull request may be sent to, and who it has already been sent to. */
    readonly listReviewerCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestReviewerCandidateList, GitHubPullRequestCliError>;

    readonly setReviewerRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<{
        readonly id: string;
        readonly kind: PullRequestReviewerKind;
      }>;
      /** False deletes the same collection a request posts to, which takes the request back. */
      readonly requested: boolean;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly runPullRequestAction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly commentOnPullRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly submitReview: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly replyToReviewThread: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly threadId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;

    readonly setReviewThreadResolution: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly threadId: string;
      readonly resolved: boolean;
    }) => Effect.Effect<void, GitHubPullRequestCliError>;
  }
>()("t3/pullRequest/GitHubPullRequestCli") {}

/**
 * The GraphQL API takes owner and name as separate arguments, so `owner/repo` is split here.
 * The host is not read off the identity: it travels alongside it, because the identity a
 * project records is the path below its host and never names the host itself.
 */
export function parseRepositorySelector(value: string): {
  readonly owner: string;
  readonly name: string;
} {
  const parts = value.trim().split("/").filter(Boolean);
  return { name: parts.at(-1) ?? "", owner: parts.at(-2) ?? "" };
}

/**
 * The page a diff cursor names, or null for anything this walk cannot have issued. The cursor
 * arrives from the reader as a string and goes straight into a request path, so it is parsed
 * rather than trusted; the length bound keeps a page number out of exponential notation.
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

/**
 * The reader's own words as one literal phrase of a GitHub search query. Quoting is the whole
 * defence: outside quotes GitHub reads `is:merged` as a qualifier and `label:x` as another, so
 * text typed into a search box could widen the very listing it is meant to narrow — inside them
 * it is only text. The two characters that could end the phrase early are therefore escaped
 * first, which GitHub reads back as themselves; an unbalanced quote is dropped instead, which
 * would let everything after it out of the phrase.
 *
 * The phrase is one argv element, so nothing in it can become a flag of its own either.
 */
function searchPhrase(query: string): string {
  return `"${query.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function involvementArgs(input: {
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
  readonly query?: string | undefined;
  /** Where to carry on from, which only a search can express. */
  readonly cursor?: ProviderListCursor | undefined;
  /**
   * Ask GitHub for the order the page reads its rows in. False on the fallback read, which
   * cannot use search at all and takes whatever order `gh pr list` answers in.
   */
  readonly sorted: boolean;
}): ReadonlyArray<string> {
  // `--state closed` includes merged pull requests, so the Closed tab additionally excludes
  // them through search; `--author` and `review-requested:` are GitHub's own filters. `gh`
  // takes one `--search`, so the reader's text joins the qualifiers rather than replacing them.
  const query = input.query?.trim() ?? "";
  // The fallback read exists because this repository's search index answered nothing, so it goes
  // nowhere near search: no order, cursor or qualifiers. Its decoded rows are narrowed by state
  // and involvement below, since widening either would put unrelated pull requests on the page.
  const searchTerms = !input.sorted
    ? []
    : [
        ...(input.involvement === "reviewing" ? [`review-requested:${input.viewer}`] : []),
        ...(input.state === "closed" ? ["is:unmerged"] : []),
        ...(query.length === 0 ? [] : [searchPhrase(query)]),
        // The instant the last slice ended on, and everything before it. Inclusive, because rows
        // sharing one instant are ordinary and the caller drops the ones it has already sent —
        // asking for strictly older would lose the rest of them instead.
        ...(input.cursor === undefined ? [] : [`updated:<=${input.cursor.updatedBefore}`]),
        // `gh pr list` answers newest-created first, which is not the order the page reads rows in
        // and not an order a continuation can carry on from: a change request opened last year and
        // touched this morning belongs at the top of the list and at the front of the first slice.
        // Free text would otherwise come back in best-match order, which is worse again.
        "sort:updated-desc",
      ];
  return [
    ...(input.involvement === "authored" ? ["--author", input.viewer] : []),
    ...(searchTerms.length > 0 ? ["--search", searchTerms.join(" ")] : []),
  ];
}

/** The search-free fallback is wider than the request, so narrow its decoded rows locally. */
function matchesUnsortedListing(
  item: GitHubPullRequestListItem,
  input: {
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
  },
): boolean {
  const matchesState = input.state === "all" || item.state === input.state;
  const viewer = input.viewer.toLowerCase();
  const matchesInvolvement =
    input.involvement === "all" ||
    (input.involvement === "authored"
      ? item.author?.login.toLowerCase() === viewer
      : item.hasTeamReviewRequest ||
        item.reviewRequestLogins.some((login) => login.toLowerCase() === viewer));
  return matchesState && matchesInvolvement;
}

/** What a repository selector may hold before it goes into a search as itself. */
const SEARCH_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * The same listing as one GitHub search across several repositories, which is the only way to
 * read a whole host in one request.
 *
 * Every narrowing `involvementArgs` hands to `gh pr list` as a flag is a qualifier here instead,
 * because a search has no flags to borrow: `--author X` is `author:X`, `--state open` is
 * `is:open`, and `--state closed` — which includes merged pull requests — is `is:closed
 * is:unmerged`. The two belong together; a tab added to one wants adding to the other.
 *
 * Null where a repository is not `owner/name`. A name is written into the query as itself, and a
 * name holding a space could otherwise end the `repo:` qualifier and start a qualifier of its
 * own — so an unaddressable one refuses the whole read rather than being escaped into something
 * GitHub might still read.
 */
function searchQuery(input: {
  readonly repositories: ReadonlyArray<string>;
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
  readonly query?: string | undefined;
  readonly cursor?: ProviderListCursor | undefined;
}): string | null {
  if (input.repositories.length === 0) return null;
  const repositories = input.repositories.map((repository) => repository.trim());
  if (!repositories.every((repository) => SEARCH_REPOSITORY.test(repository))) return null;
  const query = input.query?.trim() ?? "";
  return [
    "is:pr",
    // "all" is every state, which `is:pr` already is.
    ...(input.state === "open" ? ["is:open"] : []),
    ...(input.state === "closed" ? ["is:closed", "is:unmerged"] : []),
    ...(input.state === "merged" ? ["is:merged"] : []),
    ...(input.involvement === "authored" ? [`author:${input.viewer}`] : []),
    ...(input.involvement === "reviewing" ? [`review-requested:${input.viewer}`] : []),
    ...(query.length === 0 ? [] : [searchPhrase(query)]),
    // Inclusive, and de-duplicated by the caller, for the reason the per-repository read gives.
    ...(input.cursor === undefined ? [] : [`updated:<=${input.cursor.updatedBefore}`]),
    // The order the page reads its rows in, and the only order a continuation can carry on from.
    "sort:updated-desc",
    ...repositories.map((repository) => `repo:${repository}`),
  ].join(" ");
}

/**
 * The `after` a paged read carries. gh sends a JSON null only through a typed field, and an
 * untyped `cursor=` would send the empty string, which GitHub refuses as a cursor rather than
 * reading as "start at the beginning".
 */
function cursorVariable(cursor: string | null): readonly [string, string] {
  return cursor === null ? ["-F", "cursor=null"] : ["-f", `cursor=${cursor}`];
}

function actionArgs(
  action: PullRequestAction,
  mergeMethod: PullRequestMergeMethod | undefined,
): ReadonlyArray<string> {
  switch (action) {
    case "merge":
      return ["merge", `--${mergeMethod ?? "merge"}`];
    case "ready":
      return ["ready"];
    case "draft":
      return ["ready", "--undo"];
    case "close":
      return ["close"];
    case "reopen":
      return ["reopen"];
  }
}

export const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;

  // `gh` resolves a bare `owner/repo` against whichever host it defaults to, which is
  // github.com. Naming the host makes a GitHub Enterprise repository resolve to its own
  // install rather than to a same-named repository on github.com.
  const repositoryArgs = (input: { readonly host: string; readonly repository: string }) => [
    "--repo",
    `${input.host}/${input.repository}`,
  ];

  /**
   * A GraphQL mutation whose answer is not read back. `gh` exits non-zero on a GraphQL error,
   * so a failed mutation is already a failed command rather than a body to inspect.
   *
   * The query and its variables travel over stdin as one document: a variable can carry a
   * body the reader wrote, and argv is visible in process listings and echoed back inside
   * process-runner failure messages.
   */
  const graphql = (input: {
    readonly cwd: string;
    readonly host: string;
    readonly query: string;
    readonly variables: Readonly<Record<string, string>>;
  }) =>
    github
      .execute({
        cwd: input.cwd,
        args: ["api", "graphql", "--hostname", input.host, "--input", "-"],
        stdin: encodeGraphQlRequestJson({ query: input.query, variables: input.variables }),
      })
      .pipe(Effect.asVoid);

  /** A GraphQL read whose answer is decoded, reporting a failure against the read that made it. */
  const graphqlRead = <A>(input: {
    readonly cwd: string;
    readonly host: string;
    readonly operation: string;
    /** Variables as `-f` flags, for values this module composed itself. */
    readonly variables?: ReadonlyArray<readonly [string, string]>;
    /**
     * Variables carrying words the reader typed. Document and variables travel over stdin
     * together, because argv is visible in process listings and is echoed back inside a
     * process-runner failure message.
     */
    readonly privateVariables?: Readonly<Record<string, string>>;
    readonly query: string;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, GitHubPullRequestCliError> =>
    github
      .execute(
        input.privateVariables === undefined
          ? {
              cwd: input.cwd,
              args: [
                "api",
                "graphql",
                "--hostname",
                input.host,
                ...(input.variables ?? []).flat(),
                "-f",
                `query=${input.query}`,
              ],
            }
          : {
              cwd: input.cwd,
              args: ["api", "graphql", "--hostname", input.host, "--input", "-"],
              stdin: encodeGraphQlRequestJson({
                query: input.query,
                variables: input.privateVariables,
              }),
            },
      )
      .pipe(
        Effect.flatMap((result) => {
          const decoded = input.decode(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new GitHubPullRequestReadError({
                  command: "gh",
                  cwd: input.cwd,
                  operation: input.operation,
                  cause: decoded.failure,
                }),
              );
        }),
      );

  /**
   * One page of the patch, read from the files API. GitHub refuses `pr diff` outright past 300
   * changed files, and still serves those files' hunks here.
   *
   * A page is a whole number of files, so each one parses on its own; the caller carries on from
   * `nextCursor` for as long as GitHub keeps handing pages back.
   *
   * A named commit is read from the commit endpoint, which lists the same file entries and pages
   * them the same way — only wrapped in an object, which jq unwraps before they are decoded.
   */
  const diffFilesPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly page: number;
    readonly commit?: string | undefined;
  }): Effect.Effect<GitHubPullRequestDiffSlice, GitHubPullRequestCliError> => {
    const { owner, name } = parseRepositorySelector(input.repository);
    const paging = `per_page=${DIFF_FILES_PAGE_SIZE}&page=${input.page}`;
    return github
      .execute({
        cwd: input.cwd,
        args: [
          "api",
          "--hostname",
          input.host,
          input.commit === undefined
            ? `repos/${owner}/${name}/pulls/${input.number}/files?${paging}`
            : `repos/${owner}/${name}/commits/${input.commit}?${paging}`,
          // An empty commit carries no `files` at all, which is a commit with nothing in it
          // rather than an answer that could not be read.
          ...(input.commit === undefined ? [] : ["--jq", ".files // []"]),
        ],
        maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
        timeoutMs: DIFF_TIMEOUT_MS,
      })
      .pipe(
        Effect.flatMap((result) => {
          // Checked before decoding: a byte-truncated response is a JSON prefix, which would
          // fail to parse. Nothing of this page can be shown, and an empty patch would render
          // as a change with no files rather than as the failure it is; slices already handed
          // over stay with the reader either way.
          if (result.stdoutTruncated) {
            return Effect.fail(
              new GitHubPullRequestReadError({
                command: "gh",
                cwd: input.cwd,
                operation: "getPullRequestDiff",
                cause: new Error(`Page ${input.page} of the changed files was too large to read.`),
              }),
            );
          }
          const decoded = decodePullRequestFilesJson(result.stdout.trim());
          if (!Result.isSuccess(decoded)) {
            return Effect.fail(
              new GitHubPullRequestReadError({
                command: "gh",
                cwd: input.cwd,
                operation: "getPullRequestDiff",
                cause: decoded.failure,
              }),
            );
          }
          // Counted before decoding, so a page whose files all failed to decode still moves on
          // rather than pointing the reader back at the page it just read.
          const morePages = decoded.success.rawCount >= DIFF_FILES_PAGE_SIZE;
          return Effect.succeed({
            patch: decoded.success.patch,
            truncated: decoded.success.truncated,
            nextCursor: morePages ? String(input.page + 1) : null,
          });
        }),
      );
  };

  const getPullRequestDiffFileContents: GitHubPullRequestCli["Service"]["getPullRequestDiffFileContents"] =
    (input) =>
      Effect.gen(function* () {
        if (input.commit !== undefined && !isCommitSha(input.commit)) {
          return yield* new GitHubDiffCommitError({ command: "gh", cwd: input.cwd });
        }
        const { owner, name } = parseRepositorySelector(input.repository);
        const refsResult = yield* github.execute({
          cwd: input.cwd,
          args: [
            "api",
            "--hostname",
            input.host,
            input.commit === undefined
              ? `repos/${owner}/${name}/pulls/${input.number}`
              : `repos/${owner}/${name}/commits/${input.commit}`,
            "--jq",
            input.commit === undefined
              ? "[.base.sha, .head.sha] | @tsv"
              : "[.parents[0].sha, .sha] | @tsv",
          ],
          maxOutputBytes: 1024,
          timeoutMs: DIFF_TIMEOUT_MS,
        });
        // Keep a leading tab: a root commit has no parent, and jq represents that absent old
        // revision as the empty field before the tab. Every file in it is new, so that is a
        // usable answer whenever the caller does not need the old side.
        const [baseRef, headRef, ...extraRefs] = refsResult.stdout.trimEnd().split("\t");
        const rootCommitNewFile =
          input.commit !== undefined && input.changeType === "new" && baseRef === "";
        if (
          refsResult.stdoutTruncated ||
          !headRef ||
          extraRefs.length > 0 ||
          (!rootCommitNewFile && (baseRef === undefined || !isCommitSha(baseRef))) ||
          !isCommitSha(headRef)
        ) {
          return yield* new GitHubDiffRevisionsUnavailableError({
            command: "gh",
            cwd: input.cwd,
            number: input.number,
            ...(input.commit === undefined ? {} : { commit: input.commit }),
          });
        }

        const readFile = (revision: string, filePath: string) =>
          github
            .execute({
              cwd: input.cwd,
              args: [
                "api",
                "--hostname",
                input.host,
                "--header",
                "Accept: application/vnd.github.raw+json",
                `repos/${owner}/${name}/contents/${filePath
                  .split("/")
                  .map(encodeURIComponent)
                  .join("/")}?ref=${encodeURIComponent(revision)}`,
              ],
              maxOutputBytes: DIFF_FILE_MAX_OUTPUT_BYTES,
              timeoutMs: DIFF_TIMEOUT_MS,
            })
            .pipe(
              Effect.flatMap((result) =>
                result.stdoutTruncated ||
                result.stdout.includes("\0") ||
                result.stdoutInvalidUtf8 === true
                  ? Effect.fail(
                      new GitHubDiffFileContentsUnavailableError({
                        command: "gh",
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
            input.changeType === "new" ? Effect.succeed("") : readFile(baseRef, input.oldPath),
            input.changeType === "deleted" ? Effect.succeed("") : readFile(headRef, input.newPath),
          ],
          { concurrency: 2 },
        );
        return { oldContents, newContents };
      });

  return GitHubPullRequestCli.of({
    getViewerLogin: (input) =>
      github.execute({ cwd: input.cwd, args: ["api", "user", "--jq", ".login"] }).pipe(
        Effect.flatMap((result) => {
          const login = result.stdout.trim();
          return login.length > 0
            ? Effect.succeed(login)
            : Effect.fail(new GitHubViewerLoginUnavailableError({ command: "gh", cwd: input.cwd }));
        }),
      ),

    listPullRequests: (input) => {
      const fallbackMaxRows = Math.max(input.limit + 1, PULL_REQUEST_FALLBACK_MAX_ROWS);
      const read = (
        continues: boolean,
        requestedRows = input.limit + 1,
      ): Effect.Effect<GitHubPullRequestListBatch, GitHubPullRequestCliError> =>
        github
          .execute({
            cwd: input.cwd,
            args: [
              "pr",
              "list",
              ...repositoryArgs(input),
              ...involvementArgs({ ...input, sorted: continues }),
              "--state",
              input.state,
              "--limit",
              // One extra row reveals that the repository has more than the page shows.
              String(requestedRows),
              "--json",
              PULL_REQUEST_LIST_JSON_FIELDS,
            ],
          })
          .pipe(
            Effect.flatMap((result) => {
              const raw = result.stdout.trim();
              if (raw.length === 0) {
                return Effect.succeed({ items: [], truncated: false, continues });
              }
              const decoded = decodePullRequestListJson(raw);
              if (Result.isSuccess(decoded)) {
                const items = continues
                  ? decoded.success.items
                  : decoded.success.items.filter((item) => matchesUnsortedListing(item, input));
                if (
                  !continues &&
                  items.length < input.limit &&
                  decoded.success.rawCount >= requestedRows &&
                  requestedRows < fallbackMaxRows
                ) {
                  const nextRows = Math.min(requestedRows * 2, fallbackMaxRows);
                  if (nextRows > requestedRows) return read(false, nextRows);
                }
                return Effect.succeed({
                  items: items.slice(0, input.limit),
                  // One row over the page size is the probe for a next page, and it is
                  // counted before decoding: a skipped malformed row must not end paging.
                  truncated: continues
                    ? decoded.success.rawCount > input.limit
                    : items.length > input.limit || decoded.success.rawCount >= requestedRows,
                  continues,
                });
              }
              return Effect.fail(
                new GitHubPullRequestReadError({
                  command: "gh",
                  cwd: input.cwd,
                  operation: "listPullRequests",
                  cause: decoded.failure,
                }),
              );
            }),
          );
      // GitHub does not index every repository for search, and one it will not search answers
      // with no rows rather than with an error — so an empty listing is read again the way `gh`
      // lists without one. Those rows come back newest-created first, an order no `updated:`
      // qualifier can carry on from, so that page says it cannot be continued and the reader
      // reaches the rest of it by asking for a larger page, as every listing used to.
      //
      // Only ever the first slice: a repository that answered the search once will answer it
      // again, so an empty slice under a cursor is a repository that has run out.
      // A text search that finds nothing has found nothing: falling back would answer it with the
      // repository's whole list, which is every row the reader did not search for. The fallback
      // is for a repository the index does not cover, and a listing with no text to match is the
      // only place an empty answer can mean that.
      const searched = (input.query?.trim().length ?? 0) > 0;
      return read(true).pipe(
        Effect.flatMap((batch) =>
          batch.items.length === 0 && input.cursor === undefined && !searched
            ? read(false)
            : Effect.succeed(batch),
        ),
      );
    },

    searchPullRequests: (input) => {
      const query = searchQuery(input);
      if (query === null) {
        return Effect.fail(
          new GitHubRepositorySelectorError({
            command: "gh",
            cwd: input.cwd,
            operation: "searchPullRequests",
          }),
        );
      }
      // One extra row reveals that the host has more than the slice shows, the way the
      // per-repository read does — up to GitHub's own ceiling on a search page, past which
      // `hasNextPage` is what says there is more.
      const rows = Math.min(input.limit + 1, PULL_REQUEST_SEARCH_MAX_ROWS);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "searchPullRequests",
        // The reader's own words are in the query, so it travels over stdin rather than in argv.
        privateVariables: { q: query },
        query: pullRequestSearchGraphQlQuery(rows),
        decode: decodePullRequestSearchJson,
      }).pipe(
        Effect.map((batch) => ({
          items: batch.items.slice(0, input.limit),
          truncated: batch.rawCount > input.limit || batch.hasNextPage,
        })),
      );
    },

    listPullRequestStats: (input) => {
      const chunks: Array<ReadonlyArray<{ readonly repository: string; readonly number: number }>> =
        [];
      for (let start = 0; start < input.changeRequests.length; start += STAT_ALIASES_PER_REQUEST) {
        chunks.push(input.changeRequests.slice(start, start + STAT_ALIASES_PER_REQUEST));
      }
      return Effect.forEach(
        chunks,
        (chunk) => {
          const query = buildPullRequestStatsGraphQlQuery(chunk);
          if (query === null) {
            return Effect.fail(
              new GitHubRepositorySelectorError({
                command: "gh",
                cwd: input.cwd,
                operation: "listPullRequestStats",
              }),
            );
          }
          return graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "listPullRequestStats",
            query,
            decode: decodePullRequestStatsJson,
          }).pipe(
            Effect.map((stats) =>
              chunk.flatMap((changeRequest, index) => {
                const stat = stats.get(index);
                return stat === undefined ? [] : [{ ...changeRequest, ...stat }];
              }),
            ),
          );
        },
        { concurrency: STAT_REQUEST_CONCURRENCY },
      ).pipe(Effect.map((results) => results.flat()));
    },

    getPullRequestDetail: (input) =>
      github
        .execute({
          cwd: input.cwd,
          args: [
            "pr",
            "view",
            String(input.number),
            ...repositoryArgs(input),
            "--json",
            PULL_REQUEST_DETAIL_JSON_FIELDS,
          ],
        })
        .pipe(
          Effect.flatMap((result) => {
            const decoded = decodePullRequestDetailJson(result.stdout.trim());
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(
                  new GitHubPullRequestReadError({
                    command: "gh",
                    cwd: input.cwd,
                    operation: "getPullRequestDetail",
                    cause: decoded.failure,
                  }),
                );
          }),
        ),

    getPullRequestActivity: (input) =>
      github
        .execute({
          cwd: input.cwd,
          args: [
            "pr",
            "view",
            String(input.number),
            ...repositoryArgs(input),
            "--json",
            PULL_REQUEST_ACTIVITY_JSON_FIELDS,
          ],
        })
        .pipe(
          Effect.flatMap((result) => {
            const decoded = decodePullRequestActivityJson(result.stdout.trim());
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(
                  new GitHubPullRequestReadError({
                    command: "gh",
                    cwd: input.cwd,
                    operation: "getPullRequestActivity",
                    cause: decoded.failure,
                  }),
                );
          }),
        ),

    getPullRequestDiff: (input) => {
      const filesPage = (page: number) =>
        diffFilesPage({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          page,
          ...(input.commit === undefined ? {} : { commit: input.commit }),
        });
      if (input.commit !== undefined && !isCommitSha(input.commit)) {
        return Effect.fail(new GitHubDiffCommitError({ command: "gh", cwd: input.cwd }));
      }
      // A cursor only ever comes from the files walk, so a reader carrying one is already past
      // the point where `gh pr diff` had anything to say.
      if (input.cursor !== undefined) {
        const page = diffCursorPage(input.cursor);
        return page === null
          ? Effect.fail(new GitHubDiffCursorError({ command: "gh", cwd: input.cwd }))
          : filesPage(page);
      }
      // `gh pr diff` speaks for the whole pull request and has no way to name one commit of it.
      if (input.commit !== undefined) {
        return filesPage(1);
      }
      return github
        .execute({
          cwd: input.cwd,
          args: ["pr", "diff", String(input.number), ...repositoryArgs(input), "--color", "never"],
          maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
          timeoutMs: DIFF_TIMEOUT_MS,
        })
        .pipe(
          Effect.flatMap((result) =>
            // A patch cut at a byte boundary ends mid-file, which is neither a whole slice nor
            // something the reader can carry on from. The files API can serve the same change a
            // whole number of files at a time, so an oversized patch takes that road as well.
            result.stdoutTruncated
              ? filesPage(1)
              : // One read served the whole patch, so there is no next slice to ask for.
                Effect.succeed({ patch: result.stdout, truncated: false, nextCursor: null }),
          ),
          // GitHub answers 406 rather than a diff past 300 changed files, so the patch is read
          // from the files API instead, a page per call. Only once the direct read has failed: a
          // pull request GitHub will serve a diff for must not pay for a second request. A
          // fallback that fails too reports the original refusal, which is the one that explains
          // the page. Narrowed to a command that ran and was refused: a missing `gh` or a
          // signed-out one fails the same way for every request.
          Effect.catchTags({
            GitHubCliCommandError: (error) =>
              filesPage(1).pipe(Effect.catch(() => Effect.fail(error))),
          }),
        );
    },

    getPullRequestDiffFileContents,

    listReviewThreadComments: (input) =>
      Effect.gen(function* () {
        const { owner, name } = parseRepositorySelector(input.repository);
        const threadPage = (
          cursor: string | null,
        ): Effect.Effect<GitHubReviewThreadPage, GitHubPullRequestCliError> =>
          graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "listReviewThreadComments",
            variables: [
              ["-f", `owner=${owner}`],
              ["-f", `name=${name}`],
              ["-F", `number=${input.number}`],
              cursorVariable(cursor),
            ],
            query: REVIEW_THREADS_GRAPHQL_QUERY,
            decode: decodeReviewThreadsJson,
          });
        const commentPage = (
          threadId: string,
          cursor: string,
        ): Effect.Effect<
          {
            readonly comments: ReadonlyArray<PullRequestThreadComment>;
            readonly nextCursor: string | null;
          },
          GitHubPullRequestCliError
        > =>
          graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "listReviewThreadComments",
            variables: [["-f", `threadId=${threadId}`], cursorVariable(cursor)],
            query: REVIEW_THREAD_COMMENTS_GRAPHQL_QUERY,
            decode: decodeReviewThreadCommentsJson,
          });

        const entries: GitHubReviewThreadEntry[] = [];
        const avatarsByLogin = new Map<string, string>();
        const commitStats = new Map<
          string,
          { readonly additions: number; readonly deletions: number }
        >();
        let reviewers: ReadonlyArray<PullRequestActor> = [];
        let commits: GitHubReviewThreadPage["commits"] = [];
        let viewer: GitHubReviewThreadPage["viewer"] = { canUpdate: true, didAuthor: false };
        let cursor: string | null = null;
        let page = 0;
        do {
          const read: GitHubReviewThreadPage = yield* threadPage(cursor);
          entries.push(...read.threads);
          for (const [login, avatarUrl] of read.avatarsByLogin)
            avatarsByLogin.set(login, avatarUrl);
          // The roster, the commits and the viewer's standing travel with every page, and the
          // first one already carries all of them.
          if (page === 0) {
            reviewers = read.reviewers;
            commits = read.commits;
            viewer = read.viewer;
            for (const [oid, stat] of read.commitStats) commitStats.set(oid, stat);
          }
          cursor = read.nextCursor;
          page += 1;
        } while (cursor !== null && page < REVIEW_THREAD_PAGES);

        // Only the threads GitHub said were unfinished cost a request; the rest arrived whole
        // with the page they were listed on.
        const finished = yield* Effect.forEach(
          entries,
          (entry) =>
            Effect.gen(function* () {
              const comments = [...entry.thread.comments];
              let commentCursor = entry.nextCommentCursor;
              let commentPageCount = 0;
              while (commentCursor !== null && commentPageCount < REVIEW_THREAD_COMMENT_PAGES) {
                const read = yield* commentPage(entry.thread.id, commentCursor);
                comments.push(...read.comments);
                commentCursor = read.nextCursor;
                commentPageCount += 1;
              }
              return {
                thread: { ...entry.thread, comments },
                commentCount: entry.commentCount,
                truncated: commentCursor !== null,
              };
            }),
          { concurrency: REVIEW_THREAD_CONCURRENCY },
        );

        const reviewThreads = finished.map((entry) => entry.thread);
        return {
          comments: reviewThreadConversation(reviewThreads),
          reviewThreads,
          // GitHub's own count of each thread, so the number the page shows is the host's even
          // where a bound kept some of the words on GitHub.
          commentCount: finished.reduce((total, entry) => total + entry.commentCount, 0),
          truncated: cursor !== null || finished.some((entry) => entry.truncated),
          reviewers,
          avatarsByLogin,
          commitStats,
          commits,
          viewer,
        };
      }),

    listActorAvatars: (input) => {
      if (input.ids.length === 0) {
        return Effect.succeed(new Map<string, string>());
      }
      return github
        .execute({
          cwd: input.cwd,
          args: [
            "api",
            "graphql",
            "--hostname",
            input.host,
            ...input.ids.flatMap((id) => ["-f", `ids[]=${id}`]),
            "-f",
            `query=${ACTOR_AVATARS_GRAPHQL_QUERY}`,
          ],
        })
        .pipe(
          Effect.flatMap((result) => {
            const decoded = decodeActorAvatarsJson(result.stdout.trim());
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(
                  new GitHubPullRequestReadError({
                    command: "gh",
                    cwd: input.cwd,
                    operation: "listActorAvatars",
                    cause: decoded.failure,
                  }),
                );
          }),
        );
    },

    getRepositoryAccess: (input) =>
      github
        .execute({
          cwd: input.cwd,
          args: [
            "repo",
            "view",
            `${input.host}/${input.repository}`,
            "--json",
            REPOSITORY_ACCESS_JSON_FIELDS,
          ],
        })
        .pipe(
          Effect.flatMap((result) => {
            const decoded = decodeRepositoryAccessJson(result.stdout.trim());
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(
                  new GitHubPullRequestReadError({
                    command: "gh",
                    cwd: input.cwd,
                    operation: "getRepositoryAccess",
                    cause: decoded.failure,
                  }),
                );
          }),
        ),

    getViewerAccess: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getViewerAccess",
        variables: [
          ["-f", `owner=${owner}`],
          ["-f", `name=${name}`],
          ["-F", `number=${input.number}`],
        ],
        query: VIEWER_PERMISSIONS_GRAPHQL_QUERY,
        decode: decodeViewerPermissionsJson,
      });
    },

    listReviewerCandidates: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "listReviewerCandidates",
        variables: [
          ["-f", `owner=${owner}`],
          ["-f", `name=${name}`],
          ["-F", `number=${input.number}`],
        ],
        query: REVIEWER_CANDIDATES_GRAPHQL_QUERY,
        decode: decodeReviewerCandidatesJson,
      });
    },

    setReviewerRequest: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return github
        .execute({
          cwd: input.cwd,
          // Posting to a login GitHub has already been asked about is what a re-request is, so
          // there is nothing to say here about somebody who has reviewed once already. The body
          // travels over stdin for the reason every other one does: argv is visible in process
          // listings and echoed back inside process-runner failure messages.
          args: [
            "api",
            "--method",
            input.requested ? "POST" : "DELETE",
            "--hostname",
            input.host,
            `repos/${owner}/${name}/pulls/${input.number}/requested_reviewers`,
            "--input",
            "-",
          ],
          stdin: buildReviewerRequestJson(input.reviewers),
        })
        .pipe(Effect.asVoid);
    },

    runPullRequestAction: (input) => {
      const [subcommand, ...flags] = actionArgs(input.action, input.mergeMethod);
      return github
        .execute({
          cwd: input.cwd,
          args: ["pr", subcommand!, String(input.number), ...repositoryArgs(input), ...flags],
        })
        .pipe(Effect.asVoid);
    },

    commentOnPullRequest: (input) =>
      github
        .execute({
          cwd: input.cwd,
          // The body travels over stdin: argv is visible in process listings and is echoed
          // back inside process-runner failure messages.
          args: [
            "pr",
            "comment",
            String(input.number),
            ...repositoryArgs(input),
            "--body-file",
            "-",
          ],
          stdin: input.body,
        })
        .pipe(Effect.asVoid),

    submitReview: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return github
        .execute({
          cwd: input.cwd,
          // The whole review is one request, so nothing is visible to anyone else until the
          // verdict is sent. The payload travels over stdin for the same reason a comment
          // body does: argv is visible in process listings and echoed back in failures.
          args: [
            "api",
            "--method",
            "POST",
            "--hostname",
            input.host,
            `repos/${owner}/${name}/pulls/${input.number}/reviews`,
            "--input",
            "-",
          ],
          stdin: buildReviewSubmissionJson({
            verdict: input.verdict,
            body: input.body,
            comments: input.comments,
          }),
        })
        .pipe(Effect.asVoid);
    },

    replyToReviewThread: (input) =>
      graphql({
        cwd: input.cwd,
        host: input.host,
        query: REVIEW_THREAD_REPLY_GRAPHQL_MUTATION,
        variables: { threadId: input.threadId, body: input.body },
      }),

    setReviewThreadResolution: (input) =>
      graphql({
        cwd: input.cwd,
        host: input.host,
        query: input.resolved
          ? RESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION
          : UNRESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
        variables: { threadId: input.threadId },
      }),
  });
});

export const layer = Layer.effect(GitHubPullRequestCli, make);
