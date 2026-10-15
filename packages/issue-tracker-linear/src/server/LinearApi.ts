/**
 * Linear's GraphQL API over the platform HttpClient, signed with the personal API key the user
 * saved in Settings. One method per document the tracker needs; every response is decoded
 * against a schema here, so the tracker above sees Linear's shapes and nothing looser.
 *
 * Linear rate-limits by query complexity and reports the budget in `x-ratelimit-*` headers; a
 * refusal arrives as HTTP 429 or as a `RATELIMITED` GraphQL error on a 400, and both map to
 * `rate-limited` with the reset time when Linear names one.
 *
 * @module issue-tracker-linear/server/LinearApi
 */
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { IssueTrackerKind } from "@t3tools/contracts";
import { IssueTrackerError } from "@t3tools/issue-tracker-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/issue-tracker-core/server/IssueTrackerHost";
import { retryAtFromHeader } from "@t3tools/source-control-core/server/SourceControlRateLimit";

export const KIND = IssueTrackerKind.make("linear");
const DEFAULT_API_URL = "https://api.linear.app/graphql";

const LinearApiConfig = Config.all({
  apiUrl: Config.String("T3CODE_LINEAR_API_URL").pipe(Config.withDefault(DEFAULT_API_URL)),
});

// --- Linear's shapes -----------------------------------------------------------------------

export const LinearUser = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});
export type LinearUser = typeof LinearUser.Type;

const LinearTeam = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  name: Schema.String,
});
type LinearTeam = typeof LinearTeam.Type;

/** `type` is one of Linear's categories: triage, backlog, unstarted, started, completed, canceled. */
export const LinearWorkflowState = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  position: Schema.optional(Schema.Number),
});
export type LinearWorkflowState = typeof LinearWorkflowState.Type;

const LinearLabel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});
type LinearLabel = typeof LinearLabel.Type;

export const LinearReaction = Schema.Struct({
  id: Schema.String,
  emoji: Schema.String,
  user: Schema.NullOr(LinearUser),
});
export type LinearReaction = typeof LinearReaction.Type;

export const LinearComment = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  url: Schema.NullOr(Schema.String),
  user: Schema.NullOr(LinearUser),
  reactions: Schema.Array(LinearReaction),
});
export type LinearComment = typeof LinearComment.Type;

const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});

const Connection = <S extends Schema.Top>(node: S) =>
  Schema.Struct({ nodes: Schema.Array(node), pageInfo: PageInfo });

export const LinearIssue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  description: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  canceledAt: Schema.NullOr(Schema.String),
  state: LinearWorkflowState,
  creator: Schema.NullOr(LinearUser),
  assignee: Schema.NullOr(LinearUser),
  labels: Schema.Struct({ nodes: Schema.Array(LinearLabel) }),
});
export type LinearIssue = typeof LinearIssue.Type;

export const LinearAttachment = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  sourceType: Schema.NullOr(Schema.String),
  metadata: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
});
export type LinearAttachment = typeof LinearAttachment.Type;

export const LinearHistoryEntry = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  actor: Schema.NullOr(LinearUser),
  fromState: Schema.NullOr(LinearWorkflowState),
  toState: Schema.NullOr(LinearWorkflowState),
  fromAssignee: Schema.NullOr(LinearUser),
  toAssignee: Schema.NullOr(LinearUser),
  addedLabels: Schema.NullOr(Schema.Array(LinearLabel)),
  removedLabels: Schema.NullOr(Schema.Array(LinearLabel)),
  fromTitle: Schema.NullOr(Schema.String),
  toTitle: Schema.NullOr(Schema.String),
});
export type LinearHistoryEntry = typeof LinearHistoryEntry.Type;

const LinearTemplateData = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.Unknown),
  descriptionData: Schema.optional(Schema.Unknown),
  labelIds: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  assigneeId: Schema.optional(Schema.NullOr(Schema.String)),
});

export const LinearTemplate = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** The template body as markdown, where Linear stored it that way. */
  content: Schema.NullOr(Schema.String),
  type: Schema.String,
  hasFormFields: Schema.Boolean,
  templateData: Schema.Union([Schema.fromJsonString(LinearTemplateData), LinearTemplateData]),
});
export type LinearTemplate = typeof LinearTemplate.Type;

