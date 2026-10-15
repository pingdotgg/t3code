/**
 * GitHub's issue tracker, over the same `GitHubApi` the pull request reads use: one credential,
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
import {
  IssueTrackerKind,
  type IssueCapabilities,
  type IssueInvolvement,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as GitHubApi from "./GitHubApi.ts";
import {
  ADD_REACTION_GRAPHQL_MUTATION,
  gitHubReactionContent,
  REMOVE_REACTION_GRAPHQL_MUTATION,
} from "./gitHubPullRequestJson.ts";
import {
  decodeCreatedIssueJson,
  decodeIssueCandidatesJson,
  decodeIssueCommentScopeJson,
  decodeIssueCommentsJson,
  decodeIssueDetailJson,
  decodeIssueNodeIdJson,
  decodeIssueSearchJson,
  decodeIssueTemplatesJson,
  decodeIssueViewerPermissionsJson,
  decodeViewerLoginJson,
  ISSUE_CANDIDATES_GRAPHQL_QUERY,
  ISSUE_COMMENT_SCOPE_GRAPHQL_QUERY,
  ISSUE_COMMENTS_GRAPHQL_QUERY,
  ISSUE_DETAIL_GRAPHQL_QUERY,
  ISSUE_NODE_ID_GRAPHQL_QUERY,
  ISSUE_TEMPLATES_GRAPHQL_QUERY,
  ISSUE_VIEWER_PERMISSIONS_GRAPHQL_QUERY,
  issueSearchGraphQlQuery,
  SEARCH_MAX_ROWS,
} from "./gitHubIssueJson.ts";

const KIND = IssueTrackerKind.make("github");

const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
  reactions: true,
  templates: true,
  linkedPullRequests: true,
  events: true,
  search: true,
  states: [
    { category: "open", name: "open" },
    { category: "closed", name: "closed" },
  ],
  closeReasons: ["completed", "not-planned"],
};

/** Where a repository configures the rest of its issue chooser, as GitHub spells the path. */
const TEMPLATE_CONFIG_PATH = ".github/ISSUE_TEMPLATE/config.yml";

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
}): string {
  const qualifier = INVOLVEMENT_QUALIFIER[input.involvement];
  return [
    // The search index holds pull requests as issues; `is:issue` keeps them out.
    "is:issue",
    `repo:${input.scope.trim()}`,
    ...(input.state === "all" ? [] : [`is:${input.state}`]),
    ...(qualifier === null ? [] : [`${qualifier}:${input.viewer}`]),
    "sort:updated-desc",
    ...searchTerms(input.query ?? ""),
  ].join(" ");
}

/** The REST close reasons, which the capability names in the contract's own spelling. */
const CLOSE_REASON: Record<string, "completed" | "not_planned"> = {
  completed: "completed",
  "not-planned": "not_planned",
};

