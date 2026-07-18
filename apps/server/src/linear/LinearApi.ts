import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  LinearApiError,
  type LinearApiOperation,
  type LinearGetIssueInput,
  type LinearIssueDetail,
  type LinearIssueSummary,
  type LinearSearchIssuesInput,
  type LinearSearchIssuesResult,
  type LinearStatus,
} from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

const DESCRIPTION_MAX_LENGTH = 3000;
const COMMENT_BODY_MAX_LENGTH = 800;

const STATUS_QUERY = `query { viewer { name } organization { name } }`;

const SEARCH_ISSUES_QUERY = `query($term: String!, $first: Int!) { searchIssues(term: $term, first: $first) { nodes { id identifier title url state { name type } team { key } } } }`;

const RECENT_ISSUES_QUERY = `query($first: Int!) { issues(first: $first, orderBy: updatedAt) { nodes { id identifier title url state { name type } team { key } } } }`;

const GET_ISSUE_QUERY = `query($id: String!) { issue(id: $id) { id identifier title url description priorityLabel updatedAt state { name type } team { key } assignee { displayName } labels(first: 50) { nodes { name } } comments(first: 8) { nodes { body createdAt user { name } } } } }`;

const StatusDataSchema = Schema.Struct({
  viewer: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  organization: Schema.NullOr(Schema.Struct({ name: Schema.String })),
});

const IssueStateSchema = Schema.NullOr(Schema.Struct({ name: Schema.String, type: Schema.String }));
const IssueTeamSchema = Schema.NullOr(Schema.Struct({ key: Schema.String }));

const IssueSummaryNodeSchema = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  state: IssueStateSchema,
  team: IssueTeamSchema,
});

const SearchIssuesDataSchema = Schema.Struct({
  searchIssues: Schema.Struct({
    nodes: Schema.Array(IssueSummaryNodeSchema),
  }),
});

const IssuesDataSchema = Schema.Struct({
  issues: Schema.Struct({
    nodes: Schema.Array(IssueSummaryNodeSchema),
  }),
});

const GetIssueDataSchema = Schema.Struct({
  issue: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      identifier: Schema.String,
      title: Schema.String,
      url: Schema.String,
      description: Schema.NullOr(Schema.String),
      priorityLabel: Schema.NullOr(Schema.String),
      updatedAt: Schema.String,
      state: IssueStateSchema,
      team: IssueTeamSchema,
      assignee: Schema.NullOr(Schema.Struct({ displayName: Schema.String })),
      labels: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ name: Schema.String })) }),
      comments: Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            body: Schema.String,
            createdAt: Schema.String,
            user: Schema.NullOr(Schema.Struct({ name: Schema.String })),
          }),
        ),
      }),
    }),
  ),
});

