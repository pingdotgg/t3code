/**
 * GitHub's issue tracker, over the REST and GraphQL policy the pull request reads use: one credential,
 * one quota reserve, one rate-limit pause per host.
 *
 * Reads go through GraphQL, which is the only API that answers the viewer's standing, the
 * timeline and reactions. Writes to the issue's own fields go through REST `PATCH`, which takes
 * the whole label and assignee sets in one call, the way the port asks for them.
 *
 * @module source-control-github/server/GitHubIssueTracker
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { GraphQLClient, GraphQLClientError, GraphQLGroup } from "effect/graphql";
import {
  IssueTrackerKind,
  SourceControlProviderKind,
  type IssueRelation,
  type IssuePageInput,
  type IssueLinkedPullRequest,
  type IssueCapabilities,
  type IssueInvolvement,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
  type IssueScopeTarget,
  type IssueTarget,
} from "@t3tools/issue-tracker-core/server/IssueTracker";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { readGitHubIssueTemplateFiles } from "./gitHubIssueTemplates.ts";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubGraphQlClient from "./gitHubGraphQlClient.ts";
import { AddReaction, RemoveReaction, UpdateIssueComment } from "./pullRequestMutations.graphql.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { gitHubReactionContent } from "./gitHubPullRequestJson.ts";
import {
  decodeCreatedIssueJson,
  toIssueCandidates,
  toIssueLinkedPullRequests,
  toIssueCommentScope,
  toIssueComments,
  toIssueDetail,
  toIssueHistory,
  decodeRestIssueLabelsJson,
  decodeRestIssueMetadataJson,
  toIssueNodeId,
  toIssueSearch,
  toRepositoryIssues,
  toIssueTemplates,
  toIssueTemplateFiles,
  toIssueEditableCommentScope,
  toIssueViewerPermissions,
  IssueQueries,
  SEARCH_MAX_ROWS,
} from "./gitHubIssueJson.ts";

const RelatedIssue = Schema.Struct({
  id: Schema.Int,
  number: Schema.Int,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  state_reason: Schema.optional(Schema.NullOr(Schema.String)),
  pull_request: Schema.optional(Schema.Unknown),
});
const CandidateActor = Schema.Struct({
  id: Schema.Int,
  login: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});
const CandidateLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
});
const TimelineCursor = Schema.Struct({
  provider: Schema.Literal("github"),
  version: Schema.Literal(1),
  operation: Schema.Literals(["getComments", "getHistory"]),
  cwd: Schema.String,
  host: Schema.String,
  scope: Schema.String,
  key: Schema.String,
  connectionId: Schema.NullOr(Schema.String),
  order: Schema.Literals(["asc", "desc"]),
  cursor: Schema.String,
  window: Schema.Literals(["before", "after"]),
  previous: Schema.NullOr(Schema.String),
});
const decodeTimelineCursor = Schema.decodeResult(Schema.fromJsonString(TimelineCursor), {
  onExcessProperty: "error",
});
const encodeTimelineCursor = Schema.encodeSync(Schema.fromJsonString(TimelineCursor));
const KIND = IssueTrackerKind.make("github");
const MAX_ASSIGNEES = 10;

const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  editComment: true,
  subIssues: true,
  createSubIssue: true,
  updateParent: true,
  dependencies: true,
  listSorts: ["created", "updated", "comments"],
  listOrders: ["asc", "desc"],
  labels: true,
  assignees: true,
  maxAssignees: MAX_ASSIGNEES,
  reactions: true,
  templates: true,
  linkedPullRequests: true,
  events: true,
  search: true,
  involvements: ["all", "assigned", "authored", "mentioned"],
  states: [
    { category: "open", name: "open" },
    { category: "closed", name: "closed" },
  ],
  closeReasons: ["completed", "not-planned"],
};

function skippedMetadata(
  requested: {
    readonly labels?: ReadonlyArray<string> | undefined;
    readonly assignees?: ReadonlyArray<string> | undefined;
  },
  response: GitHubRest.GitHubRestResponse,
): ReadonlyArray<string> {
  const decoded = decodeRestIssueMetadataJson(response.body);
  const actual =
    !response.truncated && !response.invalidUtf8 && Result.isSuccess(decoded)
      ? decoded.success
      : undefined;
  const fields = [
    ["labels", requested.labels, actual?.labels?.map((label) => label.name)],
    ["assignees", requested.assignees, actual?.assignees?.map((assignee) => assignee.login)],
  ] as const;
  return fields.flatMap(([name, expected, saved]) => {
    if (expected === undefined) return [];
    if (saved === undefined) return [name];
    const wanted = new Set(expected.map((value) => value.toLowerCase()));
    const received = new Set(saved.map((value) => value.toLowerCase()));
    return wanted.size === received.size && [...wanted].every((value) => received.has(value))
      ? []
      : [name];
  });
}

/** What a repository selector may hold before it goes into a search query as itself. */
const SEARCH_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** The GraphQL and REST APIs take owner and name apart, so `owner/repo` is split here. */
function parseRepository(scope: string): { readonly owner: string; readonly name: string } {
  const parts = scope.trim().split("/").filter(Boolean);
  return { owner: parts.at(-2) ?? "", name: parts.at(-1) ?? "" };
}

/** An issue key is its number; anything else names no GitHub issue. */
function parseNumber(key: string): number | null {
  return /^[1-9]\d*$/.test(key) ? Number(key) : null;
}

/**
 * The reader's words as quoted search terms. Outside quotes GitHub reads `is:closed` as a
 * qualifier, so text typed into a box could widen the listing it narrows; inside them it is only
 * text. Each word is quoted on its own so the words still match apart, not only as a phrase.
 */
