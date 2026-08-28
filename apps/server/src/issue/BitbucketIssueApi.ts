import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { IssueAction, IssueComment, IssueListState } from "@t3tools/contracts";

import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import {
  decodeCreatedIssueJson,
  decodeIssueCommentsJson,
  decodeIssueJson,
  decodeIssuePageJson,
  decodeRepositoryPermissionJson,
  decodeViewerJson,
  type BitbucketIssue,
  type BitbucketIssueDetail,
} from "./bitbucketIssueJson.ts";
import type { ProviderListCursor } from "./IssueProvider.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class BitbucketIssueReadError extends Schema.TaggedErrorClass<BitbucketIssueReadError>()(
  "BitbucketIssueReadError",
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
export class BitbucketIssueViewerUnavailableError extends Schema.TaggedErrorClass<BitbucketIssueViewerUnavailableError>()(
  "BitbucketIssueViewerUnavailableError",
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
export class BitbucketIssueRepositoryUnsupportedError extends Schema.TaggedErrorClass<BitbucketIssueRepositoryUnsupportedError>()(
  "BitbucketIssueRepositoryUnsupportedError",
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

export type BitbucketIssueApiError =
  | BitbucketApi.BitbucketApiError
  | BitbucketIssueReadError
  | BitbucketIssueViewerUnavailableError
  | BitbucketIssueRepositoryUnsupportedError;

/**
 * Bitbucket's own ceiling, the same one the pull request API respects. Asking for more does not
 * fail — it answers with an empty page and no error at all, so this is a number to respect rather
 * than to push against.
 */
const MAX_PAGE_SIZE = 50;
/** Pages to walk before a listing is reported as truncated. */
const MAX_LIST_PAGES = 10;
/** Pages of the conversation to follow before it is reported as truncated. */
const CONVERSATION_PAGES = 10;

export interface BitbucketIssueBatch {
  readonly items: ReadonlyArray<BitbucketIssue>;
  readonly truncated: boolean;
}

export class BitbucketIssueApi extends Context.Service<
  BitbucketIssueApi,
  {
    /** A function rather than a value, so the request is built per call and not at layer time. */
    readonly getViewer: () => Effect.Effect<string, BitbucketIssueApiError>;

    readonly listIssues: (input: {
      readonly repository: string;
      readonly state: IssueListState;
      readonly limit: number;
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<BitbucketIssueBatch, BitbucketIssueApiError>;

    readonly getIssue: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<BitbucketIssueDetail, BitbucketIssueApiError>;

    /** True where the credentials can write to the repository. */
    readonly getRepositoryPermission: (input: {
      readonly repository: string;
    }) => Effect.Effect<boolean, BitbucketIssueApiError>;

    readonly listComments: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly comments: ReadonlyArray<IssueComment>; readonly truncated: boolean },
      BitbucketIssueApiError
    >;

    readonly createIssue: (input: {
      readonly repository: string;
      readonly title: string;
      readonly body: string;
      /** The first of the reader's requested assignees, since Bitbucket takes only one. */
      readonly assignee: string | null;
    }) => Effect.Effect<{ readonly number: number; readonly url: string }, BitbucketIssueApiError>;

    readonly updateIssue: (input: {
      readonly repository: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    }) => Effect.Effect<void, BitbucketIssueApiError>;

    readonly runAction: (input: {
      readonly repository: string;
      readonly number: number;
      readonly action: IssueAction;
    }) => Effect.Effect<void, BitbucketIssueApiError>;

    readonly comment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, BitbucketIssueApiError>;

    readonly updateComment: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commentId: string;
      readonly body: string;
    }) => Effect.Effect<void, BitbucketIssueApiError>;

    /**
     * Bitbucket's issue tracker takes one assignee, not a set: null clears it, and the first name
     * of a written set becomes it — the rest are dropped rather than making a write that would
     * silently take the assignee off. Named by nickname, the same handle the read carries, since
     * there is no candidate list to hand out an id of Bitbucket's own instead.
     */
    readonly setAssignee: (input: {
      readonly repository: string;
      readonly number: number;
      readonly assignee: string | null;
    }) => Effect.Effect<void, BitbucketIssueApiError>;
  }
>()("t3/issue/BitbucketIssueApi") {}

/** `workspace/slug`; Bitbucket has no deeper nesting to address. */
function repositorySegments(
  repository: string,
): Result.Result<
  { readonly workspace: string; readonly slug: string },
  BitbucketIssueRepositoryUnsupportedError
> {
  const segments = repository
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const [workspace, slug] = segments;
  if (segments.length !== 2 || workspace === undefined || slug === undefined) {
    return Result.fail(new BitbucketIssueRepositoryUnsupportedError({ repository }));
  }
  return Result.succeed({ workspace, slug });
}

function repositoryPathOf(segments: { readonly workspace: string; readonly slug: string }): string {
  return `/repositories/${encodeURIComponent(segments.workspace)}/${encodeURIComponent(segments.slug)}`;
}

/**
 * Bitbucket's own states, narrowed to the two the port asks a listing to span. Only `new` and
 * `open` are open-ish; the rest — resolved, on hold, invalid, duplicate, wontfix, closed itself —
 * all read as closed, so a "closed" tab asks for every one of them at once.
 */
function stateParams(state: IssueListState): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return ["new", "open"];
    case "closed":
      return ["resolved", "on hold", "invalid", "duplicate", "wontfix", "closed"];
    case "all":
      return ["new", "open", "resolved", "on hold", "invalid", "duplicate", "wontfix", "closed"];
  }
}

