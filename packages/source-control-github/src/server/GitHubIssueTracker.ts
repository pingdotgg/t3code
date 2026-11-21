import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { GraphQLClient, GraphQLClientError, GraphQLGroup } from "effect/graphql";
import {
  IssueTrackerKind,
  type IssueCapabilities,
  type IssueActor,
  type IssueInvolvement,
  type IssueLabel,
  type IssueListSort,
} from "@t3tools/contracts";
import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import {
  IssueTrackerError,
  type IssueInvolvementFilter,
  type IssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";

import * as GitHubRest from "./GitHubRest.ts";
import { readIssueTemplates } from "./gitHubIssueTemplates.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubGraphQlClient from "./gitHubGraphQlClient.ts";
import { IssuesGraphQLGroup } from "./issues.graphql.ts";
import { AddReaction, RemoveReaction } from "./pullRequestMutations.graphql.ts";
import { gitHubReactionContent } from "./gitHubPullRequestJson.ts";
import {
  ISSUE_STATES,
  decodeCreatedIssueJson,
  decodeIssueMetadataJson,
  toIssueCandidates,
  toIssueComments,
  toIssueDetail,
  toIssueSearch,
  toRepositoryIssues,
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
};

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;

/** Quoted, so no character in it can start a qualifier of its own. */
function quotedTerm(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function searchTerms(query: string): ReadonlyArray<string> {
  return query
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map(quotedTerm);
}

const REPOSITORY_ISSUES_CURSOR = "repository-issues:";

function isMissingRepository(error: unknown): boolean {
  if (!GraphQLClientError.isGraphQLClientError(error) || error.reason._tag !== "ResponseError") {
    return false;
  }
  const { status, errors } = error.reason;
  return (
    status === 200 &&
    errors.length > 0 &&
    errors.every(
      ({ type, path }) => type === "NOT_FOUND" && path?.length === 1 && path[0] === "repository",
    )
  );
}

const INVOLVEMENT_QUALIFIER: Record<Exclude<IssueInvolvement, "all">, string> = {
  assigned: "assignee",
  authored: "author",
  mentioned: "mentions",
};

function searchQuery(
  input: IssueInvolvementFilter & {
    readonly scope: string;
    readonly state: "all" | "open" | "closed";
    readonly query?: string | undefined;
    readonly labels?: ReadonlyArray<string> | undefined;
    readonly assignee?: string | undefined;
    readonly sort: IssueListSort;
  },
): string {
  return [
    "is:issue",
    `repo:${input.scope.trim()}`,
    ...(input.state === "all" ? [] : [`is:${input.state}`]),
    ...(input.involvement === "all"
      ? []
      : [`${INVOLVEMENT_QUALIFIER[input.involvement]}:${input.viewer}`]),
    ...(input.labels ?? []).map((label) => `label:${quotedTerm(label)}`),
    ...(input.assignee === undefined ? [] : [`assignee:${quotedTerm(input.assignee)}`]),
    `sort:${input.sort}-desc`,
    ...searchTerms(input.query ?? ""),
  ].join(" ");
}

function reasonFor(
  error: GitHubRequestPolicy.GitHubApiError | GraphQLClientError.GraphQLClientError,
): IssueTrackerError["reason"] {
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

const FAILURE_DETAIL: Record<IssueTrackerError["reason"], string> = {
  "missing-tool": "GitHub CLI is not installed.",
  unauthenticated: "GitHub authentication is unavailable. Sign in and retry.",
  "rate-limited": "GitHub API rate limit exceeded.",
  "not-found": "GitHub could not find the requested issue.",
  failed: "The GitHub issue request failed.",
};

const group = GraphQLGroup.merge(
  IssuesGraphQLGroup,
  GraphQLGroup.make(AddReaction, RemoveReaction),
).middleware(GitHubGraphQlClient.GitHubGraphQlAuth);

export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const client = yield* GraphQLClient.make(group).pipe(Effect.provide(GitHubGraphQlClient.layer));

  const fail =
    (operation: string) =>
    (error: GitHubRequestPolicy.GitHubApiError | GraphQLClientError.GraphQLClientError) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: reasonFor(error),
        detail: GraphQLClientError.isGraphQLClientError(error)
          ? `GitHub returned an unreadable ${operation} response.`
          : FAILURE_DETAIL[reasonFor(error)],
        ...("retryAt" in error && error.retryAt !== undefined ? { retryAt: error.retryAt } : {}),
        cause: error,
      });

  const invalid = (operation: string, detail: string, reason: "failed" | "not-found" = "failed") =>
    new IssueTrackerError({ tracker: KIND, operation, reason, detail });

  const notFound = (operation: string) =>
    invalid(operation, "GitHub could not find the requested issue.", "not-found");

  const repository = Effect.fn("GitHubIssueTracker.repository")(function* (
    scope: string,
    operation: string,
  ) {
    if (!REPOSITORY.test(scope) || scope.endsWith("/.") || scope.endsWith("/..")) {
      return yield* invalid(operation, "A repository was named that GitHub cannot address.");
    }
    const [owner = "", name = ""] = scope.split("/");
    return { owner, name };
  });

  const issue = Effect.fn("GitHubIssueTracker.issue")(function* (
    input: { readonly scope: string; readonly key: string },
    operation: string,
  ) {
    const repo = yield* repository(input.scope, operation);
    const number = Number(input.key);
    if (!/^[1-9]\d*$/.test(input.key) || !Number.isSafeInteger(number) || number > 2_147_483_647) {
      return yield* notFound(operation);
    }
    return { ...repo, number, path: `repos/${repo.owner}/${repo.name}/issues/${number}` };
  });

  const graphql =
    (host: string, operation: string) =>
    <A, E extends GitHubRequestPolicy.GitHubApiError | GraphQLClientError.GraphQLClientError, R>(
      effect: Effect.Effect<A, E, R>,
    ) =>
      effect.pipe(GitHubGraphQlClient.call({ host, operation }), Effect.mapError(fail(operation)));

  const verifiedIssue = Effect.fn("GitHubIssueTracker.verifiedIssue")(function* (
    input: { readonly host: string; readonly scope: string; readonly key: string },
    operation: string,
  ) {
    const target = yield* issue(input, operation);
    const { owner, name, number } = target;
    // REST issue endpoints also accept pull requests; resolve an Issue before writing.
    const result = yield* client
      .IssueNodeId({ owner, name, number })
      .pipe(graphql(input.host, operation));
    const found = result.repository?.issue;
    if (found == null) return yield* notFound(operation);
    return { ...target, id: found.id, state: found.state, stateReason: found.stateReason };
  });

  // As sets: GitHub applies a name asked for twice once.
  const sameNames = (wanted: ReadonlyArray<string>, applied: ReadonlyArray<string>) => {
    const names = new Set(wanted.map((name) => name.trim().toLowerCase()));
    return (
      names.size === new Set(applied).size && [...names].every((name) => applied.includes(name))
    );
  };

  return {
    kind: KIND,
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      client.IssueViewer({}).pipe(
        graphql(input.host, "getViewer"),
        Effect.map(({ viewer }) => viewer.login),
      ),

    listIssues: Effect.fn("GitHubIssueTracker.listIssues")(function* (input) {
      const { owner, name } = yield* repository(input.scope, "listIssues");
      const rows = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
      const host = normalizeHost(input.host);
      // A cursor is valid only for the GraphQL connection that issued it.
      const directPage = input.cursor?.startsWith(REPOSITORY_ISSUES_CURSOR) === true;
      const cursor = directPage ? input.cursor?.slice(REPOSITORY_ISSUES_CURSOR.length) : undefined;
      const unfiltered =
        host === "github.com" &&
        input.involvement === "all" &&
        (input.query?.trim() ?? "") === "" &&
        (input.labels?.length ?? 0) === 0 &&
        input.assignee === undefined;
      if (unfiltered && (input.cursor === undefined || (directPage && cursor !== ""))) {
        const held = yield* api.credential(host).pipe(Effect.mapError(fail("listIssues")));
        if (held.source !== undefined && held.source !== "app") {
          return yield* client
            .RepositoryIssues({
              owner,
              name,
              states:
                input.state === "all" ? undefined : [input.state === "open" ? "OPEN" : "CLOSED"],
              sort: input.sort === "created" ? "CREATED_AT" : "UPDATED_AT",
              cursor,
              rows,
            })
            .pipe(
              // Search answers an empty page when the repository does not exist or is private.
              Effect.catchIf(isMissingRepository, () => Effect.succeed({ repository: null })),
              graphql(host, "listIssues"),
              Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
                host,
                source: held.source,
                token: held.token,
                credentialFingerprint: held.fingerprint,
              }),
              Effect.map(({ repository }) => {
                const page = toRepositoryIssues(repository);
                return {
                  items: page.items,
                  nextCursor:
                    page.nextCursor === null ? null : REPOSITORY_ISSUES_CURSOR + page.nextCursor,
                };
              }),
            );
        }
      }
      if (directPage) {
        return yield* invalid(
          "listIssues",
          "This issue page is no longer available. Refresh the issues list.",
        );
      }

      return yield* client
        .IssueSearch({ q: searchQuery(input), cursor: input.cursor, rows })
        .pipe(graphql(input.host, "listIssues"), Effect.map(toIssueSearch));
    }),

    getIssue: Effect.fn("GitHubIssueTracker.getIssue")(function* (input) {
      const { owner, name, number } = yield* issue(input, "getIssue");
      const result = yield* client
        .IssueDetail({ owner, name, number })
        .pipe(graphql(input.host, "getIssue"));
      const repository = result.repository;
      const raw = repository?.issue;
      if (repository == null || raw == null) return yield* notFound("getIssue");
      // Editing replaces labels and assignees, and a closing reference can sit past the first
      // page. Finish their pages before handing the issue to a client.
      let labels = raw.labels;
      let assignees = raw.assignees;
      let closing = raw.closedByPullRequestsReferences;
      const seen = new Set<string>();
      const moreLabels: IssueLabel[] = [];
      const moreAssignees: IssueActor[] = [];
      const allClosing = [...(closing?.nodes ?? [])];
      while (
        labels?.pageInfo.hasNextPage === true ||
        assignees.pageInfo.hasNextPage ||
        closing?.pageInfo.hasNextPage === true
      ) {
        const labelsCursor = labels?.pageInfo.hasNextPage ? labels.pageInfo.endCursor : null;
        const assigneesCursor = assignees.pageInfo.hasNextPage
          ? assignees.pageInfo.endCursor
          : null;
        const closingPullRequestsCursor = closing?.pageInfo.hasNextPage
          ? closing.pageInfo.endCursor
          : null;
        const key = `${labelsCursor ?? ""} ${assigneesCursor ?? ""} ${closingPullRequestsCursor ?? ""}`;
        if (
          (labels?.pageInfo.hasNextPage && labelsCursor === null) ||
          (assignees.pageInfo.hasNextPage && assigneesCursor === null) ||
          (closing?.pageInfo.hasNextPage && closingPullRequestsCursor === null) ||
          seen.has(key)
        ) {
          return yield* invalid(
            "getIssue",
            "GitHub did not return complete issue labels, assignees or linked pull requests.",
          );
        }
        seen.add(key);
        const page = yield* client
          .IssueCollections({
            owner,
            name,
            number,
            labelsCursor,
            assigneesCursor,
            closingPullRequestsCursor,
            withLabels: labelsCursor !== null,
            withAssignees: assigneesCursor !== null,
            withClosingPullRequests: closingPullRequestsCursor !== null,
          })
          .pipe(graphql(input.host, "getIssue"));
        const next = page.repository?.issue;
        if (next == null) return yield* notFound("getIssue");
        if (labelsCursor !== null) {
          if (next.labels == null) {
            return yield* invalid("getIssue", "GitHub did not return complete issue labels.");
          }
          labels = next.labels;
          moreLabels.push(
            ...(next.labels.nodes ?? []).flatMap((node) =>
              node === null ? [] : [{ name: node.name, color: node.color }],
            ),
          );
        }
        if (assigneesCursor !== null) {
          if (next.assignees === undefined) {
            return yield* invalid("getIssue", "GitHub did not return complete issue assignees.");
          }
          assignees = next.assignees;
          moreAssignees.push(
            ...(next.assignees.nodes ?? []).flatMap((node) =>
              node === null
                ? []
                : [{ login: node.login, name: node.name, avatarUrl: node.avatarUrl }],
            ),
          );
        }
        if (closingPullRequestsCursor !== null) {
          if (next.closedByPullRequestsReferences == null) {
            return yield* invalid(
              "getIssue",
              "GitHub did not return complete linked pull requests.",
            );
          }
          closing = next.closedByPullRequestsReferences;
          allClosing.push(...(closing.nodes ?? []));
        }
      }
      const detail = toIssueDetail({
        ...result,
        repository: {
          ...repository,
          issue: {
            ...raw,
            closedByPullRequestsReferences:
              raw.closedByPullRequestsReferences === null
                ? null
                : { ...raw.closedByPullRequestsReferences, nodes: allClosing },
          },
        },
      });
      if (detail === null) return yield* notFound("getIssue");
      return {
        ...detail,
        labels: [...detail.labels, ...moreLabels],
        assignees: [...detail.assignees, ...moreAssignees],
      };
    }),

    getComments: (input) =>
      issue(input, "getComments").pipe(
        Effect.flatMap(({ owner, name, number }) =>
          client
            .IssueComments({ owner, name, number, cursor: input.cursor })
            .pipe(graphql(input.host, "getComments")),
        ),
        Effect.flatMap((result) =>
          result.repository?.issue == null
            ? Effect.fail(notFound("getComments"))
            : Effect.succeed(toIssueComments(result)),
        ),
      ),

    create: (input) =>
      repository(input.scope, "create").pipe(
        Effect.flatMap(({ owner, name }) =>
          api
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
            .pipe(Effect.mapError(fail("create"))),
        ),
        Effect.flatMap((response) => {
          const decoded = decodeCreatedIssueJson(response.body);
          return Result.isSuccess(decoded)
            ? Effect.succeed({
                key: String(decoded.success.number),
                displayKey: `#${decoded.success.number}`,
                url: decoded.success.url,
              })
            : Effect.fail(
                new IssueTrackerError({
                  tracker: KIND,
                  operation: "create",
                  reason: "failed",
                  detail: "GitHub returned an unreadable create response.",
                  cause: decoded.failure,
                }),
              );
        }),
      ),

    comment: (input) =>
      verifiedIssue(input, "comment").pipe(
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

    update: Effect.fn("GitHubIssueTracker.update")(function* (input) {
      const { path } = yield* verifiedIssue(input, "update");
      const response = yield* api
        .rest({
          host: input.host,
          operation: "update",
          method: "PATCH",
          path,
          body: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
            ...(input.labels === undefined ? {} : { labels: input.labels }),
            ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
          },
        })
        .pipe(Effect.mapError(fail("update")));
      // Without triage access GitHub drops labels and assignees and still answers with success.
      const applied = decodeIssueMetadataJson(response.body);
      if (
        Result.isSuccess(applied) &&
        ((input.labels !== undefined && !sameNames(input.labels, applied.success.labels)) ||
          (input.assignees !== undefined && !sameNames(input.assignees, applied.success.assignees)))
      ) {
        return yield* invalid(
          "update",
          "GitHub did not apply the labels or assignees. Changing them needs triage access to the repository.",
        );
      }
    }),

    setState: Effect.fn("GitHubIssueTracker.setState")(function* (input) {
      const { path, state, stateReason } = yield* verifiedIssue(input, "setState");
      const wanted = ISSUE_STATES.find((candidate) => candidate.name === input.state);
      if (wanted === undefined) {
        return yield* invalid("setState", `A GitHub issue has no "${input.state}" state.`);
      }
      const reason = wanted.closeReason?.replace("-", "_");
      // GitHub ignores `state_reason` unless the state changes, and would answer with success.
      if (reason !== undefined && state === "CLOSED" && stateReason?.toLowerCase() !== reason) {
        return yield* invalid(
          "setState",
          "GitHub cannot change why a closed issue was closed. Reopen it, then close it again.",
        );
      }
      yield* api
        .rest({
          host: input.host,
          operation: "setState",
          method: "PATCH",
          path,
          body: {
            state: wanted.category,
            ...(reason === undefined ? {} : { state_reason: reason }),
          },
        })
        .pipe(Effect.mapError(fail("setState")));
    }),

    setReaction: Effect.fn("GitHubIssueTracker.setReaction")(function* (input) {
      let subjectId: string;
      if (input.subjectId === undefined) {
        const target = yield* verifiedIssue(input, "setReaction");
        subjectId = target.id;
      } else {
        const { owner, name, number } = yield* issue(input, "setReaction");
        // Node ids are global: prove the comment belongs to this issue before writing.
        const result = yield* client
          .IssueCommentScope({ owner, name, number, commentId: input.subjectId })
          .pipe(graphql(input.host, "setReaction"));
        const expected = result.repository?.issue?.id;
        if (
          expected === undefined ||
          result.node?.__typename !== "IssueComment" ||
          result.node.issue.id !== expected
        ) {
          return yield* invalid(
            "setReaction",
            "The comment does not belong to the selected issue.",
          );
        }
        subjectId = input.subjectId;
      }
      const variables = { subjectId, content: gitHubReactionContent(input.content) };
      yield* (
        input.reacted
          ? client.AddReaction(variables).pipe(Effect.asVoid)
          : client.RemoveReaction(variables).pipe(Effect.asVoid)
      ).pipe(graphql(input.host, "setReaction"));
    }),

    listTemplates: (input) =>
      repository(input.scope, "listTemplates").pipe(
        Effect.flatMap(({ owner, name }) =>
          client.IssueTemplates({ owner, name }).pipe(graphql(input.host, "listTemplates")),
        ),
        Effect.flatMap(({ repository }) =>
          repository === null
            ? Effect.fail(notFound("listTemplates"))
            : readIssueTemplates(repository),
        ),
      ),

    listCandidates: (input) =>
      repository(input.scope, "listCandidates").pipe(
        Effect.flatMap(({ owner, name }) =>
          client.IssueCandidates({ owner, name }).pipe(graphql(input.host, "listCandidates")),
        ),
        Effect.flatMap(({ repository }) =>
          repository === null
            ? Effect.fail(notFound("listCandidates"))
            : Effect.succeed(toIssueCandidates(repository)),
        ),
      ),
  } satisfies IssueTrackerApi;
});