function searchTerms(query: string): ReadonlyArray<string> {
  return query
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => `"${word.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);
}

const INVOLVEMENT_QUALIFIER: Record<IssueInvolvement, string | null> = {
  all: null,
  assigned: "assignee",
  authored: "author",
  mentioned: "mentions",
};

function searchQuery(input: {
  readonly scope: string;
  readonly state: "all" | "open" | "closed";
  readonly involvement: IssueInvolvement;
  readonly viewer: string;
  readonly query?: string | undefined;
  readonly sort?: "created" | "updated" | "comments";
  readonly order?: "asc" | "desc";
  readonly stateCategories?: ReadonlyArray<
    "backlog" | "unstarted" | "started" | "completed" | "canceled"
  >;
}): string {
  const qualifier = INVOLVEMENT_QUALIFIER[input.involvement];
  const categories = input.stateCategories;
  const open =
    categories === undefined ? input.state !== "closed" : categories.includes("unstarted");
  const closed =
    categories === undefined
      ? input.state !== "open"
      : categories.includes("completed") || categories.includes("canceled");
  const state = open && closed ? "all" : open ? "open" : "closed";
  return [
    // The search index holds pull requests as issues; `is:issue` keeps them out.
    "is:issue",
    `repo:${input.scope.trim()}`,
    ...(state === "all" ? [] : [`is:${state}`]),
    ...(categories === undefined ||
    open ||
    categories.includes("completed") === categories.includes("canceled")
      ? []
      : [categories.includes("canceled") ? 'reason:"not planned"' : "reason:completed"]),
    ...(qualifier === null ? [] : [`${qualifier}:${input.viewer}`]),
    `sort:${input.sort ?? "updated"}-${input.order ?? "desc"}`,
    ...searchTerms(input.query ?? ""),
  ].join(" ");
}

/** The REST close reasons, which the capability names in the contract's own spelling. */
const CLOSE_REASON: Record<string, "completed" | "not_planned"> = {
  completed: "completed",
  "not-planned": "not_planned",
};

/** The tags that mean GitHub is out of reach for this account rather than one request failing. */
function reasonFor(error: GitHubRequestPolicy.GitHubApiError): IssueTrackerError["reason"] {
  switch (error._tag) {
    case "GitHubCliMissingError":
      return "missing-tool";
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
    case "GitHubApiAuthenticationError":
      return "unauthenticated";
    case "GitHubApiRateLimitError":
    case "SourceControlRateLimitPausedError":
      return "rate-limited";
    case "GitHubApiNotFoundError":
      return "not-found";
    default:
      return "failed";
  }
}

export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const client = yield* GraphQLClient.make(
    GraphQLGroup.merge(
      IssueQueries,
      GraphQLGroup.make(AddReaction, RemoveReaction, UpdateIssueComment),
    ).middleware(GitHubGraphQlClient.GitHubGraphQlAuth),
  ).pipe(Effect.provide(GitHubGraphQlClient.layer));

  const fail = (operation: string) => (error: GitHubRequestPolicy.GitHubApiError) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: reasonFor(error),
      detail: error.message,
      ...("retryAt" in error && error.retryAt !== undefined ? { retryAt: error.retryAt } : {}),
      cause: error,
    });

  const unreadable = (operation: string, cause: unknown) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: "failed",
      detail: `GitHub returned an unreadable ${operation} response.`,
      cause,
    });

  const notFound = (operation: string) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: "not-found",
      detail: "GitHub could not find the requested issue.",
    });

  const validateAssignees = (assignees: ReadonlyArray<string> | undefined, operation: string) =>
    (assignees?.length ?? 0) > MAX_ASSIGNEES
      ? Effect.fail(
          new IssueTrackerError({
            tracker: KIND,
            operation,
            reason: "failed",
            detail: "GitHub issues support at most 10 assignees.",
          }),
        )
      : Effect.void;

  const graphqlRead = <V, A, B>(input: {
    readonly host: string;
    readonly operation: string;
    readonly query: (
      variables: V,
    ) => Effect.Effect<
      A,
      GitHubRequestPolicy.GitHubApiError | GraphQLClientError.GraphQLClientError,
      GitHubGraphQlClient.GitHubGraphQlTarget
    >;
    readonly variables: NoInfer<V>;
    readonly decode: (data: A) => B;
  }): Effect.Effect<B, IssueTrackerError> =>
    input.query(input.variables).pipe(
      GitHubGraphQlClient.call({ host: input.host, operation: input.operation }),
      Effect.mapError((error) =>
        GraphQLClientError.isGraphQLClientError(error)
          ? unreadable(input.operation, error)
          : fail(input.operation)(error),
      ),
      Effect.map(input.decode),
    );

  const mutate = <V>(input: {
    readonly host: string;
    readonly operation: string;
    readonly query: (
      variables: V,
    ) => Effect.Effect<
      unknown,
      GitHubRequestPolicy.GitHubApiError | GraphQLClientError.GraphQLClientError,
      GitHubGraphQlClient.GitHubGraphQlTarget
    >;
    readonly variables: NoInfer<V>;
  }) => graphqlRead({ ...input, decode: () => undefined });

  /** The issue as REST addresses it, or a not-found for a key that names no number. */
  const restIssue = (
    input: { readonly scope: string; readonly key: string },
    operation: string,
  ): Effect.Effect<
    {
      readonly owner: string;
      readonly name: string;
      readonly number: number;
      readonly path: string;
    },
    IssueTrackerError
  > => {
    const number = parseNumber(input.key);
    const { owner, name } = parseRepository(input.scope);
    return number === null
      ? Effect.fail(notFound(operation))
      : Effect.succeed({ owner, name, number, path: `repos/${owner}/${name}/issues/${number}` });
  };

  const timelineIdentity = (
    input: IssueTarget & { readonly order?: "asc" | "desc" },
    operation: "getComments" | "getHistory",
  ) => ({
    provider: "github" as const,
    version: 1 as const,
    operation,
    cwd: input.cwd,
    host: GitHubRequestPolicy.normalizeHost(input.host),
    scope: input.scope.trim().toLowerCase(),
    key: input.key,
    connectionId: input.connectionId ?? null,
    order: input.order ?? "desc",
  });

  const readTimelineCursor = (
    input: IssueTarget & { readonly order?: "asc" | "desc"; readonly cursor?: string | undefined },
    operation: "getComments" | "getHistory",
  ) =>
    Effect.gen(function* () {
      if (input.order !== undefined && input.order !== "asc" && input.order !== "desc")
        return yield* unreadable(operation, "invalid-order");
      if (input.cursor === undefined) return undefined;
      if (input.cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))
        return yield* unreadable(operation, "invalid-cursor");
      const decoded = decodeTimelineCursor(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (Result.isFailure(decoded)) return yield* unreadable(operation, "invalid-cursor");
      const cursor = decoded.success;
      const identity = timelineIdentity(input, operation);
      if (
        Object.entries(identity).some(
          ([key, value]) => cursor[key as keyof typeof identity] !== value,
        ) ||
        cursor.cursor.trim().length === 0 ||
        cursor.cursor.length > 2048 ||
        cursor.window !== (identity.order === "asc" ? "after" : "before") ||
        cursor.cursor === cursor.previous ||
        (cursor.previous !== null &&
          (cursor.previous.trim().length === 0 || cursor.previous.length > 2048))
      )
        return yield* unreadable(operation, "invalid-cursor");
      return cursor;
    });

  const writeTimelineCursor = (
    input: IssueTarget & { readonly order?: "asc" | "desc" },
    operation: "getComments" | "getHistory",
    cursor: string | null,
    previous?: { readonly cursor: string; readonly previous: string | null },
  ): Effect.Effect<string | null, IssueTrackerError> =>
    Effect.gen(function* () {
      if (cursor === null) return null;
      if (
        cursor.trim().length === 0 ||
        cursor.length > 2048 ||
        cursor === previous?.cursor ||
        cursor === previous?.previous
      )
        return yield* unreadable(operation, "invalid-continuation");
      const encoded = Buffer.from(
        encodeTimelineCursor({
          ...timelineIdentity(input, operation),
          cursor,
          window: input.order === "asc" ? "after" : "before",
          previous: previous?.cursor ?? null,
        }),
      ).toString("base64url");
      if (encoded.length > 8192) return yield* unreadable(operation, "invalid-continuation");
      return encoded;
    });

  /** Every write to an issue's own fields is one `PATCH`; only its body differs. */
  const patchIssue = (
    input: { readonly host: string; readonly scope: string; readonly key: string },
    operation: string,
    body: {
      readonly title?: string;
      readonly body?: string;
      readonly labels?: ReadonlyArray<string>;
      readonly assignees?: ReadonlyArray<string>;
      readonly state?: string;
      readonly state_reason?: string;
    },
  ) =>
    restIssue(input, operation).pipe(
      Effect.tap(() => validateAssignees(body.assignees, operation)),
      Effect.flatMap(({ path }) =>
        api.rest({ host: input.host, operation, method: "PATCH", path, body }).pipe(
          Effect.mapError(fail(operation)),
          Effect.flatMap((response) => {
            if (body.labels === undefined && body.assignees === undefined) return Effect.void;
            const skipped = skippedMetadata(body, response);
            return skipped.length === 0
              ? Effect.void
              : Effect.fail(
                  new IssueTrackerError({
                    tracker: KIND,
                    operation,
                    reason: "failed",
                    detail: `GitHub did not save the requested ${skipped.join(" and ")}.`,
                  }),
                );
          }),
        ),
      ),
    );

  /**
   * A client-given comment id is trusted to be whatever node it names, which can hang off any
   * issue on the host; the mutation would write wherever it belongs unless this agrees first.
   */
  const restRead = <A>(
    input: IssueScopeTarget,
    operation: string,
    path: string,
    schema: Schema.Codec<A, unknown, never, never>,
    method?: "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ) =>
    api
      .rest({
        host: input.host,
        operation,
        path,
        ...(method ? { method } : {}),
        ...(body === undefined ? {} : { body }),
      })
      .pipe(
        Effect.mapError(fail(operation)),
        Effect.flatMap((response) => {
          const decoded = decodeJsonResult(schema)(response.body);
          return !response.truncated && !response.invalidUtf8 && Result.isSuccess(decoded)
            ? Effect.succeed({ value: decoded.success, headers: response.headers })
            : Effect.fail(unreadable(operation, response));
        }),
      );

  const restPage = <A>(
    input: IssueScopeTarget & IssuePageInput,
    operation: string,
    path: string,
    schema: Schema.Codec<A, unknown, never, never>,
  ) => {
    const page =
      input.cursor === undefined
        ? 1
        : /^[1-9]\d{0,6}$/.test(input.cursor)
          ? Number(input.cursor)
          : null;
    if (page === null) return Effect.fail(unreadable(operation, "invalid-cursor"));
    const limit = Math.min(input.limit ?? 50, 100);
    return restRead(
      input,
      operation,
      `${path}?per_page=${limit}&page=${page}`,
      Schema.Array(schema),
    ).pipe(
      Effect.map(({ value, headers }) => ({
        items: value,
        nextCursor: /rel="next"/.test(headers.link ?? "") ? String(page + 1) : null,
      })),
    );
  };

  const relatedIssue = (
    input: IssueScopeTarget,
    row: typeof RelatedIssue.Type,
    operation = "getHierarchy",
  ): Effect.Effect<IssueRelation, IssueTrackerError> => {
    if (!URL.canParse(row.html_url)) return Effect.fail(unreadable(operation, "invalid-url"));
    const url = new URL(row.html_url);
    const match = /^\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (
      !match ||
      !["http:", "https:"].includes(url.protocol) ||
      url.host.toLowerCase() !== input.host.toLowerCase() ||
      match[2] !== String(row.number) ||
      row.pull_request !== undefined ||
      ((operation === "getDependencies" || operation === "setDependency") &&
        (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""))
    ) {
      return Effect.fail(unreadable(operation, "invalid-related-issue"));
    }
    return Effect.succeed({
      scope: match[1]!,
      key: String(row.number),
      displayKey: `#${row.number}`,
      title: row.title,
      url: row.html_url,
      state: {
        category: row.state,
        name: row.state,
        workflowCategory:
          row.state === "open"
            ? "unstarted"
            : row.state_reason === "not_planned"
              ? "canceled"
              : "completed",
      },
    });
  };

  const readRelatedIssue = (input: IssueTarget, operation: string) =>
    restIssue(input, operation).pipe(
      Effect.flatMap(({ path }) => restRead(input, operation, path, RelatedIssue)),
      Effect.flatMap(({ value }) =>
        relatedIssue(input, value, operation).pipe(
          Effect.filterOrFail(
            (ref) => ref.key === input.key && ref.scope.toLowerCase() === input.scope.toLowerCase(),
            () => notFound(operation),
          ),
          Effect.as(value),
        ),
      ),
    );

  const dependencyScope = (scope: string) =>
    SEARCH_REPOSITORY.test(scope) &&
    scope.split("/").every((part) => part !== "." && part !== "..");

  const readViewerPermissions = (input: IssueTarget, operation: string) =>
    restIssue(input, operation).pipe(
      Effect.flatMap(({ owner, name, number }) =>
        graphqlRead({
          host: input.host,
          operation,
          query: client.IssueViewerPermissions,
          variables: { owner, name, number },
          decode: toIssueViewerPermissions,
        }).pipe(
          Effect.filterOrFail(
            (permissions) => permissions !== null,
            () => notFound(operation),
          ),
        ),
      ),
    );

  const dependencyPermissions = (input: IssueTarget) =>
    readViewerPermissions(input, "setDependency").pipe(
      Effect.filterOrFail(
        (permissions) => permissions.updateDependencies,
        () => unreadable("setDependency", "native-permission-refused"),
      ),
    );

  const dependencyIssue = (input: IssueTarget) =>
    readRelatedIssue(input, "setDependency").pipe(
      Effect.filterOrFail(
        (issue) => Number.isSafeInteger(issue.id) && issue.id > 0,
        () => unreadable("setDependency", "invalid-native-issue-id"),
      ),
    );

  const parentIssue = (input: IssueTarget) =>
    restIssue(input, "getHierarchy").pipe(
      Effect.flatMap(({ path }) => restRead(input, "getHierarchy", `${path}/parent`, RelatedIssue)),
      Effect.map(({ value }) => value),
      Effect.catchIf(
        (error) => error.reason === "not-found",
        () => Effect.succeed(null),
      ),
    );

  const attachParent = (input: IssueScopeTarget, parentKey: string, childId: number) =>
    restIssue({ ...input, key: parentKey }, "setParent").pipe(
      Effect.flatMap(({ path }) =>
        restRead(input, "setParent", `${path}/sub_issues`, Schema.Unknown, "POST", {
          sub_issue_id: childId,
          replace_parent: true,
        }),
      ),
      Effect.asVoid,
    );

  const commentBelongsToIssue = (input: {
    readonly host: string;
    readonly scope: string;
    readonly key: string;
    readonly commentId: string;
    readonly operation: string;
  }) =>
    restIssue(input, input.operation).pipe(
      Effect.flatMap(({ owner, name, number }) =>
        graphqlRead({
          host: input.host,
          operation: input.operation,
          query: client.IssueCommentScope,
          variables: { owner, name, number, commentId: input.commentId },
          decode:
            input.operation === "editComment" ? toIssueEditableCommentScope : toIssueCommentScope,
        }),
      ),
      Effect.flatMap((belongs) =>
        belongs
          ? Effect.succeed(input.commentId)
          : Effect.fail(
              new IssueTrackerError({
                tracker: KIND,
                operation: input.operation,
                reason: "failed",
                detail: "The comment does not belong to the selected issue.",
              }),
            ),
      ),
    );

  return {
    kind: KIND,
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      graphqlRead({
        host: input.host,
        operation: "getViewer",
        query: client.IssueViewer,
        variables: {},
        decode: (data) => data.viewer.login,
      }),

    listIssues: (input) => {
      if (!SEARCH_REPOSITORY.test(input.scope.trim())) {
        // A name holding a space could end the `repo:` qualifier and start one of its own, so
        // an unaddressable one refuses the read rather than being escaped into something GitHub
        // might still read.
        return Effect.fail(
          new IssueTrackerError({
            tracker: KIND,
            operation: "listIssues",
            reason: "failed",
            detail: "A repository was named that GitHub cannot address.",
          }),
        );
      }
      if (
        input.stateCategories?.length === 0 ||
        input.stateCategories?.every((category) => category === "backlog" || category === "started")
      )
        return Effect.succeed({ items: [], nextCursor: null });
      const page =
        input.query?.trim() || input.involvement !== "all"
          ? graphqlRead({
              host: input.host,
              operation: "listIssues",
              query: client.IssueSearch,
              variables:
                input.cursor === undefined
                  ? { q: searchQuery(input), first: Math.min(input.limit, SEARCH_MAX_ROWS) }
                  : {
                      q: searchQuery(input),
                      first: Math.min(input.limit, SEARCH_MAX_ROWS),
                      cursor: input.cursor,
                    },
              decode: toIssueSearch,
            })
          : graphqlRead({
              host: input.host,
              operation: "listIssues",
              query: client.RepositoryIssues,
              variables: {
                ...parseRepository(input.scope),
                first: Math.min(input.limit, SEARCH_MAX_ROWS),
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                states: (input.stateCategories === undefined
                  ? input.state === "all"
                    ? ["OPEN", "CLOSED"]
                    : [input.state === "open" ? "OPEN" : "CLOSED"]
                  : [
                      ...(input.stateCategories.includes("unstarted") ? ["OPEN" as const] : []),
                      ...(input.stateCategories.some(
                        (state) => state === "completed" || state === "canceled",
                      )
                        ? ["CLOSED" as const]
                        : []),
                    ]) satisfies ReadonlyArray<"OPEN" | "CLOSED">,
                orderBy: {
                  field: (
                    { created: "CREATED_AT", updated: "UPDATED_AT", comments: "COMMENTS" } as const
                  )[input.sort ?? "updated"],
                  direction: input.order === "asc" ? "ASC" : "DESC",
                },
              },
              decode: toRepositoryIssues,
            }).pipe(
              Effect.filterOrFail(
                (value) => value !== null,
                () => notFound("listIssues"),
              ),
            );
      return page.pipe(
        Effect.map((page) => ({
          ...page,
          items: page.items.filter(
            (item) =>
              input.stateCategories === undefined ||
              (item.state.workflowCategory !== undefined &&
                input.stateCategories.includes(item.state.workflowCategory)),
          ),
        })),
      );
    },

    getIssue: (input) =>
      restIssue(input, "getIssue").pipe(
        Effect.flatMap(({ owner, name, number, path }) =>
          graphqlRead({
            host: input.host,
            operation: "getIssue",
            query: client.IssueDetail,
            variables: { owner, name, number },
            decode: toIssueDetail,
          }).pipe(
            Effect.filterOrFail(
              (detail) => detail !== null,
              () => notFound("getIssue"),
            ),
            Effect.filterOrFail(
              (detail) => detail.commentsCursor !== "",
              () => unreadable("getIssue", "missing-comments-cursor"),
            ),
            Effect.flatMap((detail) =>
              api.rest({ host: input.host, operation: "getIssue", path }).pipe(
                Effect.mapError(fail("getIssue")),
                Effect.flatMap((response) => {
                  const labels = decodeRestIssueLabelsJson(response.body);
                  return !response.truncated && !response.invalidUtf8 && Result.isSuccess(labels)
                    ? writeTimelineCursor(input, "getComments", detail.commentsCursor).pipe(
                        Effect.map((commentsCursor) => ({
                          ...detail,
                          commentsCursor,
                          labels: labels.success,
                          labelsTruncated: false,
                        })),
                      )
                    : Effect.fail(unreadable("getIssue", response));
                }),
              ),
            ),
          ),
        ),
      ),

    getComments: (input) =>
      Effect.gen(function* () {
        const cursor = yield* readTimelineCursor(input, "getComments");
        const { owner, name, number } = yield* restIssue(input, "getComments");
        const asc = input.order === "asc";
        const page = yield* graphqlRead({
          host: input.host,
          operation: "getComments",
          query: client.IssueComments,
          variables: {
            owner,
            name,
            number,
            ...(asc
              ? { first: 100, after: cursor?.cursor }
              : { last: 100, before: cursor?.cursor }),
          },
          decode: (data) => toIssueComments(data, input.order ?? "desc"),
        });
        if (page === null) return yield* notFound("getComments");
        if (
          !page.valid ||
          page.rowCount > 100 ||
          new Set(page.comments.map((row) => row.id)).size !== page.comments.length ||
          (cursor === undefined ? page.oppositePage : page.rowCount === 0)
        )
          return yield* unreadable("getComments", "invalid-page");
        return {
          comments: page.comments,
          nextCursor: yield* writeTimelineCursor(input, "getComments", page.nextCursor, cursor),
        };
      }),

    getViewerPermissions: (input) =>
      readViewerPermissions(input, "getViewerPermissions").pipe(
        Effect.provideService(SourceControlRateLimit.Interactive, true),
      ),

    editComment: (input) =>
      commentBelongsToIssue({ ...input, operation: "editComment" }).pipe(
        Effect.flatMap((id) =>
          mutate({
            host: input.host,
            operation: "editComment",
            query: client.UpdateIssueComment,
            variables: { commentId: id, body: input.body },
          }),
        ),
        Effect.provideService(SourceControlRateLimit.Interactive, true),
      ),

    getDependencies: (input) =>
      Effect.gen(function* () {
        const operation = "getDependencies";
        const number = parseNumber(input.key);
        const page =
          input.cursor === undefined
            ? 1
            : /^[1-9]\d{0,6}$/.test(input.cursor)
              ? Number(input.cursor)
              : null;
        const requestedLimit = input.limit ?? 50;
        const limit = Math.min(requestedLimit, 100);
        if (
          !dependencyScope(input.scope) ||
          number === null ||
          !Number.isSafeInteger(number) ||
          page === null ||
          !Number.isInteger(requestedLimit) ||
          requestedLimit < 1 ||
          requestedLimit > 200
        )
          return yield* unreadable(operation, "invalid-dependency-page");
        const { path } = yield* restIssue(input, operation);
        const endpoint = `${path}/dependencies/${input.direction === "blocks" ? "blocking" : "blocked_by"}`;
        const { value, headers } = yield* restRead(
          input,
          operation,
          `${endpoint}?per_page=${limit}&page=${page}`,
          Schema.Array(RelatedIssue),
        );
        if (value.length > limit) return yield* unreadable(operation, "oversized-dependency-page");
        const nextLinks = [...(headers.link ?? "").matchAll(/<([^>]+)>;\s*rel="next"/g)];
        if (
          nextLinks.length > 1 ||
          (/(?:^|[;\s])rel="next"/.test(headers.link ?? "") && nextLinks.length === 0)
        )
          return yield* unreadable(operation, "invalid-dependency-pagination");
        if (nextLinks.length === 1) {
          const apiRoot = new URL(GitHubRequestPolicy.gitHubApiUrls(input.host).rest);
          const expected = new URL(`${apiRoot.href.replace(/\/$/, "")}/${endpoint}`);
          const next = nextLinks[0]![1]!;
          if (!URL.canParse(next))
            return yield* unreadable(operation, "invalid-dependency-pagination");
          const url = new URL(next);
          const prefix = apiRoot.pathname.replace(/\/$/, "");
          const canonical = url.pathname.startsWith(prefix)
            ? /^\/repositories\/[1-9]\d*(\/issues\/[1-9]\d*\/dependencies\/(?:blocked_by|blocking))$/.exec(
                url.pathname.slice(prefix.length),
              )
            : null;
          if (
            url.origin !== expected.origin ||
            (url.pathname !== expected.pathname &&
              canonical?.[1] !==
                `/issues/${number}/dependencies/${input.direction === "blocks" ? "blocking" : "blocked_by"}`) ||
            url.username !== "" ||
            url.password !== "" ||
            url.hash !== "" ||
            url.searchParams.size !== 2 ||
            url.searchParams.get("page") !== String(page + 1) ||
            url.searchParams.get("per_page") !== String(limit)
          )
            return yield* unreadable(operation, "invalid-dependency-pagination");
        }
        return {
          items: yield* Effect.forEach(value, (row) =>
            relatedIssue(input, row, operation).pipe(
              Effect.filterOrFail(
                (ref) =>
                  dependencyScope(ref.scope) &&
                  Number.isSafeInteger(row.id) &&
                  row.id > 0 &&
                  Number.isSafeInteger(row.number),
                () => unreadable(operation, "invalid-dependency-issue"),
              ),
              Effect.map((ref) => ({ ...ref, kind: "issue" as const })),
            ),
          ),
          nextCursor: nextLinks.length === 1 && page < 9_999_999 ? String(page + 1) : null,
          ...(nextLinks.length === 1 && page === 9_999_999 ? { truncated: true } : {}),
        };
      }),

    setDependency: (input) =>
      Effect.gen(function* () {
        const operation = "setDependency";
        let targetKey = input.targetKey;
        if (URL.canParse(targetKey)) {
          const url = new URL(targetKey);
          const match = /^\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
          if (
            !match ||
            !["http:", "https:"].includes(url.protocol) ||
            url.host.toLowerCase() !== input.host.toLowerCase() ||
            url.username !== "" ||
            url.password !== "" ||
            url.search !== "" ||
            url.hash !== "" ||
            match[1]!.toLowerCase() !== input.targetScope.toLowerCase()
          )
            return yield* unreadable(operation, "invalid-dependency-url");
          targetKey = match[2]!;
        } else {
          const match = /^([^#]+)#([1-9]\d*)$/.exec(targetKey);
          if (match !== null) {
            if (match[1]!.toLowerCase() !== input.targetScope.toLowerCase())
              return yield* unreadable(operation, "conflicting-dependency-scope");
            targetKey = match[2]!;
          }
        }
        const sourceNumber = parseNumber(input.key);
        const targetNumber = parseNumber(targetKey);
        if (
          !dependencyScope(input.scope) ||
          !dependencyScope(input.targetScope) ||
          sourceNumber === null ||
          !Number.isSafeInteger(sourceNumber) ||
          targetNumber === null ||
          !Number.isSafeInteger(targetNumber) ||
          (input.scope.toLowerCase() === input.targetScope.toLowerCase() &&
            sourceNumber === targetNumber)
        )
          return yield* unreadable(operation, "invalid-dependency-target");
        const target = { ...input, scope: input.targetScope, key: targetKey };
        yield* dependencyPermissions(input);
        const sourceIssue = yield* dependencyIssue(input);
        const targetIssue = yield* dependencyIssue(target);
        const inverse = input.direction === "blocks";
        if (inverse) yield* dependencyPermissions(target);
        const blocked = inverse ? target : input;
        const blocker = inverse ? sourceIssue : targetIssue;
        const { path } = yield* restIssue(blocked, operation);
        yield* api
          .rest({
            host: input.host,
            operation,
            path: `${path}/dependencies/blocked_by${input.linked ? "" : `/${blocker.id}`}`,
            method: input.linked ? "POST" : "DELETE",
            ...(input.linked ? { body: { issue_id: blocker.id } } : {}),
          })
          .pipe(Effect.mapError(fail(operation)));
      }).pipe(Effect.provideService(SourceControlRateLimit.Interactive, true)),

    getHierarchy: (input) =>
      Effect.gen(function* () {
        const { path } = yield* restIssue(input, "getHierarchy");
        const [parent, children] = yield* Effect.all(
          [parentIssue(input), restPage(input, "getHierarchy", `${path}/sub_issues`, RelatedIssue)],
          { concurrency: 2 },
        );
        return {
          parent: parent === null ? null : yield* relatedIssue(input, parent),
          children: {
            ...children,
            items: yield* Effect.forEach(children.items, (child) => relatedIssue(input, child)),
          },
        };
      }),

    setParent: (input) =>
      Effect.gen(function* () {
        if (input.parentKey === input.key) return yield* unreadable("setParent", "self-parent");
        const child = yield* readRelatedIssue(input, "setParent");
        if (input.parentKey !== null) {
          yield* readRelatedIssue({ ...input, key: input.parentKey }, "setParent");
          yield* attachParent(input, input.parentKey, child.id);
          return;
        }
        const parent = yield* parentIssue(input);
        if (parent === null) return;
        const ref = yield* relatedIssue(input, parent);
        const { path } = yield* restIssue(
          { ...input, scope: ref.scope, key: ref.key },
          "setParent",
        );
        yield* restRead(input, "setParent", `${path}/sub_issue`, Schema.Unknown, "DELETE", {
          sub_issue_id: child.id,
        });
      }).pipe(Effect.provideService(SourceControlRateLimit.Interactive, true)),

    getHistory: (input) =>
      Effect.gen(function* () {
        const cursor = yield* readTimelineCursor(input, "getHistory");
        const limit = input.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
          return yield* unreadable("getHistory", "invalid-limit");
        const { owner, name, number } = yield* restIssue(input, "getHistory");
        const asc = input.order === "asc";
        const page = yield* graphqlRead({
          host: input.host,
          operation: "getHistory",
          query: client.IssueHistory,
          variables: {
            owner,
            name,
            number,
            ...(asc
              ? { first: limit, after: cursor?.cursor }
              : { last: limit, before: cursor?.cursor }),
          },
          decode: (data) => toIssueHistory(data, input.order ?? "desc"),
        });
        if (page === null) return yield* notFound("getHistory");
        if (
          !page.valid ||
          page.rowCount > limit ||
          new Set(page.items.map((row) => row.id)).size !== page.items.length ||
          (cursor === undefined ? page.oppositePage : page.rowCount === 0)
        )
          return yield* unreadable("getHistory", "invalid-page");
        return {
          items: page.items,
          nextCursor: yield* writeTimelineCursor(input, "getHistory", page.nextCursor, cursor),
        };
      }),

    listLabelCandidates: (input) => {
      const { owner, name } = parseRepository(input.scope);
      return restPage(
        input,
        "listLabelCandidates",
        `repos/${owner}/${name}/labels`,
        CandidateLabel,
      );
    },

    listAssigneeCandidates: (input) => {
      const { owner, name } = parseRepository(input.scope);
      return restPage(
        input,
        "listAssigneeCandidates",
        `repos/${owner}/${name}/assignees`,
        CandidateActor,
      ).pipe(
        Effect.map((page) => ({
          ...page,
          items: page.items.map((actor) => ({
            id: actor.login,
            login: actor.login,
            name: actor.name ?? null,
            avatarUrl: actor.avatar_url ?? null,
          })),
        })),
      );
    },

    getLinkedPullRequests: (input) =>
      Effect.gen(function* () {
        const match = /^(closing|related):(.*)$/.exec(input.cursor ?? "closing:");
        if (match === null) return yield* unreadable("getLinkedPullRequests", "invalid-cursor");
        const closing = match[1] === "closing";
        const { owner, name, number } = yield* restIssue(input, "getLinkedPullRequests");
        const variables = {
          owner,
          name,
          number,
          first: Math.min(input.limit ?? 50, 100),
          after: match[2] || null,
        };
        const page = yield* (
          closing
            ? graphqlRead({
                host: input.host,
                operation: "getLinkedPullRequests",
                query: client.IssueClosingPullRequests,
                variables,
                decode: (data) => toIssueLinkedPullRequests(data, true),
              })
            : graphqlRead({
                host: input.host,
                operation: "getLinkedPullRequests",
                query: client.IssueRelatedPullRequests,
                variables,
                decode: (data) => toIssueLinkedPullRequests(data, false),
              })
        ).pipe(
          Effect.filterOrFail(
            (connection) => connection !== null,
            () => unreadable("getLinkedPullRequests", "missing-issue"),
          ),
        );
        if (page.pageInfo.hasNextPage && page.pageInfo.endCursor === null)
          return yield* unreadable("getLinkedPullRequests", "missing-cursor");
        const seen = new Set<string>();
        return {
          nextCursor: page.pageInfo.hasNextPage
            ? `${closing ? "closing" : "related"}:${page.pageInfo.endCursor}`
            : closing
              ? "related:"
              : null,
          items: page.items.flatMap((pr): IssueLinkedPullRequest[] => {
            if (seen.has(pr.url)) return [];
            seen.add(pr.url);
            return [
              { ...pr, provider: SourceControlProviderKind.make("github"), host: input.host },
            ];
          }),
        };
      }),

    create: (input) =>
      Effect.gen(function* () {
        yield* validateAssignees(input.assignees, "create");
        if (input.parentKey !== undefined)
          yield* readRelatedIssue({ ...input, key: input.parentKey }, "create");
        const { owner, name } = parseRepository(input.scope);
        const response = yield* api
          .rest({
            host: input.host,
            operation: "create",
            method: "POST",
            path: `repos/${owner}/${name}/issues`,
            body: {
              title: input.title,
              body: input.body,
              labels: input.labels,
              assignees: input.assignees,
            },
          })
          .pipe(Effect.mapError(fail("create")));
        const decoded = decodeCreatedIssueJson(response.body);
        if (!Result.isSuccess(decoded)) return yield* unreadable("create", response);
        const created = {
          key: String(decoded.success.number),
          displayKey: `#${decoded.success.number}`,
          url: decoded.success.url,
          warnings: skippedMetadata(
            {
              labels: input.labels.length === 0 ? undefined : input.labels,
              assignees: input.assignees.length === 0 ? undefined : input.assignees,
            },
            response,
          ).map(
            (field) => `The issue was created, but GitHub did not save the requested ${field}.`,
          ),
        };
        if (input.parentKey === undefined) return created;
        const parentLinked =
          decoded.success.id === undefined
            ? false
            : yield* attachParent(input, input.parentKey, decoded.success.id).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
        return { ...created, parentLinked };
      }).pipe(Effect.provideService(SourceControlRateLimit.Interactive, true)),

    comment: (input) =>
      restIssue(input, "comment").pipe(
        Effect.flatMap(({ path }) =>
          api
            .rest({
              host: input.host,
              operation: "comment",
              method: "POST",
              path: `${path}/comments`,
              body: { body: input.body },
            })
            .pipe(Effect.asVoid, Effect.mapError(fail("comment"))),
        ),
        Effect.provideService(SourceControlRateLimit.Interactive, true),
      ),

    update: (input) =>
      patchIssue(input, "update", {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
      }).pipe(Effect.provideService(SourceControlRateLimit.Interactive, true)),

    setState: (input) =>
      patchIssue(input, "setState", {
        state: input.state,
        ...(input.state === "closed" && input.closeReason !== undefined
          ? { state_reason: CLOSE_REASON[input.closeReason] }
          : {}),
      }).pipe(Effect.provideService(SourceControlRateLimit.Interactive, true)),

    setReaction: (input) =>
      (input.subjectId === undefined
        ? restIssue(input, "setReaction").pipe(
            Effect.flatMap(({ owner, name, number }) =>
              graphqlRead({
                host: input.host,
                operation: "setReaction",
                query: client.IssueNodeId,
                variables: { owner, name, number },
                decode: toIssueNodeId,
              }).pipe(
                Effect.filterOrFail(
                  (id) => id !== null,
                  () => notFound("setReaction"),
                ),
              ),
            ),
          )
        : commentBelongsToIssue({
            ...input,
            commentId: input.subjectId,
            operation: "setReaction",
          })
      ).pipe(
        Effect.flatMap((subjectId) =>
          mutate({
            host: input.host,
            operation: "setReaction",
            query: input.reacted ? client.AddReaction : client.RemoveReaction,
            variables: { subjectId, content: gitHubReactionContent(input.content) },
          }),
        ),
        Effect.provideService(SourceControlRateLimit.Interactive, true),
      ),

    listTemplates: (input) =>
      Effect.gen(function* () {
        if (
          !SEARCH_REPOSITORY.test(input.scope) ||
          (input.metadataOnly && input.templateKey !== undefined)
        )
          return yield* unreadable("listTemplates", "invalid-template-selection");
        const { owner, name } = parseRepository(input.scope);
        const prefix = `github-default:${owner.toLowerCase()}/.github:`;
        if (
          input.templateKey?.startsWith("github-default:") &&
          (!input.templateKey.startsWith(prefix) ||
            !/^[0-9a-f]{40}:[^/\\\p{Cc}]+$/u.test(input.templateKey.slice(prefix.length)))
        )
          return yield* unreadable("listTemplates", "invalid-default-template");
        const read = (repository: string) =>
          graphqlRead({
            host: input.host,
            operation: "listTemplates",
            query: client.IssueTemplates,
            variables: {
              owner,
              name: repository,
              includeBody: !input.metadataOnly,
            },
            decode: (data) => {
              const templates = toIssueTemplates(data);
              const files = toIssueTemplateFiles(data);
              if (files === null) return null;
              const parsed = readGitHubIssueTemplateFiles(files.entries);
              return {
                ...files,
                markdown: templates.filter((template) => !/\.ya?ml$/i.test(template.key)),
                parsed,
                markdownNames: [
                  ...parsed.markdownNames,
                  ...readGitHubIssueTemplateFiles(files.legacyEntries).markdownNames,
                ],
              };
            },
          }).pipe(
            Effect.filterOrFail(
              (value) => value !== null,
              () => notFound("listTemplates"),
            ),
          );
        const local = yield* read(name);
        if (
          local.repository !== undefined &&
          local.repository.toLowerCase() !== input.scope.toLowerCase()
        )
          return yield* unreadable("listTemplates", "different-repository");
        const localMarkdown = local.markdown.some((template) =>
          local.markdownNames.includes(template.key.split("/").at(-1) ?? ""),
        );
        let effective = local;
        let inherited = false;
        if (
          !local.parsed.hasConfig &&
          !local.parsed.hasForms &&
          !localMarkdown &&
          name !== ".github"
        ) {
          const defaults = yield* read(".github").pipe(
            Effect.catchIf(
              (error) => error.reason !== "rate-limited",
              () => Effect.succeed(null),
            ),
          );
          if (
            defaults !== null &&
            defaults.isPrivate === false &&
            defaults.repository?.toLowerCase() === `${owner}/.github`.toLowerCase() &&
            defaults.oid !== undefined &&
            /^[0-9a-f]{40}$/.test(defaults.oid)
          ) {
            effective = defaults;
            inherited = true;
          }
        }
        const templates = [...effective.markdown, ...effective.parsed.templates].map(
          (template) => ({
            ...template,
            ...(inherited
              ? { key: `${prefix}${effective.oid}:${template.key.split("/").at(-1)}` }
              : {}),
            ...(input.metadataOnly ? { body: "", contentDeferred: true } : {}),
          }),
        );
        const selected =
          input.templateKey === undefined
            ? templates
            : templates.filter((template) => template.key === input.templateKey);
        if (input.templateKey !== undefined && selected.length === 0)
          return yield* unreadable("listTemplates", "template-changed-or-missing");
        return {
          templates: selected,
          blankIssuesEnabled: effective.parsed.blankIssuesEnabled,
          ...(effective.parsed.externalTemplates.length === 0
            ? {}
            : {
                externalTemplates: effective.parsed.externalTemplates.map((template) => ({
                  name: template.name,
                  about: template.about,
                  url: `https://${input.host}/${input.scope}/issues/new?${new URLSearchParams({ template: template.key })}`,
                })),
              }),
          ...(effective.parsed.contactLinks.length === 0
            ? {}
            : { contactLinks: effective.parsed.contactLinks }),
        };
      }),

    listCandidates: (input) => {
      const { owner, name } = parseRepository(input.scope);
      return graphqlRead({
        host: input.host,
        operation: "listCandidates",
        query: client.IssueCandidates,
        variables: { owner, name },
        decode: toIssueCandidates,
      }).pipe(
        Effect.filterOrFail(
          (value) => value !== null,
          () => notFound("listCandidates"),
        ),
      );
    },
  } satisfies IssueTrackerApi;
});