const LinearIssueDetail = Schema.Struct({
  ...LinearIssue.fields,
  comments: Connection(LinearComment),
  reactions: Schema.Array(LinearReaction),
  attachments: Schema.Struct({ nodes: Schema.Array(LinearAttachment) }),
  history: Schema.Struct({ nodes: Schema.Array(LinearHistoryEntry) }),
});
type LinearIssueDetail = typeof LinearIssueDetail.Type;

// --- Documents -----------------------------------------------------------------------------

const USER_FIELDS = "id name displayName email avatarUrl";
const STATE_FIELDS = "id name type position";
const LABEL_FIELDS = "id name color";
const REACTION_FIELDS = `id emoji user { ${USER_FIELDS} }`;
const COMMENT_FIELDS = `id body createdAt url user { ${USER_FIELDS} } reactions { ${REACTION_FIELDS} }`;
const ISSUE_FIELDS = `
  id identifier number title url description createdAt updatedAt completedAt canceledAt
  state { ${STATE_FIELDS} }
  creator { ${USER_FIELDS} }
  assignee { ${USER_FIELDS} }
  labels { nodes { ${LABEL_FIELDS} } }
`;

const VIEWER_QUERY = `query T3Viewer {
  viewer { ${USER_FIELDS} }
  teams(first: 250) { nodes { id key name } }
}`;
const LIST_QUERY = `query T3Issues($first: Int!, $after: String, $filter: IssueFilter!) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;
const ISSUE_QUERY = `query T3Issue($id: String!, $comments: Int!) {
  issue(id: $id) {
    ${ISSUE_FIELDS}
    comments(first: $comments, orderBy: createdAt) {
      nodes { ${COMMENT_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
    reactions { ${REACTION_FIELDS} }
    attachments(first: 50) { nodes { url title sourceType metadata } }
    history(first: 100, orderBy: createdAt) {
      nodes {
        id createdAt actor { ${USER_FIELDS} }
        fromState { ${STATE_FIELDS} } toState { ${STATE_FIELDS} }
        fromAssignee { ${USER_FIELDS} } toAssignee { ${USER_FIELDS} }
        addedLabels { ${LABEL_FIELDS} } removedLabels { ${LABEL_FIELDS} }
        fromTitle toTitle
      }
    }
  }
}`;
const COMMENTS_QUERY = `query T3Comments($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    comments(first: $first, after: $after, orderBy: createdAt) {
      nodes { ${COMMENT_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const TEAM_QUERY = `query T3Team($key: String!) {
  teams(first: 1, filter: { key: { eq: $key } }) {
    nodes {
      id key name
      states(first: 100) { nodes { ${STATE_FIELDS} } pageInfo { hasNextPage endCursor } }
      labels(first: 250) { nodes { ${LABEL_FIELDS} description } pageInfo { hasNextPage endCursor } }
      members(first: 250) { nodes { ${USER_FIELDS} } pageInfo { hasNextPage endCursor } }
      templates { nodes { id name description content type hasFormFields templateData } }
    }
  }
  issueLabels(first: 250, filter: { team: { null: true } }) {
    nodes { ${LABEL_FIELDS} description } pageInfo { hasNextPage endCursor }
  }
}`;
const ISSUE_CREATE_MUTATION = `mutation T3IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { identifier url } }
}`;
const ISSUE_UPDATE_MUTATION = `mutation T3IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;
const COMMENT_CREATE_MUTATION = `mutation T3CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;
const REACTION_CREATE_MUTATION = `mutation T3ReactionCreate($input: ReactionCreateInput!) {
  reactionCreate(input: $input) { success }
}`;
const REACTION_DELETE_MUTATION = `mutation T3ReactionDelete($id: String!) {
  reactionDelete(id: $id) { success }
}`;
const ISSUE_REACTIONS_QUERY = `query T3IssueReactions($id: String!) {
  issue(id: $id) { reactions { ${REACTION_FIELDS} } }
}`;
const COMMENT_REACTIONS_QUERY = `query T3CommentReactions($id: String!) {
  comment(id: $id) { reactions { ${REACTION_FIELDS} } }
}`;

// --- Envelopes -----------------------------------------------------------------------------

const GraphQlError = Schema.Struct({
  message: Schema.String,
  extensions: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.String) })),
});
type GraphQlError = typeof GraphQlError.Type;

const Envelope = <S extends Schema.Top>(data: S) =>
  Schema.Struct({
    data: Schema.optional(Schema.NullOr(data)),
    errors: Schema.optional(Schema.Array(GraphQlError)),
  });

const ViewerData = Schema.Struct({
  viewer: LinearUser,
  teams: Schema.Struct({ nodes: Schema.Array(LinearTeam) }),
});
const ListData = Schema.Struct({ issues: Connection(LinearIssue) });
const IssueData = Schema.Struct({ issue: Schema.NullOr(LinearIssueDetail) });
const CommentsData = Schema.Struct({
  issue: Schema.NullOr(Schema.Struct({ comments: Connection(LinearComment) })),
});
const LinearTeamDetail = Schema.Struct({
  ...LinearTeam.fields,
  states: Connection(LinearWorkflowState),
  labels: Connection(LinearLabel),
  members: Connection(LinearUser),
  templates: Schema.Struct({ nodes: Schema.Array(LinearTemplate) }),
});
type LinearTeamDetail = typeof LinearTeamDetail.Type;
const TeamData = Schema.Struct({
  teams: Schema.Struct({ nodes: Schema.Array(LinearTeamDetail) }),
  issueLabels: Connection(LinearLabel),
});
const CreatedData = Schema.Struct({
  issueCreate: Schema.Struct({
    success: Schema.Boolean,
    issue: Schema.NullOr(Schema.Struct({ identifier: Schema.String, url: Schema.String })),
  }),
});
const SuccessData = Schema.Record(Schema.String, Schema.Struct({ success: Schema.Boolean }));
const ReactionsData = Schema.Struct({
  issue: Schema.optional(Schema.NullOr(Schema.Struct({ reactions: Schema.Array(LinearReaction) }))),
  comment: Schema.optional(
    Schema.NullOr(Schema.Struct({ reactions: Schema.Array(LinearReaction) })),
  ),
});

// --- Service -------------------------------------------------------------------------------

/** The team with the workspace-wide labels that any of its issues may also carry. */
export interface LinearTeamScope {
  readonly team: LinearTeamDetail;
  readonly workspaceLabels: ReadonlyArray<LinearLabel>;
  /** Linear had more than one page of something; a missing label or member may still exist. */
  readonly truncated: boolean;
}

export class LinearApi extends Context.Service<
  LinearApi,
  {
    /** Who a credential is, and the teams it reaches. Takes the token so it can vet a new one. */
    readonly viewer: (
      token?: string,
    ) => Effect.Effect<
      { readonly viewer: LinearUser; readonly teams: ReadonlyArray<LinearTeam> },
      IssueTrackerError
    >;
    readonly listIssues: (input: {
      readonly filter: Record<string, unknown>;
      readonly first: number;
      readonly after?: string | undefined;
    }) => Effect.Effect<
      { readonly nodes: ReadonlyArray<LinearIssue>; readonly nextCursor: string | null },
      IssueTrackerError
    >;
    /** Null when Linear has no issue by that identifier, or the credential cannot see it. */
    readonly getIssue: (
      identifier: string,
      comments: number,
    ) => Effect.Effect<LinearIssueDetail | null, IssueTrackerError>;
    readonly getComments: (input: {
      readonly identifier: string;
      readonly first: number;
      readonly after: string;
    }) => Effect.Effect<
      { readonly nodes: ReadonlyArray<LinearComment>; readonly nextCursor: string | null },
      IssueTrackerError
    >;
    readonly getTeam: (key: string) => Effect.Effect<LinearTeamScope | null, IssueTrackerError>;
    readonly createIssue: (
      input: Record<string, unknown>,
    ) => Effect.Effect<{ readonly identifier: string; readonly url: string }, IssueTrackerError>;
    readonly updateIssue: (
      identifier: string,
      input: Record<string, unknown>,
    ) => Effect.Effect<void, IssueTrackerError>;
    readonly createComment: (input: {
      readonly issueId: string;
      readonly body: string;
    }) => Effect.Effect<void, IssueTrackerError>;
    readonly createReaction: (input: {
      readonly issueId?: string | undefined;
      readonly commentId?: string | undefined;
      readonly emoji: string;
    }) => Effect.Effect<void, IssueTrackerError>;
    readonly deleteReaction: (id: string) => Effect.Effect<void, IssueTrackerError>;
    /** Reactions on an issue (by identifier) or a comment (by id), to find the viewer's own. */
    readonly listReactions: (input: {
      readonly issueId?: string | undefined;
      readonly commentId?: string | undefined;
    }) => Effect.Effect<ReadonlyArray<LinearReaction>, IssueTrackerError>;
  }
>()("@t3tools/issue-tracker-linear/server/LinearApi") {}

const fail = (
  operation: string,
  reason: IssueTrackerError["reason"],
  detail: string,
  extra: { readonly retryAt?: number; readonly cause?: unknown } = {},
) =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason,
    detail,
    ...(extra.retryAt === undefined ? {} : { retryAt: extra.retryAt }),
    ...(extra.cause === undefined ? {} : { cause: extra.cause }),
  });

const isRateLimited = (errors: ReadonlyArray<GraphQlError> | undefined) =>
  errors?.some((error) => error.extensions?.code === "RATELIMITED") === true;

const isUnauthenticated = (errors: ReadonlyArray<GraphQlError> | undefined) =>
  errors?.some((error) => error.extensions?.code === "AUTHENTICATION_ERROR") === true;

/** The first error's text, which Linear writes for people ("Entity not found: Issue"). */
const errorDetail = (errors: ReadonlyArray<GraphQlError> | undefined, fallback: string) =>
  errors?.[0]?.message.trim() || fallback;

export const make = Effect.gen(function* () {
  // Only a default-carrying string: nothing in the environment can make it fail.
  const config = yield* LinearApiConfig.pipe(Effect.orDie);
  const httpClient = yield* HttpClient.HttpClient;
  const host = yield* IssueTrackerHost.IssueTrackerHost;

  const storedToken = (operation: string) =>
    host.credentials
      .get(KIND)
      .pipe(
        Effect.flatMap(
          Effect.fromOption(() =>
            fail(operation, "unauthenticated", "Linear is not connected on this server."),
          ),
        ),
      );

  const execute = <S extends Schema.Top>(
    operation: string,
    document: string,
    variables: Record<string, unknown>,
    data: S,
    token?: string,
  ): Effect.Effect<S["Type"], IssueTrackerError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const key = token ?? (yield* storedToken(operation));
      const now = yield* Clock.currentTimeMillis;
      const response = yield* httpClient
        .execute(
          HttpClientRequest.post(config.apiUrl).pipe(
            // A personal API key goes in as-is; `Bearer` is for OAuth tokens, which this is not.
            HttpClientRequest.setHeader("authorization", key),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe({ query: document, variables }),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            fail(operation, "failed", "Linear could not be reached.", { cause }),
          ),
        );
      const retryAt = retryAtFromHeader(
        response.headers["x-ratelimit-requests-reset"] ??
          response.headers["x-ratelimit-complexity-reset"],
        now,
      );
      const rateLimited = () =>
        fail(
          operation,
          "rate-limited",
          "Linear's rate limit was reached.",
          retryAt === undefined ? {} : { retryAt },
        );
      if (response.status === 429) return yield* rateLimited();
      if (response.status === 401 || response.status === 403) {
        return yield* fail(operation, "unauthenticated", "Linear rejected the API key.");
      }
      const envelope = yield* HttpClientResponse.schemaBodyJson(Envelope(data))(response).pipe(
        Effect.mapError((cause) =>
          fail(
            operation,
            "failed",
            `Linear returned HTTP ${response.status} with an unexpected body.`,
            { cause },
          ),
        ),
      );
      if (isRateLimited(envelope.errors)) return yield* rateLimited();
      if (isUnauthenticated(envelope.errors)) {
        return yield* fail(operation, "unauthenticated", "Linear rejected the API key.");
      }
      if (envelope.data === undefined || envelope.data === null) {
        return yield* fail(
          operation,
          "failed",
          errorDetail(envelope.errors, `Linear returned HTTP ${response.status}.`),
        );
      }
      return envelope.data;
    });

  const mutate = (
    operation: string,
    document: string,
    variables: Record<string, unknown>,
  ): Effect.Effect<void, IssueTrackerError> =>
    execute(operation, document, variables, SuccessData).pipe(
      Effect.flatMap((data) =>
        Object.values(data).every((result) => result.success)
          ? Effect.void
          : Effect.fail(fail(operation, "failed", "Linear did not apply the change.")),
      ),
    );

  const viewer: LinearApi["Service"]["viewer"] = (token) =>
    execute("viewer", VIEWER_QUERY, {}, ViewerData, token).pipe(
      Effect.map((data) => ({ viewer: data.viewer, teams: data.teams.nodes })),
    );

  const listIssues: LinearApi["Service"]["listIssues"] = (input) =>
    execute(
      "listIssues",
      LIST_QUERY,
      { first: input.first, after: input.after ?? null, filter: input.filter },
      ListData,
    ).pipe(
      Effect.map((data) => ({
        nodes: data.issues.nodes,
        nextCursor: data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null,
      })),
    );

  const getIssue: LinearApi["Service"]["getIssue"] = (identifier, comments) =>
    execute("getIssue", ISSUE_QUERY, { id: identifier, comments }, IssueData).pipe(
      Effect.map((data) => data.issue),
      // Linear answers an unknown identifier with an error and no data, not with null.
      Effect.catchIf(
        (error) => error.reason === "failed" && /not found/i.test(error.detail),
        () => Effect.succeed(null),
      ),
    );

  const getComments: LinearApi["Service"]["getComments"] = (input) =>
    execute(
      "getComments",
      COMMENTS_QUERY,
      { id: input.identifier, first: input.first, after: input.after },
      CommentsData,
    ).pipe(
      Effect.flatMap((data) =>
        data.issue === null
          ? Effect.fail(fail("getComments", "not-found", "This issue no longer exists."))
          : Effect.succeed({
              nodes: data.issue.comments.nodes,
              nextCursor: data.issue.comments.pageInfo.hasNextPage
                ? data.issue.comments.pageInfo.endCursor
                : null,
            }),
      ),
    );

  const getTeam: LinearApi["Service"]["getTeam"] = (key) =>
    execute("getTeam", TEAM_QUERY, { key }, TeamData).pipe(
      Effect.map((data) => {
        const team = data.teams.nodes[0];
        if (team === undefined) return null;
        return {
          team,
          workspaceLabels: data.issueLabels.nodes,
          truncated:
            team.states.pageInfo.hasNextPage ||
            team.labels.pageInfo.hasNextPage ||
            team.members.pageInfo.hasNextPage ||
            data.issueLabels.pageInfo.hasNextPage,
        };
      }),
    );

  const createIssue: LinearApi["Service"]["createIssue"] = (input) =>
    execute("createIssue", ISSUE_CREATE_MUTATION, { input }, CreatedData).pipe(
      Effect.flatMap((data) =>
        data.issueCreate.success && data.issueCreate.issue !== null
          ? Effect.succeed(data.issueCreate.issue)
          : Effect.fail(fail("createIssue", "failed", "Linear did not create the issue.")),
      ),
    );

  const updateIssue: LinearApi["Service"]["updateIssue"] = (identifier, input) =>
    mutate("updateIssue", ISSUE_UPDATE_MUTATION, { id: identifier, input });

  const createComment: LinearApi["Service"]["createComment"] = (input) =>
    mutate("createComment", COMMENT_CREATE_MUTATION, { input });

  const createReaction: LinearApi["Service"]["createReaction"] = (input) =>
    mutate("createReaction", REACTION_CREATE_MUTATION, {
      input:
        input.commentId === undefined
          ? { issueId: input.issueId, emoji: input.emoji }
          : { commentId: input.commentId, emoji: input.emoji },
    });

  const deleteReaction: LinearApi["Service"]["deleteReaction"] = (id) =>
    mutate("deleteReaction", REACTION_DELETE_MUTATION, { id });

  const listReactions: LinearApi["Service"]["listReactions"] = (input) =>
    execute(
      "listReactions",
      input.commentId === undefined ? ISSUE_REACTIONS_QUERY : COMMENT_REACTIONS_QUERY,
      { id: input.commentId ?? input.issueId },
      ReactionsData,
    ).pipe(Effect.map((data) => (data.comment ?? data.issue)?.reactions ?? []));

  return LinearApi.of({
    viewer,
    listIssues,
    getIssue,
    getComments,
    getTeam,
    createIssue,
    updateIssue,
    createComment,
    createReaction,
    deleteReaction,
    listReactions,
  });
});

export const layer = Layer.effect(LinearApi, make);