const graphqlResponseSchema = <S extends Schema.Top>(dataSchema: S) =>
  Schema.Struct({
    data: Schema.optional(Schema.NullOr(dataSchema)),
    errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
  });

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}… [truncated]` : value;
}

function toIssueSummary(node: {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly state: { readonly name: string; readonly type: string } | null;
  readonly team: { readonly key: string } | null;
}): LinearIssueSummary {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    stateName: node.state?.name ?? "",
    stateType: node.state?.type ?? "",
    teamKey: node.team?.key ?? "",
  };
}

export class LinearApi extends Context.Service<
  LinearApi,
  {
    readonly getStatus: Effect.Effect<LinearStatus, LinearApiError>;
    readonly searchIssues: (
      input: LinearSearchIssuesInput,
    ) => Effect.Effect<LinearSearchIssuesResult, LinearApiError>;
    readonly getIssue: (
      input: LinearGetIssueInput,
    ) => Effect.Effect<LinearIssueDetail, LinearApiError>;
  }
>()("t3/linear/LinearApi") {}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const readApiKey = (operation: LinearApiOperation) =>
    serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.linear.apiKey.trim()),
      Effect.mapError(
        (cause) =>
          new LinearApiError({
            operation,
            message: "Failed to read the Linear API key from server settings.",
            cause,
          }),
      ),
    );

  const requireApiKey = (operation: LinearApiOperation) =>
    readApiKey(operation).pipe(
      Effect.flatMap((apiKey) =>
        apiKey.length === 0
          ? Effect.fail(
              new LinearApiError({
                operation,
                message: "Linear is not connected.",
                cause: "not-connected",
              }),
            )
          : Effect.succeed(apiKey),
      ),
    );

  const graphql = <S extends Schema.Top>(
    operation: LinearApiOperation,
    apiKey: string,
    query: string,
    variables: Record<string, unknown>,
    dataSchema: S,
  ): Effect.Effect<S["Type"], LinearApiError, S["DecodingServices"]> =>
    httpClient
      .execute(
        HttpClientRequest.post(LINEAR_GRAPHQL_URL).pipe(
          HttpClientRequest.setHeader("authorization", apiKey),
          HttpClientRequest.bodyJsonUnsafe({ query, variables }),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new LinearApiError({
              operation,
              message: "Failed to send the Linear API request.",
              cause,
            }),
        ),
        Effect.flatMap((response) =>
          HttpClientResponse.matchStatus({
            "2xx": (success) =>
              HttpClientResponse.schemaBodyJson(graphqlResponseSchema(dataSchema))(success).pipe(
                Effect.mapError(
                  (cause) =>
                    new LinearApiError({
                      operation,
                      message: "Linear returned an unexpected response.",
                      cause,
                    }),
                ),
                Effect.flatMap((body) => {
                  if (body.errors !== undefined && body.errors.length > 0) {
                    return Effect.fail(
                      new LinearApiError({
                        operation,
                        message: body.errors[0]?.message ?? "Linear returned a GraphQL error.",
                        cause: body.errors,
                      }),
                    );
                  }
                  if (body.data === undefined || body.data === null) {
                    return Effect.fail(
                      new LinearApiError({
                        operation,
                        message: "Linear returned no data.",
                        cause: "empty-response",
                      }),
                    );
                  }
                  return Effect.succeed(body.data);
                }),
              ),
            orElse: (failed) =>
              failed.text.pipe(
                Effect.mapError(
                  (cause) =>
                    new LinearApiError({
                      operation,
                      message: `Linear returned HTTP ${failed.status}.`,
                      cause,
                    }),
                ),
                Effect.flatMap((bodyText) =>
                  Effect.fail(
                    new LinearApiError({
                      operation,
                      message: `Linear returned HTTP ${failed.status}.`,
                      cause: bodyText,
                    }),
                  ),
                ),
              ),
          })(response),
        ),
      );

  return LinearApi.of({
    getStatus: Effect.gen(function* () {
      const apiKey = yield* readApiKey("getStatus");
      if (apiKey.length === 0) {
        return { connected: false } satisfies LinearStatus;
      }
      const data = yield* graphql("getStatus", apiKey, STATUS_QUERY, {}, StatusDataSchema);
      return {
        connected: true,
        viewerName: data.viewer?.name ?? "",
        organizationName: data.organization?.name ?? "",
      } satisfies LinearStatus;
    }),
    searchIssues: (input) =>
      Effect.gen(function* () {
        const apiKey = yield* requireApiKey("searchIssues");
        const term = input.query.trim();
        const first = input.first ?? 10;
        if (term.length === 0) {
          const data = yield* graphql(
            "searchIssues",
            apiKey,
            RECENT_ISSUES_QUERY,
            { first },
            IssuesDataSchema,
          );
          return {
            issues: data.issues.nodes.map(toIssueSummary),
          } satisfies LinearSearchIssuesResult;
        }
        const data = yield* graphql(
          "searchIssues",
          apiKey,
          SEARCH_ISSUES_QUERY,
          { term, first },
          SearchIssuesDataSchema,
        );
        return {
          issues: data.searchIssues.nodes.map(toIssueSummary),
        } satisfies LinearSearchIssuesResult;
      }),
    getIssue: (input) =>
      Effect.gen(function* () {
        const apiKey = yield* requireApiKey("getIssue");
        const data = yield* graphql(
          "getIssue",
          apiKey,
          GET_ISSUE_QUERY,
          { id: input.issueId },
          GetIssueDataSchema,
        );
        const issue = data.issue;
        if (issue === null) {
          return yield* new LinearApiError({
            operation: "getIssue",
            message: `Linear issue ${input.issueId} was not found.`,
            cause: "not-found",
          });
        }
        return {
          ...toIssueSummary(issue),
          description:
            issue.description === null ? null : truncate(issue.description, DESCRIPTION_MAX_LENGTH),
          priorityLabel: issue.priorityLabel,
          assigneeName: issue.assignee?.displayName ?? null,
          labels: issue.labels.nodes.map((label) => label.name),
          updatedAt: issue.updatedAt,
          comments: issue.comments.nodes.map((comment) => ({
            authorName: comment.user?.name ?? null,
            body: truncate(comment.body, COMMENT_BODY_MAX_LENGTH),
            createdAt: comment.createdAt,
          })),
        } satisfies LinearIssueDetail;
      }),
  });
});

export const layer = Layer.effect(LinearApi, make);