function stateFilter(state: IssueListState): string {
  const states = stateParams(state);
  return states.length === 1
    ? `state = "${states[0]}"`
    : `(${states.map((value) => `state = "${value}"`).join(" OR ")})`;
}

/**
 * Text as a string literal of Bitbucket's filter grammar. The backslash is escaped first, or
 * escaping the quote would only produce a literal backslash followed by a live quote.
 */
function filterLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Bitbucket has no search term for its issue tracker either, only the same filter expression a
 * pull request search uses: a case-insensitive contains against title and body.
 */
function searchFilter(query: string): string {
  const literal = filterLiteral(query);
  return `(title ~ "${literal}" OR content.raw ~ "${literal}")`;
}

export const make = Effect.gen(function* () {
  const bitbucket = yield* BitbucketApi.BitbucketApi;

  const withRepository = <A>(
    repository: string,
    use: (path: string) => Effect.Effect<A, BitbucketIssueApiError>,
  ): Effect.Effect<A, BitbucketIssueApiError> => {
    const segments = repositorySegments(repository);
    return Result.isSuccess(segments)
      ? use(repositoryPathOf(segments.success))
      : Effect.fail(segments.failure);
  };

  const readPage = <A>(input: {
    readonly operation: string;
    readonly url: string;
    readonly decode: (body: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, BitbucketIssueApiError> =>
    bitbucket.request({ method: "GET", url: input.url }).pipe(
      Effect.flatMap((response) => {
        const decoded = input.decode(response.body);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new BitbucketIssueReadError({ operation: input.operation, cause: decoded.failure }),
            );
      }),
    );

  /**
   * Bitbucket pages with a cursor rather than an offset, so the walk follows the `next` URL it
   * sends. It stops once the caller's page is filled, when Bitbucket reports no next page, or at
   * the page cap — and anything but running out of pages means there is more to be had.
   */
  const listPage = (input: {
    readonly url: string;
    readonly limit: number;
    readonly page: number;
    readonly collected: ReadonlyArray<BitbucketIssue>;
  }): Effect.Effect<BitbucketIssueBatch, BitbucketIssueApiError> =>
    readPage({ operation: "listIssues", url: input.url, decode: decodeIssuePageJson }).pipe(
      Effect.flatMap((page) => {
        const collected = [...input.collected, ...page.items];
        if (page.next === null || collected.length >= input.limit || input.page >= MAX_LIST_PAGES) {
          return Effect.succeed({
            items: collected.slice(0, input.limit),
            truncated: page.next !== null || collected.length > input.limit,
          });
        }
        return listPage({ url: page.next, limit: input.limit, page: input.page + 1, collected });
      }),
    );

  /** The conversation, following the `next` Bitbucket sends until it sends none. */
  const commentsPage = (input: {
    readonly url: string;
    readonly page: number;
    readonly collected: ReadonlyArray<IssueComment>;
  }): Effect.Effect<
    { readonly comments: ReadonlyArray<IssueComment>; readonly truncated: boolean },
    BitbucketIssueApiError
  > =>
    readPage({ operation: "listComments", url: input.url, decode: decodeIssueCommentsJson }).pipe(
      Effect.flatMap((page) => {
        const collected = [...input.collected, ...page.comments];
        if (page.next !== null && input.page < CONVERSATION_PAGES) {
          return commentsPage({ url: page.next, page: input.page + 1, collected });
        }
        return Effect.succeed({ comments: collected, truncated: page.next !== null });
      }),
    );

  /** Every write to an issue is the same PUT, so its body is the only thing that differs. */
  const updateIssue = (input: {
    readonly repository: string;
    readonly number: number;
    readonly body: Record<string, unknown>;
  }) =>
    withRepository(input.repository, (path) =>
      bitbucket
        .request({
          method: "PUT",
          url: `${path}/issues/${input.number}`,
          body: JSON.stringify(input.body),
        })
        .pipe(Effect.asVoid),
    );

  return BitbucketIssueApi.of({
    getViewer: () =>
      bitbucket.request({ method: "GET", url: "/user" }).pipe(
        Effect.flatMap((response): Effect.Effect<string, BitbucketIssueApiError> => {
          const decoded = decodeViewerJson(response.body);
          if (!Result.isSuccess(decoded)) {
            return Effect.fail(
              new BitbucketIssueReadError({ operation: "getViewer", cause: decoded.failure }),
            );
          }
          return decoded.success === null
            ? Effect.fail(new BitbucketIssueViewerUnavailableError())
            : Effect.succeed(decoded.success);
        }),
      ),

    listIssues: (input) =>
      withRepository(input.repository, (path) => {
        const search = input.query?.trim() ?? "";
        // The boundary instant is read inclusively — the rows already sent at it come back and
        // the caller drops them, which is what keeps their neighbours at the same instant from
        // being skipped.
        const predicates = [
          stateFilter(input.state),
          ...(search.length === 0 ? [] : [searchFilter(search)]),
          ...(input.cursor === undefined ? [] : [`updated_on <= ${input.cursor.updatedBefore}`]),
        ];
        return listPage({
          url: `${path}/issues?pagelen=${MAX_PAGE_SIZE}&sort=-updated_on&q=${encodeURIComponent(
            predicates.join(" AND "),
          )}`,
          limit: input.limit,
          page: 1,
          collected: [],
        });
      }),

    getIssue: (input) =>
      withRepository(input.repository, (path) =>
        readPage({
          operation: "getIssue",
          url: `${path}/issues/${input.number}`,
          decode: decodeIssueJson,
        }),
      ),

    // Nothing on the repository or the issue states what the credentials may do, so this is the
    // one request Bitbucket makes unavoidable — the same read the pull request provider makes.
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

    listComments: (input) =>
      withRepository(input.repository, (path) =>
        commentsPage({
          url: `${path}/issues/${input.number}/comments?pagelen=${MAX_PAGE_SIZE}`,
          page: 1,
          collected: [],
        }),
      ),

    createIssue: (input) =>
      withRepository(input.repository, (path) =>
        bitbucket
          .request({
            method: "POST",
            url: `${path}/issues`,
            body: JSON.stringify({
              title: input.title,
              content: { raw: input.body },
              ...(input.assignee === null ? {} : { assignee: { nickname: input.assignee } }),
            }),
          })
          .pipe(
            Effect.flatMap((response) => {
              const decoded = decodeCreatedIssueJson(response.body);
              return Result.isSuccess(decoded)
                ? Effect.succeed(decoded.success)
                : Effect.fail(
                    new BitbucketIssueReadError({
                      operation: "createIssue",
                      cause: decoded.failure,
                    }),
                  );
            }),
          ),
      ),

    updateIssue: (input) =>
      updateIssue({
        repository: input.repository,
        number: input.number,
        body: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { content: { raw: input.body } }),
        },
      }),

    // Bitbucket has no dedicated close/reopen endpoint for an issue: the state is one field of
    // it, and this is the same PUT the edit uses.
    runAction: (input) =>
      updateIssue({
        repository: input.repository,
        number: input.number,
        body: { state: input.action === "close" ? "closed" : "open" },
      }),

    comment: (input) =>
      withRepository(input.repository, (path) =>
        bitbucket
          .request({
            method: "POST",
            url: `${path}/issues/${input.number}/comments`,
            body: JSON.stringify({ content: { raw: input.body } }),
          })
          .pipe(Effect.asVoid),
      ),

    updateComment: (input) =>
      withRepository(input.repository, (path) =>
        bitbucket
          .request({
            method: "PUT",
            url: `${path}/issues/${input.number}/comments/${encodeURIComponent(input.commentId)}`,
            body: JSON.stringify({ content: { raw: input.body } }),
          })
          .pipe(Effect.asVoid),
      ),

    setAssignee: (input) =>
      updateIssue({
        repository: input.repository,
        number: input.number,
        body: { assignee: input.assignee === null ? null : { nickname: input.assignee } },
      }),
  });
});

export const layer = Layer.effect(BitbucketIssueApi, make);
