/**
 * Linear's GraphQL API, signed with the API key saved in Settings. The operations live in
 * `LinearApi.graphql` and their client is generated (`vp run generate`). A rate-limit refusal
 * arrives as HTTP 429 or as a `RATELIMITED` GraphQL error on a 400; both map to `rate-limited`.
 */
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GraphQLClient,
  GraphQLClientError,
  GraphQLMiddleware,
  GraphQLProtocol,
} from "effect/graphql";
import { HttpClient } from "effect/http";
import * as Headers from "effect/http/Headers";
import { IssueTrackerKind } from "@t3tools/contracts";
import { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";
import { retryAtFromHeader } from "@t3tools/source-control-core/server/SourceControlRateLimit";

import type {
  CommentCreateInput,
  IssueCreateInput,
  IssueFilter,
  IssueUpdateInput,
} from "../../schema/linear.graphql.ts";
import {
  LinearApiGraphQLGroup,
  type Attachment,
  type IssueHistory,
  type LinearComment,
  type LinearIssue,
  type LinearReaction,
  type LinearTeamLabel,
  type LinearUser,
  type T3Issue,
  type T3Team,
  type Template,
} from "./LinearApi.graphql.ts";

export type { IssueFilter } from "../../schema/linear.graphql.ts";
export type {
  LinearComment,
  LinearIssue,
  LinearReaction,
  LinearUser,
} from "./LinearApi.graphql.ts";
export type { LinearWorkflowState } from "./LinearApi.graphql.ts";
export type LinearAttachment = Attachment;
export type LinearHistoryEntry = IssueHistory;

export const KIND = IssueTrackerKind.make("linear");
const DEFAULT_API_URL = "https://api.linear.app/graphql";

const LinearApiConfig = Config.all({
  apiUrl: Config.String("T3CODE_LINEAR_API_URL").pipe(Config.withDefault(DEFAULT_API_URL)),
});

const LinearTemplateData = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.Unknown),
  descriptionData: Schema.optional(Schema.Unknown),
  labelIds: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  assigneeId: Schema.optional(Schema.NullOr(Schema.String)),
});
type LinearTemplateData = typeof LinearTemplateData.Type;
const decodeTemplateData = Schema.decodeUnknownOption(
  Schema.Union([Schema.fromJsonString(LinearTemplateData), LinearTemplateData]),
);

/** A template with its data read: Linear sends it as a JSON string, and has sent an object. */
export interface LinearTemplate extends Omit<Template, "templateData"> {
  readonly templateData: LinearTemplateData;
}

type LinearTeamDetail = T3Team.Result["teams"]["nodes"][number];
type LinearIssueDetail = NonNullable<T3Issue.Result["issue"]>;

/** The team with the workspace-wide labels that any of its issues may also carry. */
export interface LinearTeamScope {
  readonly team: Omit<LinearTeamDetail, "templates"> & {
    readonly templates: { readonly nodes: ReadonlyArray<LinearTemplate> };
  };
  readonly workspaceLabels: ReadonlyArray<LinearTeamLabel>;
  /** Linear had more than one page of something; a missing label or member may still exist. */
  readonly truncated: boolean;
}