/** The tags that mean GitHub is out of reach for this account rather than one request failing. */
function reasonFor(error: GitHubApi.GitHubApiError): IssueTrackerError["reason"] {
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

export const make: Effect.Effect<IssueTrackerApi, never, GitHubApi.GitHubApi> = Effect.gen(
  function* () {
    const api = yield* GitHubApi.GitHubApi;

    const fail = (operation: string) => (error: GitHubApi.GitHubApiError) =>
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

    /** A GraphQL read whose answer is decoded, reporting a failure against the read that made it. */
    const graphqlRead = <A>(input: {
      readonly host: string;
      readonly operation: string;
      readonly query: string;
      readonly variables?: Readonly<Record<string, unknown>>;
      readonly decode: (raw: string) => Result.Result<A, unknown>;
    }): Effect.Effect<A, IssueTrackerError> =>
      api
        .graphql({
          host: input.host,
          operation: input.operation,
          query: input.query,
          ...(input.variables === undefined ? {} : { variables: input.variables }),
        })
        .pipe(
          Effect.mapError(fail(input.operation)),
          Effect.flatMap((raw) => {
            const decoded = input.decode(raw.trim());
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(unreadable(input.operation, decoded.failure));
          }),
        );

    const mutate = (input: {
      readonly host: string;
      readonly operation: string;
      readonly query: string;
      readonly variables: Readonly<Record<string, unknown>>;
    }) => api.graphql(input).pipe(Effect.asVoid, Effect.mapError(fail(input.operation)));

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

    /** Every write to an issue's own fields is one `PATCH`; only its body differs. */
    const patchIssue = (
      input: { readonly host: string; readonly scope: string; readonly key: string },
      operation: string,
      body: Record<string, unknown>,
    ) =>
      restIssue(input, operation).pipe(
        Effect.flatMap(({ path }) =>
          api
            .rest({ host: input.host, operation, method: "PATCH", path, body })
            .pipe(Effect.asVoid, Effect.mapError(fail(operation))),
        ),
      );

    /**
     * A client-given comment id is trusted to be whatever node it names, which can hang off any
     * issue on the host; the mutation would write wherever it belongs unless this agrees first.
     */
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
            query: ISSUE_COMMENT_SCOPE_GRAPHQL_QUERY,
            variables: { owner, name, number, commentId: input.commentId },
            decode: decodeIssueCommentScopeJson,
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
          query: "query { viewer { login } }",
          decode: decodeViewerLoginJson,
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
        return graphqlRead({
          host: input.host,
          operation: "listIssues",
          query: issueSearchGraphQlQuery(Math.min(input.limit, SEARCH_MAX_ROWS)),
          variables:
            input.cursor === undefined
              ? { q: searchQuery(input) }
              : { q: searchQuery(input), cursor: input.cursor },
          decode: decodeIssueSearchJson,
        });
      },

      getIssue: (input) =>
        restIssue(input, "getIssue").pipe(
          Effect.flatMap(({ owner, name, number }) =>
            graphqlRead({
              host: input.host,
              operation: "getIssue",
              query: ISSUE_DETAIL_GRAPHQL_QUERY,
              variables: { owner, name, number },
              decode: decodeIssueDetailJson,
            }),
          ),
          Effect.filterOrFail(
            (detail) => detail !== null,
            () => notFound("getIssue"),
          ),
        ),

      getComments: (input) =>
        restIssue(input, "getComments").pipe(
          Effect.flatMap(({ owner, name, number }) =>
            graphqlRead({
              host: input.host,
              operation: "getComments",
              query: ISSUE_COMMENTS_GRAPHQL_QUERY,
              variables: { owner, name, number, cursor: input.cursor },
              decode: decodeIssueCommentsJson,
            }),
          ),
        ),

      getViewerPermissions: (input) =>
        restIssue(input, "getViewerPermissions").pipe(
          Effect.flatMap(({ owner, name, number }) =>
            graphqlRead({
              host: input.host,
              operation: "getViewerPermissions",
              query: ISSUE_VIEWER_PERMISSIONS_GRAPHQL_QUERY,
              variables: { owner, name, number },
              decode: decodeIssueViewerPermissionsJson,
            }),
          ),
        ),

      create: (input) => {
        const { owner, name } = parseRepository(input.scope);
        return api
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
          .pipe(
            Effect.mapError(fail("create")),
            Effect.flatMap((response) => {
              const decoded = decodeCreatedIssueJson(response.body);
              return Result.isSuccess(decoded)
                ? Effect.succeed({
                    key: String(decoded.success.number),
                    displayKey: `#${decoded.success.number}`,
                    url: decoded.success.url,
                  })
                : Effect.fail(unreadable("create", decoded.failure));
            }),
          );
      },

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
        ),

      update: (input) =>
        patchIssue(input, "update", {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.labels === undefined ? {} : { labels: input.labels }),
          ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
        }),

      setState: (input) =>
        patchIssue(input, "setState", {
          state: input.state,
          ...(input.state === "closed" && input.closeReason !== undefined
            ? { state_reason: CLOSE_REASON[input.closeReason] }
            : {}),
        }),

      setReaction: (input) =>
        (input.subjectId === undefined
          ? restIssue(input, "setReaction").pipe(
              Effect.flatMap(({ owner, name, number }) =>
                graphqlRead({
                  host: input.host,
                  operation: "setReaction",
                  query: ISSUE_NODE_ID_GRAPHQL_QUERY,
                  variables: { owner, name, number },
                  decode: decodeIssueNodeIdJson,
                }),
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
              query: input.reacted
                ? ADD_REACTION_GRAPHQL_MUTATION
                : REMOVE_REACTION_GRAPHQL_MUTATION,
              variables: { subjectId, content: gitHubReactionContent(input.content) },
            }),
          ),
        ),

      listTemplates: (input) => {
        const { owner, name } = parseRepository(input.scope);
        return Effect.all(
          [
            graphqlRead({
              host: input.host,
              operation: "listTemplates",
              query: ISSUE_TEMPLATES_GRAPHQL_QUERY,
              variables: { owner, name },
              decode: decodeIssueTemplatesJson,
            }),
            // Only an explicit `blank_issues_enabled: false` takes the blank issue away; a missing
            // config, or one this account may not read, leaves it where GitHub puts it.
            api
              .rest({
                host: input.host,
                operation: "listTemplateConfig",
                accept: "application/vnd.github.raw",
                path: `repos/${owner}/${name}/contents/${TEMPLATE_CONFIG_PATH}`,
              })
              .pipe(
                Effect.map(
                  (response) => !/^\s*blank_issues_enabled\s*:\s*false\s*$/m.test(response.body),
                ),
                Effect.catch((error) =>
                  error._tag === "GitHubApiRateLimitError" ||
                  error._tag === "SourceControlRateLimitPausedError"
                    ? Effect.fail(fail("listTemplateConfig")(error))
                    : Effect.succeed(true),
                ),
              ),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([templates, blankIssuesEnabled]) => ({ templates, blankIssuesEnabled })),
        );
      },

      listCandidates: (input) => {
        const { owner, name } = parseRepository(input.scope);
        return graphqlRead({
          host: input.host,
          operation: "listCandidates",
          query: ISSUE_CANDIDATES_GRAPHQL_QUERY,
          variables: { owner, name },
          decode: decodeIssueCandidatesJson,
        });
      },
    };
  },
);
