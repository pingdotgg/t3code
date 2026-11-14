import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { GraphQLClient, GraphQLClientError, GraphQLGroup } from "effect/graphql";
import {
  IssueTrackerKind,
  type IssueCapabilities,
  type IssueInvolvement,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
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
  decodeCreatedIssueJson,
  toIssueCandidates,
  toIssueComments,
  toIssueDetail,
  toIssueSearch,
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

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;

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
    "is:issue",
    `repo:${input.scope.trim()}`,
    ...(input.state === "all" ? [] : [`is:${input.state}`]),
    ...(qualifier === null ? [] : [`${qualifier}:${input.viewer}`]),
    "sort:updated-desc",
    ...searchTerms(input.query ?? ""),
  ].join(" ");
}

const CLOSE_REASON: Record<string, "completed" | "not_planned"> = {
  completed: "completed",
  "not-planned": "not_planned",
};

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
    const id = result.repository?.issue?.id;
    if (id === undefined) return yield* notFound(operation);
    return { ...target, id };
  });

  const patchIssue = (
    input: { readonly host: string; readonly scope: string; readonly key: string },
    operation: string,
    body: Record<string, unknown>,
  ) =>
    verifiedIssue(input, operation).pipe(
      Effect.flatMap(({ path }) =>
        api
          .rest({ host: input.host, operation, method: "PATCH", path, body })
          .pipe(Effect.asVoid, Effect.mapError(fail(operation))),
      ),
    );

  return {
    kind: KIND,
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      client.IssueViewer({}).pipe(
        graphql(input.host, "getViewer"),
        Effect.map(({ viewer }) => viewer.login),
      ),

    listIssues: (input) =>
      repository(input.scope, "listIssues").pipe(
        Effect.flatMap(() =>
          client
            .IssueSearch({
              q: searchQuery(input),
              cursor: input.cursor,
              rows: Math.min(Math.max(Math.trunc(input.limit), 1), 100),
            })
            .pipe(graphql(input.host, "listIssues"), Effect.map(toIssueSearch)),
        ),
      ),

    getIssue: Effect.fn("GitHubIssueTracker.getIssue")(function* (input) {
      const { owner, name, number } = yield* issue(input, "getIssue");
      const result = yield* client
        .IssueDetail({ owner, name, number })
        .pipe(graphql(input.host, "getIssue"));
      const detail = toIssueDetail(result);
      const raw = result.repository?.issue;
      if (detail === null || raw == null) return yield* notFound("getIssue");
      // Editing replaces these sets. Finish their pages before handing them to a client.
      let labels = raw.labels;
      let assignees = raw.assignees;
      const seen = new Set<string>();
      const allLabels = [...detail.labels];
      const allAssignees = [...detail.assignees];
      while (labels?.pageInfo.hasNextPage === true || assignees.pageInfo.hasNextPage) {
        const labelsCursor = labels?.pageInfo.hasNextPage ? labels.pageInfo.endCursor : null;
        const assigneesCursor = assignees.pageInfo.hasNextPage
          ? assignees.pageInfo.endCursor
          : null;
        const key = `${labelsCursor ?? ""} ${assigneesCursor ?? ""}`;
        if (
          (labels?.pageInfo.hasNextPage && labelsCursor === null) ||
          (assignees.pageInfo.hasNextPage && assigneesCursor === null) ||
          seen.has(key)
        ) {
          return yield* invalid(
            "getIssue",
            "GitHub did not return complete issue labels or assignees.",
          );
        }
        seen.add(key);
        const page = yield* client
          .IssueCollections({ owner, name, number, labelsCursor, assigneesCursor })
          .pipe(graphql(input.host, "getIssue"));
        const next = page.repository?.issue;
        if (next == null) return yield* notFound("getIssue");
        if (labels?.pageInfo.hasNextPage) {
          labels = next.labels;
          if (next.labels === null) {
            return yield* invalid("getIssue", "GitHub did not return complete issue labels.");
          }
          allLabels.push(
            ...(next.labels.nodes ?? []).flatMap((node) =>
              node === null ? [] : [{ name: node.name, color: node.color }],
            ),
          );
        }
        if (assignees.pageInfo.hasNextPage) {
          assignees = next.assignees;
          allAssignees.push(
            ...(next.assignees.nodes ?? []).flatMap((node) =>
              node === null
                ? []
                : [{ login: node.login, name: node.name, avatarUrl: node.avatarUrl }],
            ),
          );
        }
      }
      return { ...detail, labels: allLabels, assignees: allAssignees };
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