export class LinearApi extends Context.Service<
  LinearApi,
  {
    /** Who a credential is, and the teams it reaches. Takes the token so it can vet a new one. */
    readonly viewer: (token?: string) => Effect.Effect<
      {
        readonly viewer: LinearUser;
        readonly teams: ReadonlyArray<{
          readonly id: string;
          readonly key: string;
          readonly name: string;
        }>;
      },
      IssueTrackerError
    >;
    readonly listIssues: (input: {
      readonly filter: IssueFilter;
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
      input: IssueCreateInput,
    ) => Effect.Effect<{ readonly identifier: string; readonly url: string }, IssueTrackerError>;
    readonly updateIssue: (
      identifier: string,
      input: IssueUpdateInput,
    ) => Effect.Effect<void, IssueTrackerError>;
    readonly createComment: (input: CommentCreateInput) => Effect.Effect<void, IssueTrackerError>;
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

/** The API key a call is sent with: the stored one, or a new one being vetted. */
class LinearToken extends Context.Service<LinearToken, string>()(
  "@t3tools/issue-tracker-linear/server/LinearApi/LinearToken",
) {}

class LinearAuth extends GraphQLMiddleware.Service<LinearAuth, { requires: LinearToken }>()(
  "@t3tools/issue-tracker-linear/server/LinearApi/LinearAuth",
) {}

const LinearGroup = LinearApiGraphQLGroup.middleware(LinearAuth);

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

const hasCode = (errors: ReadonlyArray<GraphQLClientError.GraphQLError>, code: string) =>
  errors.some((error) => error.extensions?.["code"] === code);

/** Linear's answer as the tracker's error. Linear writes its messages for people. */
const toTrackerError = (
  operation: string,
  error: GraphQLClientError.GraphQLClientError,
  now: number,
): IssueTrackerError => {
  const reason = error.reason;
  if (reason._tag !== "ResponseError" && reason._tag !== "TransportError") {
    return fail(operation, "failed", "Linear returned an unexpected body.", { cause: error });
  }
  const errors = reason._tag === "ResponseError" ? reason.errors : [];
  const headers = reason.headers ?? Headers.empty;
  if (reason.status === 429 || hasCode(errors, "RATELIMITED")) {
    const retryAt = retryAtFromHeader(
      headers["x-ratelimit-requests-reset"] ?? headers["x-ratelimit-complexity-reset"],
      now,
    );
    return fail(
      operation,
      "rate-limited",
      "Linear's rate limit was reached.",
      retryAt === undefined ? {} : { retryAt },
    );
  }
  if (reason.status === 401 || reason.status === 403 || hasCode(errors, "AUTHENTICATION_ERROR")) {
    return fail(operation, "unauthenticated", "Linear rejected the API key.");
  }
  if (reason._tag === "ResponseError") {
    return fail(operation, "failed", errors[0]?.message.trim() || "Linear refused the request.");
  }
  return reason.status === undefined
    ? fail(operation, "failed", "Linear could not be reached.", { cause: error })
    : fail(operation, "failed", `Linear returned HTTP ${reason.status} with an unexpected body.`);
};

const nextCursor = (pageInfo: {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}) => (pageInfo.hasNextPage ? pageInfo.endCursor : null);

export const make = Effect.gen(function* () {
  // Only a default-carrying string: nothing in the environment can make it fail.
  const config = yield* LinearApiConfig.pipe(Effect.orDie);
  const httpClient = yield* HttpClient.HttpClient;
  const host = yield* IssueTrackerHost.IssueTrackerHost;

  const client = yield* GraphQLClient.make(LinearGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          LinearAuth,
          GraphQLMiddleware.mapRequest((request) =>
            Effect.gen(function* () {
              const token = yield* LinearToken;
              // A personal API key goes in as-is; `Bearer` is for OAuth tokens, which this is not.
              return { ...request, headers: Headers.set(request.headers, "authorization", token) };
            }),
          ),
        ),
        GraphQLProtocol.layerHttp({ url: config.apiUrl }).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
        ),
      ),
    ),
  );

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

  const call = Effect.fn("LinearApi.call")(function* <A>(
    operation: string,
    run: (
      linear: typeof client,
    ) => Effect.Effect<A, GraphQLClientError.GraphQLClientError, LinearToken>,
    token?: string,
  ): Effect.fn.Return<A, IssueTrackerError> {
    yield* Effect.annotateCurrentSpan({ "linear.operation": operation });
    const key = token ?? (yield* storedToken(operation));
    return yield* run(client).pipe(
      Effect.catch((error) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.fail(toTrackerError(operation, error, now)),
        ),
      ),
      Effect.provideService(LinearToken, key),
    );
  });

  const applied = (operation: string, result: { readonly success: boolean }) =>
    result.success
      ? Effect.void
      : Effect.fail(fail(operation, "failed", "Linear did not apply the change."));

  const viewer: LinearApi["Service"]["viewer"] = (token) =>
    call("viewer", (linear) => linear.T3Viewer(), token).pipe(
      Effect.map((data) => ({ viewer: data.viewer, teams: data.teams.nodes })),
    );

  const listIssues: LinearApi["Service"]["listIssues"] = (input) =>
    call("listIssues", (linear) =>
      linear.T3Issues({ first: input.first, after: input.after ?? null, filter: input.filter }),
    ).pipe(
      Effect.map((data) => ({
        nodes: data.issues.nodes,
        nextCursor: nextCursor(data.issues.pageInfo),
      })),
    );

  const getIssue: LinearApi["Service"]["getIssue"] = (identifier, comments) =>
    call("getIssue", (linear) => linear.T3Issue({ id: identifier, comments })).pipe(
      Effect.map((data) => data.issue),
      // Linear answers an unknown identifier with an error and no data, not with null.
      Effect.catchIf(
        (error) => error.reason === "failed" && /not found/i.test(error.detail),
        () => Effect.succeed(null),
      ),
    );

  const getComments: LinearApi["Service"]["getComments"] = (input) =>
    call("getComments", (linear) =>
      linear.T3Comments({ id: input.identifier, first: input.first, after: input.after }),
    ).pipe(
      Effect.flatMap((data) =>
        data.issue === null
          ? Effect.fail(fail("getComments", "not-found", "This issue no longer exists."))
          : Effect.succeed({
              nodes: data.issue.comments.nodes,
              nextCursor: nextCursor(data.issue.comments.pageInfo),
            }),
      ),
    );

  const getTeam: LinearApi["Service"]["getTeam"] = (key) =>
    call("getTeam", (linear) => linear.T3Team({ key })).pipe(
      Effect.map((data) => {
        const team = data.teams.nodes[0];
        if (team === undefined) return null;
        return {
          team: {
            ...team,
            templates: {
              nodes: team.templates.nodes.map((template) => ({
                ...template,
                templateData: Option.getOrElse(
                  decodeTemplateData(template.templateData),
                  (): LinearTemplateData => ({}),
                ),
              })),
            },
          },
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
    call("createIssue", (linear) => linear.T3IssueCreate({ input })).pipe(
      Effect.flatMap(({ issueCreate }) =>
        issueCreate.success && issueCreate.issue !== null
          ? Effect.succeed(issueCreate.issue)
          : Effect.fail(fail("createIssue", "failed", "Linear did not create the issue.")),
      ),
    );

  const updateIssue: LinearApi["Service"]["updateIssue"] = (identifier, input) =>
    call("updateIssue", (linear) => linear.T3IssueUpdate({ id: identifier, input })).pipe(
      Effect.flatMap(({ issueUpdate }) => applied("updateIssue", issueUpdate)),
    );

  const createComment: LinearApi["Service"]["createComment"] = (input) =>
    call("createComment", (linear) => linear.T3CommentCreate({ input })).pipe(
      Effect.flatMap(({ commentCreate }) => applied("createComment", commentCreate)),
    );

  const createReaction: LinearApi["Service"]["createReaction"] = (input) =>
    call("createReaction", (linear) =>
      linear.T3ReactionCreate({
        input:
          input.commentId === undefined
            ? { issueId: input.issueId ?? null, emoji: input.emoji }
            : { commentId: input.commentId, emoji: input.emoji },
      }),
    ).pipe(Effect.flatMap(({ reactionCreate }) => applied("createReaction", reactionCreate)));

  const deleteReaction: LinearApi["Service"]["deleteReaction"] = (id) =>
    call("deleteReaction", (linear) => linear.T3ReactionDelete({ id })).pipe(
      Effect.flatMap(({ reactionDelete }) => applied("deleteReaction", reactionDelete)),
    );

  const listReactions: LinearApi["Service"]["listReactions"] = (input) =>
    input.commentId === undefined
      ? call("listReactions", (linear) =>
          linear.T3IssueReactions({ id: input.issueId ?? "" }),
        ).pipe(Effect.map((data) => data.issue.reactions))
      : call("listReactions", (linear) =>
          linear.T3CommentReactions({ id: input.commentId ?? "" }),
        ).pipe(Effect.map((data) => data.comment.reactions));

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
